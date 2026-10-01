import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { api, chatWithTools, connectors, listModels, orgStatus, streamChat, type Config, type ConnectorInfo, type McpTool, type StreamMeta } from "./api";
import { deleteConversation, listConversations, saveConversation, type Conversation } from "./localdb";
import { SentenceSplitter, Speaker, voiceSupported } from "./voice";
import { LiveVoice, unlockDeviceVoice } from "./live";
import { VoiceMode, type VoiceAsk } from "./VoiceMode";
import { IconMic, IconSpeaker, IconArrowUp, IconBook, IconBulb, IconChart, IconCheck, IconChevron, IconClip, IconCode, IconLeaf, IconLock, IconPen, IconPlug, IconPlus, IconRoute, IconStop, IconTrash, IconX } from "./icons";

const MODES = [
  { id: "optimise", label: "Best value", hint: "The router balances quality, speed and cost" },
  { id: "quality", label: "Best quality", hint: "The strongest model that fits" },
  { id: "fastest", label: "Fastest", hint: "Lowest time to first word" },
  { id: "cheapest", label: "Cheapest", hint: "Lowest cost that clears the quality floor" },
  { id: "decentralised_only", label: "Decentralised only", hint: "Only nodes on the open network" },
  { id: "free", label: "Free", hint: "Community nodes: 5,000 free tokens a day for everyone, 20,000 if you run a node" },
  { id: "private", label: "Private", hint: "Strict privacy: confidential providers only" },
];
const modeLabel = (id: string) => MODES.find((m) => m.id === id)?.label ?? id;

const STARTERS = [
  { label: "Write", icon: <IconPen />, text: "Help me write " },
  { label: "Learn", icon: <IconBook />, text: "Explain in simple terms: " },
  { label: "Code", icon: <IconCode />, text: "Write code that " },
  { label: "Analyse", icon: <IconChart />, text: "Analyse the pros and cons of " },
  { label: "Brainstorm", icon: <IconBulb />, text: "Give me ideas for " },
];

/** Text files only: they are read here and sent as part of the message. */
const MAX_FILE = 200_000;
interface Attachment {
  name: string;
  text: string;
}

function greeting(name?: string) {
  const h = new Date().getHours();
  const part = h < 5 ? "Evening" : h < 12 ? "Morning" : h < 18 ? "Afternoon" : "Evening";
  return name ? `${part}, ${name}` : `Good ${part.toLowerCase()}`;
}

/** Closes a popover on an outside click or Escape. */
function usePopover(open: boolean, close: () => void, selector: string) {
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => !(e.target as Element).closest?.(selector) && close();
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    addEventListener("mousedown", click);
    addEventListener("keydown", key);
    return () => (removeEventListener("mousedown", click), removeEventListener("keydown", key));
  }, [open, close, selector]);
}

const NODE_GUIDE = "/node#laptop";

interface FreeChat {
  activeNodes: number;
  probationNodes: number;
  dailyTokens: number;
  dailyRemaining: number;
  earnedTokens: number;
  available: number;
  /** Welcome answers left (hosted model, free) for newcomers while no community node can serve them. */
  welcomeRemaining?: number;
}

const WELCOME_TOTAL = 5;

/** Why running a node is worth it; shown to people who don't run one yet. */
function JoinCard({ welcomeRemaining }: { welcomeRemaining?: number }) {
  return (
    <section className="c-join" aria-labelledby="join-h">
      <h3 id="join-h">Chat free by joining the network</h3>
      {welcomeRemaining ? (
        <p className="c-join-lead">
          You have <b>{welcomeRemaining} welcome answers</b> to try it now. To keep chatting free after that, share your computer with the network:
        </p>
      ) : (
        <p className="c-join-lead">Share your computer with the network and chat free every day:</p>
      )}
      <ul>
        <li>
          <b>20,000 free tokens a day</b>, plus every token your node serves to others.
        </li>
        <li>
          <b>Earn PAI</b>, the network's reward points, for the verified work your node does.
        </li>
        <li>
          <b>One command</b> on a laptop, Mac or PC. Your city appears on the live map.
        </li>
      </ul>
      <div className="c-join-actions">
        <a className="c-cta" href={NODE_GUIDE}>
          Run a node on your laptop
        </a>
        <a href="/ai#pai">What is PAI?</a>
      </div>
      <p className="c-join-fine">PAI is recorded on an off-chain ledger today. It has not been issued and has no cash value.</p>
    </section>
  );
}

/** Shown under a welcome answer: what just happened, and how to keep chatting free. */
function WelcomeNote({ remaining }: { remaining: number }) {
  const n = WELCOME_TOTAL - remaining;
  return (
    <div className={`c-welcome ${remaining === 0 ? "last" : ""}`}>
      <p>
        {remaining > 0 ? (
          <>
            <b>
              Welcome answer {n} of {WELCOME_TOTAL}.
            </b>{" "}
            No community node was free, so a hosted open model answered, on us. Run a node to get free chat every day and earn PAI for the work it serves.
          </>
        ) : (
          <>
            <b>That was your last welcome answer.</b> To keep chatting free, run a node: one command on your laptop gives you 20,000 free tokens a day, plus every token it serves, and earns PAI.
          </>
        )}
      </p>
      <div className="c-join-actions">
        <a className="c-cta" href={NODE_GUIDE}>
          Run a node
        </a>
        <a href="/ai#pai">What is PAI?</a>
      </div>
    </div>
  );
}

function tokensLabel(n: number): string {
  return n >= 10_000 ? `${Math.floor(n / 1000)}k` : Math.max(0, Math.round(n)).toLocaleString();
}

function render(md: string) {
  return { __html: DOMPurify.sanitize(marked.parse(md, { async: false, gfm: true, breaks: true }) as string) };
}

/** Who answered, in plain words (no model name): a community node, the hosted fallback, or a vendor through your key. */
function servedBy(meta: { provider?: string; market?: string }): string {
  const p = meta.provider ?? "";
  if (p.startsWith("node:")) return "Community node";
  if (p === "workers-ai") return "Cloudflare-hosted fallback (no community node fit this request)";
  return `${p}${meta.market === "byok" ? " · your key" : meta.market ? ` · ${meta.market}` : ""}`;
}

/** Splits reasoning models' <think>…</think> blocks (possibly still streaming) from the answer. */
function splitThinking(raw: string): { thinks: Array<{ text: string; open: boolean }>; answer: string } {
  const thinks: Array<{ text: string; open: boolean }> = [];
  let answer = "";
  let rest = raw;
  for (;;) {
    const a = rest.indexOf("<think>");
    if (a < 0) {
      answer += rest;
      break;
    }
    answer += rest.slice(0, a);
    const b = rest.indexOf("</think>", a + 7);
    if (b < 0) {
      thinks.push({ text: rest.slice(a + 7).trim(), open: true });
      break;
    }
    thinks.push({ text: rest.slice(a + 7, b).trim(), open: false });
    rest = rest.slice(b + 8);
  }
  return { thinks, answer: answer.trimStart() };
}

function Assistant({ content, streaming }: { content: string; streaming: boolean }) {
  const { thinks, answer } = splitThinking(content);
  return (
    <>
      {thinks.map((t, i) => {
        const knowledge = t.text.startsWith("Knowledge consulted by this node:");
        return (
          <details key={i} className="think" open={t.open}>
            <summary>{knowledge ? "Knowledge the node consulted" : t.open ? "Reasoning…" : "Reasoning"}</summary>
            <div className="think-text">{knowledge ? t.text.replace(/^Knowledge consulted by this node:\n?/, "") : t.text}</div>
          </details>
        );
      })}
      <div className="md" dangerouslySetInnerHTML={render(answer || (streaming ? "…" : ""))} />
    </>
  );
}

type VoiceTurn = Parameters<VoiceAsk>[1];

export function Chat({ id, onSaved, config, name }: { id?: string; onSaved: () => void; config: Config; name?: string }) {
  const [conv, setConv] = useState<Conversation>();
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("auto");
  const [mode, setMode] = useState("optimise");
  const [credit, setCredit] = useState<number>();
  const creditRef = useRef<number | undefined>(undefined);
  creditRef.current = credit;
  const [freeChat, setFreeChat] = useState<FreeChat>();
  const [plus, setPlus] = useState(false);
  // Connectors (MCP servers) the user turned on for chats; their tools are offered to the model.
  const [connList, setConnList] = useState<ConnectorInfo[]>([]);
  const [connOn, setConnOn] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("dsi_conn_on") ?? "[]");
    } catch {
      return [];
    }
  });
  const toolCache = useRef(new Map<string, McpTool[]>());
  const [toolStatus, setToolStatus] = useState<string>();
  useEffect(() => {
    connectors.list().then(setConnList).catch(() => {});
  }, []);
  const toggleConn = (cid: string) =>
    setConnOn((on) => {
      const next = on.includes(cid) ? on.filter((x) => x !== cid) : [...on, cid];
      try {
        localStorage.setItem("dsi_conn_on", JSON.stringify(next));
      } catch {
        /* private mode */
      }
      return next;
    });
  const activeConns = connList.filter((c) => connOn.includes(c.id));
  const activeConnsRef = useRef(activeConns);
  activeConnsRef.current = activeConns;
  const [picker, setPicker] = useState(false);
  const [fileErr, setFileErr] = useState<string>();
  const abort = useRef<AbortController | undefined>(undefined);
  const bottom = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Voice mode (full screen, VoiceMode.tsx): an always-open mic with barge-in. The session starts
  // inside the tap on the mic button, which mobile browsers require for audio.
  const [voiceSession, setVoiceSession] = useState<{ live: LiveVoice; started: Promise<void> }>();
  // "Read aloud" on a single answer.
  const speakerRef = useRef<Speaker | undefined>(undefined);
  const speaker = () => (speakerRef.current ??= new Speaker());
  const sendRef = useRef<(spoken?: string, speak?: boolean, voice?: VoiceTurn) => Promise<void>>(async () => {});
  // The latest conversation and busy flag, for voice turns that follow each other faster than React re-renders.
  const convRef = useRef(conv);
  convRef.current = conv;
  const busyRef = useRef(false);
  const inflight = useRef<Promise<void>>(Promise.resolve());
  usePopover(plus, useCallback(() => setPlus(false), []), ".c-plus-wrap");
  usePopover(picker, useCallback(() => setPicker(false), []), ".c-picker-wrap");

  useEffect(() => {
    (async () => {
      if (id) {
        const found = (await listConversations()).find((c) => c.id === id);
        if (found) {
          setConv(found);
          setModel(found.model);
          setMode(found.mode);
        }
      }
    })();
    listModels().then(setModels).catch(() => {});
    orgStatus()
      .then((o) => {
        setCredit(o.creditUsd);
        setFreeChat(o.freeChat);
        // No credit but free tokens: start new chats in free mode.
        if (!id && o.creditUsd <= 0 && o.freeChat?.available > 0) setMode("free");
      })
      .catch(() => {});
    box.current?.focus();
  }, [id]);

  // ⌘U / Ctrl+U attaches a file, as in the + menu.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "u") {
        e.preventDefault();
        fileInput.current?.click();
      }
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, []);

  // Block body: newer browsers return a Promise from scrollIntoView, and an effect must not return one.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [conv?.messages.length, conv?.messages.at(-1)?.content]);

  const addFiles = async (list: FileList | null) => {
    setFileErr(undefined);
    for (const f of Array.from(list ?? [])) {
      if (f.size > MAX_FILE) {
        setFileErr(`${f.name} is larger than 200 KB.`);
        continue;
      }
      const text = await f.text();
      // Binary files (images, PDFs) decode with replacement characters; only text can be sent.
      if (/�/.test(text.slice(0, 4000))) {
        setFileErr(`${f.name} isn't a text file. Images and PDFs aren't supported yet.`);
        continue;
      }
      setFiles((fs) => [...fs.filter((x) => x.name !== f.name), { name: f.name, text }]);
    }
    if (fileInput.current) fileInput.current.value = "";
    box.current?.focus();
  };

  const send = async (spoken?: string, speak = false, voice?: VoiceTurn) => {
    const text = (spoken ?? input).trim();
    if ((!text && !files.length) || busyRef.current) return;
    busyRef.current = true;
    const attached = files;
    if (spoken === undefined) setInput("");
    setFiles([]);
    const sentences = speak ? new SentenceSplitter() : undefined;
    const content = [text, ...attached.map((f) => `<file name="${f.name}">\n${f.text}\n</file>`)].filter(Boolean).join("\n\n");
    const now = Date.now();
    const title = (text || attached[0]?.name || "New chat").slice(0, 60);
    const existing = convRef.current;
    const base: Conversation = existing ?? { id: crypto.randomUUID(), title, createdAt: now, updatedAt: now, model, mode, messages: [] };
    let current: Conversation = {
      ...base,
      model,
      mode,
      updatedAt: now,
      messages: [...base.messages, { role: "user", content, files: attached.length ? attached.map((f) => f.name) : undefined }, { role: "assistant", content: "" }],
    };
    setConv(current);
    convRef.current = current;
    if (!existing) history.replaceState(null, "", `#/chat/${current.id}`);
    setBusy(true);
    const ac = new AbortController();
    abort.current = ac;
    try {
      const messages = [...(voice ? [{ role: "system" as const, content: voice.system }] : []), ...current.messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }))];
      const onDelta = (raw: string) => {
        // Voice replies open with an emotion tag, which is for the voice, not the transcript.
        const d = voice ? voice.filter(raw) : raw;
        if (!d) return;
        voice?.onVisible(d);
        sentences?.push(d).forEach((t) => speaker().say(t));
        current = { ...current, messages: current.messages.map((m, i) => (i === current.messages.length - 1 ? { ...m, content: m.content + d } : m)) };
        setConv(current);
        convRef.current = current;
      };
      let meta: StreamMeta & { tools?: string[] };
      const conns = activeConnsRef.current;
      if (conns.length) {
        // Connectors on: the model may call their tools (run by DSI Axon) before answering; the
        // answer then goes through the same path as a streamed reply, so voice reads it aloud.
        setToolStatus(`Checking ${conns.map((c) => c.name).join(", ")}…`);
        const servers = await Promise.all(
          conns.map(async (c) => ({ connector: c, tools: toolCache.current.get(c.id) ?? (await connectors.tools(c.id).then((r) => (toolCache.current.set(c.id, r.tools), r.tools))) ?? [] })),
        );
        // Tool use needs a model that calls tools reliably: GLM 5.3 Flash when "Smart Routing" is on and there is credit.
        const toolModel = model === "auto" && (creditRef.current ?? 0) > 0 ? "@cf/zai-org/glm-5.3-flash" : model;
        try {
          const r = await chatWithTools({ messages, model: toolModel, mode: toolModel === "auto" ? mode : "passthrough", session: current.id, signal: ac.signal, servers, onTool: (label) => setToolStatus(`Using ${label}…`) });
          onDelta(r.text);
          meta = { ...r.meta, ...(r.used.length ? { tools: r.used } : {}) };
        } finally {
          setToolStatus(undefined);
        }
      } else {
        meta = await streamChat({
          messages,
          model,
          // A specific model means exactly that model; "Smart Routing" lets the router choose by the selected mode.
          mode: model === "auto" ? mode : "passthrough",
          session: current.id,
          affinity: current.affinity,
          signal: ac.signal,
          onDelta,
        });
      }
      sentences?.flush().forEach((t) => speaker().say(t));
      current = { ...current, affinity: meta.affinity ?? current.affinity, messages: current.messages.map((m, i) => (i === current.messages.length - 1 ? { ...m, meta } : m)) };
    } catch (e) {
      const aborted = (e as Error).name === "AbortError";
      // A voice reply cut off by the user talking over it is kept as said so far, marked with "…".
      if (aborted && voice) current = { ...current, messages: current.messages.map((m, i) => (i === current.messages.length - 1 ? { ...m, content: m.content ? `${m.content} …` : "…" } : m)) };
      else {
        const msg = aborted ? "Stopped." : (e as Error).message;
        current = { ...current, messages: current.messages.map((m, i) => (i === current.messages.length - 1 ? { ...m, error: msg } : m)) };
        if (voice && !aborted) throw e;
      }
    } finally {
      setConv(current);
      convRef.current = current;
      busyRef.current = false;
      setBusy(false);
      await saveConversation(current);
      onSaved();
      // A turn a peer answered directly never touched the router; don't add a router call for it.
      if (current.messages[current.messages.length - 1]?.meta?.market !== "p2p")
        orgStatus(true)
          .then((o) => {
            setCredit(o.creditUsd);
            setFreeChat(o.freeChat);
          })
          .catch(() => {});
    }
  };

  sendRef.current = send;

  // One spoken turn from voice mode: stop any reply still streaming, then send through the chat.
  const voiceAsk: VoiceAsk = useCallback(async (text, o) => {
    abort.current?.abort();
    await inflight.current;
    const p = sendRef.current(text, false, o);
    inflight.current = p.catch(() => {});
    await p;
  }, []);
  const voiceStop = useCallback(() => abort.current?.abort(), []);
  const closeVoice = useCallback(() => setVoiceSession(undefined), []);
  const openVoice = () => {
    speakerRef.current?.stop();
    const live = new LiveVoice();
    // Both must start inside this tap on mobile.
    const started = live.start();
    unlockDeviceVoice();
    setVoiceSession({ live, started });
  };

  const readAloud = (text: string) => {
    const sp = speaker();
    sp.unlock();
    sp.stop();
    const split = new SentenceSplitter();
    [...split.push(text), ...split.flush()].forEach((t) => sp.say(t));
  };

  // Switching conversations ends a voice conversation.
  useEffect(() => () => setVoiceSession(undefined), [id]);

  const remove = async () => {
    if (!conv) return;
    await deleteConversation(conv.id);
    onSaved();
    location.hash = "#/chat";
  };

  const empty = !conv || conv.messages.length === 0;
  const modelOptions = useMemo(() => ["auto", ...models.filter((m) => m !== "auto" && !m.startsWith("text-embedding") && !m.includes("embed") && !m.includes("bge"))], [models]);
  const payOpen = config.deposits.evm || config.deposits.solana || config.checkout;
  const free = mode === "free" && model === "auto";

  const balance = free && freeChat ? (
    <a className={`c-balance ${freeChat.available <= 0 ? "bad" : ""}`} href={NODE_GUIDE} title={`Free chat: ${freeChat.dailyRemaining.toLocaleString()} of today's ${freeChat.dailyTokens.toLocaleString()} + ${Math.round(freeChat.earnedTokens).toLocaleString()} earned by your node`}>
      {tokensLabel(freeChat.available)} free tokens
    </a>
  ) : credit !== undefined ? (
    <a className={`c-balance ${credit <= 0 ? "bad" : ""}`} href="#/console/credits" title="Network and platform credit">
      ${credit.toFixed(2)} credit
    </a>
  ) : null;

  const composer = (
    <form
      className="c-composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        addFiles(e.dataTransfer.files);
      }}
    >
      {files.length > 0 && (
        <div className="c-files">
          {files.map((f) => (
            <span key={f.name} className="c-file">
              <IconClip />
              <span>{f.name}</span>
              <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((fs) => fs.filter((x) => x.name !== f.name))}>
                <IconX />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={box}
        value={input}
        rows={1}
        placeholder={empty ? "How can I help you today?" : "Reply…"}
        aria-label="Message"
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <input ref={fileInput} type="file" multiple hidden onChange={(e) => addFiles(e.target.files)} />
      <div className="c-tools">
        <div className="c-plus-wrap">
          <button type="button" className="c-tool" aria-label="Add files and options" aria-expanded={plus} onClick={() => setPlus((v) => !v)}>
            <IconPlus />
          </button>
          {plus && (
            <div className="c-pop c-plus-menu" role="menu" onClick={() => setPlus(false)}>
              <button type="button" role="menuitem" onClick={() => fileInput.current?.click()}>
                <IconClip />
                <span>Add text files</span>
                <kbd>⌘ U</kbd>
              </button>
              <hr />
              <div className="c-pop-label">Routing</div>
              {MODES.filter((m) => m.id !== "free" && m.id !== "private").map((m) => (
                <button key={m.id} type="button" role="menuitemradio" aria-checked={mode === m.id} onClick={() => setMode(m.id)} disabled={model !== "auto"} title={m.hint}>
                  <IconRoute />
                  <span>{m.label}</span>
                  {mode === m.id && <IconCheck />}
                </button>
              ))}
              <hr />
              <button type="button" role="menuitemcheckbox" aria-checked={mode === "free"} onClick={() => (setModel("auto"), setMode(mode === "free" ? "optimise" : "free"))} title={MODES[5].hint}>
                <IconLeaf />
                <span>Free on community nodes</span>
                {mode === "free" && <IconCheck />}
              </button>
              <button type="button" role="menuitemcheckbox" aria-checked={mode === "private"} onClick={() => (setModel("auto"), setMode(mode === "private" ? "optimise" : "private"))} title={MODES[6].hint}>
                <IconLock />
                <span>Private (strict)</span>
                {mode === "private" && <IconCheck />}
              </button>
              <hr />
              <div className="c-pop-label">Connectors</div>
              {connList.map((c) => (
                <button key={c.id} type="button" role="menuitemcheckbox" aria-checked={connOn.includes(c.id)} onClick={() => toggleConn(c.id)} title={c.url}>
                  <IconPlug />
                  <span>{c.name}</span>
                  {connOn.includes(c.id) && <IconCheck />}
                </button>
              ))}
              <a role="menuitem" href="#/connectors">
                <IconPlus />
                <span>{connList.length ? "Manage connectors…" : "Add a connector (MCP)…"}</span>
              </a>
            </div>
          )}
        </div>
        {model === "auto" && mode !== "optimise" && (
          <button type="button" className="c-chip" onClick={() => setMode("optimise")} title="Back to best value">
            {mode === "free" ? <IconLeaf /> : mode === "private" ? <IconLock /> : <IconRoute />}
            <span>{modeLabel(mode)}</span>
            <IconX />
          </button>
        )}
        {activeConns.length > 0 && (
          <a className="c-chip" href="#/connectors" title="Connectors on for this chat">
            <IconPlug />
            <span>{activeConns.length === 1 ? activeConns[0].name : `${activeConns.length} connectors`}</span>
          </a>
        )}
        <span className="c-grow" />
        {balance}
        <div className="c-picker-wrap">
          <button type="button" className="c-picker" aria-expanded={picker} onClick={() => setPicker((v) => !v)}>
            <span>{model === "auto" ? "Smart Routing" : model}</span>
            <IconChevron />
          </button>
          {picker && (
            <div className="c-pop c-picker-menu" role="menu" onClick={() => setPicker(false)}>
              <div className="c-pop-label">Model</div>
              {modelOptions.map((m) => (
                <button key={m} type="button" role="menuitemradio" aria-checked={model === m} onClick={() => setModel(m)}>
                  <span className="c-model">
                    <b>{m === "auto" ? "Smart Routing" : m}</b>
                    {m === "auto" && <small>The router picks per conversation</small>}
                  </span>
                  {model === m && <IconCheck />}
                </button>
              ))}
            </div>
          )}
        </div>
        {voiceSupported() && (
          <button
            type="button"
            className={`c-tool c-mic ${voiceSession ? "on" : ""}`}
            aria-label="Talk"
            title="Talk: a live voice conversation"
            onClick={openVoice}
          >
            <IconMic />
          </button>
        )}
        {busy ? (
          <button type="button" className="c-send" aria-label="Stop" onClick={() => abort.current?.abort()}>
            <IconStop />
          </button>
        ) : (
          <button className="c-send" aria-label="Send" disabled={!input.trim() && !files.length}>
            <IconArrowUp />
          </button>
        )}
      </div>
    </form>
  );

  const voiceScreen = voiceSession && (
    <VoiceMode
      live={voiceSession.live}
      started={voiceSession.started}
      ask={voiceAsk}
      stop={voiceStop}
      onClose={closeVoice}
      onType={() => requestAnimationFrame(() => box.current?.focus())}
    />
  );

  // The voice screen sits first in both layouts (empty chat and conversation), so switching layout
  // after the first spoken question does not remount it and cut the microphone.
  const withVoice = (view: ReactNode) => (
    <>
      {voiceScreen}
      {view}
    </>
  );

  const notice =
    mode === "free" && freeChat ? (
      freeChat.available > 0 ? (
        <>Free chat runs on community nodes, which see the text they answer. Keep private details out of free chats.</>
      ) : freeChat.probationNodes > 0 ? (
        <>Your node is being checked (usually under an hour). Free chat unlocks when it becomes active.</>
      ) : (
        <>
          Free chat is for people who share their computer. <a href={NODE_GUIDE}>Run a node</a> to get {tokensLabel(20_000)} free tokens a day.
        </>
      )
    ) : credit !== undefined && credit <= 0 ? (
      <>
        No credit yet. {payOpen ? <a href="#/console/credits">Top up</a> : <a href={NODE_GUIDE}>Run a node for free chat</a>}, or add your own key in <a href="#/console/providers">Providers</a>.
      </>
    ) : null;

  if (empty)
    return withVoice(
      <div className="c-chat c-home">
        <div className="c-center">
          <h1 className="c-greet">
            <img src="/brand/logo-96.png" alt="" width={44} height={44} />
            <span>{greeting(name)}</span>
          </h1>
          {composer}
          {fileErr && <p className="c-notice err">{fileErr}</p>}
          <div className="c-starters">
            {STARTERS.map((s) => (
              <button
                key={s.label}
                type="button"
                onClick={() => {
                  setInput(s.text);
                  requestAnimationFrame(() => {
                    box.current?.focus();
                    box.current?.setSelectionRange(s.text.length, s.text.length);
                  });
                }}
              >
                {s.icon}
                <span>{s.label}</span>
              </button>
            ))}
          </div>
          {freeChat && freeChat.activeNodes === 0 && (credit ?? 0) <= 0 ? (
            <JoinCard welcomeRemaining={freeChat.welcomeRemaining} />
          ) : (
            notice && <p className="c-notice">{notice}</p>
          )}
        </div>
      </div>
    );

  return withVoice(
    <div className="c-chat">
      <header className="c-top">
        <h2 title={conv!.title}>{conv!.title}</h2>
        <button className="c-icon" aria-label="Delete chat" title="Delete chat" onClick={remove}>
          <IconTrash />
        </button>
      </header>
      <div className="c-messages">
        {conv!.messages.map((m, i) => (
          <div key={i} className={`c-msg ${m.role}`}>
            {m.role === "user" ? (
              <div className="c-bubble">
                {m.files && (
                  <div className="c-files">
                    {m.files.map((f) => (
                      <span key={f} className="c-file">
                        <IconClip />
                        <span>{f}</span>
                      </span>
                    ))}
                  </div>
                )}
                {m.files ? m.content.replace(/\n*<file name="[^"]*">[\s\S]*?<\/file>/g, "").trim() : m.content}
              </div>
            ) : (
              <>
                <img className="c-mark" src="/brand/logo-96.png" alt="" width={24} height={24} />
                <div className="c-answer">
                  <Assistant content={m.content} streaming={busy && i === conv!.messages.length - 1} />
                  {m.error && <p className="err small">{m.error}</p>}
                  {m.error && /run a node|still being checked|used today's/i.test(m.error) && (
                    <p className="note small">
                      <a href={NODE_GUIDE}>How to run a node on your laptop</a>, or choose another routing option from the + menu.
                    </p>
                  )}
                  {m.error && /no network credit|insufficient credit/i.test(m.error) && (
                    <p className="note small">
                      To keep chatting, {payOpen ? <a href="#/console/credits">add credit</a> : <a href={NODE_GUIDE}>run a node for free chat</a>} or add your own provider key in <a href="#/console/providers">Providers</a>. Then send your message again.
                    </p>
                  )}
                  {busy && i === conv!.messages.length - 1 && toolStatus && <p className="cn-status">{toolStatus}</p>}
                  {(m.meta as { tools?: string[] } | undefined)?.tools?.length ? <p className="cn-used">Used {[...new Set((m.meta as { tools: string[] }).tools)].join(", ")}</p> : null}
                  {m.meta?.model && (
                    <p className="c-meta">
                      {servedBy(m.meta)}
                      {voiceSupported() && m.content && (
                        <button type="button" className="c-read" onClick={() => readAloud(m.content)} title="Read this answer aloud">
                          <IconSpeaker />
                          <span>Read aloud</span>
                        </button>
                      )}
                    </p>
                  )}
                  {m.meta?.welcomeRemaining !== undefined && <WelcomeNote remaining={m.meta.welcomeRemaining} />}
                </div>
              </>
            )}
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <div className="c-dock">
        {composer}
        {fileErr ? <p className="c-notice err">{fileErr}</p> : <p className="c-notice">{notice ?? "Answers can be wrong. Check anything important."}</p>}
      </div>
    </div>
  );
}
