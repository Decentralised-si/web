import { useEffect, useMemo, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { API, api, type Config } from "../api";
import type { Session } from "../App";
import { Bars, dailyTotals, int, LimitFields, Section, Stat, useLoad, usd, when, type Limits } from "../Console";
import { Wallet } from "../Wallet";

// ---------------------------------------------------------------- Dashboard

function Ring({ value, max }: { value: number; max?: number }) {
  const pct = max ? Math.min(1, value / max) : 0;
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" role="img" aria-label={max ? `${Math.round(pct * 100)}% of limit` : "no limit set"}>
      <circle cx="32" cy="32" r={r} fill="none" stroke="var(--line)" strokeWidth="6" />
      <circle cx="32" cy="32" r={r} fill="none" stroke={pct >= 0.9 ? "var(--bad)" : "var(--accent)"} strokeWidth="6" strokeDasharray={`${c * pct} ${c}`} strokeLinecap="round" transform="rotate(-90 32 32)" />
    </svg>
  );
}

const TIERS = [
  { label: "Most capable", level: 3, tags: ["Research", "Complex projects"] },
  { label: "Reasoning", level: 2, tags: ["Agents", "Coding"] },
  { label: "Everyday", level: 1, tags: ["Writing", "Cost-efficient"] },
  { label: "Fastest", level: 0, tags: ["Lowest cost", "High volume"] },
];

export function Dashboard({ session, go }: { session: Session; go: (id: string) => void }) {
  const org = useLoad(() => api("/org"));
  const usage = useLoad(() => api("/usage?days=7"));
  const cat = useLoad(() => api("/catalog"));
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const name = session.user.email?.split("@")[0] ?? "there";
  const o = org.data;
  const t = usage.data?.totals;
  const cacheShare = t && t.inputTokens ? t.cacheReadTokens / t.inputTokens : 0;
  const resets = useMemo(() => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }, []);
  // One model per tier: best available (or best overall) at each reasoning level.
  const picks = useMemo(() => {
    const ms = (cat.data?.models ?? []).filter((m: any) => m.kind === "chat");
    return TIERS.map((tier) => {
      const at = ms.filter((m: any) => (m.reasoningLevel ?? levelOf(m.quality)) === tier.level).sort((a: any, b: any) => Number(b.available) - Number(a.available) || b.quality - a.quality);
      return { tier, model: at[0] };
    });
  }, [cat.data]);
  return (
    <>
      <div className="page-head row between wrap">
        <h1 className="serif">
          {greeting}, {name}
        </h1>
        <div className="row">
          <button onClick={() => go("docs")} aria-label="Documentation">
            Docs
          </button>
          <button onClick={() => go("keys")}>Get API key</button>
          <button className="primary" onClick={() => go("agents")}>
            Build an agent
          </button>
        </div>
      </div>
      <div className="grid3">
        <section className="card">
          <div className="muted small">Organization credits</div>
          <div className="row between">
            <div className="big">{o ? usd(o.creditUsd) : "…"}</div>
            <button onClick={() => go("credits")}>Add funds</button>
          </div>
          <a className="small" href="#/console/notifications">
            Set a low-balance alert
          </a>
        </section>
        <section className="card">
          <div className="muted small">Spend this month</div>
          <div className="row between">
            <div>
              <div className="big">{o ? usd(o.spend.month) : "…"}</div>
              <div className="fine muted">
                {o?.limits.monthlySpendUsd !== undefined ? `of ${usd(o.limits.monthlySpendUsd)} limit` : "no monthly limit"} · resets {resets}
              </div>
            </div>
            <Ring value={o?.spend.month ?? 0} max={o?.limits.monthlySpendUsd} />
          </div>
        </section>
        <section className="card">
          <div className="muted small">Prompt caching</div>
          <div className="big">{t ? int(t.cacheReadTokens) : "…"}</div>
          <div className="fine muted">tokens reused in 7 days{t?.inputTokens ? ` · ${(cacheShare * 100).toFixed(1)}% of input` : ""}</div>
        </section>
      </div>
      <Section title="Token volume" actions={<button onClick={() => go("playground")}>Try a prompt</button>}>
        {t && t.requests === 0 ? <p className="muted">No activity in the last 7 days</p> : <Bars rows={dailyTotals(usage.data?.rows ?? [])} value="tokens" format={int} />}
      </Section>
      <div className="row between">
        <h2>Models</h2>
        <a href="#/console/models">Compare models</a>
      </div>
      <div className="grid4 models">
        {picks.map(({ tier, model }, i) => (
          <a key={tier.label} className={`card model-card tone${i}`} href="#/console/models">
            <div className="model-art" aria-hidden>
              {["◆", "✦", "◉", "➶"][i]}
            </div>
            <h3>{model?.id ?? "—"}</h3>
            <div className="fine muted">
              {tier.label}
              {model && !model.available ? " · connect a provider" : ""}
            </div>
            <div className="row wrap">
              {tier.tags.map((x) => (
                <span key={x} className="pill">
                  {x}
                </span>
              ))}
            </div>
          </a>
        ))}
      </div>
      <h2>Resources</h2>
      <div className="grid4">
        {[
          ["Playground", "Test prompts across models, then get the code.", "playground"],
          ["Batch API", "Run thousands of requests asynchronously; collect JSONL results.", "batches"],
          ["Files", "Upload documents and images once; reference them by id.", "files"],
          ["Agent terminal", "DSI Agent Terminal in your shell, routed through Decentralised.si.", "terminal"],
        ].map(([title, body, to]) => (
          <section key={to} className="card">
            <h3>{title}</h3>
            <p className="small muted">{body}</p>
            <button onClick={() => go(to)}>Open</button>
          </section>
        ))}
      </div>
    </>
  );
}

const levelOf = (q: number) => (q >= 0.93 ? 3 : q >= 0.86 ? 2 : q >= 0.78 ? 1 : 0);

// ---------------------------------------------------------------- Models

export function Models({ go }: { go: (id: string) => void }) {
  const c = useLoad(() => api("/catalog"));
  const [filter, setFilter] = useState<"all" | "available">("all");
  const [kind, setKind] = useState<"chat" | "embedding">("chat");
  const rows = (c.data?.models ?? []).filter((m: any) => m.kind === kind && (filter === "all" || m.available));
  return (
    <>
      <div className="page-head">
        <h1>Models</h1>
        <p className="muted small">Every model the router can use. "Available" means your organisation can reach it now: through your own provider key (BYOK), platform access, or the decentralised network.</p>
      </div>
      <div className="row">
        <select value={kind} onChange={(e) => setKind(e.target.value as never)} aria-label="Kind">
          <option value="chat">Chat models</option>
          <option value="embedding">Embedding models</option>
        </select>
        <select value={filter} onChange={(e) => setFilter(e.target.value as never)} aria-label="Filter">
          <option value="all">All models</option>
          <option value="available">Available to me</option>
        </select>
        <button onClick={() => go("providers")}>Connect providers</button>
      </div>
      <Section title={`${rows.length} models`}>
        <div className="tbl">
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th>Provider</th>
                <th>Level</th>
                <th>Context</th>
                <th>Max output</th>
                <th>Input / 1M</th>
                <th>Output / 1M</th>
                <th>Capabilities</th>
                <th>Access</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m: any) => (
                <tr key={m.id}>
                  <td>
                    <code>{m.id}</code>
                  </td>
                  <td>{m.operator ?? m.provider}</td>
                  <td>L{m.reasoningLevel ?? levelOf(m.quality)}</td>
                  <td>{int(m.contextWindow)}</td>
                  <td>{m.maxOutput ? int(m.maxOutput) : "—"}</td>
                  <td>${m.inputPer1M}</td>
                  <td>{m.outputPer1M ? `$${m.outputPer1M}` : "—"}</td>
                  <td className="small">{m.features.filter((f: string) => !["system", "streaming"].includes(f)).join(", ")}</td>
                  <td>{m.available ? <span className="pill ok">{m.market}</span> : <span className="pill">not connected</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- Cost

export function Cost() {
  const [days, setDays] = useState(30);
  const u = useLoad(() => api(`/usage?days=${days}`), [days]);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const st = useLoad(() => api(`/billing/statement?month=${month}`), [month]);
  const byDay = dailyTotals(u.data?.rows ?? []);
  const byMarket = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of u.data?.rows ?? []) m[r.market || "—"] = (m[r.market || "—"] ?? 0) + (r.settledUsd || r.costUsd);
    return m;
  }, [u.data]);
  return (
    <>
      <div className="page-head row between">
        <h1>Cost</h1>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
          {[7, 30, 90].map((d) => (
            <option key={d} value={d}>
              Last {d} days
            </option>
          ))}
        </select>
      </div>
      <div className="grid4">
        <Stat label="Billed by Decentralised.si" value={u.data ? usd(u.data.totals.billedUsd) : "…"} sub="network + platform, from credit" />
        <Stat label="Estimated at list price" value={u.data ? usd(u.data.totals.costUsd) : "…"} sub="incl. your own vendor keys" />
        {Object.entries(byMarket).map(([k, v]) => (
          <Stat key={k} label={`Market: ${k}`} value={usd(v)} />
        ))}
      </div>
      <Section title="Daily cost">
        <Bars rows={byDay} value="costUsd" format={usd} />
      </Section>
      <Section
        title="Monthly statement"
        actions={
          <div className="row">
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" />
            <button onClick={() => printStatement(st.data)}>Print / save PDF</button>
          </div>
        }
      >
        {st.data && (
          <>
            <p className="small">
              Credit added {usd(st.data.depositsUsd)} · billed {usd(st.data.billedUsd)} · current balance {usd(st.data.closingCreditUsd)}
            </p>
            <div className="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Requests</th>
                    <th>Input tokens</th>
                    <th>Output tokens</th>
                    <th>Billed</th>
                  </tr>
                </thead>
                <tbody>
                  {st.data.usage.map((r: any) => (
                    <tr key={r.model}>
                      <td>{r.model}</td>
                      <td>{int(r.requests)}</td>
                      <td>{int(r.inputTokens)}</td>
                      <td>{int(r.outputTokens)}</td>
                      <td>{usd(r.billedUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Section>
    </>
  );
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Opens a printable statement or receipt in a new window (the browser's print dialog saves it as PDF). */
export function printDoc(title: string, html: string) {
  const w = open("", "_blank");
  if (!w) return;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:14px/1.5 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#111}h1{font-size:22px}table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}.muted{color:#666}</style></head><body>${html}<script>onload=()=>print()</script></body></html>`);
  w.document.close();
}

function printStatement(s: any) {
  if (!s) return;
  printDoc(
    `Statement ${s.month}`,
    `<h1>Decentralised.si — statement ${esc(s.month)}</h1><p class="muted">${esc(s.organization.name ?? s.organization.id)} · generated ${esc(new Date(s.generatedAt).toUTCString())}</p>
<h2>Credit added</h2><table><tr><th>Date</th><th>Method</th><th>Asset</th><th>Amount</th><th>Credit (USD)</th><th>Reference</th></tr>${s.deposits
      .map((d: any) => `<tr><td>${esc(d.createdAt.slice(0, 10))}</td><td>${esc(d.method)}</td><td>${esc(d.token)}</td><td>${esc(d.amount)}</td><td>${d.usdValue.toFixed(2)}</td><td>${esc(d.txHash ?? d.reference ?? "")}</td></tr>`)
      .join("")}</table><p>Total added: $${s.depositsUsd.toFixed(2)}</p>
<h2>Usage billed</h2><table><tr><th>Model</th><th>Requests</th><th>Input tokens</th><th>Output tokens</th><th>Billed (USD)</th></tr>${s.usage
      .map((r: any) => `<tr><td>${esc(r.model)}</td><td>${r.requests}</td><td>${r.inputTokens}</td><td>${r.outputTokens}</td><td>${r.billedUsd.toFixed(4)}</td></tr>`)
      .join("")}</table><p>Total billed: $${s.billedUsd.toFixed(2)} · balance at generation: $${s.closingCreditUsd.toFixed(2)}</p>
<p class="muted">Usage through your own provider keys is billed by those providers and not included.</p>`,
  );
}

// ---------------------------------------------------------------- Notifications

export function Notifications({ canEdit, onRead }: { canEdit: boolean; onRead: () => void }) {
  const n = useLoad(() => api("/notifications"));
  const al = useLoad(() => api("/alerts"));
  const [form, setForm] = useState<any>();
  const [msg, setMsg] = useState<string>();
  useEffect(() => {
    if (al.data) setForm({ ...al.data.alerts, thresholds: (al.data.alerts.thresholdsPct ?? [50, 80, 100]).join(", ") });
  }, [al.data]);
  useEffect(() => {
    if (n.data?.unread) api("/notifications/read", { body: {} }).then(onRead);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n.data]);
  const save = () =>
    api("/alerts", { method: "PUT", body: { monthlyBudgetUsd: form.monthlyBudgetUsd, lowCreditUsd: form.lowCreditUsd, webhookUrl: form.webhookUrl || undefined, thresholdsPct: String(form.thresholds).split(",").map((x) => Number(x.trim())).filter(Boolean) } })
      .then(() => setMsg("Saved."))
      .catch((e) => setMsg(e.message));
  return (
    <>
      <div className="page-head">
        <h1>Notifications</h1>
      </div>
      {form && (
        <Section title="Alerts">
          <div className="grid4">
            <label>
              Monthly budget (USD)
              <input type="number" min="0" step="1" value={form.monthlyBudgetUsd ?? ""} placeholder="uses monthly limit" onChange={(e) => setForm({ ...form, monthlyBudgetUsd: e.target.value })} disabled={!canEdit} />
            </label>
            <label>
              Notify at (% of budget)
              <input value={form.thresholds} onChange={(e) => setForm({ ...form, thresholds: e.target.value })} disabled={!canEdit} />
            </label>
            <label>
              Low credit below (USD)
              <input type="number" min="0" step="1" value={form.lowCreditUsd ?? ""} placeholder="off" onChange={(e) => setForm({ ...form, lowCreditUsd: e.target.value })} disabled={!canEdit} />
            </label>
            <label>
              Webhook (Slack, Discord, Teams)
              <input type="url" value={form.webhookUrl ?? ""} placeholder="https://hooks.slack.com/…" onChange={(e) => setForm({ ...form, webhookUrl: e.target.value })} disabled={!canEdit} />
            </label>
          </div>
          <div className="row">
            <button className="primary" onClick={save} disabled={!canEdit}>
              Save alerts
            </button>
            <button onClick={() => api("/alerts/test", { body: {} }).then(n.reload)}>Send test</button>
            {msg && <span className="small">{msg}</span>}
          </div>
        </Section>
      )}
      <Section title="Inbox">
        {(n.data?.notifications ?? []).map((x: any) => (
          <div key={x.id} className={`notif ${x.read ? "" : "unread"}`}>
            <div className="row between">
              <strong>{x.title}</strong>
              <span className="fine muted">{when(x.createdAt)}</span>
            </div>
            {x.body && <p className="small muted">{x.body}</p>}
          </div>
        ))}
        {n.data && !n.data.notifications.length && <p className="muted">Nothing yet. Budget, low-credit, deposit and batch notifications appear here.</p>}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- Credits

export function Credits({ role, config, session }: { role: string; config: Config; session: Session }) {
  return <Wallet role={role} config={config} session={session} />;
}

// ---------------------------------------------------------------- Workspaces

export function Workspaces({ admin, onChange }: { admin: boolean; onChange: () => void }) {
  const w = useLoad(() => api("/workspaces"));
  const keys = useLoad(() => api("/keys"));
  const [name, setName] = useState("");
  const [edit, setEdit] = useState<{ id: string; name: string; limits: Limits }>();
  const [msg, setMsg] = useState<string>();
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const k of keys.data?.keys ?? []) if (!k.revoked) m[k.workspaceId ?? "default"] = (m[k.workspaceId ?? "default"] ?? 0) + 1;
    return m;
  }, [keys.data]);
  const done = () => (w.reload(), onChange());
  return (
    <>
      <div className="page-head">
        <h1>Workspaces</h1>
        <p className="muted small">Separate projects or environments: each workspace has its own API keys, rate and spend limits, and usage. Choose the active workspace from the selector at the top of the sidebar.</p>
      </div>
      {admin && (
        <Section title="Create workspace">
          <div className="row">
            <input placeholder="e.g. production, staging, research" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
            <button className="primary" onClick={() => api("/workspaces", { body: { name } }).then(() => (setName(""), done())).catch((e) => setMsg(e.message))}>
              Create
            </button>
          </div>
          {msg && <p className="err small">{msg}</p>}
        </Section>
      )}
      <Section title="Workspaces">
        <div className="tbl">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>ID</th>
                <th>Keys</th>
                <th>Limits</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(w.data?.workspaces ?? []).map((x: any) => (
                <tr key={x.id}>
                  <td>{x.name}</td>
                  <td>
                    <code>{x.id}</code>
                  </td>
                  <td>{counts[x.id] ?? 0}</td>
                  <td className="small">{x.id === "default" ? "organisation limits" : x.limits && Object.keys(x.limits).length ? Object.entries(x.limits).map(([k, v]) => `${k}: ${v}`).join(" · ") : "organisation limits"}</td>
                  <td>{when(x.createdAt)}</td>
                  <td className="row">
                    {admin && x.id !== "default" && (
                      <>
                        <button onClick={() => setEdit({ id: x.id, name: x.name, limits: x.limits ?? {} })}>Edit</button>
                        <button className="danger" onClick={() => api(`/workspaces/${x.id}`, { method: "PATCH", body: { archived: true } }).then(done)}>
                          Archive
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {edit && (
          <div className="reveal">
            <label>
              Name
              <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </label>
            <LimitFields value={edit.limits} onChange={(l) => setEdit({ ...edit, limits: l })} />
            <div className="row">
              <button className="primary" onClick={() => api(`/workspaces/${edit.id}`, { method: "PATCH", body: { name: edit.name, limits: edit.limits } }).then(() => (setEdit(undefined), done()))}>
                Save
              </button>
              <button onClick={() => setEdit(undefined)}>Cancel</button>
            </div>
          </div>
        )}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- Organization & profile

export function OrgSettings({ admin, role, session, onOrgsChanged, switchOrg }: { admin: boolean; role: string; session: Session; onOrgsChanged: () => void; switchOrg: (id: string) => void }) {
  const org = useLoad(() => api("/org"));
  const { user, linkEmail, linkWallet, linkGoogle, linkGithub } = usePrivy();
  const [name, setName] = useState("");
  const [newOrg, setNewOrg] = useState("");
  const [msg, setMsg] = useState<string>();
  const [confirmLeave, setConfirmLeave] = useState(false);
  useEffect(() => {
    if (org.data) setName(org.data.name ?? "");
  }, [org.data]);
  const linked = (user?.linkedAccounts ?? []) as Array<{ type: string; address?: string; email?: string }>;
  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      <Section title="Organization">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={!admin} />
        </label>
        <div className="row">
          <button className="primary" disabled={!admin} onClick={() => api("/org", { method: "PATCH", body: { name } }).then(() => (setMsg("Saved."), onOrgsChanged())).catch((e) => setMsg(e.message))}>
            Save
          </button>
          {msg && <span className="small">{msg}</span>}
        </div>
        <p className="small muted">
          Organization id <code>{org.data?.id}</code> · your role: {role}
        </p>
        <div className="row">
          {confirmLeave ? (
            <button className="danger" onClick={() => api("/org/leave", { body: {} }).then(() => (onOrgsChanged(), switchOrg(session.defaultOrganization))).catch((e) => setMsg(e.message))}>
              Confirm: leave {org.data?.name}
            </button>
          ) : (
            <button className="danger" onClick={() => setConfirmLeave(true)}>
              Leave organisation
            </button>
          )}
        </div>
      </Section>
      <Section title="Create another organisation">
        <div className="row">
          <input placeholder="Organization name" value={newOrg} onChange={(e) => setNewOrg(e.target.value)} style={{ flex: 1 }} />
          <button
            className="primary"
            onClick={() =>
              api("/orgs", { body: { name: newOrg } })
                .then((r) => (onOrgsChanged(), switchOrg(r.organization.id)))
                .catch((e) => setMsg(e.message))
            }
          >
            Create
          </button>
        </div>
      </Section>
      <Section title="Your profile">
        <p className="small">Signed in as {session.user.email ?? session.user.id}</p>
        <div className="tbl">
          <table>
            <tbody>
              {linked.map((a, i) => (
                <tr key={i}>
                  <td>{a.type.replace("_oauth", "")}</td>
                  <td>
                    <code>{a.email ?? a.address ?? ""}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row wrap">
          <button onClick={() => linkEmail()}>Link email</button>
          <button onClick={() => linkWallet()}>Link wallet</button>
          <button onClick={() => linkGoogle()}>Link Google</button>
          <button onClick={() => linkGithub()}>Link GitHub</button>
        </div>
        <p className="fine muted">Linked wallets can fund this account; deposits are only credited from wallets linked here.</p>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- Documentation

export function Docs() {
  const block = (t: string) => <pre className="codeblock">{t}</pre>;
  return (
    <div className="docs">
      <div className="page-head">
        <h1>Documentation</h1>
        <p className="muted">
          Decentralised.si speaks the Anthropic, OpenAI and Gemini APIs. Keep your SDK and code; change the base URL. Full design: <a href="/whitepaper">whitepaper</a>.
        </p>
      </div>
      <Section title="Quickstart">
        {block(`from anthropic import Anthropic
client = Anthropic(api_key="ds_live_...", base_url="${API}/anthropic")
msg = client.messages.create(model="auto", max_tokens=1024, messages=[{"role": "user", "content": "Hello"}])`)}
        {block(`from openai import OpenAI
client = OpenAI(api_key="ds_live_...", base_url="${API}/openai/v1")`)}
        {block(`from google import genai
client = genai.Client(api_key="ds_live_...", http_options={"base_url": "${API}/gemini"})`)}
      </Section>
      <Section title="Endpoints">
        <div className="tbl">
          <table>
            <tbody>
              {[
                ["Messages", "POST /anthropic/v1/messages", "streaming, tools, vision, structured output"],
                ["Count tokens", "POST /anthropic/v1/messages/count_tokens", ""],
                ["Message Batches", "POST/GET /anthropic/v1/messages/batches[/{id}[/results|/cancel]]", "async, JSONL results"],
                ["Files", "POST/GET/DELETE /anthropic/v1/files[/{id}[/content]] · /openai/v1/files", "reference by file_id in messages"],
                ["Chat Completions", "POST /openai/v1/chat/completions", ""],
                ["Responses", "POST /openai/v1/responses", ""],
                ["Embeddings", "POST /openai/v1/embeddings", ""],
                ["Models", "GET /openai/v1/models · /anthropic/v1/models · /gemini/v1beta/models", "includes auto"],
                ["Gemini", "POST /gemini/v1beta/models/{m}:generateContent | :streamGenerateContent", ""],
                ["MCP", "POST /mcp", "tools: ask, explain_route, list_models, network_status, pai_account"],
              ].map(([a, b, c]) => (
                <tr key={a}>
                  <td>{a}</td>
                  <td>
                    <code>{b}</code>
                  </td>
                  <td className="small muted">{c}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Section title="Models, agents and routing">
        <ul className="small">
          <li>
            <code>model: "auto"</code> lets the router choose; a specific model id is used exactly (passthrough).
          </li>
          <li>
            <code>model: "agent:&lt;id&gt;"</code> runs a saved agent (instructions, model, parameters, tools).
          </li>
          <li>
            Headers (optional): <code>X-Decentralise-Mode</code>, <code>-Max-Cost</code>, <code>-Max-Latency-Ms</code>, <code>-Min-Quality</code>, <code>-Privacy</code>, <code>-Reasoning</code> (0–3), <code>-Session</code>, <code>-Workspace</code>.
          </li>
          <li>
            Every response reports <code>x-decentralise-actual-provider</code>, <code>-actual-model</code>, <code>-market</code>, <code>-receipt</code>; rate limits in <code>anthropic-ratelimit-*</code> and <code>x-ratelimit-*</code>.
          </li>
        </ul>
      </Section>
      <Section title="Keys and limits">
        <ul className="small">
          <li>
            <strong>Inference keys</strong> call models, files and batches. <strong>Admin keys</strong> manage the organisation through <code>/api/*</code> and cannot call models.
          </li>
          <li>Limits (requests/min, tokens/min, daily and monthly spend) apply per key, per workspace and per organisation; over-limit requests get HTTP 429 with <code>retry-after</code>.</li>
        </ul>
      </Section>
    </div>
  );
}
