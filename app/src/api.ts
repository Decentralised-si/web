import { classifyDomain } from "./domain";
import { p2pChat } from "./p2p";
/** API client for the Decentralised.si router, authenticated with the Privy session. */

const DOMAINS = ["decentralised.si", "decentralise.si", "decentralise.ai", "decentralised.ai"];

function apiBase(): string {
  const host = location.hostname.replace(/^www\./, "");
  const override = new URLSearchParams(location.search).get("api");
  if (["localhost", "127.0.0.1"].includes(location.hostname) && override) return override;
  // On our own domains, go through the site itself (/gw -> the router): some mobile networks and
  // blockers cannot reach the api. subdomain. Elsewhere, the public API host.
  return DOMAINS.includes(host) ? `${location.origin}/gw` : "https://api.decentralised.si";
}
export const API = apiBase();
/** The public API host, for code samples and docs shown to developers. */
export const PUBLIC_API = "https://api.decentralised.si";

export interface Config {
  privyAppId: string | null;
  deposits: { evm: boolean; solana: boolean; minUsd: number };
  checkout: boolean;
  platformVendors: string[];
}

/**
 * Router answers that change rarely are kept in this browser, so opening the app does not cost a
 * router call each time (at a million users that is the difference between free and not).
 */
const DAY = 86_400_000;
function cacheGet<T>(key: string, maxAgeMs: number): T | undefined {
  try {
    const c = JSON.parse(localStorage.getItem(key) ?? "null") as { at: number; v: T } | null;
    return c && Date.now() - c.at < maxAgeMs ? c.v : undefined;
  } catch {
    return undefined;
  }
}
function cachePut(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), v }));
  } catch {
    /* private mode */
  }
}

/** Startup config: from this browser's cache (30 days), else the router. */
export async function loadConfig(attempts = 4): Promise<Config> {
  const cached = cacheGet<Config>("dsi_config", 30 * DAY);
  if (cached?.privyAppId) return cached;
  const fresh = await fetchConfig(attempts);
  cachePut("dsi_config", fresh);
  return fresh;
}

/** Mobile networks drop the odd request, so retry a few times before giving up. */
async function fetchConfig(attempts: number): Promise<Config> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((r) => setTimeout(r, 600 * 2 ** (i - 1)));
    try {
      const r = await fetch(`${API}/api/config`, { cache: "no-store", signal: AbortSignal.timeout?.(10_000) });
      if (r.ok) return await r.json();
      last = new Error(`HTTP ${r.status}`);
      if (r.status < 500 && r.status !== 429) break;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

let tokenSource: () => Promise<string | null> = async () => null;
let accountId: string | undefined;
let workspaceId = "default";
export function setWorkspace(id: string) {
  workspaceId = id;
}
export function currentWorkspace() {
  return workspaceId;
}
export async function authHeaders(): Promise<Record<string, string>> {
  return headers();
}
export function setTokenSource(fn: () => Promise<string | null>) {
  tokenSource = fn;
}
export function setAccount(id: string | undefined) {
  accountId = id;
}
export function currentAccount() {
  return accountId;
}

async function headers(extra: Record<string, string> = {}) {
  const t = await tokenSource();
  return {
    "content-type": "application/json",
    ...(t ? { authorization: `Bearer ${t}` } : {}),
    ...(accountId ? { "x-decentralise-account": accountId } : {}),
    ...(workspaceId !== "default" ? { "x-decentralise-workspace": workspaceId } : {}),
    ...extra,
  };
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const r = await fetch(`${API}/api${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: await headers(init.headers),
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 202) throw Object.assign(new Error(j?.error?.message ?? j?.reason ?? `HTTP ${r.status}`), { status: r.status, body: j });
  return j as T;
}

export async function listModels(): Promise<string[]> {
  const cached = cacheGet<string[]>("dsi_models", 30 * DAY);
  if (cached?.length) return cached;
  const r = await fetch(`${API}/openai/v1/models`, { headers: await headers() });
  if (!r.ok) return [];
  const ids = ((await r.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id);
  cachePut("dsi_models", ids);
  return ids;
}

/** Account balance and free-chat status: cached for 14 days on open; refreshed after paid turns. */
export async function orgStatus(fresh = false): Promise<any> {
  const key = `dsi_org_${accountId ?? "me"}`;
  if (!fresh) {
    const cached = cacheGet<any>(key, 14 * DAY);
    if (cached) return cached;
  }
  const o = await api("/org");
  cachePut(key, o);
  return o;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface StreamMeta {
  provider?: string;
  model?: string;
  market?: string;
  affinity?: string;
  receipt?: string;
  /** Set on a newcomer's welcome answer (hosted model, free): how many remain after this one. */
  welcomeRemaining?: number;
}

/** Stream a chat completion; calls onDelta for every text chunk. */
/** Domain of the latest user message, classified on this device (see domain.ts). */
function domainHint(messages: ChatMessage[]): string | undefined {
  const last = [...messages].reverse().find((m) => m.role === "user");
  return last && typeof last.content === "string" ? classifyDomain(last.content) : undefined;
}

export async function streamChat(opts: {
  messages: ChatMessage[];
  model: string;
  mode: string;
  session: string;
  affinity?: string;
  signal: AbortSignal;
  onDelta: (t: string) => void;
}): Promise<StreamMeta> {
  // Free chat goes straight to a community node (DIP-P2P): no router on the way, no cost to anyone
  // but the peer, who earns PAI for it. The router is the fallback when no peer can answer.
  if (opts.mode === "free") {
    const direct = await p2pChat({ messages: opts.messages, domain: domainHint(opts.messages), session: opts.session, signal: opts.signal, onDelta: opts.onDelta }).catch((e: Error) => {
      if (e.name === "AbortError" || e.name === "P2PCutOff") throw e;
      return undefined;
    });
    if (direct) return direct;
  }
  const r = await fetch(`${API}/openai/v1/chat/completions`, {
    method: "POST",
    signal: opts.signal,
    headers: await headers({
      "x-decentralise-mode": opts.mode,
      "x-decentralise-session": opts.session,
      ...(opts.affinity ? { "x-decentralise-affinity": opts.affinity } : {}),
      ...(domainHint(opts.messages) ? { "x-decentralise-domain": domainHint(opts.messages)! } : {}),
    }),
    body: JSON.stringify({ model: opts.model, messages: opts.messages, stream: true, stream_options: { include_usage: true } }),
  });
  if (!r.ok || !r.body) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j?.error?.message ?? `HTTP ${r.status}`);
  }
  const meta: StreamMeta = {
    provider: r.headers.get("x-decentralise-actual-provider") ?? undefined,
    model: r.headers.get("x-decentralise-actual-model") ?? undefined,
    market: r.headers.get("x-decentralise-market") ?? undefined,
    affinity: r.headers.get("x-decentralise-affinity") ?? undefined,
    receipt: r.headers.get("x-decentralise-receipt") ?? undefined,
    ...(r.headers.get("x-decentralise-welcome-remaining") !== null ? { welcomeRemaining: Number(r.headers.get("x-decentralise-welcome-remaining")) } : {}),
  };
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const ev = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = ev.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
      if (!data || data === "[DONE]") continue;
      const j = JSON.parse(data);
      if (j.error) throw new Error(j.error.message);
      const d = j.choices?.[0]?.delta?.content;
      if (d) opts.onDelta(d);
    }
  }
  return meta;
}

// ---------------------------------------------------------------- connectors (MCP servers)

export interface ConnectorInfo {
  id: string;
  name: string;
  url: string;
  auth: "none" | "bearer" | "oauth";
  created_at: string;
}
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export const connectors = {
  list: () => api<{ connectors: ConnectorInfo[] }>("/connectors").then((r) => r.connectors),
  add: (b: { name?: string; url: string; api_key?: string }) => api<{ connector: ConnectorInfo; tools: McpTool[] }>("/connectors", { body: b }),
  oauthStart: (b: { name?: string; url: string; redirect_uri: string }) => api<{ authorize_url: string; state: string }>("/connectors/oauth/start", { body: b }),
  oauthFinish: (b: { state: string; code: string }) => api<{ connector: ConnectorInfo; tools: McpTool[] }>("/connectors/oauth/finish", { body: b }),
  tools: (id: string) => api<{ server: string; instructions?: string; tools: McpTool[] }>(`/connectors/${id}/tools`),
  call: (id: string, name: string, args: Record<string, unknown>) => api<{ result: { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean } }>(`/connectors/${id}/call`, { body: { name, arguments: args } }),
  remove: (id: string) => api(`/connectors/${id}`, { method: "DELETE" }),
};

/** Where OAuth sign-ins come back to (the app's root; App.tsx finishes the sign-in). */
export const OAUTH_RETURN = `${location.origin}/app`;

type ToolMsg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

/** Text of an MCP tool result, trimmed so one big result can't flood the model's context. */
function toolText(r: { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean }): string {
  const text = (r.content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type}]`)).join("\n") || (r.structuredContent ? JSON.stringify(r.structuredContent) : "");
  return (r.isError ? "Tool error: " : "") + (text.length > 12_000 ? `${text.slice(0, 12_000)}\n… (truncated)` : text);
}

/**
 * Answers with tools from the user's connectors: the model may call MCP tools (run by DSI Axon on
 * the user's behalf) over a few rounds, then answers in words. Returns the final text and the tools used.
 */
export async function chatWithTools(opts: {
  messages: ChatMessage[];
  model: string;
  mode: string;
  session: string;
  signal: AbortSignal;
  servers: Array<{ connector: ConnectorInfo; tools: McpTool[] }>;
  onTool?: (label: string) => void;
}): Promise<{ text: string; meta: StreamMeta; used: string[] }> {
  // Tool names must be [a-zA-Z0-9_-]{1,64}: prefix each server's tools with its position.
  const table = new Map<string, { id: string; tool: string; label: string }>();
  const tools = opts.servers.flatMap((s, i) =>
    s.tools.map((t) => {
      const name = `c${i + 1}__${t.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
      table.set(name, { id: s.connector.id, tool: t.name, label: `${s.connector.name} · ${t.name}` });
      return { type: "function" as const, function: { name, description: `[${s.connector.name}] ${t.description ?? t.name}`.slice(0, 1000), parameters: t.inputSchema ?? { type: "object", properties: {} } } };
    }),
  );
  // The tools note goes after any leading system messages (voice mode's prompt must stay first).
  const given = opts.messages as ToolMsg[];
  const lead = given.findIndex((m) => m.role !== "system");
  const at = lead < 0 ? given.length : lead;
  const msgs: ToolMsg[] = [
    ...given.slice(0, at),
    { role: "system", content: `You can use tools from the user's connected services (${opts.servers.map((s) => s.connector.name).join(", ")}). Call them when they help answer; use what they return, and say which service the facts came from.` },
    ...given.slice(at),
  ];
  const used: string[] = [];
  let meta: StreamMeta = {};
  for (let round = 0; round < 6; round++) {
    const r = await fetch(`${API}/openai/v1/chat/completions`, {
      method: "POST",
      signal: opts.signal,
      headers: await headers({ "x-decentralise-mode": opts.mode, "x-decentralise-session": opts.session }),
      body: JSON.stringify({ model: opts.model, messages: msgs, tools, tool_choice: "auto", stream: false }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message ?? `HTTP ${r.status}`);
    meta = {
      provider: r.headers.get("x-decentralise-actual-provider") ?? undefined,
      model: r.headers.get("x-decentralise-actual-model") ?? undefined,
      market: r.headers.get("x-decentralise-market") ?? undefined,
      receipt: r.headers.get("x-decentralise-receipt") ?? undefined,
      ...(r.headers.get("x-decentralise-welcome-remaining") !== null ? { welcomeRemaining: Number(r.headers.get("x-decentralise-welcome-remaining")) } : {}),
    };
    const m = j.choices?.[0]?.message ?? {};
    const calls = (m.tool_calls ?? []) as Array<{ id: string; function: { name: string; arguments: string } }>;
    if (!calls.length) return { text: String(m.content ?? ""), meta, used };
    msgs.push({ role: "assistant", content: m.content ?? null, tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: c.function })) });
    for (const c of calls) {
      const target = table.get(c.function.name);
      let out: string;
      if (!target) out = `Unknown tool ${c.function.name}`;
      else {
        opts.onTool?.(target.label);
        used.push(target.label);
        try {
          const args = c.function.arguments ? JSON.parse(c.function.arguments) : {};
          out = toolText((await connectors.call(target.id, target.tool, args)).result);
        } catch (e) {
          out = `Tool failed: ${(e as Error).message}`;
        }
      }
      msgs.push({ role: "tool", tool_call_id: c.id, content: out });
    }
  }
  throw new Error("The tools didn't lead to an answer after several steps. Try asking more specifically.");
}
