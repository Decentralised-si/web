/**
 * Voice chat: record a question, transcribe it with Whisper, and speak the reply while it streams.
 * Transcription and speech run on Cloudflare Workers AI through the router (/api/voice/*); audio is
 * never stored.
 */
import { API, authHeaders } from "./api";

// ---------------------------------------------------------------- recording

export interface Recording {
  blob: Blob;
  heardSpeech: boolean;
}

export interface RecorderEvents {
  /** Input level 0..1, for the mic animation. */
  onLevel?: (level: number) => void;
}

const MIME = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"];

export function voiceSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
}

/**
 * Records until the speaker pauses (1.2 s of silence after speech), stop() is called, or 60 s pass.
 * Gives up after 8 s with no speech.
 */
export class Recorder {
  private stream?: MediaStream;
  private rec?: MediaRecorder;
  private ctx?: AudioContext;
  private raf = 0;
  private done?: (r: Recording) => void;
  private heard = false;

  async start(ev: RecorderEvents = {}): Promise<Recording> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const mimeType = MIME.find((m) => MediaRecorder.isTypeSupported?.(m));
    this.rec = new MediaRecorder(this.stream, mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : undefined);
    const chunks: Blob[] = [];
    this.rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const finished = new Promise<Recording>((resolve) => {
      this.done = resolve;
      this.rec!.onstop = () => {
        this.cleanup();
        resolve({ blob: new Blob(chunks, { type: this.rec?.mimeType || mimeType || "audio/webm" }), heardSpeech: this.heard });
      };
    });
    this.rec.start(250);

    // Voice activity detection on the input level.
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    const an = this.ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    const started = performance.now();
    let lastVoice = started;
    let noise = 0.01;
    const tick = () => {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      // Track the noise floor; speech is well above it.
      if (!this.heard) noise = Math.min(0.05, noise * 0.95 + rms * 0.05);
      const speaking = rms > Math.max(0.02, noise * 3);
      if (speaking) {
        this.heard = true;
        lastVoice = now;
      }
      ev.onLevel?.(Math.min(1, rms * 8));
      if ((this.heard && now - lastVoice > 1200) || (!this.heard && now - started > 8000) || now - started > 60_000) return this.stop();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    return finished;
  }

  stop() {
    cancelAnimationFrame(this.raf);
    if (this.rec && this.rec.state !== "inactive") this.rec.stop();
    else this.cleanup();
  }

  /** Stop and discard. */
  cancel() {
    this.heard = false;
    this.stop();
  }

  private cleanup() {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.stream = undefined;
    this.ctx = undefined;
  }
}

// ---------------------------------------------------------------- API

async function voiceError(r: Response): Promise<Error> {
  const j = await r.json().catch(() => ({}));
  return new Error(j?.error?.message ?? `Voice request failed (HTTP ${r.status})`);
}

export async function transcribe(blob: Blob): Promise<string> {
  const h = await authHeaders();
  const r = await fetch(`${API}/api/voice/transcribe`, { method: "POST", headers: { ...h, "content-type": blob.type || "audio/webm" }, body: blob });
  if (!r.ok) throw await voiceError(r);
  return ((await r.json()) as { text: string }).text;
}

async function synthesize(text: string, signal: AbortSignal): Promise<Blob | undefined> {
  const r = await fetch(`${API}/api/voice/speak`, { method: "POST", headers: await authHeaders(), body: JSON.stringify({ text }), signal });
  if (r.status === 204) return undefined;
  if (!r.ok) throw await voiceError(r);
  return r.blob();
}

// ---------------------------------------------------------------- speaking

/** 50 ms of silence as a WAV data URI (8 kHz, 8-bit mono), used to unlock playback on mobile. */
const SILENCE = (() => {
  const n = 400;
  const b = new Uint8Array(44 + n);
  const v = new DataView(b.buffer);
  const str = (o: number, t: string) => [...t].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  str(36, "data");
  v.setUint32(40, n, true);
  b.fill(128, 44);
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...b))}`;
})();

/**
 * Splits streaming text into speakable sentences. Code blocks are skipped (announced once) and
 * reasoning blocks are never read.
 */
export class SentenceSplitter {
  /**
   * @param eager hand over the first clause early (at a comma once it is long enough), so speech
   * starts sooner in a live conversation.
   */
  constructor(private eager = false) {}
  private emitted = 0;
  private buf = "";
  private inCode = false;
  private inThink = false;
  /** Fragments with no words yet ("1.", "**") wait for the next sentence. */
  private carry = "";

  push(delta: string): string[] {
    this.buf += delta;
    return this.drain(false);
  }

  flush(): string[] {
    return this.drain(true);
  }

  private drain(final: boolean): string[] {
    const out: string[] = [];
    const emit = (s: string) => {
      const t = `${this.carry} ${s}`.trim();
      if (/\p{L}{2,}/u.test(t) || (/\p{L}/u.test(t) && /[\u3000-\u9fff\uac00-\ud7af]/u.test(t))) {
        out.push(t);
        this.emitted++;
        this.carry = "";
      } else this.carry = t;
    };
    for (;;) {
      if (this.inThink) {
        const e = this.buf.indexOf("</think>");
        if (e < 0) return final ? ((this.buf = ""), out) : out;
        this.buf = this.buf.slice(e + 8);
        this.inThink = false;
        continue;
      }
      if (this.inCode) {
        const e = this.buf.indexOf("```");
        if (e < 0) return final ? ((this.buf = ""), out) : out;
        this.buf = this.buf.slice(this.buf.indexOf("\n", e) >= 0 ? this.buf.indexOf("\n", e) + 1 : e + 3);
        this.inCode = false;
        continue;
      }
      const think = this.buf.indexOf("<think>");
      const code = this.buf.indexOf("```");
      const stop = [think, code].filter((i) => i >= 0).sort((a, b) => a - b)[0];
      const prose = stop === undefined ? this.buf : this.buf.slice(0, stop);
      // Complete sentences in the prose before any block: they end at a newline, or at . ! ? followed
      // by whitespace ("3.14" and "e.g.x" do not end one). A stop at the very end of the buffer waits.
      let used = 0;
      for (let i = 0; i < prose.length; i++) {
        const ch = prose[i];
        let end = -1;
        if (ch === "\n") end = i + 1;
        // Chinese, Japanese, Arabic and Hindi end sentences without a following space.
        else if ("。！？؟।".includes(ch)) end = i + 1;
        else if (this.eager && !this.emitted && ",，、".includes(ch) && i - used > 25) end = i + 1;
        else if (".!?".includes(ch)) {
          let j = i + 1;
          while (j < prose.length && ".!?\"')]".includes(prose[j])) j++;
          if (j < prose.length && /\s/.test(prose[j])) end = j;
          else if (j >= prose.length) break;
          i = j - 1;
        }
        if (end >= 0) {
          const s = prose.slice(used, end).trim();
          if (s) emit(s);
          used = end;
          i = end - 1;
        }
      }
      if (stop !== undefined) {
        const rest = prose.slice(used).trim();
        if (rest) emit(rest);
        if (stop === think) {
          this.inThink = true;
          this.buf = this.buf.slice(stop + 7);
        } else {
          out.push("I've put the code in the chat.");
          this.inCode = true;
          this.buf = this.buf.slice(stop + 3);
        }
        continue;
      }
      this.buf = prose.slice(used);
      if (final && this.buf.trim()) {
        emit(this.buf.trim());
        this.buf = "";
      }
      return out;
    }
  }
}

/**
 * Speaks sentences in order while fetching the next ones ahead, so audio starts after the first
 * sentence arrives instead of after the whole reply.
 */
export class Speaker {
  private audio: HTMLAudioElement;
  private queue: Array<Promise<Blob | undefined>> = [];
  private playing = false;
  private ac = new AbortController();
  private idle?: () => void;
  onState?: (speaking: boolean) => void;
  onError?: (e: Error) => void;

  constructor() {
    this.audio = new Audio();
    this.audio.preload = "auto";
  }

  /** Call from a user gesture so mobile browsers allow later playback. */
  unlock() {
    this.audio.src = SILENCE;
    this.audio.play().catch(() => {});
  }

  get busy() {
    return this.playing || this.queue.length > 0;
  }

  say(text: string) {
    const t = text.trim();
    if (!t) return;
    this.queue.push(synthesize(t, this.ac.signal).catch((e) => (e.name !== "AbortError" && this.onError?.(e), undefined)));
    if (!this.playing) void this.play();
  }

  /** Resolves when everything queued so far has been spoken (or stopped). */
  whenIdle(): Promise<void> {
    return this.busy ? new Promise((r) => (this.idle = r)) : Promise.resolve();
  }

  stop() {
    this.ac.abort();
    this.ac = new AbortController();
    this.queue = [];
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.setPlaying(false);
  }

  private setPlaying(p: boolean) {
    if (this.playing === p) return;
    this.playing = p;
    this.onState?.(p);
    if (!p && !this.queue.length) {
      this.idle?.();
      this.idle = undefined;
    }
  }

  private async play() {
    this.setPlaying(true);
    while (this.queue.length) {
      const blob = await this.queue[0];
      this.queue.shift();
      if (!blob || !this.playing) continue;
      const url = URL.createObjectURL(blob);
      try {
        this.audio.src = url;
        await new Promise<void>((resolve) => {
          this.audio.onended = () => resolve();
          this.audio.onerror = () => resolve();
          this.audio.onpause = () => this.audio.ended || resolve();
          this.audio.play().catch(() => resolve());
        });
      } finally {
        URL.revokeObjectURL(url);
      }
      if (!this.playing) break;
    }
    this.setPlaying(false);
  }
}
