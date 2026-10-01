import { useEffect, useState } from "react";
import { connectors, OAUTH_RETURN, type ConnectorInfo, type McpTool } from "./api";

/** Servers people often add; any MCP server URL works. */
const SUGGESTED = [
  { name: "Tax Terminal", url: "https://mcp.taxterminal.ai/mcp", note: "Tax rules, rates and calculations. Sign in with your Tax Terminal account." },
  { name: "DeepWiki", url: "https://mcp.deepwiki.com/mcp", note: "Ask questions about any public GitHub repository. No sign-in." },
];

/** Starts the MCP OAuth sign-in: Axon registers this app with the server, then the browser goes to its sign-in page. */
export async function startOAuth(name: string, url: string) {
  const r = await connectors.oauthStart({ name, url, redirect_uri: OAUTH_RETURN });
  location.href = r.authorize_url;
}

export function ConnectorsPage({ notice }: { notice?: string }) {
  const [list, setList] = useState<ConnectorInfo[]>();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [needsSignIn, setNeedsSignIn] = useState<{ name: string; url: string }>();
  const [open, setOpen] = useState<string>();
  const [tools, setTools] = useState<Record<string, McpTool[] | string>>({});

  const refresh = () => connectors.list().then(setList).catch((e) => setErr((e as Error).message));
  useEffect(() => void refresh(), []);

  const add = async (n: string, u: string, k?: string) => {
    setErr(undefined);
    setNeedsSignIn(undefined);
    setBusy(true);
    try {
      const r = await connectors.add({ name: n || undefined, url: u, api_key: k || undefined });
      setTools((t) => ({ ...t, [r.connector.id]: r.tools }));
      setOpen(r.connector.id);
      setUrl("");
      setName("");
      setKey("");
      await refresh();
    } catch (e) {
      const body = (e as { body?: { needs_oauth?: boolean } }).body;
      if (body?.needs_oauth) setNeedsSignIn({ name: n || new URL(u).hostname, url: u });
      else setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const signIn = async (n: string, u: string) => {
    setBusy(true);
    try {
      await startOAuth(n, u);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  const showTools = async (c: ConnectorInfo) => {
    if (open === c.id) return setOpen(undefined);
    setOpen(c.id);
    if (tools[c.id]) return;
    try {
      setTools((t) => ({ ...t, [c.id]: [] }));
      const r = await connectors.tools(c.id);
      setTools((t) => ({ ...t, [c.id]: r.tools }));
    } catch (e) {
      setTools((t) => ({ ...t, [c.id]: (e as Error).message }));
    }
  };

  const remove = async (c: ConnectorInfo) => {
    await connectors.remove(c.id);
    await refresh();
  };

  return (
    <div className="cn-page">
      <h1>Connectors</h1>
      <p className="cn-lead">
        Connect MCP servers so chats (typed or spoken) can look things up and act in other services. DSI Axon calls the tools for you, and keys and sign-ins are stored encrypted, never in this browser. Turn connectors on for a chat from the <b>+</b> menu.
      </p>
      {notice && <p className="cn-ok">{notice}</p>}
      {err && <p className="cn-err">{err}</p>}

      <h2>Your connectors</h2>
      {!list ? (
        <p className="cn-muted">Loading…</p>
      ) : !list.length ? (
        <p className="cn-muted">None yet. Add one below.</p>
      ) : (
        <ul className="cn-list">
          {list.map((c) => (
            <li key={c.id}>
              <div className="cn-row">
                <div className="cn-id">
                  <b>{c.name}</b>
                  <span>
                    {c.url} · {c.auth === "oauth" ? "signed in" : c.auth === "bearer" ? "API key" : "no sign-in"}
                  </span>
                </div>
                <button type="button" onClick={() => showTools(c)}>
                  {open === c.id ? "Hide tools" : "Show tools"}
                </button>
                <button type="button" className="cn-danger" onClick={() => remove(c)}>
                  Remove
                </button>
              </div>
              {open === c.id && (
                <div className="cn-tools">
                  {typeof tools[c.id] === "string" ? (
                    <p className="cn-err">
                      {tools[c.id] as string}
                      {c.auth === "oauth" && (
                        <>
                          {" "}
                          <button type="button" className="cn-link" onClick={() => signIn(c.name, c.url)}>
                            Sign in again
                          </button>
                        </>
                      )}
                    </p>
                  ) : !(tools[c.id] as McpTool[])?.length ? (
                    <p className="cn-muted">Loading tools…</p>
                  ) : (
                    <ul>
                      {(tools[c.id] as McpTool[]).map((t) => (
                        <li key={t.name}>
                          <code>{t.name}</code> {t.description && <span>{t.description.slice(0, 160)}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <h2>Add a connector</h2>
      <div className="cn-suggest">
        {SUGGESTED.filter((s) => !list?.some((c) => c.url === s.url)).map((s) => (
          <button key={s.url} type="button" disabled={busy} onClick={() => add(s.name, s.url)}>
            <b>{s.name}</b>
            <span>{s.note}</span>
          </button>
        ))}
      </div>
      <form
        className="cn-form"
        onSubmit={(e) => {
          e.preventDefault();
          add(name.trim(), url.trim(), key.trim());
        }}
      >
        <label>
          MCP server URL
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" inputMode="url" required />
        </label>
        <label>
          Name (optional)
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tax Terminal" />
        </label>
        <label>
          API key (optional, if the service gave you one)
          <input value={key} onChange={(e) => setKey(e.target.value)} type="password" autoComplete="off" />
        </label>
        <button className="primary" disabled={busy || !url.trim()}>
          {busy ? "Connecting…" : "Connect"}
        </button>
      </form>
      {needsSignIn && (
        <div className="cn-signin">
          <p>
            <b>{needsSignIn.name}</b> asks you to sign in. You'll go to its sign-in page and come straight back here.
          </p>
          <button className="primary" disabled={busy} onClick={() => signIn(needsSignIn.name, needsSignIn.url)}>
            Sign in to {needsSignIn.name}
          </button>
        </div>
      )}
    </div>
  );
}
