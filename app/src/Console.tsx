import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";
import type { Session } from "./App";

const TABS = [
  ["overview", "Overview"],
  ["usage", "Usage & cost"],
  ["keys", "API keys"],
  ["limits", "Limits"],
  ["logs", "Logs"],
  ["members", "Members"],
  ["providers", "Providers"],
  ["routing", "Routing"],
  ["settings", "Settings"],
] as const;

export const usd = (n: number) => (n === 0 ? "$0.00" : n < 0.01 ? `$${n.toFixed(5)}` : `$${n.toFixed(2)}`);
export const int = (n: number) => n.toLocaleString();
export const when = (s?: string) => (s ? new Date(s).toLocaleString() : "—");

export type Limits = { rpm?: number; tpm?: number; dailySpendUsd?: number; monthlySpendUsd?: number };

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    fn()
      .then((d) => live && (setData(d), setError(undefined)))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, reload: () => setN((x) => x + 1) };
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      <div className="row between">
        <h2>{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="muted small">{label}</div>
      <div className="big">{value}</div>
      {sub && <div className="fine muted">{sub}</div>}
    </div>
  );
}

export function LimitFields({ value, onChange }: { value: Limits; onChange: (l: Limits) => void }) {
  const f = (k: keyof Limits, label: string, step: string, placeholder: string) => (
    <label>
      {label}
      <input
        type="number"
        min="0"
        step={step}
        placeholder={placeholder}
        value={value[k] ?? ""}
        onChange={(e) => onChange({ ...value, [k]: e.target.value === "" ? undefined : Number(e.target.value) })}
      />
    </label>
  );
  return (
    <div className="grid4">
      {f("rpm", "Requests / minute", "1", "no limit")}
      {f("tpm", "Tokens / minute", "1000", "no limit")}
      {f("dailySpendUsd", "Daily spend (USD)", "0.01", "no limit")}
      {f("monthlySpendUsd", "Monthly spend (USD)", "1", "no limit")}
    </div>
  );
}

/** Minimal accessible bar chart. */
export function Bars({ rows, value, format }: { rows: Array<{ day: string } & Record<string, number | string>>; value: string; format: (n: number) => string }) {
  const max = Math.max(1e-12, ...rows.map((r) => Number(r[value])));
  if (!rows.length) return <p className="muted">No usage in this period.</p>;
  return (
    <div className="bars" role="img" aria-label={`Daily ${value}`}>
      {rows.map((r) => (
        <div key={r.day} className="bar-col" title={`${r.day}: ${format(Number(r[value]))}`}>
          <div className="bar" style={{ height: `${(Number(r[value]) / max) * 100}%` }} />
          <div className="bar-label">{r.day.slice(5)}</div>
        </div>
      ))}
    </div>
  );
}

export function Console({ tab, role, session }: { tab: string; role: string; session: Session }) {
  const admin = role === "owner" || role === "admin";
  return (
    <div className="page">
      <div className="page-head">
        <h1>Console</h1>
        <nav className="tabs" aria-label="Console sections">
          {TABS.map(([id, label]) => (
            <a key={id} href={`#/console/${id}`} className={tab === id ? "on" : ""}>
              {label}
            </a>
          ))}
        </nav>
      </div>
      {tab === "overview" && <Overview />}
      {tab === "usage" && <Usage />}
      {tab === "keys" && <Keys canLimit={admin} />}
      {tab === "limits" && <LimitsTab admin={admin} />}
      {tab === "logs" && <Logs />}
      {tab === "members" && <Members admin={admin} me={session.user.id} />}
      {tab === "providers" && <Providers admin={admin} />}
      {tab === "routing" && <Routing admin={admin} />}
      {tab === "settings" && <Settings admin={admin} role={role} />}
    </div>
  );
}

export function Overview() {
  const org = useLoad(() => api("/org"));
  const usage = useLoad(() => api("/usage?days=30"));
  const net = useLoad(() => api("/network"));
  if (org.error) return <p className="err">{org.error}</p>;
  const o = org.data;
  const t = usage.data?.totals;
  return (
    <>
      <div className="grid4">
        <Stat label="Credit balance" value={o ? usd(o.creditUsd) : "…"} sub="Pays for network and platform models" />
        <Stat label="Spend today" value={o ? usd(o.spend.day) : "…"} sub={o?.limits.dailySpendUsd !== undefined ? `limit ${usd(o.limits.dailySpendUsd)}` : "no daily limit"} />
        <Stat label="Spend this month" value={o ? usd(o.spend.month) : "…"} sub={o?.limits.monthlySpendUsd !== undefined ? `limit ${usd(o.limits.monthlySpendUsd)}` : "no monthly limit"} />
        <Stat label="Requests (30 days)" value={t ? int(t.requests) : "…"} sub={t ? `${int(t.inputTokens + t.outputTokens)} tokens` : undefined} />
      </div>
      <Section title="Daily cost, last 30 days">
        <Bars rows={dailyTotals(usage.data?.rows ?? [])} value="costUsd" format={usd} />
      </Section>
      <Section title="Get started">
        <ol className="steps">
          <li>
            Create an API key in <a href="#/console/keys">API keys</a>.
          </li>
          <li>
            Point your existing SDK at <code>https://api.decentralised.si/anthropic</code>, <code>/openai/v1</code> or <code>/gemini</code>. Nothing else changes.
          </li>
          <li>
            Fund usage with crypto in <a href="#/wallet">Wallet &amp; billing</a>, or connect your own vendor keys in <a href="#/console/providers">Providers</a>.
          </li>
          <li>
            Install the <a href="#/agent">agent terminal</a> (Hermes) to work from your shell.
          </li>
        </ol>
        {net.data && <p className="fine muted">Network: {net.data.nodes.routable} live nodes · today's PAI emission {Math.round(net.data.emission_today_pai).toLocaleString()}</p>}
      </Section>
    </>
  );
}

export function dailyTotals(rows: any[]) {
  const m = new Map<string, any>();
  for (const r of rows) {
    const d = m.get(r.day) ?? { day: r.day, costUsd: 0, requests: 0, tokens: 0 };
    d.costUsd += r.settledUsd || r.costUsd;
    d.requests += r.requests;
    d.tokens += r.inputTokens + r.outputTokens;
    m.set(r.day, d);
  }
  return [...m.values()];
}

export function Usage() {
  const [days, setDays] = useState(30);
  const [group, setGroup] = useState<"model" | "apiKeyId" | "market">("model");
  const u = useLoad(() => api(`/usage?days=${days}`), [days]);
  const keys = useLoad(() => api("/keys"));
  const names = useMemo(() => Object.fromEntries((keys.data?.keys ?? []).map((k: any) => [k.id, k.name])), [keys.data]);
  const grouped = useMemo(() => {
    const m = new Map<string, any>();
    for (const r of u.data?.rows ?? []) {
      const k = r[group] || (group === "apiKeyId" ? "(unknown)" : "—");
      const g = m.get(k) ?? { key: k, requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, billedUsd: 0 };
      g.requests += r.requests;
      g.errors += r.errors;
      g.inputTokens += r.inputTokens;
      g.outputTokens += r.outputTokens;
      g.costUsd += r.costUsd;
      g.billedUsd += r.settledUsd;
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.costUsd - a.costUsd);
  }, [u.data, group]);
  const t = u.data?.totals;
  const csv = () => {
    const lines = ["day,model,provider,market,api_key,requests,errors,input_tokens,output_tokens,estimated_cost_usd,billed_usd", ...(u.data?.rows ?? []).map((r: any) => [r.day, r.model, r.provider, r.market, r.apiKeyId, r.requests, r.errors, r.inputTokens, r.outputTokens, r.costUsd, r.settledUsd].join(","))];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.download = `decentralised-usage-${days}d.csv`;
    a.click();
  };
  return (
    <>
      <div className="row">
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
          {[1, 7, 30, 90].map((d) => (
            <option key={d} value={d}>
              Last {d} day{d > 1 ? "s" : ""}
            </option>
          ))}
        </select>
        <button onClick={csv}>Export CSV</button>
      </div>
      <div className="grid4">
        <Stat label="Requests" value={t ? int(t.requests) : "…"} sub={t ? `${int(t.errors)} errors` : undefined} />
        <Stat label="Input tokens" value={t ? int(t.inputTokens) : "…"} />
        <Stat label="Output tokens" value={t ? int(t.outputTokens) : "…"} />
        <Stat label="Billed" value={t ? usd(t.billedUsd) : "…"} sub={t ? `est. list cost ${usd(t.costUsd)} (BYOK billed by your vendor)` : undefined} />
      </div>
      <Section title="Tokens per day">
        <Bars rows={dailyTotals(u.data?.rows ?? [])} value="tokens" format={int} />
      </Section>
      <Section
        title="Breakdown"
        actions={
          <select value={group} onChange={(e) => setGroup(e.target.value as never)} aria-label="Group by">
            <option value="model">By model</option>
            <option value="apiKeyId">By API key</option>
            <option value="market">By market</option>
          </select>
        }
      >
        <div className="tbl">
          <table>
            <thead>
              <tr>
                <th>{group === "apiKeyId" ? "API key" : group === "market" ? "Market" : "Model"}</th>
                <th>Requests</th>
                <th>Errors</th>
                <th>Input</th>
                <th>Output</th>
                <th>Est. cost</th>
                <th>Billed</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map((g) => (
                <tr key={g.key}>
                  <td>{group === "apiKeyId" ? (g.key === "web" ? "Chat (web)" : names[g.key] ? `${names[g.key]} (${g.key}…)` : g.key) : g.key}</td>
                  <td>{int(g.requests)}</td>
                  <td>{int(g.errors)}</td>
                  <td>{int(g.inputTokens)}</td>
                  <td>{int(g.outputTokens)}</td>
                  <td>{usd(g.costUsd)}</td>
                  <td>{usd(g.billedUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}

export function Keys({ canLimit }: { canLimit: boolean }) {
  const keys = useLoad(() => api("/keys"));
  const [name, setName] = useState("");
  const [limits, setLimits] = useState<Limits>({});
  const [scope, setScope] = useState<"inference" | "admin">("inference");
  const [created, setCreated] = useState<string>();
  const [err, setErr] = useState<string>();
  const [editing, setEditing] = useState<string>();
  const [editLimits, setEditLimits] = useState<Limits>({});
  const [confirm, setConfirm] = useState<string>();
  const create = async () => {
    try {
      const r = await api("/keys", { body: { name: name || "Untitled key", scope, ...(canLimit && Object.keys(limits).length ? { limits } : {}) } });
      setCreated(r.api_key);
      setName("");
      setLimits({});
      keys.reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const active = (keys.data?.keys ?? []).filter((k: any) => !k.revoked);
  const revoked = (keys.data?.keys ?? []).filter((k: any) => k.revoked);
  return (
    <>
      <Section title="Create a key">
        <div className="row wrap">
          <input placeholder="Key name, e.g. production-backend" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
          <select value={scope} onChange={(e) => setScope(e.target.value as never)} aria-label="Key type" title="Inference keys call models; admin keys manage the organization">
            <option value="inference">Inference key</option>
            {canLimit && <option value="admin">Admin key</option>}
          </select>
          <button className="primary" onClick={create}>
            Create key
          </button>
        </div>
        {canLimit && (
          <details>
            <summary className="small">Per-key limits (optional)</summary>
            <LimitFields value={limits} onChange={setLimits} />
          </details>
        )}
        {created && (
          <div className="reveal">
            <p className="small">Copy your key now. For your security it won't be shown again.</p>
            <div className="row">
              <code className="secret">{created}</code>
              <button onClick={() => navigator.clipboard.writeText(created)}>Copy</button>
              <button className="link" onClick={() => setCreated(undefined)}>
                Done
              </button>
            </div>
          </div>
        )}
        {err && <p className="err">{err}</p>}
      </Section>
      <Section title={`Active keys (${active.length})`}>
        <div className="tbl">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Type</th>
                <th>Workspace</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Limits</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {active.map((k: any) => (
                <tr key={k.id}>
                  <td>{k.name ?? "—"}</td>
                  <td>
                    <code>{k.id}…</code>
                  </td>
                  <td>{k.scope ?? "full"}</td>
                  <td>{k.workspaceId ?? "default"}</td>
                  <td>{when(k.createdAt)}</td>
                  <td>{when(k.lastUsedAt)}</td>
                  <td className="small">{fmtLimits(k.limits)}</td>
                  <td className="row">
                    {canLimit && (
                      <button
                        onClick={() => {
                          setEditing(k.id);
                          setEditLimits(k.limits ?? {});
                        }}
                      >
                        Limits
                      </button>
                    )}
                    <button
                      onClick={async () => {
                        const n = prompt("New name", k.name ?? "");
                        if (n) await api(`/keys/${k.id}`, { method: "PATCH", body: { name: n } }).then(keys.reload);
                      }}
                    >
                      Rename
                    </button>
                    {confirm === k.id ? (
                      <button className="danger" onClick={() => api(`/keys/${k.id}`, { method: "DELETE" }).then(() => (setConfirm(undefined), keys.reload()))}>
                        Confirm revoke
                      </button>
                    ) : (
                      <button className="danger" onClick={() => setConfirm(k.id)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {editing && (
          <div className="reveal">
            <p className="small">
              Limits for <code>{editing}…</code>
            </p>
            <LimitFields value={editLimits} onChange={setEditLimits} />
            <div className="row">
              <button className="primary" onClick={() => api(`/keys/${editing}`, { method: "PATCH", body: { limits: editLimits } }).then(() => (setEditing(undefined), keys.reload()))}>
                Save limits
              </button>
              <button onClick={() => setEditing(undefined)}>Cancel</button>
            </div>
          </div>
        )}
      </Section>
      {revoked.length > 0 && (
        <Section title={`Revoked (${revoked.length})`}>
          <p className="small muted">{revoked.map((k: any) => `${k.name ?? k.id} (${k.id}…)`).join(" · ")}</p>
        </Section>
      )}
    </>
  );
}

export function fmtLimits(l?: Limits) {
  if (!l || !Object.keys(l).length) return "org limits";
  return [l.rpm !== undefined && `${l.rpm} RPM`, l.tpm !== undefined && `${int(l.tpm)} TPM`, l.dailySpendUsd !== undefined && `${usd(l.dailySpendUsd)}/day`, l.monthlySpendUsd !== undefined && `${usd(l.monthlySpendUsd)}/mo`].filter(Boolean).join(" · ");
}

export function LimitsTab({ admin }: { admin: boolean }) {
  const l = useLoad(() => api("/limits"));
  const [org, setOrg] = useState<Limits>();
  const [saved, setSaved] = useState<string>();
  useEffect(() => {
    if (l.data) setOrg(l.data.organization.limits);
  }, [l.data]);
  if (!l.data || !org) return <p className="muted">Loading…</p>;
  const s = l.data.organization.spend;
  return (
    <>
      <Section title="Organization limits">
        <p className="small muted">Apply to every key and to chat. Requests over a limit get HTTP 429 with <code>retry-after</code> and <code>anthropic-ratelimit-*</code> / <code>x-ratelimit-*</code> headers, just like the vendor APIs.</p>
        <LimitFields value={org} onChange={setOrg} />
        <div className="row">
          <button className="primary" disabled={!admin} onClick={() => api("/limits", { method: "PUT", body: org }).then(() => (setSaved("Saved."), l.reload()))}>
            Save
          </button>
          {!admin && <span className="small muted">Only owners and admins can change limits.</span>}
          {saved && <span className="small">{saved}</span>}
        </div>
        <p className="small muted">
          Spent today {usd(s.day)} · this month {usd(s.month)}
        </p>
      </Section>
      <Section title="Per-key limits">
        <div className="tbl">
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Limits</th>
                <th>Spent today</th>
                <th>This month</th>
              </tr>
            </thead>
            <tbody>
              {l.data.keys.map((k: any) => (
                <tr key={k.id}>
                  <td>
                    {k.name} <code>{k.id}…</code>
                  </td>
                  <td className="small">{fmtLimits(k.limits)}</td>
                  <td>{usd(k.spend.day)}</td>
                  <td>{usd(k.spend.month)}</td>
                </tr>
              ))}
              <tr>
                <td>Chat (web)</td>
                <td className="small">org limits</td>
                <td>{usd(l.data.web.spend.day)}</td>
                <td>{usd(l.data.web.spend.month)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="small muted">
          Edit per-key limits in <a href="#/console/keys">API keys</a>.
        </p>
      </Section>
    </>
  );
}

export function Logs() {
  const r = useLoad(() => api("/receipts?limit=100"));
  const [open, setOpen] = useState<string>();
  return (
    <Section title="Recent requests" actions={<button onClick={r.reload}>Refresh</button>}>
      <p className="small muted">Content is never stored: logs keep metadata and SHA-256 hashes only.</p>
      <div className="tbl">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Key</th>
              <th>Protocol</th>
              <th>Requested</th>
              <th>Served by</th>
              <th>Market</th>
              <th>Tokens</th>
              <th>Cost</th>
              <th>Latency</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {(r.data?.receipts ?? []).map((x: any) => (
              <Fragment key={x.id}>
                <tr onClick={() => setOpen(open === x.id ? undefined : x.id)} className="clickable">
                  <td>{when(x.createdAt)}</td>
                  <td>
                    <code>{x.apiKeyId || "—"}</code>
                  </td>
                  <td>{x.protocol}</td>
                  <td>{x.requestedModel}</td>
                  <td>
                    {x.actualProvider}/{x.actualModel}
                  </td>
                  <td>{x.market}</td>
                  <td>
                    {int(x.usage.inputTokens)} / {int(x.usage.outputTokens)}
                  </td>
                  <td>{usd(x.settledUsd || x.costUsd)}</td>
                  <td>{x.latencyMs} ms</td>
                  <td>
                    <span className={`pill ${x.status === "ok" ? "ok" : "bad"}`}>{x.status}</span>
                  </td>
                </tr>
                {open === x.id && (
                  <tr>
                    <td colSpan={10}>
                      <pre className="small">{JSON.stringify({ receipt: x.id, request: x.requestId, mode: x.mode, difficulty: x.difficulty, attempts: x.attempts, resumedOn: x.resumedOn, verification: x.verification, requestHash: x.requestHash, responseHash: x.responseHash, error: x.error }, null, 2)}</pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

export function Members({ admin, me }: { admin: boolean; me: string }) {
  const m = useLoad(() => api("/members"));
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("developer");
  const [msg, setMsg] = useState<string>();
  return (
    <>
      {admin && (
        <Section title="Invite">
          <div className="row wrap">
            <input type="email" placeholder="colleague@company.com" value={email} onChange={(e) => setEmail(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
            <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
              <option value="admin">Admin</option>
              <option value="developer">Developer</option>
              <option value="billing">Billing</option>
            </select>
            <button
              className="primary"
              onClick={() =>
                api("/members/invite", { body: { email, role } })
                  .then((r) => (setMsg(r.note), setEmail(""), m.reload()))
                  .catch((e) => setMsg(e.message))
              }
            >
              Invite
            </button>
          </div>
          {msg && <p className="small">{msg}</p>}
          <p className="fine muted">Owners and admins manage members, limits and providers; developers create keys and use models; billing manages credit.</p>
        </Section>
      )}
      <Section title="Members">
        <div className="tbl">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Joined</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(m.data?.members ?? []).map((x: any) => (
                <tr key={x.userId}>
                  <td>
                    {x.email ?? x.userId} {x.userId === me && <span className="pill">you</span>}
                  </td>
                  <td>
                    {admin && x.userId !== me ? (
                      <select value={x.role} onChange={(e) => api(`/members/${encodeURIComponent(x.userId)}`, { method: "PATCH", body: { role: e.target.value } }).then(m.reload).catch((er) => setMsg(er.message))} aria-label="Role">
                        {["owner", "admin", "developer", "billing"].map((r) => (
                          <option key={r}>{r}</option>
                        ))}
                      </select>
                    ) : (
                      x.role
                    )}
                  </td>
                  <td>{when(x.createdAt)}</td>
                  <td>
                    {admin && x.userId !== me && (
                      <button className="danger" onClick={() => api(`/members/${encodeURIComponent(x.userId)}`, { method: "DELETE" }).then(m.reload).catch((er) => setMsg(er.message))}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {(m.data?.invites ?? []).map((i: any) => (
                <tr key={i.email}>
                  <td>{i.email}</td>
                  <td>{i.role} (invited)</td>
                  <td>{when(i.createdAt)}</td>
                  <td>
                    {admin && (
                      <button onClick={() => api(`/invites/${encodeURIComponent(i.email)}`, { method: "DELETE" }).then(m.reload)}>
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}

export function Providers({ admin }: { admin: boolean }) {
  const p = useLoad(() => api("/providers"));
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Record<string, string>>({});
  const act = async (provider: string, fn: () => Promise<any>) => {
    try {
      const r = await fn();
      setMsg({ ...msg, [provider]: r?.ok === false ? `Test failed: ${r.error}` : "Done." });
      p.reload();
    } catch (e) {
      setMsg({ ...msg, [provider]: (e as Error).message });
    }
  };
  return (
    <>
      <p className="small muted">Bring your own vendor keys: requests to that vendor use your key and are billed by the vendor directly. Keys are envelope-encrypted, never shown again after you add them, and never sent to network nodes.</p>
      <div className="grid3">
        {(p.data?.providers ?? []).map((x: any) => (
          <section key={x.provider} className="card">
            <div className="row between">
              <h2 className="cap">{x.provider}</h2>
              <span className={`pill ${x.status === "CONNECTED" ? "ok" : x.status === "DISABLED" ? "warn" : ""}`}>{x.status}</span>
            </div>
            {x.credentials.map((c: any) => (
              <div key={c.id} className="row wrap small">
                <code>{c.hint}</code>
                {c.enabled ? <span className="pill ok">active</span> : <span className="pill">disabled</span>}
                {admin && (
                  <>
                    <button onClick={() => act(x.provider, () => api(`/credentials/${c.id}/test`, { method: "POST", body: {} }))}>Test</button>
                    <button onClick={() => act(x.provider, () => api(`/credentials/${c.id}`, { method: "PATCH", body: { enabled: !c.enabled } }))}>{c.enabled ? "Disable" : "Enable"}</button>
                    <button className="danger" onClick={() => act(x.provider, () => api(`/credentials/${c.id}`, { method: "DELETE" }))}>
                      Delete
                    </button>
                  </>
                )}
              </div>
            ))}
            {admin && (
              <div className="row wrap">
                <input type="password" autoComplete="off" placeholder={`${x.provider} API key`} value={keys[x.provider] ?? ""} onChange={(e) => setKeys({ ...keys, [x.provider]: e.target.value })} style={{ flex: 1 }} />
                <button className="primary" onClick={() => act(x.provider, () => api("/credentials", { body: { provider: x.provider, api_key: keys[x.provider] } }).then((r) => (setKeys({ ...keys, [x.provider]: "" }), r)))}>
                  {x.credentials.length ? "Rotate" : "Add"}
                </button>
              </div>
            )}
            {msg[x.provider] && <p className="small">{msg[x.provider]}</p>}
          </section>
        ))}
        {p.data && (
          <section className="card">
            <div className="row between">
              <h2>Network</h2>
              <span className={`pill ${p.data.network.status === "ENABLED" ? "ok" : "warn"}`}>{p.data.network.status}</span>
            </div>
            <p className="small muted">Open-weight models served by independent operators, paid from your credit.</p>
            {p.data.network.models.slice(0, 8).map((m: any) => (
              <div key={m.id} className="small">
                <code>{m.id}</code>
              </div>
            ))}
          </section>
        )}
      </div>
    </>
  );
}

export function Routing({ admin }: { admin: boolean }) {
  const me = useLoad(() => api("/me"));
  const [p, setP] = useState<any>();
  const [msg, setMsg] = useState<string>();
  useEffect(() => {
    if (me.data) setP(me.data.policy);
  }, [me.data]);
  if (!p) return <p className="muted">Loading…</p>;
  const set = (k: string, v: unknown) => setP({ ...p, [k]: v });
  return (
    <Section title="Default routing policy">
      <p className="small muted">Applies to every API call and chat that doesn't send <code>X-Decentralise-*</code> headers.</p>
      <div className="grid3">
        <label>
          Default mode
          <select value={p.defaultMode} onChange={(e) => set("defaultMode", e.target.value)}>
            {["passthrough", "optimise", "cheapest", "fastest", "quality", "private", "decentralised_only", "byok_only", "network_only", "free"].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <label>
          Privacy
          <select value={p.privacy} onChange={(e) => set("privacy", e.target.value)}>
            <option>standard</option>
            <option>strict</option>
          </select>
        </label>
        <label>
          Shadow mode
          <select value={p.shadowMode} onChange={(e) => set("shadowMode", e.target.value)}>
            <option value="off">off</option>
            <option value="estimate">estimate</option>
            <option value="benchmark">benchmark (runs alternatives)</option>
          </select>
        </label>
      </div>
      <h3>Priorities</h3>
      <div className="grid4">
        {["quality", "cost", "latency", "decentralisation"].map((w) => (
          <label key={w}>
            {w} {Math.round(p.weights[w] * 100)}%
            <input type="range" min="0" max="1" step="0.05" value={p.weights[w]} onChange={(e) => set("weights", { ...p.weights, [w]: Number(e.target.value) })} />
          </label>
        ))}
      </div>
      <h3>Allowed providers</h3>
      <div className="row wrap">
        {["anthropic", "openai", "gemini", "network"].map((k) => (
          <label key={k} className="check">
            <input type="checkbox" checked={!!p.allowedProviders[k]} onChange={(e) => set("allowedProviders", { ...p.allowedProviders, [k]: e.target.checked })} /> {k}
          </label>
        ))}
      </div>
      <div className="row">
        <button className="primary" disabled={!admin} onClick={() => api("/policy", { method: "PUT", body: p }).then(() => setMsg("Saved.")).catch((e) => setMsg(e.message))}>
          Save policy
        </button>
        {msg && <span className="small">{msg}</span>}
      </div>
    </Section>
  );
}

export function Settings({ admin, role }: { admin: boolean; role: string }) {
  const org = useLoad(() => api("/org"));
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<string>();
  useEffect(() => {
    if (org.data) setName(org.data.name ?? "");
  }, [org.data]);
  return (
    <Section title="Organization">
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} disabled={!admin} />
      </label>
      <div className="row">
        <button className="primary" disabled={!admin} onClick={() => api("/org", { method: "PATCH", body: { name } }).then(() => setMsg("Saved.")).catch((e) => setMsg(e.message))}>
          Save
        </button>
        {msg && <span className="small">{msg}</span>}
      </div>
      <p className="small muted">
        Organization id <code>{org.data?.id}</code> · your role: {role}
      </p>
    </Section>
  );
}
