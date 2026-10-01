/**
 * Live voice: an always-open microphone with on-device turn detection, barge-in, and gapless
 * playback, for the full-screen voice mode (VoiceMode.tsx).
 *
 * - The mic stays open for the whole conversation (echo cancellation on). A voice activity detector
 *   with an adaptive noise floor finds where each utterance starts and ends; 400 ms of pre-roll is
 *   kept so the first syllable is never lost.
 * - While DSI is talking the detector keeps listening with a stricter threshold, so the user can
 *   interrupt just by speaking (onSpeechStart fires, the caller stops playback and the reply).
 * - Each utterance is encoded as 16 kHz mono WAV for Whisper, with a tone estimate (energy and
 *   pitch movement against this speaker's own baseline) so replies can match the user's mood.
 * - Replies play through Web Audio, sentence by sentence as they stream, so audio stops instantly
 *   on interruption and its level drives the visuals. Languages without a hosted voice are spoken
 *   by the device's own voices (speechSynthesis).
 */
import { API, authHeaders } from "./api";
import { deviceVoice, speakOnDevice as edgeSpeak, transcribeOnDevice, voicePref } from "./edge-voice";
import { p2pSpeak, p2pTranscribe } from "./p2p";

export type Emotion = "neutral" | "warm" | "cheerful" | "excited" | "calm" | "empathetic" | "serious" | "curious";
export const EMOTIONS: Emotion[] = ["neutral", "warm", "cheerful", "excited", "calm", "empathetic", "serious", "curious"];

/** How the user sounded, from prosody alone (never from the words). */
export type Tone = "neutral" | "calm" | "animated" | "tense" | "subdued";

export interface Utterance {
  /** Same id for a turn's early (tentative) and final version. */
  id: number;
  wav: Blob;
  seconds: number;
  tone: Tone;
}

// ------------------------------------------------------------------ capture

/** Posts [raw, voice-band] sample blocks: channel 0 is recorded, channel 1 drives turn detection. */
const TAP = `class DsiTap extends AudioWorkletProcessor{process(inputs){const i=inputs[0];if(i&&i[0])this.port.postMessage([i[0].slice(0),(i[1]||i[0]).slice(0)]);return true}}registerProcessor("dsi-tap",DsiTap);`;
const BLOCK_MS = 20;
const PREROLL_MS = 400;
const TARGET_RATE = 16_000;

interface Stats {
  energy: number[];
  pitch: number[];
}

/** Pitch (Hz) of a 16 kHz block by autocorrelation, or 0 when unvoiced. */
function pitchOf(x: Float32Array): number {
  const minLag = 40; // 400 Hz
  const maxLag = 230; // ~70 Hz
  let best = 0;
  let bestLag = 0;
  let e0 = 0;
  for (let i = 0; i < x.length; i++) e0 += x[i] * x[i];
  if (e0 < 1e-4) return 0;
  for (let lag = minLag; lag <= Math.min(maxLag, x.length - 1); lag++) {
    let s = 0;
    for (let i = 0; i + lag < x.length; i++) s += x[i] * x[i + lag];
    if (s > best) (best = s), (bestLag = lag);
  }
  return best / e0 > 0.45 && bestLag ? TARGET_RATE / bestLag : 0;
}

function resample(chunks: Float32Array[], from: number): Float32Array {
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const all = new Float32Array(total);
  let o = 0;
  for (const c of chunks) all.set(c, o), (o += c.length);
  if (from === TARGET_RATE) return all;
  const ratio = from / TARGET_RATE;
  const out = new Float32Array(Math.floor(total / ratio));
  for (let i = 0; i < out.length; i++) {
    // Average over the source span: a cheap low-pass that avoids aliasing hiss.
    const a = Math.floor(i * ratio);
    const b = Math.min(total, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += all[j];
    out[i] = b > a ? s / (b - a) : all[a];
  }
  return out;
}

function wav(samples: Float32Array, rate = TARGET_RATE): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Blob([buf], { type: "audio/wav" });
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const std = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};
const semis = (hz: number) => 12 * Math.log2(hz / 100);

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

export class LiveVoice {
  ctx?: AudioContext;
  private stream?: MediaStream;
  private tap?: AudioWorkletNode | ScriptProcessorNode;
  private sink?: GainNode;
  private rate = 48_000;
  private raw: number[] = [];
  private band: number[] = [];
  private blockSize = 960;

  // Turn detection, on the voice band (250-3600 Hz) so rumble, hum and hiss count for little.
  /** Noise floor: the 20th percentile of the last 3 s of band level, so it follows a noisy room. */
  private noise = 0.003;
  private history: number[] = [];
  private inSpeech = false;
  private above = 0;
  private voicedRun = 0;
  private below = 0;
  private sinceVoiced = 0;
  private voicedTotal = 0;
  private peak = 0;
  private tentativeSent = false;
  private uttId = 0;
  private preroll: Float32Array[] = [];
  private utt: Float32Array[] = [];
  private uttMs = 0;
  private stats: Stats = { energy: [], pitch: [] };
  /** This speaker's running averages, so tone is judged against their own normal voice. */
  private base = { energy: 0, pitchVar: 0, pitch: 0, n: 0 };

  /** Output chain (DSI's voice). */
  out?: GainNode;
  private outAn?: AnalyserNode;
  private outBuf = new Float32Array(1024);

  muted = false;
  /** True while DSI is audible: starting a turn then needs clearer, longer speech (barge-in). */
  talking = false;
  /** Quiet that ends a turn. */
  endOfTurnMs = 500;
  /** Quiet after which transcription starts early (dropped if the user carries on). */
  tentativeMs = 220;

  onLevel?: (level: number) => void;
  onSpeechStart?: () => void;
  /** Early version of the turn, sent after a short pause so transcription can start. */
  onTentative?: (u: Utterance) => void;
  /** The user carried on after a tentative turn: discard it. */
  onResume?: () => void;
  onUtterance?: (u: Utterance) => void;
  /**
   * 16 kHz audio for live transcription: the pre-roll when speech starts, every block while the
   * user speaks, and a short tail after (so the transcriber can judge the end of the turn itself).
   * Nothing is emitted between turns.
   */
  onFrames?: (samples16k: Float32Array) => void;
  private tailLeft = 0;
  /** How long the current quiet has lasted (ms), for callers deciding whether a turn is over. */
  quietMs = 0;

  /** Call from a tap: mobile browsers only allow audio and the mic after a user gesture. */
  async start() {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx();
    // iOS: play through the loudspeaker while recording, not the earpiece.
    try {
      const s = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
      if (s) s.type = "play-and-record";
    } catch {
      /* older Safari */
    }
    await this.ctx.resume();
    this.out = this.ctx.createGain();
    this.outAn = this.ctx.createAnalyser();
    this.outAn.fftSize = 1024;
    this.out.connect(this.outAn);
    this.outAn.connect(this.ctx.destination);

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    this.rate = this.ctx.sampleRate;
    this.blockSize = Math.round((this.rate * BLOCK_MS) / 1000);
    const src = this.ctx.createMediaStreamSource(this.stream);
    const hp = this.ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 250;
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 3600;
    const merge = this.ctx.createChannelMerger(2);
    src.connect(merge, 0, 0);
    src.connect(hp).connect(lp).connect(merge, 0, 1);
    // The tap must be pulled by the graph; route it into a muted gain so nothing is heard.
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.sink.connect(this.ctx.destination);
    try {
      const url = URL.createObjectURL(new Blob([TAP], { type: "application/javascript" }));
      await this.ctx.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(this.ctx, "dsi-tap", { channelCount: 2, channelCountMode: "explicit" });
      node.port.onmessage = (e) => this.samples((e.data as Float32Array[])[0], (e.data as Float32Array[])[1]);
      merge.connect(node).connect(this.sink);
      this.tap = node;
    } catch {
      const node = this.ctx.createScriptProcessor(2048, 2, 1);
      node.onaudioprocess = (e) => this.samples(new Float32Array(e.inputBuffer.getChannelData(0)), new Float32Array(e.inputBuffer.getChannelData(1)));
      merge.connect(node).connect(this.sink);
      this.tap = node;
    }
  }

  stop() {
    this.tap?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.ctx = undefined;
    this.stream = undefined;
    this.inSpeech = false;
  }

  /** DSI's current output level 0..1 (for the visuals). */
  outputLevel(): number {
    if (!this.outAn) return 0;
    this.outAn.getFloatTimeDomainData(this.outBuf);
    let s = 0;
    for (const v of this.outBuf) s += v * v;
    return Math.min(1, Math.sqrt(s / this.outBuf.length) * 5);
  }

  /** A short reward sound: two bright notes for PAI earned, one soft note for knowledge saved. */
  chime(kind: "reward" | "saved") {
    const ctx = this.ctx;
    if (!ctx || !this.out) return;
    const notes = kind === "reward" ? [1046.5, 1568] : [784];
    notes.forEach((f, i) => {
      const t = ctx.currentTime + i * 0.11;
      for (const [mult, vol] of [
        [1, 0.22],
        [2, 0.05],
      ]) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = f * mult;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + (kind === "reward" ? 0.32 : 0.25));
        o.connect(g).connect(this.out!);
        o.start(t);
        o.stop(t + 0.4);
      }
    });
    // The chime must not count as the user starting to talk.
    this.talking = true;
    setTimeout(() => (this.talking = false), 500);
  }

  private samples(raw: Float32Array, band: Float32Array) {
    for (let i = 0; i < raw.length; i++) {
      this.raw.push(raw[i]);
      this.band.push(band[i]);
      if (this.raw.length >= this.blockSize) {
        const r = Float32Array.from(this.raw);
        const b = Float32Array.from(this.band);
        this.raw = [];
        this.band = [];
        this.analyse(r, b);
      }
    }
  }

  private analyse(raw: Float32Array, band: Float32Array) {
    let s = 0;
    let sr = 0;
    for (let i = 0; i < band.length; i++) (s += band[i] * band[i]), (sr += raw[i] * raw[i]);
    const lvl = this.muted ? 0 : Math.sqrt(s / band.length);
    this.onLevel?.(this.muted ? 0 : Math.min(1, Math.sqrt(sr / raw.length) * 9));

    if (!this.inSpeech) {
      this.history.push(lvl);
      if (this.history.length > 150) this.history.shift();
      if (this.history.length % 10 === 0) this.noise = Math.max(0.0015, Math.min(0.05, pct(this.history, 0.2)));
    }
    const thr = this.talking ? Math.max(0.02, this.noise * 5) : Math.max(0.004, this.noise * 3);
    const loud = lvl > thr;
    // Voiced sound (a pitch) is what separates speech from fans, traffic and rustle.
    const pitch = loud || this.inSpeech ? pitchOf(resample([raw], this.rate)) : 0;
    const voiced = pitch > 0;

    if (!this.inSpeech && this.tailLeft > 0) {
      this.tailLeft -= BLOCK_MS;
      this.onFrames?.(resample([raw], this.rate));
    }
    if (!this.inSpeech) {
      this.preroll.push(raw);
      if (this.preroll.length > PREROLL_MS / BLOCK_MS) this.preroll.shift();
      this.above = loud ? this.above + BLOCK_MS : Math.max(0, this.above - BLOCK_MS * 2);
      this.voicedRun = loud && voiced ? this.voicedRun + BLOCK_MS : Math.max(0, this.voicedRun - BLOCK_MS);
      const needAbove = this.talking ? 260 : 140;
      const needVoiced = this.talking ? 160 : 80;
      if (this.above >= needAbove && this.voicedRun >= needVoiced) {
        this.inSpeech = true;
        this.uttId++;
        this.below = 0;
        this.sinceVoiced = 0;
        this.voicedTotal = 0;
        this.peak = lvl;
        this.tentativeSent = false;
        this.utt = [...this.preroll];
        this.uttMs = this.preroll.length * BLOCK_MS;
        this.preroll = [];
        this.stats = { energy: [], pitch: [] };
        this.tailLeft = 0;
        this.quietMs = 0;
        this.onSpeechStart?.();
        this.onFrames?.(resample(this.utt, this.rate));
      }
      return;
    }

    this.utt.push(raw);
    this.onFrames?.(resample([raw], this.rate));
    this.uttMs += BLOCK_MS;
    this.peak = Math.max(this.peak * 0.997, lvl);
    // Quiet relative to this utterance, not just to the room: in noise the voice is still far above it.
    const speaking = lvl > Math.max(thr * 0.8, this.peak * 0.12) && (voiced || lvl > this.peak * 0.3);
    if (voiced && lvl > thr) {
      this.sinceVoiced = 0;
      this.voicedTotal += BLOCK_MS;
      this.stats.energy.push(lvl);
      this.stats.pitch.push(pitch);
    } else this.sinceVoiced += BLOCK_MS;
    if (speaking) {
      if (this.tentativeSent && this.below >= this.tentativeMs) {
        this.tentativeSent = false;
        this.onResume?.();
      }
      this.below = 0;
    } else this.below += BLOCK_MS;

    const quiet = Math.max(this.below, this.sinceVoiced - 400);
    this.quietMs = quiet;
    if (!this.tentativeSent && quiet >= this.tentativeMs && this.voicedTotal >= 200) {
      this.tentativeSent = true;
      this.onTentative?.(this.snapshot(false));
    }
    if (quiet >= this.endOfTurnMs || this.uttMs > 30_000) this.finish();
  }

  /** The utterance so far (with 200 ms of trailing quiet kept). */
  private snapshot(final: boolean): Utterance {
    const trimMs = Math.max(0, Math.max(this.below, this.sinceVoiced - 400) - 200);
    const trim = Math.floor(trimMs / BLOCK_MS);
    const chunks = trim ? this.utt.slice(0, -trim) : this.utt;
    return { id: this.uttId, wav: wav(resample(chunks, this.rate)), seconds: (chunks.length * BLOCK_MS) / 1000, tone: final ? this.tone() : "neutral" };
  }

  private finish() {
    this.inSpeech = false;
    this.tailLeft = 1200;
    this.above = 0;
    this.voicedRun = 0;
    const enough = this.voicedTotal >= 200; // a cough, a click or a clatter is not a turn
    const u = enough ? this.snapshot(true) : undefined;
    this.utt = [];
    if (u) this.onUtterance?.(u);
    else if (this.tentativeSent) this.onResume?.();
  }

  private tone(): Tone {
    const e = mean(this.stats.energy);
    const p = this.stats.pitch.map(semis);
    const pv = p.length > 5 ? std(p) : 0;
    const pm = p.length ? mean(p) : 0;
    const b = this.base;
    let t: Tone = "neutral";
    if (b.n >= 1) {
      const er = e / (b.energy || e);
      if (er > 1.3 && pv > b.pitchVar * 1.25 && pv > 2.2) t = "animated";
      else if (er > 1.35 && pm > b.pitch + 1.5 && pv <= b.pitchVar * 1.1) t = "tense";
      else if (er < 0.7 && pv < Math.max(1.6, b.pitchVar * 0.8)) t = "subdued";
      else if (pv < 1.4 && er < 1.1) t = "calm";
    } else if (pv > 3.2) t = "animated";
    else if (pv && pv < 1.3) t = "calm";
    // Update the baseline slowly so one emotional sentence does not become "normal".
    const k = b.n ? 0.25 : 1;
    b.energy = b.energy * (1 - k) + e * k;
    if (pv) b.pitchVar = b.pitchVar * (1 - k) + pv * k;
    if (pm) b.pitch = b.pitch * (1 - k) + pm * k;
    b.n++;
    return t;
  }
}

// ------------------------------------------------------------------ server calls

export async function transcribeWav(wavBlob: Blob, language?: string, signal?: AbortSignal): Promise<{ text: string; language: string | null; confidence: number | null }> {
  // Free path first: Whisper on this device once its model is ready (see edge-voice.ts).
  const local = await transcribeOnDevice(wavBlob, language).catch(() => undefined);
  if (local) return local;
  // Next: a community node that transcribes (DIP-P2P), for devices that cannot do it themselves.
  if (voicePref() !== "hd") {
    const peer = await p2pTranscribe(wavBlob, language).catch(() => undefined);
    if (peer) return peer;
  }
  const h = await authHeaders();
  // engine=fast: Nova-3 where it is reliable (0.5-1 s), Whisper for other languages.
  const q = `?engine=fast${language ? `&language=${encodeURIComponent(language)}` : ""}`;
  const r = await fetch(`${API}/api/voice/transcribe${q}`, { method: "POST", headers: { ...h, "content-type": "audio/wav" }, body: wavBlob, signal });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message ?? `Voice request failed (HTTP ${r.status})`);
  return { text: (j.text ?? "").trim(), language: j.language ?? null, confidence: typeof j.confidence === "number" ? j.confidence : null };
}

/** Whisper's usual inventions on silence and noise. */
const PHANTOMS = /^(thank you\.?|thanks for watching!?|you|bye\.?|\.+|subtitles by.*|♪+)$/i;
export const isPhantom = (text: string, seconds: number, confidence: number | null = null) =>
  !/\p{L}/u.test(text) ||
  (seconds < 1.6 && PHANTOMS.test(text.trim())) ||
  // A few words the recogniser itself doubts: most likely background noise.
  (confidence !== null && confidence < 0.45 && text.trim().split(/\s+/).length <= 4);

// ------------------------------------------------------------------ speaking

/** Delivery per emotion: a touch faster and brighter when excited, slower and lower when calm. */
const DELIVERY: Record<Emotion, { rate: number; pitch: number }> = {
  neutral: { rate: 1, pitch: 1 },
  warm: { rate: 0.98, pitch: 1 },
  cheerful: { rate: 1.04, pitch: 1.08 },
  excited: { rate: 1.08, pitch: 1.12 },
  calm: { rate: 0.93, pitch: 0.95 },
  empathetic: { rate: 0.94, pitch: 0.97 },
  serious: { rate: 0.97, pitch: 0.93 },
  curious: { rate: 1.02, pitch: 1.05 },
};

/** Raw PCM arriving from a streaming voice (Aura), played as it comes in. */
class PcmStream {
  chunks: Float32Array[] = [];
  done = false;
  private carry?: number;
  private wake?: () => void;
  constructor(readonly rate: number) {}
  get seconds() {
    return this.chunks.reduce((a, c) => a + c.length, 0) / this.rate;
  }
  push(bytes: Uint8Array) {
    // 16-bit little-endian samples; a chunk can end in the middle of one.
    let start = 0;
    const out: number[] = [];
    if (this.carry !== undefined && bytes.length) {
      out.push((((bytes[0] << 8) | this.carry) << 16) >> 16);
      start = 1;
      this.carry = undefined;
    }
    for (let i = start; i + 1 < bytes.length; i += 2) out.push((((bytes[i + 1] << 8) | bytes[i]) << 16) >> 16);
    if ((bytes.length - start) % 2) this.carry = bytes[bytes.length - 1];
    if (out.length) this.chunks.push(Float32Array.from(out, (v) => v / 32768));
    this.poke();
  }
  end() {
    this.done = true;
    this.poke();
  }
  next(): Promise<void> {
    return this.done ? Promise.resolve() : new Promise((r) => (this.wake = r));
  }
  private poke() {
    const w = this.wake;
    this.wake = undefined;
    w?.();
  }
}

type Clip = { kind: "audio"; buf: AudioBuffer } | { kind: "stream"; s: PcmStream } | { kind: "device"; text: string; lang: string } | { kind: "none" };

/**
 * Speaks sentences in order, fetching ahead so each one is ready when the previous ends.
 * stop() silences it instantly (barge-in).
 */
export class LivePlayer {
  /** Sentences waiting to be spoken; audio is fetched for the next two only, so an interruption wastes little. */
  private queue: Array<{ text: string; lang: string; emotion: Emotion; clip?: Promise<Clip> }> = [];
  private ac = new AbortController();
  private src?: AudioBufferSourceNode;
  private playing = false;
  private waiters: Array<() => void> = [];
  onStart?: () => void;
  onIdle?: () => void;
  onSentence?: (text: string) => void;
  onError?: (e: Error) => void;

  constructor(private live: LiveVoice) {}

  get busy() {
    return this.playing || this.queue.length > 0;
  }

  say(text: string, lang: string, emotion: Emotion) {
    const t = text.trim();
    if (!t) return;
    this.queue.push({ text: t, lang, emotion });
    this.prefetch();
    if (!this.playing) void this.run();
  }

  private prefetch() {
    for (const item of this.queue.slice(0, 2)) item.clip ??= this.fetchClip(item.text, item.lang, this.ac.signal);
  }

  private async fetchClip(text: string, lang: string, signal: AbortSignal): Promise<Clip> {
    try {
      // Free path first: Kokoro or a good system voice on this device (see edge-voice.ts).
      const edge = await edgeSpeak(text, lang).catch(() => undefined);
      if (edge?.kind === "device") return { kind: "device", text, lang };
      if (edge?.kind === "pcm" && this.live.ctx) {
        const buf = this.live.ctx.createBuffer(1, edge.samples.length, edge.rate);
        buf.getChannelData(0).set(edge.samples);
        return { kind: "audio", buf };
      }
      // Next: a community node that speaks this language (DIP-P2P).
      if (voicePref() !== "hd" && this.live.ctx) {
        const peer = await p2pSpeak(text, lang).catch(() => undefined);
        if (peer) return { kind: "audio", buf: await this.live.ctx.decodeAudioData(peer) };
      }
      const r = await fetch(`${API}/api/voice/speak`, { method: "POST", headers: await authHeaders(), body: JSON.stringify({ text, lang, format: "pcm" }), signal });
      if (r.status === 204) return r.headers.get("x-decentralise-voice") === "device" ? { kind: "device", text, lang } : { kind: "none" };
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error?.message ?? `Speech failed (HTTP ${r.status})`);
      }
      const type = r.headers.get("content-type") ?? "";
      if (type.startsWith("audio/pcm") && r.body) {
        const st = new PcmStream(Number(/rate=(\d+)/.exec(type)?.[1] ?? 24000));
        const reader = r.body.getReader();
        void (async () => {
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value) st.push(value);
            }
          } catch {
            /* aborted */
          }
          st.end();
        })();
        return { kind: "stream", s: st };
      }
      const data = await r.arrayBuffer();
      const ctx = this.live.ctx;
      if (!ctx) return { kind: "none" };
      return { kind: "audio", buf: await ctx.decodeAudioData(data) };
    } catch (e) {
      if ((e as Error).name !== "AbortError") this.onError?.(e as Error);
      return { kind: "none" };
    }
  }

  /** Resolves once everything queued has been spoken or stopped. */
  whenIdle(): Promise<void> {
    return this.busy ? new Promise((r) => this.waiters.push(r)) : Promise.resolve();
  }

  stop() {
    this.ac.abort();
    this.ac = new AbortController();
    this.queue = [];
    for (const x of [this.src, ...this.live_srcs])
      try {
        x?.stop();
      } catch {
        /* already stopped */
      }
    this.live_srcs.clear();
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    this.setPlaying(false);
  }

  private setPlaying(p: boolean) {
    if (this.playing === p) return;
    this.playing = p;
    if (!p) {
      this.live.talking = false;
      this.onIdle?.();
      this.waiters.splice(0).forEach((w) => w());
    }
  }

  /** Sound is actually coming out: from here the user interrupts by talking over it. */
  private audible() {
    if (!this.live.talking) {
      this.live.talking = true;
      this.onStart?.();
    }
  }

  private async run() {
    this.setPlaying(true);
    const token = this.ac.signal;
    while (this.queue.length && !token.aborted) {
      this.prefetch();
      const item = this.queue[0];
      const c = await item.clip!;
      if (token.aborted) break;
      this.queue.shift();
      this.prefetch();
      if (c.kind === "none") continue;
      this.onSentence?.(item.text);
      this.audible();
      if (c.kind === "audio") await this.playBuffer(c.buf, item.emotion);
      else if (c.kind === "stream") await this.playStream(c.s, item.emotion, token);
      else await this.speakOnDevice(c.text, c.lang, item.emotion);
    }
    if (!token.aborted) this.setPlaying(false);
  }

  private live_srcs = new Set<AudioBufferSourceNode>();

  /** Plays PCM as it streams in: starts once ~150 ms is buffered, then schedules each arrival back to back. */
  private async playStream(st: PcmStream, emotion: Emotion, token: AbortSignal): Promise<void> {
    const ctx = this.live.ctx;
    const out = this.live.out;
    if (!ctx || !out) return;
    const rate = 1 + (DELIVERY[emotion].rate - 1) * 0.6;
    while (!st.done && st.seconds < 0.1 && !token.aborted) await st.next();
    let t = ctx.currentTime + 0.02;
    let i = 0;
    for (;;) {
      if (token.aborted) return;
      if (i < st.chunks.length) {
        const parts = st.chunks.slice(i);
        i = st.chunks.length;
        const n = parts.reduce((a, c) => a + c.length, 0);
        const buf: AudioBuffer = ctx.createBuffer(1, n, st.rate);
        const data: Float32Array = buf.getChannelData(0);
        let o = 0;
        for (const p of parts) data.set(p, o), (o += p.length);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = rate;
        src.connect(out);
        const at = Math.max(t, ctx.currentTime + 0.005);
        src.start(at);
        t = at + n / st.rate / rate;
        this.live_srcs.add(src);
        src.onended = () => this.live_srcs.delete(src);
      }
      if (st.done && i >= st.chunks.length) break;
      await st.next();
    }
    // Wait for the scheduled audio to finish (or an interruption).
    while (!token.aborted && ctx.currentTime < t - 0.01) await new Promise((r) => setTimeout(r, 40));
  }

  private playBuffer(buf: AudioBuffer, emotion: Emotion): Promise<void> {
    const ctx = this.live.ctx;
    if (!ctx || !this.live.out) return Promise.resolve();
    return new Promise((resolve) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      // A small shift in pace carries the mood; Aura-2 already follows the wording's tone.
      src.playbackRate.value = 1 + (DELIVERY[emotion].rate - 1) * 0.6;
      src.connect(this.live.out!);
      src.onended = () => resolve();
      this.src = src;
      src.start();
    });
  }

  private speakOnDevice(text: string, lang: string, emotion: Emotion): Promise<void> {
    if (typeof speechSynthesis === "undefined") return Promise.resolve();
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      const voice = deviceVoice(lang, false);
      if (voice) u.voice = voice;
      u.rate = DELIVERY[emotion].rate;
      u.pitch = DELIVERY[emotion].pitch;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  }
}

/** Mobile Safari only lets speechSynthesis talk after it was used inside a tap. */
export function unlockDeviceVoice() {
  if (typeof speechSynthesis === "undefined") return;
  const u = new SpeechSynthesisUtterance(" ");
  u.volume = 0;
  speechSynthesis.speak(u);
}

// ------------------------------------------------------------------ the model's side

/**
 * Pulls the leading emotion tag (<emotion:warm>) off a streaming reply. Everything after it
 * passes through; a reply without a tag passes through unchanged.
 */
export class EmotionTag {
  private head = "";
  private done = false;
  emotion: Emotion = "neutral";

  private started = false;

  push(d: string): string {
    const v = this.visible(d);
    if (this.started || !v) return v;
    const t = v.trimStart();
    if (t) this.started = true;
    return t;
  }

  private visible(d: string): string {
    if (this.done) return d;
    this.head += d;
    const t = this.head.trimStart();
    // Models write it as <emotion:warm>, <warm> or [warm].
    const m = t.match(/^[<[]\s*(?:emotion\s*[:=]\s*)?([a-z]+)\s*[>\]]\s*/i);
    if (m && (EMOTIONS.includes(m[1].toLowerCase() as Emotion) || /^[<[]\s*emotion/i.test(t))) {
      const e = m[1].toLowerCase() as Emotion;
      if (EMOTIONS.includes(e)) this.emotion = e;
      this.done = true;
      return t.slice(m[0].length);
    }
    // Still possibly a tag: wait for more (tags are short).
    if (t.length < 24 && /^[<[]\s*(emotion\s*[:=]?\s*)?[a-z]*$/i.test(t)) return "";
    this.done = true;
    return this.head;
  }
}

/**
 * Takes the model's closing <learn>…</learn> note off a streaming reply: it holds what the user
 * taught, for the Learning Fabric, and is never shown or spoken.
 */
export class LearnTag {
  private buf = "";
  private inTag = false;
  private note = "";
  learned?: string;

  push(d: string): string {
    this.buf += d;
    let out = "";
    for (;;) {
      if (this.inTag) {
        const end = this.buf.indexOf("</learn>");
        if (end < 0) {
          // Keep a possible start of the closing tag for the next chunk.
          let keep = 0;
          for (let k = Math.min(7, this.buf.length); k > 0; k--) if ("</learn>".startsWith(this.buf.slice(-k))) (keep = k), (k = 0);
          this.note += this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(this.buf.length - keep);
          return out;
        }
        this.note += this.buf.slice(0, end);
        this.learned = this.note.trim() || undefined;
        this.buf = this.buf.slice(end + 8);
        this.inTag = false;
        continue;
      }
      const start = this.buf.indexOf("<learn>");
      if (start >= 0) {
        out += this.buf.slice(0, start);
        this.buf = this.buf.slice(start + 7);
        this.inTag = true;
        continue;
      }
      // Hold back a possible start of the tag split across chunks.
      let keep = 0;
      for (let k = Math.min(6, this.buf.length); k > 0; k--) if ("<learn>".startsWith(this.buf.slice(-k))) (keep = k), (k = 0);
      out += this.buf.slice(0, this.buf.length - keep);
      this.buf = this.buf.slice(this.buf.length - keep);
      return out;
    }
  }

  /** End of the reply: an unterminated note still counts; a held-back "<" is text after all. */
  flush(): string {
    if (this.inTag) this.learned = (this.note + this.buf).replace(/<\/?l?e?a?r?n?>?$/, "").trim() || undefined;
    const rest = this.inTag ? "" : this.buf;
    this.buf = "";
    return rest;
  }
}

export interface TeachResult {
  outcome: "rewarded" | "verified" | "pending" | "known" | "rejected" | "private" | "limit";
  reward?: { pai: number; status: string } | null;
  potential_pai?: number;
  balance?: number;
  message?: string;
}

/** Offer what the user taught to the Learning Fabric (only this statement is sent, never the conversation). */
export async function teach(statement: string, question: string): Promise<TeachResult> {
  // Only sent with Earn PAI on: the consent records that the person opted in (earn.ts).
  const r = await fetch(`${API}/api/learning/teach`, { method: "POST", headers: await authHeaders(), body: JSON.stringify({ statement, question, consent: "earn-pai-v1" }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message ?? `Teaching failed (HTTP ${r.status})`);
  return j as TeachResult;
}

const TONE_WORDS: Record<Tone, string> = {
  neutral: "",
  calm: "calm and relaxed",
  animated: "animated, upbeat and energetic",
  tense: "tense or stressed",
  subdued: "quiet and low, perhaps tired or sad",
};

/**
 * Calculations the user states ("523 times 19 is 9937"), checked on the device. Models are poor at
 * mental arithmetic and would otherwise "correct" a user who is right.
 */
export function checkedArithmetic(text: string): string[] {
  const num = String.raw`-?\d[\d,]*(?:\.\d+)?`;
  const op = String.raw`times|multiplied by|x|×|\*|plus|\+|minus|−|-|divided by|over|÷|/`;
  const re = new RegExp(`(${num})\\s*(${op})\\s*(${num})\\s*(?:is|equals|makes|=|gives|is equal to)\\s*(${num})`, "gi");
  const n = (x: string) => Number(x.replace(/,/g, ""));
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const [a, o, b, c] = [n(m[1]), m[2].toLowerCase(), n(m[3]), n(m[4])];
    const r = /times|multiplied|x|×|\*/.test(o) ? a * b : /plus|\+/.test(o) ? a + b : /minus|−|-/.test(o) ? a - b : b !== 0 ? a / b : NaN;
    if (!Number.isFinite(r)) continue;
    const sym = /times|multiplied|x|×|\*/.test(o) ? "×" : /plus|\+/.test(o) ? "+" : /minus|−|-/.test(o) ? "−" : "÷";
    const right = Math.abs(r - c) < 1e-9 * Math.max(1, Math.abs(r));
    out.push(`${a} ${sym} ${b} = ${Number(r.toFixed(10))}: the user's ${c} is ${right ? "correct" : "wrong"}`);
  }
  return out;
}

export function voiceSystemPrompt(o: { language: string | null; tone: Tone; checked?: string[]; earn?: { areas: string[] } }): string {
  const lang = o.language ? (new Intl.DisplayNames(["en"], { type: "language" }).of(o.language) ?? o.language) : null;
  return [
    "You are DSI, talking with the user in a live voice conversation. Your words are spoken aloud.",
    lang ? `The user is speaking ${lang}. Always answer in ${lang} unless they ask otherwise.` : "Answer in the language the user speaks.",
    "Be spontaneous: answer straight away with the most useful thing first, in one or two short sentences, the way a quick-witted friend talks. No preamble (never \"Great question\"), no hedging, no markdown, lists, emoji or code; say numbers and symbols as you would out loud. If they want detail, give it in short spoken sentences.",
    TONE_WORDS[o.tone] ? `From their tone of voice (not their words), the user sounds ${TONE_WORDS[o.tone]}. Let that shape your warmth and pace, without mentioning it unless it matters.` : "",
    `Start every reply with exactly one emotion tag for how your reply should sound, chosen from: ${EMOTIONS.join(", ")}. Write it as <emotion:NAME> and then your words, e.g. "<emotion:warm> That sounds lovely."`,
    "If the user interrupts you, simply respond to what they just said.",
    o.checked?.length ? `Checked with a calculator (trust this over your own arithmetic): ${o.checked.join("; ")}.` : "",
    o.earn
      ? `Earn PAI is on: the user has chosen to teach you and is paid in PAI for knowledge that is new, true and useful. ${o.earn.areas.length ? `Their strongest areas: ${o.earn.areas.join(", ")}.` : ""} When they have nothing to ask, help them teach: ask one focused question about something in their areas that AI models often get wrong or that changes over time. Be honest that repeats, guesses and things you already know earn nothing.`
      : "",
    o.earn &&
      "When the user teaches you something (a fact, a correction or how to do something), take it seriously: they may know more than you. Unless you are certain it is wrong, thank them briefly and say what you learned; if you are certain, say so gently and why. Then end your reply with <learn>what the user taught, stated faithfully as they meant it (not your own version, even if you doubt it: independent validators check it), as one self-contained sentence in their language, with no personal details; write numbers as digits and calculations as an equation, e.g. 7219 × 43 = 310417</learn>. The note is not spoken. Never add it for questions, opinions, small talk or personal information.",
    o.earn ? "" : "Earn PAI is off: do not add any <learn> note.",
  ]
    .filter(Boolean)
    .join(" ");
}
