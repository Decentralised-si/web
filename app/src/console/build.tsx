import { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { API, api, authHeaders, listModels, streamChat, PUBLIC_API } from "../api";
import { Section, useLoad, when } from "../Console";

const MODES = ["optimise", "quality", "fastest", "cheapest", "decentralised_only", "private", "passthrough"];
const md = (s: string) => ({ __html: DOMPurify.sanitize(marked.parse(s, { async: false, gfm: true }) as string) });
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// ---------------------------------------------------------------- Playground

interface Params {
  model: string;
  mode: string;
  system: string;
  temperature: string;
  maxTokens: string;
  stop: string;
}

function codeFor(lang: string, p: Params, messages: Array<{ role: string; content: string }>) {
  const msgs = messages.length ? messages : [{ role: "user", content: "Hello" }];
  const model = p.model || "auto";
  const t = p.temperature !== "" ? Number(p.temperature) : undefined;
  const mt = Number(p.maxTokens) || 1024;
  const hdr = p.mode !== "passthrough" && model === "auto" ? p.mode : undefined;
  const py = (v: unknown) => JSON.stringify(v, null, 4).replace(/\n/g, "\n    ");
  if (lang === "python")
    return `from anthropic import Anthropic

client = Anthropic(
    api_key="ds_live_...",  # your Decentralised.si key
    base_url="${PUBLIC_API}/anthropic",${hdr ? `\n    default_headers={"X-Decentralise-Mode": "${hdr}"},` : ""}
)

message = client.messages.create(
    model="${model}",
    max_tokens=${mt},${p.system ? `\n    system=${JSON.stringify(p.system)},` : ""}${t !== undefined ? `\n    temperature=${t},` : ""}${p.stop ? `\n    stop_sequences=${JSON.stringify(p.stop.split(",").map((x) => x.trim()))},` : ""}
    messages=${py(msgs)},
)
print(message.content[0].text)`;
  if (lang === "typescript")
    return `import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.DECENTRALISE_API_KEY,
  baseURL: "${PUBLIC_API}/anthropic",${hdr ? `\n  defaultHeaders: { "X-Decentralise-Mode": "${hdr}" },` : ""}
});

const message = await client.messages.create({
  model: "${model}",
  max_tokens: ${mt},${p.system ? `\n  system: ${JSON.stringify(p.system)},` : ""}${t !== undefined ? `\n  temperature: ${t},` : ""}
  messages: ${JSON.stringify(msgs, null, 2).replace(/\n/g, "\n  ")},
});
console.log(message.content);`;
  if (lang === "openai")
    return `from openai import OpenAI

client = OpenAI(api_key="ds_live_...", base_url="${PUBLIC_API}/openai/v1")

resp = client.chat.completions.create(
    model="${model}",
    max_tokens=${mt},${t !== undefined ? `\n    temperature=${t},` : ""}${hdr ? `\n    extra_headers={"X-Decentralise-Mode": "${hdr}"},` : ""}
    messages=${py([...(p.system ? [{ role: "system", content: p.system }] : []), ...msgs])},
)
print(resp.choices[0].message.content)`;
  return `curl ${PUBLIC_API}/anthropic/v1/messages \\
  -H "x-api-key: $DECENTRALISE_API_KEY" \\
  -H "content-type: application/json" \\${hdr ? `\n  -H "X-Decentralise-Mode: ${hdr}" \\` : ""}
  -d '${JSON.stringify({ model, max_tokens: mt, ...(p.system ? { system: p.system } : {}), ...(t !== undefined ? { temperature: t } : {}), messages: msgs }).replace(/'/g, "'\\''")}'`;
}

export function Playground({ initialAgent }: { initialAgent?: string }) {
  const [p, setP] = useState<Params>({ model: "auto", mode: "optimise", system: "", temperature: "", maxTokens: "1024", stop: "" });
  const [models, setModels] = useState<string[]>([]);
  const [messages, setMessages] = useState<Array<{ role: "user" | "assistant"; content: string; meta?: string }>>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [code, setCode] = useState<string>();
  const [lang, setLang] = useState("python");
  const [saved, setSaved] = useState<string>();
  const session = useRef(crypto.randomUUID());
  const abort = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    listModels().then(setModels);
    if (initialAgent)
      api(`/agents/${initialAgent}`)
        .then(({ agent: a }) => setP({ model: `agent:${a.id}`, mode: a.mode ?? "optimise", system: "", temperature: a.temperature ?? "", maxTokens: String(a.maxTokens ?? 1024), stop: "" }))
        .catch(() => {});
  }, [initialAgent]);
  const set = (k: keyof Params, v: string) => setP({ ...p, [k]: v });

  const run = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const convo = [...messages, { role: "user" as const, content: text }];
    setMessages([...convo, { role: "assistant", content: "" }]);
    setInput("");
    setBusy(true);
    setErr(undefined);
    const ac = new AbortController();
    abort.current = ac;
    const started = performance.now();
    let out = "";
    try {
      const body = [...(p.system ? [{ role: "system" as const, content: p.system }] : []), ...convo];
      const meta = await streamChat({
        messages: body,
        model: p.model,
        mode: p.model === "auto" || p.model.startsWith("agent:") ? p.mode : "passthrough",
        session: session.current,
        signal: ac.signal,
        onDelta: (d) => {
          out += d;
          setMessages([...convo, { role: "assistant", content: out }]);
        },
      });
      setMessages([...convo, { role: "assistant", content: out, meta: `${meta.model} · ${meta.provider} · ${meta.market} · ${Math.round(performance.now() - started)} ms` }]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async () => {
    const name = prompt("Agent name");
    if (!name) return;
    const r = await api("/agents", { body: { name, system: p.system, model: p.model.startsWith("agent:") ? "auto" : p.model, mode: p.mode, temperature: p.temperature, maxTokens: p.maxTokens } });
    setSaved(`Saved as ${r.agent.name}: call it with model "agent:${r.agent.id}".`);
  };

  return (
    <div className="playground">
      <div className="page-head row between">
        <h1>Playground</h1>
        <div className="row">
          <button onClick={() => (setMessages([]), (session.current = crypto.randomUUID()))}>Clear</button>
          <button onClick={saveAgent}>Save as agent</button>
          <button className="primary" onClick={() => setCode(codeFor(lang, p, messages.filter((m) => m.content).map(({ role, content }) => ({ role, content }))))}>
            Get code
          </button>
        </div>
      </div>
      {saved && <p className="note small">{saved}</p>}
      <div className="pg-grid">
        <section className="card pg-params">
          <label>
            Model
            <select value={p.model} onChange={(e) => set("model", e.target.value)}>
              {p.model.startsWith("agent:") && <option value={p.model}>{p.model}</option>}
              {models.map((m) => (
                <option key={m} value={m}>
                  {m === "auto" ? "auto (router decides)" : m}
                </option>
              ))}
            </select>
          </label>
          <label>
            Routing mode
            <select value={p.mode} onChange={(e) => set("mode", e.target.value)} disabled={p.model !== "auto" && !p.model.startsWith("agent:")}>
              {MODES.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label>
            System prompt
            <textarea rows={8} value={p.system} onChange={(e) => set("system", e.target.value)} placeholder="Optional instructions" />
          </label>
          <label>
            Temperature
            <input type="number" min="0" max="2" step="0.1" value={p.temperature} placeholder="model default" onChange={(e) => set("temperature", e.target.value)} />
          </label>
          <label>
            Max tokens
            <input type="number" min="1" value={p.maxTokens} onChange={(e) => set("maxTokens", e.target.value)} />
          </label>
          <label>
            Stop sequences
            <input value={p.stop} placeholder="comma separated" onChange={(e) => set("stop", e.target.value)} />
          </label>
        </section>
        <section className="card pg-chat">
          <div className="pg-messages">
            {!messages.length && <p className="muted">Send a message to try your prompt. Playground requests are billed like any API call.</p>}
            {messages.map((m, i) => (
              <div key={i} className={`pg-msg ${m.role}`}>
                <div className="fine muted">{m.role === "user" ? "User" : "Assistant"}</div>
                {m.role === "user" ? <div className="pre">{m.content}</div> : <div className="md" dangerouslySetInnerHTML={md(m.content || (busy ? "…" : ""))} />}
                {m.meta && <div className="fine muted">{m.meta}</div>}
              </div>
            ))}
            {err && <p className="err small">{err}</p>}
          </div>
          <div className="composer inline">
            <textarea
              rows={2}
              value={input}
              placeholder="User message"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
              }}
            />
            {busy ? (
              <button onClick={() => abort.current?.abort()}>Stop</button>
            ) : (
              <button className="primary" onClick={run} disabled={!input.trim()} title="⌘/Ctrl + Enter">
                Run
              </button>
            )}
          </div>
        </section>
      </div>
      {code && (
        <div className="palette-backdrop" onClick={() => setCode(undefined)}>
          <div className="modal" role="dialog" aria-label="Get code" onClick={(e) => e.stopPropagation()}>
            <div className="row between">
              <h2>Get code</h2>
              <button className="link" onClick={() => setCode(undefined)}>
                Close
              </button>
            </div>
            <div className="tabs">
              {[
                ["python", "Python (Anthropic)"],
                ["typescript", "TypeScript (Anthropic)"],
                ["openai", "Python (OpenAI)"],
                ["curl", "cURL"],
              ].map(([id, label]) => (
                <a key={id} className={lang === id ? "on" : ""} href="#/console/playground" onClick={(e) => (e.preventDefault(), setLang(id), setCode(codeFor(id, p, messages.filter((m) => m.content).map(({ role, content }) => ({ role, content })))))}>
                  {label}
                </a>
              ))}
            </div>
            <pre className="codeblock">{code}</pre>
            <button onClick={() => navigator.clipboard.writeText(code)}>Copy</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Files

export function Files() {
  const [files, setFiles] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [drag, setDrag] = useState(false);
  const load = async () => {
    const r = await fetch(`${API}/anthropic/v1/files?limit=500`, { headers: await authHeaders() });
    const j = await r.json();
    setFiles(j.data ?? []);
  };
  useEffect(() => {
    load();
  }, []);
  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    setErr(undefined);
    try {
      for (const file of Array.from(list)) {
        const form = new FormData();
        form.append("file", file);
        const h = await authHeaders();
        delete h["content-type"];
        const r = await fetch(`${API}/anthropic/v1/files`, { method: "POST", headers: h, body: form });
        if (!r.ok) throw new Error((await r.json()).error?.message ?? `upload failed (${r.status})`);
      }
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    await fetch(`${API}/anthropic/v1/files/${id}`, { method: "DELETE", headers: await authHeaders() });
    load();
  };
  const download = async (x: any) => {
    const r = await fetch(`${API}/anthropic/v1/files/${x.id}/content`, { headers: await authHeaders() });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await r.blob());
    a.download = x.filename;
    a.click();
  };
  return (
    <>
      <div className="page-head">
        <h1>Files</h1>
        <p className="muted small">
          Upload once, reference by id in messages: <code>{`{"type":"document","source":{"type":"file","file_id":"file_…"}}`}</code> (Anthropic) or <code>{`{"type":"file","file":{"file_id":"file_…"}}`}</code> (OpenAI). Images, text/code/CSV/JSON and PDFs, up to 32 MB.
        </p>
      </div>
      <label className={`dropzone ${drag ? "on" : ""}`} onDragOver={(e) => (e.preventDefault(), setDrag(true))} onDragLeave={() => setDrag(false)} onDrop={(e) => (e.preventDefault(), setDrag(false), upload(e.dataTransfer.files))}>
        <input type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
        {busy ? "Uploading…" : "Drop files here or click to upload"}
      </label>
      {err && <p className="err small">{err}</p>}
      <Section title={`Files (${files.length})`}>
        <div className="tbl">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>ID</th>
                <th>Type</th>
                <th>Size</th>
                <th>Uploaded</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {files.map((x) => (
                <tr key={x.id}>
                  <td>{x.filename}</td>
                  <td>
                    <code>{x.id}</code> <button className="link" onClick={() => navigator.clipboard.writeText(x.id)}>Copy</button>
                  </td>
                  <td>{x.mime_type}</td>
                  <td>{size(x.size_bytes)}</td>
                  <td>{when(x.created_at)}</td>
                  <td className="row">
                    <button onClick={() => download(x)}>Download</button>
                    <button className="danger" onClick={() => remove(x.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {!files.length && (
                <tr>
                  <td colSpan={6} className="muted">
                    No files yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- Batches

export function Batches() {
  const [list, setList] = useState<any[]>([]);
  const [err, setErr] = useState<string>();
  const [text, setText] = useState("");
  const load = async () => {
    const r = await fetch(`${API}/anthropic/v1/messages/batches?limit=100`, { headers: await authHeaders() });
    setList((await r.json()).data ?? []);
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  const call = async (path: string, method = "GET", body?: unknown) => {
    const r = await fetch(`${API}/anthropic/v1/messages/batches${path}`, { method, headers: await authHeaders(), body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error((await r.json()).error?.message ?? `HTTP ${r.status}`);
    return r;
  };
  const submit = async () => {
    setErr(undefined);
    try {
      const requests = text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l, i) => {
          try {
            return JSON.parse(l);
          } catch {
            throw new Error(`Line ${i + 1} is not valid JSON`);
          }
        });
      await call("", "POST", { requests });
      setText("");
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const results = async (id: string) => {
    const r = await call(`/${id}/results`);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await r.blob());
    a.download = `${id}_results.jsonl`;
    a.click();
  };
  const example = '{"custom_id": "q1", "params": {"model": "auto", "max_tokens": 256, "messages": [{"role": "user", "content": "Summarise the history of Ljubljana in one line."}]}}';
  return (
    <>
      <div className="page-head">
        <h1>Batches</h1>
        <p className="muted small">
          Submit up to 10,000 requests; they run asynchronously through the router and results are available as JSONL for 24 hours. API: <code>POST /anthropic/v1/messages/batches</code> (compatible with the Anthropic SDK's <code>messages.batches</code>).
        </p>
      </div>
      <Section title="New batch">
        <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={`One request per line (JSONL), e.g.\n${example}`} style={{ width: "100%" }} />
        <div className="row">
          <button className="primary" onClick={submit} disabled={!text.trim()}>
            Create batch
          </button>
          <label className="button">
            Upload .jsonl
            <input type="file" accept=".jsonl,.json,.txt" hidden onChange={async (e) => setText((await e.target.files?.[0]?.text()) ?? "")} />
          </label>
          <button className="link" onClick={() => setText(example)}>
            Insert example
          </button>
        </div>
        {err && <p className="err small">{err}</p>}
      </Section>
      <Section title="Batches">
        <div className="tbl">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Status</th>
                <th>Succeeded</th>
                <th>Errored</th>
                <th>Processing</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((b) => (
                <tr key={b.id}>
                  <td>
                    <code>{b.id}</code>
                  </td>
                  <td>
                    <span className={`pill ${b.processing_status === "ended" ? "ok" : "warn"}`}>{b.processing_status.replace("_", " ")}</span>
                  </td>
                  <td>{b.request_counts.succeeded}</td>
                  <td>{b.request_counts.errored}</td>
                  <td>{b.request_counts.processing}</td>
                  <td>{when(b.created_at)}</td>
                  <td className="row">
                    {b.processing_status === "ended" ? (
                      <>
                        <button onClick={() => results(b.id)}>Results</button>
                        <button className="danger" onClick={() => call(`/${b.id}`, "DELETE").then(load)}>
                          Delete
                        </button>
                      </>
                    ) : (
                      <button onClick={() => call(`/${b.id}/cancel`, "POST").then(load)}>Cancel</button>
                    )}
                  </td>
                </tr>
              ))}
              {!list.length && (
                <tr>
                  <td colSpan={7} className="muted">
                    No batches yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- Agents

const EMPTY = { name: "", description: "", system: "", model: "auto", mode: "optimise", temperature: "", maxTokens: "1024", tools: "[]" };

export function Agents({ admin }: { admin: boolean }) {
  const a = useLoad(() => api("/agents"));
  const [models, setModels] = useState<string[]>([]);
  const [form, setForm] = useState<typeof EMPTY & { id?: string }>();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    listModels().then(setModels);
  }, []);
  const save = async () => {
    try {
      setErr(undefined);
      const body = { ...form, tools: JSON.parse(form!.tools || "[]") };
      if (form!.id) await api(`/agents/${form!.id}`, { method: "PATCH", body });
      else await api("/agents", { body });
      setForm(undefined);
      a.reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const agents = a.data?.agents ?? [];
  const snippet = (id: string) => `client.messages.create(model="agent:${id}", max_tokens=1024, messages=[{"role": "user", "content": "..."}])`;
  const set = (k: string, v: string) => setForm({ ...form!, [k]: v });
  return (
    <>
      <div className="page-head row between">
        <div>
          <h1>Agents</h1>
          <p className="muted small">
            An agent bundles instructions, a model or routing mode, parameters and tools. Call it from any SDK with <code>model: "agent:&lt;id&gt;"</code>, or run it in the terminal with <a href="#/console/terminal">Hermes</a>.
          </p>
        </div>
        {admin && (
          <button className="primary" onClick={() => setForm({ ...EMPTY })}>
            Build an agent
          </button>
        )}
      </div>
      {form && (
        <Section title={form.id ? `Edit ${form.name}` : "New agent"}>
          <div className="grid3">
            <label>
              Name
              <input value={form.name} onChange={(e) => set("name", e.target.value)} />
            </label>
            <label>
              Model
              <select value={form.model} onChange={(e) => set("model", e.target.value)}>
                {models.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
            <label>
              Routing mode (for auto)
              <select value={form.mode} onChange={(e) => set("mode", e.target.value)}>
                {MODES.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Description
            <input value={form.description} onChange={(e) => set("description", e.target.value)} />
          </label>
          <label>
            Instructions (system prompt)
            <textarea rows={8} value={form.system} onChange={(e) => set("system", e.target.value)} />
          </label>
          <div className="grid3">
            <label>
              Temperature
              <input type="number" step="0.1" value={form.temperature} onChange={(e) => set("temperature", e.target.value)} placeholder="model default" />
            </label>
            <label>
              Max tokens
              <input type="number" value={form.maxTokens} onChange={(e) => set("maxTokens", e.target.value)} />
            </label>
          </div>
          <label>
            Tools (JSON array of {"{name, description, input_schema}"})
            <textarea rows={5} className="mono" value={form.tools} onChange={(e) => set("tools", e.target.value)} />
          </label>
          <div className="row">
            <button className="primary" onClick={save}>
              Save agent
            </button>
            <button onClick={() => setForm(undefined)}>Cancel</button>
          </div>
          {err && <p className="err small">{err}</p>}
        </Section>
      )}
      <div className="grid3">
        {agents.map((x: any) => (
          <section key={x.id} className="card">
            <h2>{x.name}</h2>
            <p className="small muted">{x.description || x.system?.slice(0, 140) || "No instructions"}</p>
            <p className="fine">
              <code>agent:{x.id}</code> · {x.model}
              {x.model === "auto" ? ` · ${x.mode}` : ""} · {x.tools?.length ?? 0} tools
            </p>
            <div className="row wrap">
              <a className="button" href={`#/console/playground/${x.id}`}>
                Try in playground
              </a>
              {admin && (
                <button onClick={() => setForm({ id: x.id, name: x.name, description: x.description ?? "", system: x.system ?? "", model: x.model, mode: x.mode ?? "optimise", temperature: x.temperature ?? "", maxTokens: String(x.maxTokens ?? 1024), tools: JSON.stringify(x.tools ?? [], null, 2) })}>
                  Edit
                </button>
              )}
              <button onClick={() => navigator.clipboard.writeText(snippet(x.id))}>Copy code</button>
              {admin && (
                <button className="danger" onClick={() => api(`/agents/${x.id}`, { method: "DELETE" }).then(a.reload)}>
                  Delete
                </button>
              )}
            </div>
          </section>
        ))}
        {!agents.length && !form && <p className="muted">No agents yet. Build one, or save a playground prompt as an agent.</p>}
      </div>
    </>
  );
}

