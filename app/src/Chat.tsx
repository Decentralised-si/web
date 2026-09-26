import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { api, listModels, streamChat, type Config } from "./api";
import { deleteConversation, listConversations, saveConversation, type Conversation } from "./localdb";

const MODES = [
  { id: "optimise", label: "Auto — best value" },
  { id: "quality", label: "Best quality" },
  { id: "fastest", label: "Fastest" },
  { id: "cheapest", label: "Cheapest" },
  { id: "decentralised_only", label: "Decentralised only" },
  { id: "private", label: "Private (strict)" },
];

function render(md: string) {
  return { __html: DOMPurify.sanitize(marked.parse(md, { async: false, gfm: true, breaks: true }) as string) };
}

export function Chat({ id, onSaved, config }: { id?: string; onSaved: () => void; config: Config }) {
  const [conv, setConv] = useState<Conversation>();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("auto");
  const [mode, setMode] = useState("optimise");
  const [credit, setCredit] = useState<number>();
  const abort = useRef<AbortController | undefined>(undefined);
  const bottom = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

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
    api("/org")
      .then((o) => setCredit(o.creditUsd))
      .catch(() => {});
    box.current?.focus();
  }, [id]);

  // Block body: newer browsers return a Promise from scrollIntoView, and an effect must not return one.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [conv?.messages.length, conv?.messages.at(-1)?.content]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    const now = Date.now();
    const base: Conversation = conv ?? { id: crypto.randomUUID(), title: text.slice(0, 60), createdAt: now, updatedAt: now, model, mode, messages: [] };
    let current: Conversation = { ...base, model, mode, updatedAt: now, messages: [...base.messages, { role: "user", content: text }, { role: "assistant", content: "" }] };
    setConv(current);
    if (!conv) history.replaceState(null, "", `#/chat/${current.id}`);
    setBusy(true);
    const ac = new AbortController();
    abort.current = ac;
    try {
      const meta = await streamChat({
        messages: current.messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
        model,
        // A specific model means exactly that model; "any model" lets the router choose by the selected mode.
        mode: model === "auto" ? mode : "passthrough",
        session: current.id,
        affinity: current.affinity,
        signal: ac.signal,
        onDelta: (d) => {
          current = { ...current, messages: current.messages.map((m, i) => (i === current.messages.length - 1 ? { ...m, content: m.content + d } : m)) };
          setConv(current);
        },
      });
      current = { ...current, affinity: meta.affinity ?? current.affinity, messages: current.messages.map((m, i) => (i === current.messages.length - 1 ? { ...m, meta } : m)) };
    } catch (e) {
      const msg = (e as Error).name === "AbortError" ? "Stopped." : (e as Error).message;
      current = { ...current, messages: current.messages.map((m, i) => (i === current.messages.length - 1 ? { ...m, error: msg } : m)) };
    } finally {
      setConv(current);
      setBusy(false);
      await saveConversation(current);
      onSaved();
      api("/org")
        .then((o) => setCredit(o.creditUsd))
        .catch(() => {});
    }
  };

  const remove = async () => {
    if (!conv) return;
    await deleteConversation(conv.id);
    onSaved();
    location.hash = "#/chat";
  };

  const empty = !conv || conv.messages.length === 0;
  const modelOptions = useMemo(() => ["auto", ...models.filter((m) => m !== "auto" && !m.startsWith("text-embedding") && !m.includes("embed") && !m.includes("bge"))], [models]);

  return (
    <div className="chat">
      <header className="chat-head">
        <div className="row">
          <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m === "auto" ? "Any model (router decides)" : m}
              </option>
            ))}
          </select>
          <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Routing mode" disabled={model !== "auto"} title={model !== "auto" ? "A specific model is used exactly as chosen" : undefined}>
            {MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          {credit !== undefined && (
            <a className={`pill ${credit <= 0 ? "bad" : ""}`} href="#/wallet" title="Network and platform credit">
              ${credit.toFixed(2)} credit
            </a>
          )}
          {conv && (
            <button className="link" onClick={remove}>
              Delete chat
            </button>
          )}
        </div>
      </header>

      <div className="messages">
        {empty ? (
          <div className="hello">
            <h1>What can I help with?</h1>
            <p className="muted">One conversation goes to one provider; each new chat can go to a different one. Nothing you type is stored on our servers.</p>
            {credit !== undefined && credit <= 0 && (
              <p className="note">
                Your organization has no credit yet. <a href="#/wallet">Top up with crypto</a>, or connect your own provider keys in <a href="#/console/providers">Console → Providers</a>.
              </p>
            )}
            {!config.platformVendors.length && <p className="fine muted">Commercial models (Claude, GPT, Gemini) need your own key in Console → Providers until platform access is enabled; open-weight network models work with credit.</p>}
          </div>
        ) : (
          conv!.messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.role === "user" ? (
                <div className="bubble">{m.content}</div>
              ) : (
                <>
                  <div className="md" dangerouslySetInnerHTML={render(m.content || (busy && i === conv!.messages.length - 1 ? "…" : ""))} />
                  {m.error && <p className="err small">{m.error}</p>}
                  {m.meta?.model && (
                    <p className="fine muted">
                      {m.meta.model} · {m.meta.provider} · {m.meta.market}
                    </p>
                  )}
                </>
              )}
            </div>
          ))
        )}
        <div ref={bottom} />
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          ref={box}
          value={input}
          rows={1}
          placeholder="Message Decentralised.si…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {busy ? (
          <button type="button" className="primary" onClick={() => abort.current?.abort()}>
            Stop
          </button>
        ) : (
          <button className="primary" disabled={!input.trim()}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}
