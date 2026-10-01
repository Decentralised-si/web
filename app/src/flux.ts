/**
 * Live transcription while the user speaks (Deepgram Flux via the router, /api/voice/live).
 *
 * One stream per conversation, opened when voice mode starts, so there is no connection set-up
 * in a turn. Audio is sent only while the user speaks (LiveVoice emits the pre-roll, the speech
 * and a short tail), plus 100 ms of silence every few seconds to keep the stream open; Flux bills
 * by audio, so the conversation costs about what the user actually says. Flux reports each turn as
 * it happens: the transcript grows word by word, and EndOfTurn arrives a fraction of a second
 * after the user stops, so the reply can start at once with no upload or separate transcription.
 *
 * Flux transcribes English; other languages use the per-utterance path (Whisper) as before.
 */
import { API, api } from "./api";

export interface FluxEvent {
  event: "Update" | "StartOfTurn" | "EagerEndOfTurn" | "TurnResumed" | "EndOfTurn" | "Failed" | string;
  transcript: string;
  eot: number;
}

const wsBase = () => API.replace(/^http/, "ws");
const KEEPALIVE_MS = 4_000;
/** The router ends a stream after 30 minutes; reconnect a little before that. */
const ROTATE_MS = 25 * 60_000;

/** After repeated failures (no credit, a network that blocks WebSockets…) stop trying for a while. */
let disabledUntil = 0;

export function liveSttAvailable(): boolean {
  return typeof WebSocket !== "undefined" && Date.now() > disabledUntil;
}

export class LiveTranscriber {
  private ws?: WebSocket;
  private queue: ArrayBuffer[] = [];
  private closed = false;
  private lastSent = 0;
  private openedAt = 0;
  private timer?: ReturnType<typeof setInterval>;
  private failures = 0;
  /** The current turn's transcript (reset when Flux starts a new turn). */
  transcript = "";
  eot = 0;
  /** True while the stream is open and healthy; turns fall back to uploads otherwise. */
  ready = false;
  onEvent?: (e: FluxEvent) => void;

  get failed() {
    return !this.ready;
  }

  start(opts: { eot?: number; eager?: number } = {}) {
    this.closed = false;
    void this.connect(opts);
    this.timer = setInterval(() => {
      if (this.closed) return;
      // Keep the stream alive between turns with a little silence.
      if (this.ws?.readyState === WebSocket.OPEN && performance.now() - this.lastSent > KEEPALIVE_MS) this.send(new Int16Array(1600).buffer);
      // Rotate before the router's session limit, between turns.
      if (this.ready && performance.now() - this.openedAt > ROTATE_MS && performance.now() - this.lastSent > 2_000) {
        this.ws?.close(1000);
        void this.connect(opts);
      }
    }, 1_000);
  }

  private async connect(opts: { eot?: number; eager?: number }) {
    if (this.closed) return;
    try {
      const { token } = await api<{ token: string }>("/voice/live/token", { body: {} });
      if (this.closed) return;
      const q = new URLSearchParams({ t: token, ...(opts.eot ? { eot: String(opts.eot) } : {}), ...(opts.eager ? { eager: String(opts.eager) } : {}) });
      const ws = new WebSocket(`${wsBase()}/api/voice/live?${q}`);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.onopen = () => {
        this.openedAt = performance.now();
        this.ready = true;
        this.failures = 0;
        for (const f of this.queue.splice(0)) this.send(f);
      };
      ws.onmessage = (m) => {
        if (typeof m.data !== "string") return;
        let j: { event?: string; type?: string; transcript?: string; end_of_turn_confidence?: number };
        try {
          j = JSON.parse(m.data);
        } catch {
          return;
        }
        if (j.type === "Error") return this.lost(ws);
        if (!j.event) return;
        if (j.event === "StartOfTurn") this.transcript = "";
        if (j.transcript) this.transcript = j.transcript;
        this.eot = j.end_of_turn_confidence ?? this.eot;
        this.onEvent?.({ event: j.event, transcript: this.transcript, eot: this.eot });
      };
      ws.onerror = () => this.lost(ws);
      ws.onclose = () => this.lost(ws);
    } catch {
      this.lost(undefined);
    }
  }

  /** The stream dropped: fall back to uploads now, reconnect shortly (and give up for a while after repeats). */
  private lost(ws: WebSocket | undefined) {
    if (ws && ws !== this.ws) return;
    const was = this.ready;
    this.ready = false;
    this.ws = undefined;
    this.transcript = "";
    if (was) this.onEvent?.({ event: "Failed", transcript: "", eot: 0 });
    if (this.closed) return;
    this.failures++;
    if (this.failures >= 3) {
      disabledUntil = Date.now() + 5 * 60_000;
      return;
    }
    setTimeout(() => void this.connect({}), 1_500 * this.failures);
  }

  private send(buf: ArrayBuffer) {
    try {
      this.ws!.send(buf);
      this.lastSent = performance.now();
    } catch {
      this.lost(this.ws);
    }
  }

  /** 16 kHz mono samples (−1…1) as PCM16. */
  push(samples: Float32Array) {
    if (this.closed) return;
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) pcm[i] = Math.max(-1, Math.min(1, samples[i])) * 0x7fff;
    if (this.ws?.readyState === WebSocket.OPEN) this.send(pcm.buffer);
    else if (this.queue.length < 250) this.queue.push(pcm.buffer); // ≤ 5 s while (re)connecting
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    const ws = this.ws;
    this.ws = undefined;
    this.ready = false;
    try {
      ws?.send(JSON.stringify({ type: "CloseStream" }));
    } catch {
      /* closing anyway */
    }
    setTimeout(() => ws?.close(1000), 200);
  }
}
