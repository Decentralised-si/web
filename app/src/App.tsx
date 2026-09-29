import { useCallback, useEffect, useRef, useState } from "react";
import { usePrivy, useIdentityToken, useLoginWithOAuth } from "@privy-io/react-auth";
import { api, setAccount, setTokenSource, type Config } from "./api";
import { listConversations, setNamespace, type Conversation } from "./localdb";
import { Chat } from "./Chat";
import { ConsoleShell } from "./console/Shell";
import { IconCheck, IconChevron, IconConsole, IconDownload, IconGauge, IconGear, IconHelp, IconInfo, IconLogout, IconMenu, IconNode, IconPanel, IconPlus, IconRight, IconUsers, IconWallet } from "./icons";

export interface Session {
  user: { id: string; email?: string; wallets: Array<{ address: string; chain: string; type: string }> };
  organizations: Array<{ id: string; name: string; role: string }>;
  defaultOrganization: string;
}

type Route = { view: "chat"; id?: string } | { view: "console"; page: string; arg?: string };

function parseRoute(): Route {
  const [view, page, arg] = location.hash.replace(/^#\/?/, "").split("/");
  if (view === "console") return { view: "console", page: page || "dashboard", arg: arg || undefined };
  // Older links: the wallet and agent pages now live inside the console.
  if (view === "wallet" || view === "billing") return { view: "console", page: "credits" };
  if (view === "agent") return { view: "console", page: "terminal" };
  return { view: "chat", id: page || undefined };
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
  const [userMenu, setUserMenu] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("dsi_side") === "closed";
    } catch {
      return false;
    }
  });
  // Google, Apple and GitHub sign in with a full-page redirect rather than Privy's popup: the
  // provider sends the browser back to this page, and this hook (mounted while signed out)
  // finishes the login here, so the visitor lands in the signed-in chat.
  const { initOAuth, state: oauth } = useLoginWithOAuth({
    onComplete: () => {
      if (!location.hash || location.hash === "#" || location.hash === "#/") history.replaceState(null, "", `${location.pathname}#/chat`);
      setRoute(parseRoute());
    },
  });
  const signInWith = (provider: "google" | "apple" | "github") => {
    // The provider returns to the URL we leave from: make that the chat.
    if (!location.hash.startsWith("#/")) history.replaceState(null, "", `${location.pathname}#/chat`);
    initOAuth({ provider }).catch(() => {});
  };
  // A new, unsaved chat keeps the "#/chat" route after its first message (the id is written with
  // replaceState), so "New chat" needs its own key to start a fresh conversation.
  const [newChat, setNewChat] = useState(0);

  useEffect(() => {
    if (!userMenu) return;
    const close = (e: MouseEvent) => !(e.target as Element).closest?.(".c-foot") && setUserMenu(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setUserMenu(false);
    addEventListener("mousedown", close);
    addEventListener("keydown", esc);
    return () => (removeEventListener("mousedown", close), removeEventListener("keydown", esc));
  }, [userMenu]);

  useEffect(() => {
    const on = () => setRoute(parseRoute());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);

  // Arriving from "Chat with DSI" on the intro (/app?login=1): the sign-in screen below, then the
  // chat. Already signed in: straight to the chat.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (!ready || !q.has("login")) return;
    q.delete("login");
    history.replaceState(null, "", location.pathname + (q.toString() ? `?${q}` : "") + (location.hash || "#/chat"));
  }, [ready]);

  // Always call the latest token getter without re-running the session exchange on every render.
  const tokenRef = useRef(getAccessToken);
  tokenRef.current = getAccessToken;

  // Exchange the Privy session for a Decentralised.si session (creates the org on first login).
  const loadSession = useCallback(async () => {
    const s = await api<Session>("/session", { method: "POST", headers: identityToken ? { "privy-id-token": identityToken } : {} });
    setSession(s);
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("dsi_org");
    } catch {
      /* private mode */
    }
    const chosen = s.organizations.find((o) => o.id === saved)?.id ?? s.defaultOrganization;
    setOrg(chosen);
    setAccount(chosen);
    setNamespace(s.user.id);
    setConversations(await listConversations());
  }, [identityToken]);

  useEffect(() => {
    if (!ready || !authenticated) return;
    setTokenSource(() => tokenRef.current());
    loadSession().catch((e) => setError(String((e as Error).message)));
  }, [ready, authenticated, loadSession]);

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

  if (!ready || oauth.status === "loading" || (oauth.status === "done" && !authenticated)) return <div className="center muted">{ready ? "Signing you in…" : "Loading…"}</div>;
  if (!authenticated)
    return (
      <div className="center">
        <div className="c-login">
          <img src="/brand/logo-96.png" alt="" width={48} height={48} />
          <h1>Every AI model, routed for you.</h1>
          <p className="muted">Sign in to chat. Your conversations stay in this browser.</p>
          <div className="c-login-options">
            <button className="primary big" onClick={() => signInWith("google")}>
              Continue with Google
            </button>
            <div className="row">
              <button onClick={() => signInWith("apple")}>Apple</button>
              <button onClick={() => signInWith("github")}>GitHub</button>
              <button onClick={() => login()}>Email or wallet</button>
            </div>
          </div>
          {oauth.status === "error" && <p className="err small">Sign-in didn't complete{oauth.error?.message ? `: ${oauth.error.message}` : ""}. Please try again.</p>}
          <p className="fine">
            <a href="/home">About</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a>
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
  if (route.view === "console")
    return (
      <ConsoleShell
        key={org}
        page={route.page}
        arg={route.arg}
        role={role}
        session={session}
        org={org}
        config={config}
        switchOrg={switchOrg}
        onOrgsChanged={() => loadSession().catch((e) => setError(String((e as Error).message)))}
      />
    );

  const nav = (hash: string) => {
    location.hash = hash;
    setMenu(false);
  };
  const toggleSide = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem("dsi_side", c ? "open" : "closed");
      } catch {
        /* private mode */
      }
      return !c;
    });
  // Email, else a short wallet address, else "Anonymous" (e.g. a social sign-in with neither).
  const wallet = session.user.wallets?.[0]?.address;
  const who = session.user.email || (wallet ? `${wallet.slice(0, 6)}…` : "Anonymous");
  const orgName = session.organizations.find((o) => o.id === org)?.name ?? "";

  return (
    <div className={`c-shell ${menu ? "menu-open" : ""} ${collapsed ? "collapsed" : ""}`}>
      <aside className="c-side" aria-label="Chats">
        <div className="c-side-top">
          <button className="c-icon" aria-label={collapsed ? "Open sidebar" : "Close sidebar"} onClick={() => (menu ? setMenu(false) : toggleSide())}>
            <IconPanel />
          </button>
          <a className="c-brand" href="#/chat" onClick={() => setNewChat((n) => n + 1)}>
            <img src="/brand/logo-96.png" alt="" width={24} height={24} />
            <span>
              Decentralised<span className="tld">.si</span>
            </span>
          </a>
        </div>
        <button
          className={`c-row c-new ${route.view === "chat" && !route.id ? "on" : ""}`}
          onClick={() => {
            setNewChat((n) => n + 1);
            nav("#/chat");
          }}
        >
          <IconPlus />
          <span>New chat</span>
        </button>
        <nav className="c-links">
          <a className="c-row" href="#/console/dashboard">
            <IconConsole />
            <span>Console</span>
          </a>
          <a className="c-row" href="#/console/credits">
            <IconWallet />
            <span>Credits &amp; wallet</span>
          </a>
          <a className="c-row" href="/node#laptop">
            <IconNode />
            <span>Run a node</span>
          </a>
        </nav>
        <div className="c-label">Recents</div>
        <div className="c-convos" role="list">
          {conversations.length === 0 && <p className="c-empty">Chats are saved in this browser only.</p>}
          {conversations.map((c) => (
            <a key={c.id} role="listitem" className={`c-convo ${route.view === "chat" && route.id === c.id ? "on" : ""}`} href={`#/chat/${c.id}`} onClick={() => setMenu(false)} title={c.title}>
              {c.title}
            </a>
          ))}
        </div>
        <div className="c-foot">
          <button className="c-user" onClick={() => setUserMenu((v) => !v)} aria-expanded={userMenu}>
            <span className="c-avatar">{who.slice(0, 1).toUpperCase()}</span>
            <span className="c-user-text">
              <b>{who}</b>
              <small>{orgName}</small>
            </span>
            <IconChevron />
          </button>
          {userMenu && (
            <div className="c-pop c-user-menu" role="menu" onClick={() => setUserMenu(false)}>
              <div className="c-pop-head">{who}</div>
              <a role="menuitem" href="#/console/settings">
                <IconGear />
                <span>Settings</span>
              </a>
              <a role="menuitem" href="#/console/usage">
                <IconGauge />
                <span>Usage</span>
              </a>
              <a role="menuitem" href="#/console/credits">
                <IconWallet />
                <span>Credits &amp; wallet</span>
              </a>
              <a role="menuitem" href="https://github.com/Decentralised-si" target="_blank" rel="noopener">
                <IconHelp />
                <span>Get help</span>
              </a>
              <hr />
              <a role="menuitem" href="/node#laptop">
                <IconNode />
                <span>Run a node for free chat</span>
              </a>
              <a role="menuitem" href="/download">
                <IconDownload />
                <span>Get DSI Synapse</span>
              </a>
              <a role="menuitem" href="#/console/members">
                <IconUsers />
                <span>Invite your team</span>
              </a>
              <a role="menuitem" href="/home">
                <IconInfo />
                <span>Learn more</span>
                <IconRight />
              </a>
              {session.organizations.length > 1 && (
                <>
                  <hr />
                  <div className="c-pop-label">Organisation</div>
                  {session.organizations.map((o) => (
                    <button key={o.id} role="menuitem" onClick={() => switchOrg(o.id)}>
                      <span className="c-sp" />
                      <span>{o.name}</span>
                      {o.id === org && <IconCheck />}
                    </button>
                  ))}
                </>
              )}
              <hr />
              <button role="menuitem" onClick={() => logout()}>
                <IconLogout />
                <span>Log out</span>
              </button>
            </div>
          )}
        </div>
      </aside>
      <div className="c-scrim" onClick={() => setMenu(false)} />
      <main className="c-main">
        <button className="c-icon c-menu-btn" aria-label="Open menu" onClick={() => setMenu(true)}>
          <IconMenu />
        </button>
        {collapsed && (
          <button className="c-icon c-open-btn" aria-label="Open sidebar" onClick={toggleSide}>
            <IconPanel />
          </button>
        )}
        <Chat key={`${org}:${route.id ?? `new-${newChat}`}`} id={route.id} onSaved={refreshConversations} config={config} name={firstName(session.user.email)} />
      </main>
    </div>
  );
}

/** "yousef.hosseini@x" → "Yousef"; nothing for wallet-only sign-ins. */
function firstName(email?: string): string | undefined {
  const w = email?.split("@")[0].split(/[._+\-\d]/)[0];
  return w && w.length > 1 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : undefined;
}
