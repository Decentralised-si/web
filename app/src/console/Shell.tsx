import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { api, currentWorkspace, setWorkspace } from "../api";
import type { Session } from "../App";
import { Keys, LimitsTab, Logs, Members, Providers, Routing, Usage } from "../Console";
import { Agents, Batches, Files, Playground } from "./build";
import { Cost, Credits, Dashboard, Docs, Models, Notifications, OrgSettings, Workspaces } from "./pages";
import { Agent as Terminal } from "../Agent";
import type { Config } from "../api";

interface NavItem {
  id: string;
  label: string;
  group?: string;
  badge?: string;
}

const NAV: NavItem[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "keys", label: "API keys" },
  { id: "playground", label: "Playground", group: "Build" },
  { id: "files", label: "Files", group: "Build" },
  { id: "batches", label: "Batches", group: "Build" },
  { id: "agents", label: "Agents", group: "Build" },
  { id: "terminal", label: "Agent terminal", group: "Build" },
  { id: "usage", label: "Usage", group: "Analytics" },
  { id: "cost", label: "Cost", group: "Analytics" },
  { id: "logs", label: "Logs", group: "Analytics" },
  { id: "models", label: "Models", group: "Analytics" },
  { id: "limits", label: "Limits", group: "Manage" },
  { id: "workspaces", label: "Workspaces", group: "Manage" },
  { id: "members", label: "Members", group: "Manage" },
  { id: "providers", label: "Providers", group: "Manage" },
  { id: "routing", label: "Routing", group: "Manage" },
  { id: "settings", label: "Settings", group: "Manage" },
];

export function ConsoleShell({ page, arg, role, session, org, config, switchOrg, onOrgsChanged }: { page: string; arg?: string; role: string; session: Session; org: string; config: Config; switchOrg: (id: string) => void; onOrgsChanged: () => void }) {
  const { logout } = usePrivy();
  const admin = role === "owner" || role === "admin";
  const [ws, setWs] = useState(currentWorkspace());
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>([{ id: "default", name: "Default" }]);
  const [credit, setCredit] = useState<number>();
  const [unread, setUnread] = useState(0);
  const [palette, setPalette] = useState(false);
  const [menu, setMenu] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const refresh = () => {
    api("/workspaces").then((r) => setWorkspaces(r.workspaces)).catch(() => {});
    api("/org").then((o) => setCredit(o.creditUsd)).catch(() => {});
    api("/notifications").then((n) => setUnread(n.unread)).catch(() => {});
  };
  useEffect(refresh, [org, page]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
      if (e.key === "Escape") setPalette(false);
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, []);

  const chooseWs = (id: string) => {
    if (id === "__manage") return (location.hash = "#/console/workspaces");
    setWorkspace(id);
    setWs(id);
    try {
      localStorage.setItem(`dsi_ws_${org}`, id);
    } catch {
      /* private mode */
    }
    refresh();
  };
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`dsi_ws_${org}`);
      if (saved) chooseWs(saved);
    } catch {
      /* private mode */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org]);

  const go = (id: string) => {
    location.hash = `#/console/${id}`;
    setMenu(false);
    setPalette(false);
  };
  const groups = useMemo(() => {
    const out: Array<{ group?: string; items: NavItem[] }> = [];
    for (const n of NAV) {
      const last = out.at(-1);
      if (last && last.group === n.group) last.items.push(n);
      else out.push({ group: n.group, items: [n] });
    }
    return out;
  }, []);

  let body: ReactNode;
  switch (page) {
    case "dashboard":
    case "overview":
      body = <Dashboard session={session} go={go} />;
      break;
    case "keys":
      body = <Keys canLimit={admin} />;
      break;
    case "playground":
      body = <Playground initialAgent={arg} />;
      break;
    case "files":
      body = <Files />;
      break;
    case "batches":
      body = <Batches />;
      break;
    case "agents":
      body = <Agents admin={role !== "billing"} />;
      break;
    case "terminal":
      body = <Terminal />;
      break;
    case "usage":
      body = <Usage />;
      break;
    case "cost":
      body = <Cost />;
      break;
    case "logs":
      body = <Logs />;
      break;
    case "models":
      body = <Models go={go} />;
      break;
    case "limits":
      body = <LimitsTab admin={admin} />;
      break;
    case "workspaces":
      body = <Workspaces admin={admin} onChange={refresh} />;
      break;
    case "members":
      body = <Members admin={admin} me={session.user.id} />;
      break;
    case "providers":
      body = <Providers admin={admin} />;
      break;
    case "routing":
      body = <Routing admin={admin} />;
      break;
    case "settings":
      body = <OrgSettings admin={admin} role={role} session={session} onOrgsChanged={onOrgsChanged} switchOrg={switchOrg} />;
      break;
    case "notifications":
      body = <Notifications canEdit={["owner", "admin", "billing"].includes(role)} onRead={() => setUnread(0)} />;
      break;
    case "docs":
      body = <Docs />;
      break;
    case "credits":
    case "billing":
      body = <Credits role={role} config={config} session={session} />;
      break;
    default:
      body = <Dashboard session={session} go={go} />;
  }

  const orgName = session.organizations.find((o) => o.id === org)?.name ?? "Organization";
  return (
    <div className={`shell console-shell ${menu ? "menu-open" : ""}`}>
      <aside className="sidebar">
        <div className="side-top">
          <a className="brand" href="#/console/dashboard">
            Decentralised<span>.si</span> <span className="muted small">Console</span>
          </a>
          <button className="icon only-mobile" aria-label="Close menu" onClick={() => setMenu(false)}>
            ✕
          </button>
        </div>
        <select className="ws-select" value={ws} onChange={(e) => chooseWs(e.target.value)} aria-label="Workspace">
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              ◆ {w.name}
            </option>
          ))}
          <option value="__manage">Manage workspaces…</option>
        </select>
        <button className="search" onClick={() => setPalette(true)}>
          <span>Search Console…</span>
          <kbd>⌘K</kbd>
        </button>
        <nav className="console-nav" aria-label="Console">
          {groups.map((g, i) => (
            <div key={i}>
              {g.group && (
                <button className="nav-group" onClick={() => setCollapsed({ ...collapsed, [g.group!]: !collapsed[g.group!] })} aria-expanded={!collapsed[g.group]}>
                  {g.group} <span>{collapsed[g.group] ? "▸" : "▾"}</span>
                </button>
              )}
              {!(g.group && collapsed[g.group]) &&
                g.items.map((n) => (
                  <a key={n.id} href={`#/console/${n.id}`} className={`${page === n.id || (page === "overview" && n.id === "dashboard") ? "on" : ""} ${g.group ? "indent" : ""}`} onClick={() => setMenu(false)}>
                    {n.label}
                  </a>
                ))}
            </div>
          ))}
        </nav>
        <nav className="side-nav">
          <a href="#/console/notifications" className={page === "notifications" ? "on" : ""}>
            Notifications {unread > 0 && <span className="count">{unread}</span>}
          </a>
          <a href="#/console/docs" className={page === "docs" ? "on" : ""}>
            Documentation
          </a>
          <a href="#/console/credits" className={page === "credits" ? "on" : ""}>
            Credits <span className="muted right">{credit !== undefined ? `$${credit.toFixed(2)}` : ""}</span>
          </a>
          <a href="#/chat">Open chat</a>
        </nav>
        <div className="side-foot">
          <button className="user-btn" onClick={() => setUserMenu(!userMenu)} aria-expanded={userMenu}>
            <span className="avatar">{(session.user.email ?? "?").slice(0, 1).toUpperCase()}</span>
            <span className="user-lines">
              <span>{session.user.email ?? `${session.user.wallets[0]?.address.slice(0, 8)}…`}</span>
              <span className="muted fine">
                {role} · {orgName}
              </span>
            </span>
            <span>▾</span>
          </button>
          {userMenu && (
            <div className="user-menu" role="menu">
              {session.organizations.map((o) => (
                <button key={o.id} className={o.id === org ? "on" : ""} onClick={() => (switchOrg(o.id), setUserMenu(false))}>
                  {o.id === org ? "✓ " : ""}
                  {o.name} <span className="muted fine">{o.role}</span>
                </button>
              ))}
              <button onClick={() => (go("settings"), setUserMenu(false))}>Organization settings</button>
              <button onClick={() => logout()}>Sign out</button>
            </div>
          )}
        </div>
      </aside>
      <main className="main">
        <button className="icon menu-btn only-mobile" aria-label="Open menu" onClick={() => setMenu(true)}>
          ☰
        </button>
        <div className="page">{body}</div>
      </main>
      {palette && <Palette onClose={() => setPalette(false)} go={go} />}
    </div>
  );
}

/** ⌘K: jump to any console page, key, agent, file or model. */
function Palette({ onClose, go }: { onClose: () => void; go: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Array<{ label: string; hint: string; to: string }>>(NAV.map((n) => ({ label: n.label, hint: n.group ?? "Console", to: n.id })));
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    const extra: typeof items = [
      { label: "Notifications", hint: "Console", to: "notifications" },
      { label: "Documentation", hint: "Console", to: "docs" },
      { label: "Credits & billing", hint: "Console", to: "credits" },
      { label: "Create API key", hint: "Action", to: "keys" },
      { label: "Build an agent", hint: "Action", to: "agents" },
    ];
    Promise.all([api("/keys").catch(() => ({ keys: [] })), api("/agents").catch(() => ({ agents: [] })), api("/catalog").catch(() => ({ models: [] }))]).then(([k, a, m]) => {
      setItems((cur) => [
        ...cur,
        ...extra,
        ...k.keys.filter((x: any) => !x.revoked).map((x: any) => ({ label: `${x.name ?? "Key"} (${x.id}…)`, hint: "API key", to: "keys" })),
        ...a.agents.map((x: any) => ({ label: x.name, hint: "Agent", to: `playground/${x.id}` })),
        ...m.models.filter((x: any) => x.kind === "chat").map((x: any) => ({ label: x.id, hint: "Model", to: "models" })),
      ]);
    });
  }, []);
  const shown = items.filter((x) => `${x.label} ${x.hint}`.toLowerCase().includes(q.toLowerCase())).slice(0, 12);
  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="palette" role="dialog" aria-label="Search console" onClick={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={q}
          placeholder="Search pages, keys, agents, models…"
          onChange={(e) => (setQ(e.target.value), setI(0))}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setI((x) => Math.min(shown.length - 1, x + 1));
            if (e.key === "ArrowUp") setI((x) => Math.max(0, x - 1));
            if (e.key === "Enter" && shown[i]) go(shown[i].to);
          }}
        />
        <div role="listbox">
          {shown.map((x, k) => (
            <button key={`${x.label}${k}`} className={k === i ? "on" : ""} onMouseEnter={() => setI(k)} onClick={() => go(x.to)} role="option" aria-selected={k === i}>
              <span>{x.label}</span>
              <span className="muted fine">{x.hint}</span>
            </button>
          ))}
          {!shown.length && <p className="muted small pad">No results</p>}
        </div>
      </div>
    </div>
  );
}
