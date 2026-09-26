/** API client for the Decentralised.si router, authenticated with the Privy session. */

const DOMAINS = ["decentralised.si", "decentralise.si", "decentralise.ai", "decentralised.ai"];

function apiBase(): string {
  const host = location.hostname.replace(/^www\./, "");
  const override = new URLSearchParams(location.search).get("api");
  if (["localhost", "127.0.0.1"].includes(location.hostname) && override) return override;
  return DOMAINS.includes(host) ? `https://api.${host}` : "https://api.decentralised.si";
}
export const API = apiBase();

export interface Config {
  privyAppId: string | null;
  deposits: { evm: boolean; solana: boolean; minUsd: number };
  checkout: boolean;
  platformVendors: string[];
}

export async function loadConfig(): Promise<Config> {
  const r = await fetch(`${API}/api/config`);
  if (!r.ok) throw new Error(`config ${r.status}`);
  return r.json();
}

let tokenSource: () => Promise<string | null> = async () => null;
let accountId: string | undefined;
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
  return { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}), ...(accountId ? { "x-decentralise-account": accountId } : {}), ...extra };
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
  const r = await fetch(`${API}/openai/v1/models`, { headers: await headers() });
  if (!r.ok) return [];
  return ((await r.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id);
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
}

/** Stream a chat completion; calls onDelta for every text chunk. */
export async function streamChat(opts: {
  messages: ChatMessage[];
  model: string;
  mode: string;
  session: string;
  affinity?: string;
  signal: AbortSignal;
  onDelta: (t: string) => void;
}): Promise<StreamMeta> {
  const r = await fetch(`${API}/openai/v1/chat/completions`, {
    method: "POST",
    signal: opts.signal,
    headers: await headers({
      "x-decentralise-mode": opts.mode,
      "x-decentralise-session": opts.session,
      ...(opts.affinity ? { "x-decentralise-affinity": opts.affinity } : {}),
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
