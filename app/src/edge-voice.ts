/**
 * Edge voice: speech recognition and synthesis on the user's own device, so a voice conversation
 * costs the network nothing.
 *
 * The approach is the one Spotify used to start songs instantly without paying for every byte:
 * serve the first moments from the fastest source, and move to the free source as soon as it is
 * ready. Here the fast source is Cloudflare (Whisper, Aura) and the free one is the device:
 *
 *   1. The first time voice is used, the device starts fetching its own models in the background
 *      (Whisper for listening, Kokoro for an HD English voice), once, from a CDN; they stay cached.
 *   2. Until they are ready the conversation runs on Cloudflare, so it starts with zero wait.
 *   3. From then on, recognition and speech run locally: no upload, no per-minute cost, and the
 *      audio never leaves the device. Speech changes engine only between conversations, never in
 *      the middle of one.
 *   4. Languages Kokoro does not speak use the device's own voices when they are good enough, and
 *      Cloudflare (within the daily allowance) when they are not.
 *
 * Settings: "auto" (the above), "free" (never use Cloudflare once local engines are ready; until
 * then device voices only), "hd" (always Cloudflare).
 */

export type VoicePref = "auto" | "free" | "hd";
const PREF_KEY = "dsi_voice_engine";

export function voicePref(): VoicePref {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === "free" || v === "hd" ? v : "auto";
  } catch {
    return "auto";
  }
}
export function setVoicePref(p: VoicePref) {
  try {
    localStorage.setItem(PREF_KEY, p);
  } catch {
    /* private mode */
  }
  emit();
}

// ---------------------------------------------------------------- status

export type LoadState = "idle" | "loading" | "ready" | "failed" | "unsupported";
export interface EdgeStatus {
  listen: { state: LoadState; progress: number; model?: string };
  speak: { state: LoadState; progress: number };
}
const status: EdgeStatus = { listen: { state: "idle", progress: 0 }, speak: { state: "idle", progress: 0 } };
const listeners = new Set<(s: EdgeStatus) => void>();
function emit() {
  for (const l of listeners) l({ listen: { ...status.listen }, speak: { ...status.speak } });
}
export function onEdgeStatus(fn: (s: EdgeStatus) => void): () => void {
  listeners.add(fn);
  fn({ listen: { ...status.listen }, speak: { ...status.speak } });
  return () => listeners.delete(fn);
}
export function edgeStatus(): EdgeStatus {
  return { listen: { ...status.listen }, speak: { ...status.speak } };
}

/** Download progress across a model's files. */
function progressTracker(set: (p: number) => void) {
  const files = new Map<string, { loaded: number; total: number }>();
  return (e: { status?: string; file?: string; loaded?: number; total?: number }) => {
    if (!e.file || (e.status !== "progress" && e.status !== "done")) return;
    const f = files.get(e.file) ?? { loaded: 0, total: 0 };
    if (e.total) f.total = e.total;
    f.loaded = e.status === "done" ? f.total || f.loaded : (e.loaded ?? f.loaded);
    files.set(e.file, f);
    let l = 0;
    let t = 0;
    for (const x of files.values()) (l += x.loaded), (t += x.total);
    set(t ? Math.min(0.99, l / t) : 0);
  };
}

/** Big model downloads only where they make sense: enough memory, no data saver. */
function deviceCanHost(): boolean {
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  if (nav.connection?.saveData) return false;
  if (nav.deviceMemory !== undefined && nav.deviceMemory < 4) return false;
  return typeof WebAssembly === "object";
}

const hasWebGpu = () => typeof navigator !== "undefined" && "gpu" in navigator;

// ---------------------------------------------------------------- listening (Whisper on device)

const TRANSFORMERS = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0";

type Asr = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string } | Array<{ text: string }>>;
let asr: Asr | undefined;
let asrLoading: Promise<void> | undefined;

/** Languages local Whisper (base/tiny) handles well; others go to Cloudflare's larger model. */
const LOCAL_LANGS = new Set(["en", "es", "fr", "de", "it", "pt", "nl"]);

export function warmListening(): Promise<void> {
  if (asr || asrLoading) return asrLoading ?? Promise.resolve();
  if (!deviceCanHost()) {
    status.listen.state = "unsupported";
    emit();
    return Promise.resolve();
  }
  status.listen.state = "loading";
  emit();
  asrLoading = (async () => {
    try {
      const tf = (await import(/* @vite-ignore */ TRANSFORMERS)) as { pipeline: (...a: unknown[]) => Promise<Asr>; env: { allowLocalModels: boolean } };
      tf.env.allowLocalModels = false;
      const gpu = hasWebGpu();
      const model = gpu ? "onnx-community/whisper-base" : "onnx-community/whisper-tiny";
      status.listen.model = model;
      const onProgress = progressTracker((p) => ((status.listen.progress = p), emit()));
      const load = (device: string) =>
        tf.pipeline("automatic-speech-recognition", model, {
          device,
          dtype: device === "webgpu" ? { encoder_model: "fp32", decoder_model_merged: "q4" } : "q8",
          progress_callback: onProgress,
        });
      asr = gpu ? await load("webgpu").catch(() => load("wasm")) : await load("wasm");
      status.listen.state = "ready";
      status.listen.progress = 1;
    } catch {
      status.listen.state = "failed";
    }
    emit();
  })();
  return asrLoading;
}

/** 16-bit PCM WAV (as LiveVoice produces) to samples, without an AudioContext. */
async function wavSamples(wav: Blob): Promise<{ samples: Float32Array; rate: number } | undefined> {
  const buf = await wav.arrayBuffer();
  const v = new DataView(buf);
  if (buf.byteLength < 44 || v.getUint32(0, false) !== 0x52494646 || v.getUint16(34, true) !== 16 || v.getUint16(22, true) !== 1) return undefined;
  const rate = v.getUint32(24, true);
  // Find the "data" chunk (usually at 36).
  let o = 12;
  while (o + 8 <= buf.byteLength && v.getUint32(o, false) !== 0x64617461) o += 8 + v.getUint32(o + 4, true);
  if (o + 8 > buf.byteLength) return undefined;
  const n = Math.min(v.getUint32(o + 4, true), buf.byteLength - o - 8) >> 1;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = v.getInt16(o + 8 + i * 2, true) / 0x8000;
  return { samples, rate };
}

/**
 * Transcribe on the device when the local model is ready and fits the language; otherwise
 * undefined (the caller uses Cloudflare) and the local model keeps loading in the background.
 */
export async function transcribeOnDevice(wav: Blob, language?: string): Promise<{ text: string; language: string | null; confidence: null } | undefined> {
  const pref = voicePref();
  if (pref === "hd") return undefined;
  if (!asr) {
    void warmListening();
    return undefined;
  }
  const lang = language?.slice(0, 2).toLowerCase();
  // An unpinned conversation may be in any language: local Whisper only when it is one it knows well.
  if (lang && !LOCAL_LANGS.has(lang) && pref !== "free") return undefined;
  const pcm = await wavSamples(wav);
  if (!pcm || pcm.rate !== 16_000) return undefined;
  const out = await asr(pcm.samples, { ...(lang ? { language: lang } : {}), task: "transcribe" });
  const text = ((Array.isArray(out) ? out[0] : out).text ?? "").trim();
  if (lang) return { text, language: lang, confidence: null };
  // The pipeline does not report Whisper's language, so read it from the words. Anything outside
  // the languages the small model knows well (another script, or no clear match) goes to Cloudflare.
  if (/[^\p{Script=Latin}\p{N}\p{P}\p{Z}\p{S}]/u.test(text) && pref !== "free") return undefined;
  const guess = guessLanguage(text);
  // A real sentence that matches none of them (Slovenian, Turkish…): Cloudflare's large model does it better.
  if (!guess && text.split(/\s+/).length >= 4 && pref !== "free") return undefined;
  return { text, language: guess, confidence: null };
}

const STOPWORDS: Record<string, string[]> = {
  en: ["the", "is", "and", "what", "how", "you", "of", "to", "a", "it", "in", "that", "can", "i", "my", "are", "do", "with", "this"],
  es: ["el", "la", "que", "de", "y", "es", "en", "los", "por", "un", "una", "como", "qué", "para", "mi", "me", "cómo"],
  fr: ["le", "la", "les", "est", "et", "que", "de", "un", "une", "je", "vous", "pour", "dans", "comment", "quoi", "pas", "c'est"],
  de: ["der", "die", "das", "und", "ist", "ich", "nicht", "ein", "eine", "wie", "was", "zu", "mit", "mir", "du", "sie", "es"],
  it: ["il", "la", "che", "di", "e", "è", "un", "una", "per", "non", "come", "cosa", "sono", "mi", "con", "del", "della"],
  pt: ["o", "a", "que", "de", "e", "é", "um", "uma", "para", "não", "como", "eu", "você", "com", "do", "da", "em"],
  nl: ["de", "het", "een", "en", "is", "van", "ik", "je", "niet", "wat", "hoe", "dat", "met", "voor", "op", "zijn"],
};

/** Language of a transcript among the local languages, or null when it is too short or unclear. */
export function guessLanguage(text: string): string | null {
  const words = text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  if (words.length < 3) return null;
  const scores = Object.entries(STOPWORDS).map(([l, list]) => [l, words.filter((w) => list.includes(w)).length] as const).sort((a, b) => b[1] - a[1]);
  const [best, second] = scores;
  return best[1] >= 2 && best[1] > second[1] ? best[0] : null;
}

// ---------------------------------------------------------------- speaking (Kokoro on device)

const KOKORO = "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js";
type Kokoro = { generate: (text: string, o: { voice: string; speed?: number }) => Promise<{ audio: Float32Array; sampling_rate: number }> };
let kokoro: Kokoro | undefined;
let kokoroLoading: Promise<void> | undefined;
/** Kokoro becomes the voice only from the next conversation, so a reply never changes voice midway. */
let kokoroLive = false;

export function warmSpeaking(): Promise<void> {
  if (kokoro || kokoroLoading) return kokoroLoading ?? Promise.resolve();
  if (!deviceCanHost()) {
    status.speak.state = "unsupported";
    emit();
    return Promise.resolve();
  }
  status.speak.state = "loading";
  emit();
  kokoroLoading = (async () => {
    try {
      const k = (await import(/* @vite-ignore */ KOKORO)) as { KokoroTTS: { from_pretrained: (id: string, o: Record<string, unknown>) => Promise<Kokoro> } };
      const onProgress = progressTracker((p) => ((status.speak.progress = p), emit()));
      const load = (device: string) => k.KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: device === "webgpu" ? "fp32" : "q8", device, progress_callback: onProgress });
      kokoro = hasWebGpu() ? await load("webgpu").catch(() => load("wasm")) : await load("wasm");
      status.speak.state = "ready";
      status.speak.progress = 1;
    } catch {
      status.speak.state = "failed";
    }
    emit();
  })();
  return kokoroLoading;
}

/** Engine chosen per language for the current conversation, so the voice never changes midway. */
const chosen = new Map<string, "kokoro" | "device" | "cloud">();

/** Chrome fills the voice list asynchronously; wait briefly the first time. */
async function voicesReady(): Promise<void> {
  if (typeof speechSynthesis === "undefined" || speechSynthesis.getVoices().length) return;
  await new Promise<void>((r) => {
    const t = setTimeout(r, 400);
    speechSynthesis.addEventListener("voiceschanged", () => (clearTimeout(t), r()), { once: true });
  });
}

/** Call when a voice conversation starts: fetch what is missing, and switch to what is ready. */
export function startConversation() {
  kokoroLive = !!kokoro;
  chosen.clear();
  void voicesReady();
  if (voicePref() !== "hd") {
    void warmListening();
    void warmSpeaking();
  }
}

/** Device voices good enough to replace a hosted one (system neural / premium voices). */
const GOOD_VOICE = /natural|neural|premium|enhanced|siri|google|online|wavenet|microsoft .* online/i;

export function deviceVoice(lang: string, requireGood: boolean): SpeechSynthesisVoice | undefined {
  if (typeof speechSynthesis === "undefined") return undefined;
  const l = lang.toLowerCase();
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().replace("_", "-").startsWith(l));
  const good = voices.find((v) => GOOD_VOICE.test(v.name));
  return good ?? (requireGood ? undefined : voices.find((v) => v.localService) ?? voices[0]);
}

export type EdgeClip = { kind: "pcm"; samples: Float32Array; rate: number } | { kind: "device" };

/**
 * Speech on the device for one sentence, or undefined to use Cloudflare.
 * English: Kokoro HD voice when loaded. Others: the system's own voice, if it is a good one
 * ("auto") or any voice at all ("free").
 */
export async function speakOnDevice(text: string, lang: string): Promise<EdgeClip | undefined> {
  const pref = voicePref();
  if (pref === "hd") return undefined;
  const l = lang.slice(0, 2).toLowerCase();
  let engine = chosen.get(l);
  if (!engine) {
    await voicesReady();
    engine = l === "en" && kokoro && kokoroLive ? "kokoro" : deviceVoice(l, pref !== "free") ? "device" : "cloud";
    chosen.set(l, engine);
  }
  if (engine === "kokoro") {
    try {
      const a = await kokoro!.generate(text, { voice: "af_heart" });
      return { kind: "pcm", samples: a.audio, rate: a.sampling_rate };
    } catch {
      return deviceVoice(l, false) ? { kind: "device" } : undefined;
    }
  }
  return engine === "device" ? { kind: "device" } : undefined;
}

/** What a conversation is costing the network right now, for the UI. */
export function costLabel(): string {
  if (voicePref() === "hd") return "HD voice on Cloudflare (uses your daily voice allowance)";
  const l = status.listen.state;
  const s = status.speak.state;
  if (l === "loading" || s === "loading") {
    const p = Math.round(((status.listen.progress + status.speak.progress) / 2) * 100);
    return `Getting your device ready for free voice (${p}%), using Cloudflare meanwhile`;
  }
  if (l === "ready") return "Free: listening and speaking on this device";
  return "Using Cloudflare voice (this device can't run the free on-device voice)";
}
