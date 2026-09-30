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

export type Emotion = "neutral" | "warm" | "cheerful" | "excited" | "calm" | "empathetic" | "serious" | "curious";
export const EMOTIONS: Emotion[] = ["neutral", "warm", "cheerful", "excited", "calm", "empathetic", "serious", "curious"];

/** How the user sounded, from prosody alone (never from the words). */
export type Tone = "neutral" | "calm" | "animated" | "tense" | "subdued";

export interface Utterance {
  wav: Blob;
  seconds: number;
  tone: Tone;
}

// ------------------------------------------------------------------ capture

const TAP = `class DsiTap extends AudioWorkletProcessor{process(inputs){const c=inputs[0]&&inputs[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor("dsi-tap",DsiTap);`;
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

export class LiveVoice {
  ctx?: AudioContext;
  private stream?: MediaStream;
  private tap?: AudioWorkletNode | ScriptProcessorNode;
  private sink?: GainNode;
  private rate = 48_000;
  private block: number[] = [];
  private blockSize = 960;
  private noise = 0.006;
  private inSpeech = false;
  private above = 0;
  private below = 0;
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
  /** True while DSI is talking: the detector then needs louder, longer speech (barge-in). */
  talking = false;
  /** Silence that ends a turn. */
  endOfTurnMs = 600;

  onLevel?: (level: number) => void;
  onSpeechStart?: () => void;
  onUtterance?: (u: Utterance) => void;

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
    // The tap must be pulled by the graph; route it into a muted gain so nothing is heard.
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.sink.connect(this.ctx.destination);
    try {
      const url = URL.createObjectURL(new Blob([TAP], { type: "application/javascript" }));
      await this.ctx.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(this.ctx, "dsi-tap");
      node.port.onmessage = (e) => this.samples(e.data as Float32Array);
      src.connect(node).connect(this.sink);
      this.tap = node;
    } catch {
      const node = this.ctx.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = (e) => this.samples(new Float32Array(e.inputBuffer.getChannelData(0)));
      src.connect(node).connect(this.sink);
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

  private samples(x: Float32Array) {
    for (let i = 0; i < x.length; i++) {
      this.block.push(x[i]);
      if (this.block.length >= this.blockSize) {
        const b = Float32Array.from(this.block);
        this.block = [];
        this.analyse(b);
      }
    }
  }

  private analyse(b: Float32Array) {
    let s = 0;
    for (const v of b) s += v * v;
    const rms = this.muted ? 0 : Math.sqrt(s / b.length);
    this.onLevel?.(Math.min(1, rms * 9));

    // Barge-in needs clearer, longer speech than a normal turn, so DSI's own voice leaking past
    // echo cancellation does not interrupt it.
    const thr = this.talking ? Math.max(0.035, this.noise * 6) : Math.max(0.012, this.noise * 3);
    const startMs = this.talking ? 260 : 120;
    const loud = rms > thr;

    if (!this.inSpeech) {
      this.preroll.push(b);
      if (this.preroll.length > PREROLL_MS / BLOCK_MS) this.preroll.shift();
      if (!loud) this.noise = Math.min(0.04, this.noise * 0.985 + rms * 0.015);
      this.above = loud ? this.above + BLOCK_MS : 0;
      if (this.above >= startMs) {
        this.inSpeech = true;
        this.below = 0;
        this.utt = [...this.preroll];
        this.uttMs = this.preroll.length * BLOCK_MS;
        this.preroll = [];
        this.stats = { energy: [], pitch: [] };
        this.onSpeechStart?.();
      }
      return;
    }

    this.utt.push(b);
    this.uttMs += BLOCK_MS;
    if (rms > thr * 0.6) {
      this.below = 0;
      this.stats.energy.push(rms);
      const p = pitchOf(resample([b], this.rate));
      if (p) this.stats.pitch.push(p);
    } else this.below += BLOCK_MS;

    if (this.below >= this.endOfTurnMs || this.uttMs > 30_000) this.finish();
  }

  private finish() {
    this.inSpeech = false;
    this.above = 0;
    // Keep 200 ms of the trailing silence.
    const trim = Math.max(0, Math.floor((this.below - 200) / BLOCK_MS));
    const chunks = trim ? this.utt.slice(0, -trim) : this.utt;
    const seconds = (chunks.length * BLOCK_MS) / 1000;
    const spoken = this.stats.energy.length * (BLOCK_MS / 1000);
    this.utt = [];
    if (spoken < 0.3) return; // a cough or a click
    const tone = this.tone();
    this.onUtterance?.({ wav: wav(resample(chunks, this.rate)), seconds, tone });
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

export async function transcribeWav(wavBlob: Blob, language?: string): Promise<{ text: string; language: string | null }> {
  const h = await authHeaders();
  // engine=fast: Nova-3 where it is reliable (0.5-1 s), Whisper for other languages.
  const q = `?engine=fast${language ? `&language=${encodeURIComponent(language)}` : ""}`;
  const r = await fetch(`${API}/api/voice/transcribe${q}`, { method: "POST", headers: { ...h, "content-type": "audio/wav" }, body: wavBlob });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message ?? `Voice request failed (HTTP ${r.status})`);
  return { text: (j.text ?? "").trim(), language: j.language ?? null };
}

/** Whisper's usual inventions on silence and noise. */
const PHANTOMS = /^(thank you\.?|thanks for watching!?|you|bye\.?|\.+|subtitles by.*|♪+)$/i;
export const isPhantom = (text: string, seconds: number) => !/\p{L}/u.test(text) || (seconds < 1.6 && PHANTOMS.test(text.trim()));

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

type Clip = { kind: "audio"; buf: AudioBuffer } | { kind: "device"; text: string; lang: string } | { kind: "none" };

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
      const r = await fetch(`${API}/api/voice/speak`, { method: "POST", headers: await authHeaders(), body: JSON.stringify({ text, lang }), signal });
      if (r.status === 204) return r.headers.get("x-decentralise-voice") === "device" ? { kind: "device", text, lang } : { kind: "none" };
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error?.message ?? `Speech failed (HTTP ${r.status})`);
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
    try {
      this.src?.stop();
    } catch {
      /* already stopped */
    }
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
      else await this.speakOnDevice(c.text, c.lang, item.emotion);
    }
    if (!token.aborted) this.setPlaying(false);
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
      const voice = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith(lang.toLowerCase()));
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

const TONE_WORDS: Record<Tone, string> = {
  neutral: "",
  calm: "calm and relaxed",
  animated: "animated, upbeat and energetic",
  tense: "tense or stressed",
  subdued: "quiet and low, perhaps tired or sad",
};

export function voiceSystemPrompt(o: { language: string | null; tone: Tone }): string {
  const lang = o.language ? (new Intl.DisplayNames(["en"], { type: "language" }).of(o.language) ?? o.language) : null;
  return [
    "You are DSI, talking with the user in a live voice conversation. Your words are spoken aloud.",
    lang ? `The user is speaking ${lang}. Always answer in ${lang} unless they ask otherwise.` : "Answer in the language the user speaks.",
    "Keep it conversational: usually one to three short sentences, like a person talking. No markdown, lists, headings, emoji or code; say numbers and symbols the way you would out loud. If they want detail, give it in short spoken sentences.",
    TONE_WORDS[o.tone] ? `From their tone of voice (not their words), the user sounds ${TONE_WORDS[o.tone]}. Let that shape your warmth and pace, without mentioning it unless it matters.` : "",
    `Start every reply with exactly one emotion tag for how your reply should sound, chosen from: ${EMOTIONS.join(", ")}. Write it as <emotion:NAME> and then your words, e.g. "<emotion:warm> That sounds lovely."`,
    "If the user interrupts you, simply respond to what they just said.",
  ]
    .filter(Boolean)
    .join(" ");
}
