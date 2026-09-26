import { useCallback, useEffect, useRef, useState } from "react";
import { usePrivy, useIdentityToken } from "@privy-io/react-auth";
import { api, setAccount, setTokenSource, type Config } from "./api";
import { listConversations, setNamespace, type Conversation } from "./localdb";
import { Chat } from "./Chat";
import { Console } from "./Console";
import { Wallet } from "./Wallet";
import { Agent } from "./Agent";

export interface Session {
  user: { id: string; email?: string; wallets: Array<{ address: string; chain: string; type: string }> };
  organizations: Array<{ id: string; name: string; role: string }>;
  defaultOrganization: string;
}

type Route = { view: "chat"; id?: string } | { view: "console"; tab: string } | { view: "wallet" } | { view: "agent" };

function parseRoute(): Route {
  const [view, arg] = location.hash.replace(/^#\/?/, "").split("/");
  if (view === "console") return { view: "console", tab: arg || "overview" };
  if (view === "wallet" || view === "billing") return { view: "wallet" };
  if (view === "agent") return { view: "agent" };
  return { view: "chat", id: arg || undefined };
}

export function App({ config }: { config: Config }) {
  const { ready, authenticated, login, logout, getAccessToken, user } = usePrivy();
  const { identityToken } = useIdentityToken();
  const [session, setSession] = useState<Session>();
  const [org, setOrg] = useState<string>();
  const [route, setRoute] = useState<Route>(parseRoute());
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [error, setError] = useState<string>();
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    const on = () => setRoute(parseRoute());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);

  // Always call the latest token getter without re-running the session exchange on every render.
  const tokenRef = useRef(getAccessToken);
  tokenRef.current = getAccessToken;

  // Exchange the Privy session for a Decentralised.si session (creates the org on first login).
  useEffect(() => {
    if (!ready || !authenticated) return;
    setTokenSource(() => tokenRef.current());
    (async () => {
      try {
        const s = await api<Session>("/session", { method: "POST", headers: identityToken ? { "privy-id-token": identityToken } : {} });
        setSession(s);
        const saved = localStorage.getItem("dsi_org");
        const chosen = s.organizations.find((o) => o.id === saved)?.id ?? s.defaultOrganization;
        setOrg(chosen);
        setAccount(chosen);
        setNamespace(s.user.id);
        setConversations(await listConversations());
      } catch (e) {
        setError(String((e as Error).message));
      }
    })();
  }, [ready, authenticated, identityToken]);

  const refreshConversations = useCallback(async () => setConversations(await listConversations()), []);

  const switchOrg = (id: string) => {
    setOrg(id);
    setAccount(id);
    try {
      localStorage.setItem("dsi_org", id);
    } catch {
      /* private mode */
    }
  };

  if (!ready) return <div className="center muted">Loading…</div>;
  if (!authenticated)
    return (
      <div className="center">
        <div className="card narrow login">
          <div className="brand-lg">
            Decentralised<span>.si</span>
          </div>
          <h1>Every AI model. Private. Paid in crypto.</h1>
          <p className="muted">Sign in with email, Google, Apple, GitHub or your wallet. You get a self-custodial wallet for paying with crypto; your conversations stay in this browser.</p>
          <button className="primary big" onClick={() => login()}>
            Sign in
          </button>
          <p className="fine">
            <a href="/">About</a> · <a href="/whitepaper">Whitepaper</a>
          </p>
        </div>
      </div>
    );
  if (error)
    return (
      <div className="center">
        <div className="card narrow">
          <p className="err">{error}</p>
          <button onClick={() => location.reload()}>Retry</button> <button onClick={() => logout()}>Sign out</button>
        </div>
      </div>
    );
  if (!session || !org) return <div className="center muted">Setting up your workspace…</div>;

  const role = session.organizations.find((o) => o.id === org)?.role ?? "developer";
  const nav = (hash: string) => {
    location.hash = hash;
    setMenu(false);
  };

  return (
    <div className={`shell ${menu ? "menu-open" : ""}`}>
      <aside className="sidebar">
        <div className="side-top">
          <a className="brand" href="#/chat">
            Decentralised<span>.si</span>
          </a>
          <button className="icon only-mobile" aria-label="Close menu" onClick={() => setMenu(false)}>
            ✕
          </button>
        </div>
        <button className="new-chat" onClick={() => nav("#/chat")}>
          + New chat
        </button>
        <div className="convos" role="list">
          {conversations.length === 0 && <p className="muted small pad">Your conversations are stored in this browser only.</p>}
          {conversations.map((c) => (
            <a key={c.id} role="listitem" className={`convo ${route.view === "chat" && route.id === c.id ? "on" : ""}`} href={`#/chat/${c.id}`} onClick={() => setMenu(false)} title={c.title}>
              {c.title}
            </a>
          ))}
        </div>
        <nav className="side-nav">
          <a href="#/console/overview" className={route.view === "console" ? "on" : ""} onClick={() => setMenu(false)}>
            Console
          </a>
          <a href="#/wallet" className={route.view === "wallet" ? "on" : ""} onClick={() => setMenu(false)}>
            Wallet &amp; billing
          </a>
          <a href="#/agent" className={route.view === "agent" ? "on" : ""} onClick={() => setMenu(false)}>
            Agent terminal
          </a>
        </nav>
        <div className="side-foot">
          {session.organizations.length > 1 ? (
            <select value={org} onChange={(e) => switchOrg(e.target.value)} aria-label="Organization">
              {session.organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({o.role})
                </option>
              ))}
            </select>
          ) : (
            <div className="small muted">{session.organizations[0]?.name}</div>
          )}
          <div className="who">
            <span className="small" title={user?.id}>
              {session.user.email ?? `${session.user.wallets[0]?.address.slice(0, 6)}…`}
            </span>
            <button className="link" onClick={() => logout()}>
              Sign out
            </button>
          </div>
        </div>
      </aside>
      <main className="main">
        <button className="icon menu-btn only-mobile" aria-label="Open menu" onClick={() => setMenu(true)}>
          ☰
        </button>
        {route.view === "chat" && <Chat key={`${org}:${route.id ?? "new"}`} id={route.id} onSaved={refreshConversations} config={config} />}
        {route.view === "console" && <Console key={org} tab={route.tab} role={role} session={session} />}
        {route.view === "wallet" && <Wallet key={org} role={role} config={config} session={session} />}
        {route.view === "agent" && <Agent />}
      </main>
    </div>
  );
}
