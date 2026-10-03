import { useCallback, useEffect, useRef, useState } from "react";
import { LiveTranscriber, liveSttAvailable } from "./flux";
import { drawFace, FACES } from "./orb-faces";
import { onWallet, recordTaught, refreshWallet, type WalletTotals } from "./browser-wallet";
import { costLabel, onEdgeStatus, setVoicePref, startConversation, voicePref, type VoicePref } from "./edge-voice";
import { checkedArithmetic, EMOTION_EMOJI, EmotionTag, isPhantom, LearnTag, LivePlayer, LiveVoice, teach, transcribeWav, voiceSystemPrompt, type Emotion, type TeachResult, type Tone } from "./live";
import { SentenceSplitter } from "./voice";
import { areasText, earnOptedIn, loadGuide, profileAreas, setEarnOptIn, teachPrompt, type Area, type GuideSection } from "./earn";

/** Sends one spoken turn through the chat (so it is saved with the conversation) and streams the reply. */
export type VoiceAsk = (text: string, o: { system: string; filter: (d: string) => string; onVisible: (d: string) => void; replaces?: boolean }) => Promise<void>;

type Phase = "starting" | "listening" | "hearing" | "transcribing" | "thinking" | "speaking";

const COLORS: Record<Emotion | "listening" | "hearing" | "thinking", string> = {
  listening: "#4da3ff",
  hearing: "#7fd6ff",
  thinking: "#9b7bff",
  neutral: "#4da3ff",
  warm: "#ffb547",
  cheerful: "#ffd166",
  excited: "#ff6b8b",
  calm: "#3ddbd9",
  empathetic: "#f497c2",
  serious: "#7b8cff",
  curious: "#5ce1e6",
};

/**
 * A turn that sounds unfinished ("Remember this:", "and…", "because"), cut by a pause mid-thought.
 * It is held briefly and joined with what the user says next instead of being answered on its own.
 */
const UNFINISHED = /(?:[,:;–—-]|\.\.\.|…|\b(?:and|but|or|so|because|then|which|that|if|when|like|um+|uh+|remember this|listen|here'?s (?:the thing|something)|you know what|guess what|the thing is))[.!]?$/i;

const TONE_LABEL: Record<Tone, string> = { neutral: "", calm: "calm", animated: "upbeat", tense: "tense", subdued: "low" };

const LANGS = ["en", "es", "fr", "de", "it", "pt", "nl", "pl", "tr", "ru", "uk", "ar", "fa", "he", "hi", "bn", "ur", "zh", "ja", "ko", "id", "vi", "th", "sw"];
const langName = (code: string) => {
  try {
    return new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
};

// ------------------------------------------------------------------ the orb

/**
 * A sphere of connected nodes, like the network. It breathes with the user's voice while listening,
 * swirls while thinking, and pulses with DSI's voice (in the colour of its mood) while speaking.
 */
function Orb({ phase, color, level, emotion }: { phase: Phase; color: string; level: () => number; emotion: Emotion }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const st = useRef({ phase, color, emotion });
  st.current = { phase, color, emotion };

  useEffect(() => {
    const cv = ref.current!;
    const g = cv.getContext("2d")!;
    const N = 160;
    const pts = Array.from({ length: N }, (_, i) => {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const t = i * Math.PI * (3 - Math.sqrt(5));
      return [Math.cos(t) * r, y, Math.sin(t) * r] as [number, number, number];
    });
    const edges: Array<[number, number]> = [];
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) if (Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1], pts[i][2] - pts[j][2]) < 0.34) edges.push([i, j]);
    let raf = 0;
    let rot = 0;
    let lvl = 0;
    let col = st.current.color;
    // The face the orb wears (see orb-faces.ts): shown while DSI speaks with feeling, briefly after.
    let shown: Emotion = "neutral";
    let faceAlpha = 0;
    let lastSpoke = 0;
    const mix = (a: string, b: string, t: number) => {
      const p = (h: string) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
      const [x, y] = [p(a), p(b)];
      return `#${x.map((v, k) => Math.round(v + (y[k] - v) * t).toString(16).padStart(2, "0")).join("")}`;
    };
    const frame = () => {
      const dpr = Math.min(2, devicePixelRatio || 1);
      const w = cv.clientWidth;
      if (cv.width !== Math.round(w * dpr)) (cv.width = Math.round(w * dpr)), (cv.height = Math.round(w * dpr));
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, w);
      const { phase: ph, color: target, emotion: em } = st.current;
      const nowS = performance.now();
      if (ph === "speaking") lastSpoke = nowS;
      const wantFace = em !== "neutral" && nowS - lastSpoke < 2500 && ph !== "hearing";
      if (em !== shown) {
        // Fade the old expression out before the new one comes in.
        faceAlpha = Math.max(0, faceAlpha - 0.08);
        if (faceAlpha <= 0.02) shown = em;
      } else faceAlpha += ((wantFace ? 1 : 0) - faceAlpha) * 0.08;
      col = mix(col, target, 0.06);
      lvl += (level() - lvl) * 0.25;
      const speed = ph === "thinking" || ph === "transcribing" ? 0.02 : ph === "speaking" ? 0.008 : 0.004;
      rot += speed + lvl * 0.01;
      const c = w / 2;
      const R = w * (0.3 + lvl * 0.08) * (ph === "starting" ? 0.85 : 1);
      // glow
      // The glow fades out inside the canvas, so no square edge shows.
      const glow = g.createRadialGradient(c, c, R * 0.2, c, c, Math.min(R * 1.65, c));
      glow.addColorStop(0, `${col}${ph === "thinking" ? "55" : "44"}`);
      glow.addColorStop(1, `${col}00`);
      g.fillStyle = glow;
      g.fillRect(0, 0, w, w);
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const tilt = 0.35;
      const t0 = performance.now() / 1000;
      const proj = pts.map(([x, y, z], i) => {
        // gentle surface waves carry the voice
        const wave = 1 + lvl * 0.18 * Math.sin(t0 * 6 + i * 0.7) + (ph === "thinking" ? 0.05 * Math.sin(t0 * 3 + y * 6) : 0);
        const X = (x * cos - z * sin) * wave;
        const Z0 = (x * sin + z * cos) * wave;
        const Y = y * wave * Math.cos(tilt) - Z0 * Math.sin(tilt);
        const Z = y * wave * Math.sin(tilt) + Z0 * Math.cos(tilt);
        return [c + X * R, c + Y * R, Z] as [number, number, number];
      });
      g.lineWidth = 1;
      for (const [a, b] of edges) {
        const z = (proj[a][2] + proj[b][2]) / 2;
        g.strokeStyle = `${col}${Math.round(20 + (z + 1) * 40).toString(16).padStart(2, "0")}`;
        g.beginPath();
        g.moveTo(proj[a][0], proj[a][1]);
        g.lineTo(proj[b][0], proj[b][1]);
        g.stroke();
      }
      for (const [x, y, z] of proj) {
        const s = 1.2 + (z + 1) * 1.3 + lvl * 1.5;
        g.fillStyle = z > 0 ? "#ffffff" : col;
        // Front nodes step back a little while the orb wears a face, so the expression reads.
        g.globalAlpha = (0.35 + (z + 1) * 0.3) * (1 - faceAlpha * (z > 0 ? 0.55 : 0.2));
        g.beginPath();
        g.arc(x, y, s, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
      drawFace(g, FACES[shown], c, R, col, faceAlpha, ph === "speaking" ? Math.min(1, lvl * 1.6) : 0, t0);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [level]);

  return <canvas ref={ref} className="vm-orb" aria-hidden="true" />;
}

// ------------------------------------------------------------------ teaching rewards

/** An amount as it should be spoken ("0.64", "12.5"). */
const spokenPai = (n: number) => (n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : n.toFixed(2));

/** The browser wallet, live: PAI pending approval, approved and paid, and this conversation's share. */
function BrowserWalletCard({ t, session }: { t: WalletTotals; session: number }) {
  return (
    <a className="vm-wallet" href="#/console/credits" aria-live="polite" title="Your browser wallet: PAI earned by teaching DSI, before it reaches your on-network wallet">
      <span className="vm-wallet-label">Browser wallet</span>
      <span className="vm-wallet-row">
        <b>{pai(t.pending)}</b> PAI pending approval
        {t.approved + t.paid > 0 && (
          <>
            {" · "}
            <b>{pai(t.approved + t.paid)}</b> approved
          </>
        )}
      </span>
      {session > 0 && <small>+{pai(session)} PAI this conversation</small>}
    </a>
  );
}

const pai = (n: number) => (n >= 100 ? n.toLocaleString("en", { maximumFractionDigits: 0 }) : n.toLocaleString("en", { maximumFractionDigits: n < 1 ? 3 : 2 }));

/** What teaching DSI earned, per the Learning Fabric: paid at once only when verified. */
function TaughtToast({ r, wallet, onDone }: { r: TeachResult; wallet?: number; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, r.outcome === "rewarded" ? 7000 : 5000);
    return () => clearTimeout(t);
  }, [r, onDone]);
  const body =
    r.outcome === "rewarded" && r.reward
      ? { big: `+${pai(r.reward.pai)} PAI`, small: r.reward.status === "deferred" ? "New knowledge verified · part paid next epoch" : "New knowledge verified and rewarded" }
      : r.outcome === "pending" || r.outcome === "verified"
        ? { big: `+${pai(r.estimate?.pai ?? r.potential_pai ?? 0)} PAI pending approval`, small: "New knowledge saved · paid when independent validators confirm it" }
        : r.outcome === "known"
          ? { big: "DSI already knew that", small: "Only new knowledge earns PAI" }
          : r.outcome === "limit"
            ? { big: "Teaching limit reached", small: r.message ?? "Limits grow as your contributions are verified" }
            : { big: "Not added", small: "It didn't pass the Learning Fabric's checks" };
  return (
    <a className={`vm-taught vm-taught-${r.outcome}`} href="#/console/credits" role="status" aria-live="polite">
      {r.outcome === "rewarded" && <span className="vm-coin" aria-hidden="true" />}
      <span>
        <b>{body.big}</b>
        <small>{body.small}</small>
        {wallet !== undefined && <small className="vm-bal">Wallet: {pai(wallet)} PAI</small>}
      </span>
    </a>
  );
}

// ------------------------------------------------------------------ voice mode

export function VoiceMode({ live, started, ask, stop, onClose, onType }: { live: LiveVoice; started: Promise<void>; ask: VoiceAsk; stop: () => void; onClose: () => void; onType: () => void }) {
  const [phase, setPhase] = useState<Phase>("starting");
  const [you, setYou] = useState("");
  const [dsi, setDsi] = useState("");
  const [tone, setTone] = useState<Tone>("neutral");
  const [emotion, setEmotion] = useState<Emotion>("neutral");
  const [lang, setLang] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [err, setErr] = useState<string>();
  const [picker, setPicker] = useState(false);
  const [needTap, setNeedTap] = useState(false);
  /** What teaching earned: shown as a toast, with the PAI balance. */
  const [taught, setTaught] = useState<{ r: TeachResult; at: number }>();
  const [wallet, setWallet] = useState<number>();
  // Earn PAI: teaching mode, opt-in (earn.ts). Off at the start of every conversation.
  const [earnOn, setEarnOn] = useState(false);
  const [earned, setEarned] = useState(0);
  /** Browser wallet, live (browser-wallet.ts), and what this conversation added to it. */
  const [wt, setWt] = useState<WalletTotals>();
  const [sessionPai, setSessionPai] = useState(0);
  useEffect(() => {
    const off = onWallet(setWt);
    void refreshWallet().catch(() => {});
    return off;
  }, []);
  const [onboard, setOnboard] = useState<{ guide: GuideSection[]; areas: Area[]; reading: boolean }>();
  const [spoken, setSpoken] = useState("");
  const earnRef = useRef<{ on: boolean; areas: Area[] }>({ on: false, areas: [] });
  /** Which engines carry the conversation: free on-device, or Cloudflare (see edge-voice.ts). */
  const [pref, setPref] = useState<VoicePref>(voicePref);
  const [, setEdgeTick] = useState(0);
  useEffect(() => onEdgeStatus(() => setEdgeTick((n) => n + 1)), []);
  useEffect(() => startConversation(), []);

  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const toneRef = useRef<Tone>("neutral");
  toneRef.current = tone;
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  const langRef = useRef(lang);
  langRef.current = lang;
  const turn = useRef(0);
  const inLevel = useRef(0);
  const player = useRef<LivePlayer>(undefined as unknown as LivePlayer);
  if (!player.current) player.current = new LivePlayer(live);

  const level = useCallback(() => (phaseRef.current === "speaking" ? live.outputLevel() : inLevel.current), [live]);

  /** What teaching earned in this conversation (for the closing message). */
  const session = useRef({ count: 0, pai: 0 });
  const [farewell, setFarewell] = useState<{ count: number; pai: number }>();
  const farewellSaid = useRef(false);

  const close = useCallback(() => {
    // A conversation that earned PAI ends with DSI saying where to find it.
    if (session.current.count && !farewellSaid.current) {
      farewellSaid.current = true;
      const { count, pai: amount } = session.current;
      turn.current++;
      stop();
      live.muted = true;
      const p = player.current;
      p.stop();
      setFarewell({ count, pai: amount });
      setPhase("speaking");
      const things = count === 1 ? "one new thing" : `${count} new things`;
      p.say(
        `Thanks for teaching me ${things} today. That's ${spokenPai(amount)} PAI, pending approval in your browser wallet. To see your PAI tokens, create your wallet in Decentralised.si and log in.`,
        "en",
        "warm",
      );
      void p.whenIdle().then(() => setPhase("listening"));
      return;
    }
    turn.current++;
    player.current.stop();
    stop();
    live.stop();
    onClose();
  }, [live, stop, onClose]);

  useEffect(() => {
    let alive = true;
    const p = player.current;
    let lock: { release(): Promise<void> } | undefined;
    // Keep the screen on while talking.
    (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock
      ?.request("screen")
      .then((l) => (lock = l))
      .catch(() => {});

    const interrupt = () => {
      turn.current++;
      p.stop();
      stop();
      setDsi("");
    };
    live.onLevel = (l) => (inLevel.current = l);
    // Transcription starts at the first pause; if the user carries on, that early result is dropped.
    let early: { id: number; p: Promise<{ text: string; language: string | null; confidence: number | null }>; ac: AbortController } | undefined;
    live.onTentative = (u) => {
      // The live transcript is already arriving: no upload needed.
      if (liveOn()) return;
      early?.ac.abort();
      const ac = new AbortController();
      early = { id: u.id, p: transcribeWav(u.wav, pinnedRef.current ?? undefined, ac.signal), ac };
      early.p.catch(() => {});
    };
    live.onResume = () => {
      early?.ac.abort();
      early = undefined;
    };
    // Live transcription (Flux, English): the transcript arrives while the user speaks, and the reply
    // starts the moment the turn ends, with no upload and no separate transcription.
    // English only (Flux). Before the conversation's language is known, go by the browser's language.
    const liveOk = () => liveSttAvailable() && (pinnedRef.current ?? langRef.current ?? (navigator.language || "en").slice(0, 2).toLowerCase()) === "en";
    // One stream for the whole conversation, opened now: no connection set-up inside a turn.
    const stt: LiveTranscriber | undefined = liveOk() ? new LiveTranscriber() : undefined;
    const liveOn = () => !!stt && stt.ready && liveOk();
    let uttNo = 0;
    let answered = 0;
    const finished = (text: string, eot: number) => /[.?!]["')]?$/.test(text.trim()) && eot >= 0.45;
    const answerLive = (text: string, seconds: number, tone: Tone) => {
      answered = uttNo;
      void afterTranscript({ text, language: "en", confidence: null }, seconds, tone, ++turn.current);
    };
    live.onFrames = (f) => {
      if (!stt || !liveOk()) return;
      stt.push(f);
      // A complete sentence and a short pause: answer now, before any end-of-turn timer.
      if (liveOn() && stt.transcript && answered !== uttNo && live.quietMs >= 350 && finished(stt.transcript, stt.eot)) answerLive(stt.transcript, 1, toneRef.current);
    };
    if (stt) {
      stt.onEvent = (e) => {
        if (!liveOk()) return;
        if (e.transcript && (e.event === "Update" || e.event === "StartOfTurn") && answered !== uttNo) setYou(e.transcript);
        if (e.event === "EndOfTurn" && e.transcript && answered !== uttNo) answerLive(e.transcript, 1, toneRef.current);
      };
      stt.start({ eot: 0.65, eager: 0.4 });
    }
    live.onSpeechStart = () => {
      // The user carried on before DSI's reply was heard: drop that reply and treat both parts as one turn.
      if (unheard && phaseRef.current === "thinking" && Date.now() - unheard.at < 4000) merge = unheard.text;
      unheard = undefined;
      if (["speaking", "thinking", "transcribing"].includes(phaseRef.current)) interrupt();
      setPhase("hearing");
      uttNo++;
      // Flux starts its own turn a moment later; until then, don't reuse the previous transcript.
      if (stt) stt.transcript = "";
    };
    type Heard = { text: string; language: string | null; tone: Tone; replaces?: boolean };
    /** A reply on its way but not yet audible, and the text to merge into the next turn if the user carries on. */
    let unheard: { text: string; at: number } | undefined;
    let merge: string | undefined;
    type Held = Heard & { at: number; timer?: ReturnType<typeof setTimeout> };
    const hold: { v?: Held } = {};

    /** Answer one complete turn: stream the reply, speak it, and offer anything taught to the fabric. */
    const respond = async (h: Heard, my: number) => {
      // Whisper can misjudge the language of a few words; keep the conversation's language unless
      // this turn is long enough to be sure (or the user pinned one).
      const language = pinnedRef.current ?? (h.language && (h.text.length >= 12 || !langRef.current) ? h.language : langRef.current ?? h.language);
      setLang(language);
      setYou(h.text);
      setTone(h.tone);
      setDsi("");
      setPhase("thinking");
      const tag = new EmotionTag();
      const learn = new LearnTag();
      const split = new SentenceSplitter(true);
      const speakLang = language ?? "en";
      unheard = { text: h.text, at: Date.now() };
      try {
        await ask(h.text, {
          replaces: h.replaces,
          system: voiceSystemPrompt({ language, tone: h.tone, checked: checkedArithmetic(h.text), earn: earnRef.current.on ? { areas: earnRef.current.areas.map((a) => a.label) } : undefined }),
          filter: (d) => learn.push(tag.push(d)),
          onVisible: (d) => {
            if (my !== turn.current) return;
            setEmotion(tag.emotion);
            split.push(d).forEach((s) => p.say(s, speakLang, tag.emotion));
          },
        });
      } catch (e) {
        if (my === turn.current) setErr((e as Error).message);
      }
      if (my !== turn.current) return;
      const tail = learn.flush();
      if (tail) split.push(tail).forEach((s) => p.say(s, speakLang, tag.emotion));
      split.flush().forEach((s) => p.say(s, speakLang, tag.emotion));
      // The user taught something: offer it to the Learning Fabric while DSI is talking.
      if (learn.learned && earnRef.current.on)
        teach(learn.learned, h.text)
          .then((t) => {
            if (t.balance !== undefined) setWallet(t.balance);
            // The browser wallet shows every taught item and its exact PAI, live.
            if (t.id && t.estimate && ["rewarded", "pending", "verified"].includes(t.outcome)) {
              recordTaught({ id: t.id, statement: learn.learned!, pai: t.estimate.pai, status: t.estimate.status });
              session.current = { count: session.current.count + 1, pai: session.current.pai + t.estimate.pai };
              setSessionPai(session.current.pai);
            }
            if (t.outcome === "rewarded" && t.reward) setEarned((x) => x + t.reward!.pai);
            if (t.outcome === "private") return;
            setTaught({ r: t, at: Date.now() });
            if (t.outcome === "rewarded") live.chime("reward");
            else if (t.outcome === "pending" || t.outcome === "verified") live.chime("saved");
          })
          .catch(() => {});
      await p.whenIdle();
      if (my === turn.current) setPhase("listening");
    };

    live.onUtterance = async (u) => {
      const mine = uttNo;
      if (stt && liveOn()) {
        if (answered === mine) return;
        // The local end of speech: if the live transcript is clearly a finished sentence, answer now;
        // otherwise give the transcriber a moment to call the end of the turn.
        const done = () => answered === mine || !liveOn() || uttNo !== mine;
        if (!(stt.transcript && finished(stt.transcript, stt.eot))) {
          for (let w = 0; w < 14 && !done(); w++) await new Promise((r) => setTimeout(r, 50));
        }
        if (answered === mine || uttNo !== mine) return;
        if (liveOn() && stt.transcript) return answerLive(stt.transcript, u.seconds, u.tone);
      }
      const my = ++turn.current;
      setPhase("transcribing");
      setErr(undefined);
      let r: { text: string; language: string | null; confidence: number | null };
      try {
        const head = early && early.id === u.id ? early : undefined;
        early = undefined;
        r = head ? await head.p.catch(() => transcribeWav(u.wav, pinnedRef.current ?? undefined)) : await transcribeWav(u.wav, pinnedRef.current ?? undefined);
      } catch (e) {
        if (my === turn.current) setErr((e as Error).message), setPhase("listening");
        return;
      }
      if (my !== turn.current) return;
      await afterTranscript(r, u.seconds, u.tone, my);
    };

    /** A transcript for one turn: drop noise, join a thought the user paused in, then answer. */
    const afterTranscript = async (r: { text: string; language: string | null; confidence: number | null }, seconds: number, tone: Tone, my: number) => {
      // Background noise the recogniser doubts is ignored, not answered.
      if (!r.text || isPhantom(r.text, seconds, r.confidence)) return setPhase("listening");
      let h: Heard = { text: r.text, language: r.language, tone };
      if (merge) {
        h = { ...h, text: `${merge} ${h.text}`, replaces: true };
        merge = undefined;
      }
      // Join the unfinished start of this thought, if the user just paused mid-sentence.
      const prev = hold.v;
      if (prev && Date.now() - prev.at < 4000) {
        clearTimeout(prev.timer);
        h = { ...h, text: `${prev.text} ${h.text}` };
      }
      hold.v = undefined;
      if (UNFINISHED.test(h.text.trim())) {
        const pending: Held = { ...h, at: Date.now() };
        hold.v = pending;
        setYou(h.text);
        setPhase("listening");
        // Nothing more within a second: it was complete after all.
        pending.timer = setTimeout(() => {
          if (hold.v !== pending) return;
          hold.v = undefined;
          void respond(pending, ++turn.current);
        }, 1100);
        return;
      }
      await respond(h, my);
    };
    p.onStart = () => {
      unheard = undefined;
      setPhase("speaking");
    };
    // Speech that is not a reply (the Earn PAI guide) also returns to listening when it ends.
    p.onIdle = () => setPhase((ph) => (ph === "speaking" ? "listening" : ph));
    p.onSentence = (t) => (setDsi(t), setSpoken(t));
    p.onError = (e) => setErr(e.message);

    started
      .then(() => {
        if (!alive) return;
        if (live.ctx?.state !== "running") setNeedTap(true);
        setPhase("listening");
      })
      .catch((e: Error) => {
        if (!alive) return;
        setErr(e.name === "NotAllowedError" ? "Microphone access is blocked. Allow it for decentralised.si in your browser settings, then try again." : `Microphone unavailable: ${e.message}`);
      });
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    addEventListener("keydown", key);
    return () => {
      alive = false;
      removeEventListener("keydown", key);
      lock?.release().catch(() => {});
      // Leaving the chat (or the page) ends the conversation too.
      turn.current++;
      p.stop();
      stt?.close();
      live.onFrames = undefined;
      live.stop();
    };
  }, [live, started, ask, stop, close]);

  useEffect(() => {
    live.muted = muted;
  }, [live, muted]);

  /** The Earn PAI button: first time, the guide (read aloud) and the opt-in; afterwards, on/off. */
  const earnClick = async () => {
    if (earnOn) {
      earnRef.current.on = false;
      setEarnOn(false);
      return;
    }
    const areas = await profileAreas().catch(() => [] as Area[]);
    earnRef.current.areas = areas;
    if (earnOptedIn()) return startEarning(areas, false);
    const guide = await loadGuide().catch(() => [] as GuideSection[]);
    setOnboard({ guide, areas, reading: true });
    // Read the guide aloud, sentence by sentence, then the person's own areas.
    const p = player.current;
    p.stop();
    turn.current++;
    const say = (text: string) => {
      const split = new SentenceSplitter();
      [...split.push(text), ...split.flush()].forEach((x) => p.say(x, "en", "warm"));
    };
    for (const sec of guide) {
      say(`${sec.title}.`);
      sec.paragraphs.forEach(say);
    }
    say(`Your best areas. ${areasText(areas)}`);
    say("When you're ready, tap Turn on Earn PAI.");
    await p.whenIdle();
    setOnboard((o) => o && { ...o, reading: false });
  };
  const startEarning = (areas: Area[], first: boolean) => {
    setEarnOptIn(true);
    earnRef.current = { on: true, areas };
    setEarnOn(true);
    setOnboard(undefined);
    const p = player.current;
    p.stop();
    const a = areas[0];
    const line = a ? `Earn PAI is on. Tell me ${teachPrompt(a.domain)}, about ${a.label}.` : "Earn PAI is on. Tell me something from your own experience that AI tends to get wrong.";
    p.say(first ? `Thank you. ${line}` : line, langRef.current ?? "en", "warm");
  };

  const color = phase === "speaking" ? COLORS[emotion] : phase === "hearing" ? COLORS.hearing : phase === "thinking" || phase === "transcribing" ? COLORS.thinking : COLORS.listening;
  const status = muted
    ? "Microphone off"
    : { starting: "Starting…", listening: "Listening", hearing: "Listening…", transcribing: "Got it", thinking: "Thinking", speaking: "Speaking · talk anytime to interrupt" }[phase];

  return (
    <div className={`vm vm-${phase}`} role="dialog" aria-modal="true" aria-label="Voice conversation" style={{ "--vm": color } as React.CSSProperties}>
      <div className="vm-top">
        <button type="button" className="vm-chip" onClick={() => setPicker((v) => !v)} aria-expanded={picker} title="Language">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
          </svg>
          <span>{pinned ? langName(pinned) : lang ? `Auto · ${langName(lang)}` : "Any language"}</span>
        </button>
        <button type="button" className={`vm-chip vm-earn ${earnOn ? "on" : ""}`} onClick={earnClick} aria-pressed={earnOn} title={earnOn ? "Teaching mode is on: tap to turn off" : "Teach DSI what it doesn't know and earn PAI"}>
          <span className="vm-earn-coin" aria-hidden="true" />
          <span>{earnOn ? (earned ? `Earning · +${earned.toFixed(3)} PAI` : "Earning PAI") : "Earn PAI"}</span>
        </button>
      </div>

      {picker && (
        <div className="vm-langs" role="listbox" aria-label="Conversation language">
          <button type="button" role="option" aria-selected={!pinned} onClick={() => (setPinned(null), setPicker(false))}>
            Detect automatically
          </button>
          {LANGS.map((l) => (
            <button key={l} type="button" role="option" aria-selected={pinned === l} onClick={() => (setPinned(l), setLang(l), setPicker(false))}>
              {langName(l)}
            </button>
          ))}
        </div>
      )}

      <div className="vm-stage" onClick={() => needTap && live.ctx?.resume().then(() => setNeedTap(false))}>
        <Orb phase={phase} color={color} level={level} emotion={emotion} />
        {/* A new element per status: Safari could leave the previous text painted underneath. */}
        <p key={needTap ? "tap" : status} className="vm-status" aria-live="polite">
          {needTap ? "Tap to start" : status}
        </p>
        {TONE_LABEL[tone] && (
          <p className="vm-tone" title="Read from your tone of voice on this device">
            you sound {TONE_LABEL[tone]}
          </p>
        )}
        {wt && (earnOn || wt.items.length > 0) && <BrowserWalletCard t={wt} session={sessionPai} />}
        {taught && <TaughtToast key={taught.at} r={taught.r} wallet={wallet} onDone={() => setTaught(undefined)} />}
        {farewell && (
          <div className="vm-farewell" role="dialog" aria-label="Your PAI">
            <b>
              {pai(farewell.pai)} PAI pending approval
            </b>
            <p>
              You taught DSI {farewell.count === 1 ? "one new thing" : `${farewell.count} new things`}. To see your PAI tokens, create your wallet in Decentralised.si and log in.
            </p>
            <div className="vm-farewell-actions">
              <a className="vm-optin" href="#/console/credits" onClick={() => close()}>
                Create wallet &amp; log in
              </a>
              <button type="button" className="vm-later" onClick={close}>
                Done
              </button>
            </div>
          </div>
        )}
        <div className="vm-captions">
          {you && (
            <p className="vm-you" dir="auto">
              “{you}”
            </p>
          )}
          {dsi && (
            <p key={dsi} className="vm-dsi" lang={lang ?? undefined} dir="auto">
              {EMOTION_EMOJI[emotion] && (
                <span key={emotion} className="vm-emoji" role="img" aria-label={emotion}>
                  {EMOTION_EMOJI[emotion]}
                </span>
              )}
              {dsi}
            </p>
          )}
          {err && <p className="vm-err">{err}</p>}
        </div>
      </div>

      {onboard && (
        <div className="vm-sheet" role="dialog" aria-label="Earn PAI">
          <div className="vm-sheet-body">
            {onboard.guide.map((sec) => (
              <section key={sec.title}>
                <h3>{sec.title}</h3>
                {sec.paragraphs.map((x) => (
                  <p
                    key={x}
                    className={spoken && x.includes(spoken.slice(0, 40)) ? "now" : undefined}
                    // Follow the reading: keep the paragraph being spoken in view.
                    ref={(el) => {
                      if (el?.classList.contains("now")) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
                    }}
                  >
                    {x}
                  </p>
                ))}
              </section>
            ))}
            <section>
              <h3>Your best areas</h3>
              {onboard.areas.length ? (
                <ul>
                  {onboard.areas.map((a) => (
                    <li key={a.domain}>
                      <b>{a.label}</b>
                      {a.gap && <span className="vm-gap">network gap</span>}
                      <small>Try {teachPrompt(a.domain)}.</small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>We'll learn your areas as we talk.</p>
              )}
              <p className="vm-fine">Worked out on this device from your own chats; they never leave it for this.</p>
            </section>
          </div>
          <div className="vm-sheet-actions">
            <button type="button" className="vm-optin" onClick={() => startEarning(onboard.areas, true)}>
              Turn on Earn PAI
            </button>
            <button type="button" className="vm-later" onClick={() => (player.current.stop(), setOnboard(undefined))}>
              {onboard.reading ? "Stop and close" : "Not now"}
            </button>
          </div>
        </div>
      )}

      <div className="vm-bar">
        <button type="button" className={`vm-btn ${muted ? "off" : ""}`} onClick={() => setMuted((m) => !m)} aria-pressed={muted} aria-label={muted ? "Turn microphone on" : "Mute microphone"}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
            {muted && <path d="M4 4l16 16" />}
          </svg>
        </button>
        <button type="button" className="vm-btn" onClick={() => (close(), onType())} aria-label="Type instead">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="6" width="18" height="12" rx="2" />
            <path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" />
          </svg>
        </button>
        <button type="button" className="vm-btn vm-end" onClick={close} aria-label="End voice conversation">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <p className="vm-fine">
        Interrupt anytime just by talking · {costLabel()} · audio is never stored{" "}
        <button
          type="button"
          className="vm-engine"
          title="Auto: free on this device once ready, Cloudflare meanwhile. Free: device only. HD: always Cloudflare."
          onClick={() => {
            const next: VoicePref = pref === "auto" ? "free" : pref === "free" ? "hd" : "auto";
            setVoicePref(next);
            setPref(next);
          }}
        >
          Voice: {pref === "auto" ? "Auto" : pref === "free" ? "Free" : "HD"}
        </button>
      </p>
    </div>
  );
}
