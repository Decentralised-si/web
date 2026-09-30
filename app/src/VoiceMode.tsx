import { useCallback, useEffect, useRef, useState } from "react";
import { EmotionTag, isPhantom, LivePlayer, LiveVoice, transcribeWav, voiceSystemPrompt, type Emotion, type Tone } from "./live";
import { SentenceSplitter } from "./voice";

/** Sends one spoken turn through the chat (so it is saved with the conversation) and streams the reply. */
export type VoiceAsk = (text: string, o: { system: string; filter: (d: string) => string; onVisible: (d: string) => void }) => Promise<void>;

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
function Orb({ phase, color, level }: { phase: Phase; color: string; level: () => number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const st = useRef({ phase, color });
  st.current = { phase, color };

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
      const { phase: ph, color: target } = st.current;
      col = mix(col, target, 0.06);
      lvl += (level() - lvl) * 0.25;
      const speed = ph === "thinking" || ph === "transcribing" ? 0.02 : ph === "speaking" ? 0.008 : 0.004;
      rot += speed + lvl * 0.01;
      const c = w / 2;
      const R = w * (0.3 + lvl * 0.08) * (ph === "starting" ? 0.85 : 1);
      // glow
      const glow = g.createRadialGradient(c, c, R * 0.2, c, c, R * 1.65);
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
        g.globalAlpha = 0.35 + (z + 1) * 0.3;
        g.beginPath();
        g.arc(x, y, s, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [level]);

  return <canvas ref={ref} className="vm-orb" aria-hidden="true" />;
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

  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  const langRef = useRef(lang);
  langRef.current = lang;
  const turn = useRef(0);
  const inLevel = useRef(0);
  const player = useRef<LivePlayer>(undefined as unknown as LivePlayer);
  if (!player.current) player.current = new LivePlayer(live);

  const level = useCallback(() => (phaseRef.current === "speaking" ? live.outputLevel() : inLevel.current), [live]);

  const close = useCallback(() => {
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
    live.onSpeechStart = () => {
      if (["speaking", "thinking", "transcribing"].includes(phaseRef.current)) interrupt();
      setPhase("hearing");
    };
    live.onUtterance = async (u) => {
      const my = ++turn.current;
      setPhase("transcribing");
      setErr(undefined);
      let r: { text: string; language: string | null };
      try {
        r = await transcribeWav(u.wav, pinnedRef.current ?? undefined);
      } catch (e) {
        if (my === turn.current) setErr((e as Error).message), setPhase("listening");
        return;
      }
      if (my !== turn.current) return;
      if (!r.text || isPhantom(r.text, u.seconds)) return setPhase("listening");
      // Whisper can misjudge the language of a few words; keep the conversation's language unless
      // this turn is long enough to be sure (or the user pinned one).
      const language = pinnedRef.current ?? (r.language && (r.text.length >= 12 || !langRef.current) ? r.language : langRef.current ?? r.language);
      setLang(language);
      setYou(r.text);
      setTone(u.tone);
      setDsi("");
      setPhase("thinking");
      const tag = new EmotionTag();
      const split = new SentenceSplitter(true);
      const speakLang = language ?? "en";
      try {
        await ask(r.text, {
          system: voiceSystemPrompt({ language, tone: u.tone }),
          filter: (d) => tag.push(d),
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
      split.flush().forEach((s) => p.say(s, speakLang, tag.emotion));
      await p.whenIdle();
      if (my === turn.current) setPhase("listening");
    };
    p.onStart = () => setPhase("speaking");
    p.onSentence = (t) => setDsi(t);
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
      live.stop();
    };
  }, [live, started, ask, stop, close]);

  useEffect(() => {
    live.muted = muted;
  }, [live, muted]);

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
        {TONE_LABEL[tone] && (
          <span className="vm-chip vm-tone" title="Read from your tone of voice on this device">
            You sound {TONE_LABEL[tone]}
          </span>
        )}
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
        <Orb phase={phase} color={color} level={level} />
        <p className="vm-status" aria-live="polite">
          {needTap ? "Tap to start" : status}
        </p>
        <div className="vm-captions">
          {you && <p className="vm-you">“{you}”</p>}
          {dsi && (
            <p className="vm-dsi" lang={lang ?? undefined}>
              {dsi}
            </p>
          )}
          {err && <p className="vm-err">{err}</p>}
        </div>
      </div>

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
      <p className="vm-fine">Interrupt anytime just by talking · speech runs on Cloudflare Workers AI, audio is never stored</p>
    </div>
  );
}
