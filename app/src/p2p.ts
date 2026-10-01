/**
 * DIP-P2P client: talk to community nodes directly, so a conversation never passes through the
 * router (and costs the network operator nothing).
 *
 *   once a month  POST /api/p2p/ticket  → ticket bound to this device's own key, router keys, directory
 *   every turn    browser ──▶ node (its tunnel URL), with the ticket and a fresh signed proof
 *   every ~6 h    the signed peer directory, fetched from any node and checked against router keys
 *
 * The private key never leaves this browser (non-extractable, kept in IndexedDB). Nodes see the
 * text they answer and this device's IP address, but never the account: tickets carry only a
 * random id. The format matches packages/core/src/p2p.ts in the router repo.
 */
import { api } from "./api";

interface PublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}
interface DirectoryNode {
  id: string;
  endpoint: string;
  models: Array<{ id: string; level: number }>;
  domains: Record<string, number>;
  voice?: { stt?: boolean; tts?: string[] };
  region?: { lat: number; lon: number; country?: string };
  reputation: number;
}
interface Stored {
  ticket: string;
  exp: number;
  keys: Record<string, PublicJwk>;
  directory?: string;
  directoryAt?: number;
}

const enc = new TextEncoder();
const ALG = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(new ArrayBuffer(b.length));
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

export function p2pSupported(): boolean {
  return typeof crypto !== "undefined" && !!crypto.subtle && typeof indexedDB !== "undefined";
}

// ---------------------------------------------------------------- the device key (IndexedDB)

function keyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("dsi-p2p", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("keys");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await keyDb();
  return new Promise((resolve, reject) => {
    const r = fn(db.transaction("keys", mode).objectStore("keys"));
    r.onsuccess = () => resolve(r.result as T);
    r.onerror = () => reject(r.error);
  });
}

let deviceKey: Promise<{ key: CryptoKey; pub: PublicJwk }> | undefined;
function device(): Promise<{ key: CryptoKey; pub: PublicJwk }> {
  deviceKey ??= (async () => {
    const saved = await idb<{ key: CryptoKey; pub: PublicJwk } | undefined>("readonly", (s) => s.get("device")).catch(() => undefined);
    if (saved?.key && saved.pub) return saved;
    const kp = (await crypto.subtle.generateKey(ALG, false, ["sign", "verify"])) as CryptoKeyPair;
    const j = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
    const v = { key: kp.privateKey, pub: { kty: "EC" as const, crv: "P-256" as const, x: j.x!, y: j.y! } };
    await idb("readwrite", (s) => s.put(v, "device")).catch(() => {});
    return v;
  })();
  return deviceKey;
}

// ---------------------------------------------------------------- ticket and directory

const STORE_KEY = "dsi_p2p";
function load(): Stored | undefined {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "null") ?? undefined;
  } catch {
    return undefined;
  }
}
function save(s: Stored) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* private mode: kept in memory only */
  }
  mem = s;
}
let mem: Stored | undefined;
let issuing: Promise<Stored> | undefined;

/** The current ticket (30 days): renewed when fewer than 3 days are left, about one router call a month. */
async function ticket(): Promise<Stored> {
  const s = mem ?? load();
  if (s && s.exp - Date.now() / 1000 > 3 * 86_400) return (mem = s);
  issuing ??= (async () => {
    try {
      const { pub } = await device();
      const r = await api<{ ticket: string; exp: number; keys: Record<string, PublicJwk>; directory?: string }>("/p2p/ticket", { body: { cnf: pub } });
      const next: Stored = { ticket: r.ticket, exp: r.exp, keys: r.keys, directory: r.directory, directoryAt: Date.now() };
      save(next);
      return next;
    } finally {
      issuing = undefined;
    }
  })();
  return issuing;
}

export async function verifySigned(token: string, prefix: "d1", keys: Record<string, PublicJwk>): Promise<{ kid: string; iat: number; nodes: DirectoryNode[] } | undefined> {
  const [v, body, sig] = token.split(".");
  if (v !== prefix || !body || !sig) return undefined;
  const d = JSON.parse(new TextDecoder().decode(fromB64url(body))) as { kid: string; iat: number; nodes: DirectoryNode[] };
  const k = keys[d.kid];
  if (!k) return undefined;
  const key = await crypto.subtle.importKey("jwk", { ...k, ext: true }, ALG, false, ["verify"]);
  return (await crypto.subtle.verify(SIGN, key, fromB64url(sig), enc.encode(`${prefix}.${body}`))) ? d : undefined;
}

/** Peers from the signed directory, refreshed from a peer (not the router) every ~6 hours. */
async function peers(): Promise<DirectoryNode[]> {
  const s = await ticket();
  let d = s.directory ? await verifySigned(s.directory, "d1", s.keys).catch(() => undefined) : undefined;
  if (d && (Date.now() - (s.directoryAt ?? 0) > 6 * 3_600_000 || Date.now() / 1000 - d.iat > 12 * 3600)) {
    for (const n of shuffle(d.nodes).slice(0, 3)) {
      try {
        const r = await fetch(`${origin(n.endpoint)}/dsi/directory`, { signal: AbortSignal.timeout?.(4000) });
        const tok = ((await r.json()) as { directory?: string }).directory;
        const fresh = tok ? await verifySigned(tok, "d1", s.keys) : undefined;
        if (fresh && fresh.iat >= d.iat) {
          save({ ...s, directory: tok, directoryAt: Date.now() });
          d = fresh;
          break;
        }
      } catch {
        /* try another peer */
      }
    }
  }
  return d?.nodes ?? [];
}

const origin = (endpoint: string) => endpoint.replace(/\/v1\/?$/, "");
function shuffle<T>(a: T[]): T[] {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

/** Peers that answer fastest from here, measured once every few minutes. */
const rtt = new Map<string, { ms: number; at: number }>();
async function ranked(cands: DirectoryNode[], score: (n: DirectoryNode) => number): Promise<DirectoryNode[]> {
  const top = [...cands].sort((a, b) => score(b) - score(a)).slice(0, 6);
  await Promise.all(
    top.map(async (n) => {
      const c = rtt.get(n.id);
      if (c && Date.now() - c.at < 300_000) return;
      const t0 = performance.now();
      const ok = await fetch(`${origin(n.endpoint)}/healthz`, { signal: AbortSignal.timeout?.(2500) }).then((r) => r.ok).catch(() => false);
      rtt.set(n.id, { ms: ok ? performance.now() - t0 : Infinity, at: Date.now() });
    }),
  );
  return top.filter((n) => (rtt.get(n.id)?.ms ?? Infinity) < Infinity).sort((a, b) => score(b) - (rtt.get(b.id)!.ms / 1000) - (score(a) - rtt.get(a.id)!.ms / 1000));
}

/** A direct request: ticket plus a proof over method, path, body and time, signed on this device. */
async function direct(n: DirectoryNode, path: string, body: string | Blob, type: string, signal?: AbortSignal): Promise<Response> {
  const s = await ticket();
  const { key } = await device();
  const url = `${n.endpoint.replace(/\/$/, "")}${path}`;
  const bytes = typeof body === "string" ? enc.encode(body) : new Uint8Array(await body.arrayBuffer());
  return fetch(url, { method: "POST", signal, headers: { authorization: `DSI-Ticket ${s.ticket}`, "x-dsi-proof": await requestProof(key, "POST", url, bytes), "content-type": type }, body: bytes });
}

/** Proof over method, path, body hash, time and a nonce (format p1, as verified by dsi-node). */
export async function requestProof(key: CryptoKey, method: string, url: string, bytes: Uint8Array<ArrayBuffer>, now = Date.now()): Promise<string> {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(12)));
  const hash = b64url(await crypto.subtle.digest("SHA-256", bytes));
  const sig = b64url(await crypto.subtle.sign(SIGN, key, enc.encode(`p1.${now}.${nonce}.${method.toUpperCase()} ${new URL(url).pathname}.${hash}`)));
  return `${now}.${nonce}.${sig}`;
}

// ---------------------------------------------------------------- chat

/** Conversation → the node that last answered it (this tab only). */
const affinity = new Map<string, string>();

const fit = (n: DirectoryNode, domain?: string) => {
  if (!domain) return n.domains.general ?? 0.6;
  let best = n.domains.general ?? 0.5;
  for (const [d, w] of Object.entries(n.domains)) if (domain === d || domain.startsWith(`${d}.`)) best = Math.max(best, w);
  return best;
};

/**
 * Stream a chat answer from the best direct peer, trying the next one if a peer fails before
 * answering. Returns undefined when no peer can take it (the caller then uses the router).
 */
export async function p2pChat(o: { messages: Array<{ role: string; content: string }>; domain?: string; session?: string; signal: AbortSignal; onDelta: (t: string) => void }): Promise<{ provider: string; model: string; market: "p2p" } | undefined> {
  if (!p2pSupported()) return undefined;
  const all = (await peers()).filter((n) => n.models.length);
  let list = await ranked(all, (n) => fit(n, o.domain) + n.reputation * 0.3).catch(() => [] as DirectoryNode[]);
  // A conversation stays on the node that answered it, so the node's prompt cache stays warm and
  // only the new turn is processed.
  const pinned = o.session ? all.find((n) => n.id === affinity.get(o.session!)) : undefined;
  if (pinned) list = [pinned, ...list.filter((n) => n.id !== pinned.id)];
  for (const n of list.slice(0, 3)) {
    const model = [...n.models].sort((a, b) => b.level - a.level)[0].id;
    let r: Response;
    try {
      r = await direct(n, "/chat/completions", JSON.stringify({ model, messages: o.messages, stream: true }), "application/json", o.signal);
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      continue;
    }
    if (!r.ok || !r.body) continue;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let started = false;
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        // Lost before any text: the next peer can answer. After text: say so rather than repeat it.
        if (!started && (e as Error).name !== "AbortError") break;
        if ((e as Error).name === "AbortError") throw e;
        throw Object.assign(new Error("The community node's answer was cut off. Send it again to try another node."), { name: "P2PCutOff" });
      }
      const { value, done } = chunk;
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const data = buf
          .slice(0, i)
          .split("\n")
          .find((l) => l.startsWith("data: "))
          ?.slice(6);
        buf = buf.slice(i + 2);
        if (!data || data === "[DONE]") continue;
        const j = JSON.parse(data);
        const d = j.choices?.[0]?.delta?.content;
        if (d) {
          started = true;
          o.onDelta(d);
        }
      }
    }
    if (!started) continue;
    if (o.session) affinity.set(o.session, n.id);
    return { provider: `p2p:${n.id}`, model, market: "p2p" };
  }
  return undefined;
}

// ---------------------------------------------------------------- voice for devices that cannot run it

/** Transcribe on a peer that offers it; undefined if none can. */
export async function p2pTranscribe(wav: Blob, language?: string): Promise<{ text: string; language: string | null; confidence: null } | undefined> {
  if (!p2pSupported()) return undefined;
  const list = await ranked((await peers()).filter((n) => n.voice?.stt), (n) => n.reputation).catch(() => [] as DirectoryNode[]);
  for (const n of list.slice(0, 2)) {
    const form = new FormData();
    form.append("file", wav, "speech.wav");
    form.append("model", "whisper-1");
    form.append("response_format", "verbose_json");
    if (language) form.append("language", language);
    // Sign exactly the bytes that will be sent: serialise the form once.
    const req = new Request("http://local/", { method: "POST", body: form });
    const type = req.headers.get("content-type") ?? "multipart/form-data";
    const blob = await req.blob();
    try {
      const r = await direct(n, "/audio/transcriptions", blob, type);
      if (!r.ok) continue;
      const j = (await r.json()) as { text?: string; language?: string };
      return { text: (j.text ?? "").trim(), language: j.language ? j.language.slice(0, 2).toLowerCase() : (language ?? null), confidence: null };
    } catch {
      /* next peer */
    }
  }
  return undefined;
}

/** Speech from a peer that speaks this language; undefined if none can. */
export async function p2pSpeak(text: string, lang: string): Promise<ArrayBuffer | undefined> {
  if (!p2pSupported()) return undefined;
  const l = lang.slice(0, 2).toLowerCase();
  const list = await ranked((await peers()).filter((n) => n.voice?.tts?.includes(l)), (n) => n.reputation).catch(() => [] as DirectoryNode[]);
  for (const n of list.slice(0, 2)) {
    try {
      const r = await direct(n, "/audio/speech", JSON.stringify({ model: "tts-1", input: text, voice: l === "en" ? "af_heart" : l, response_format: "wav" }), "application/json");
      if (r.ok) return await r.arrayBuffer();
    } catch {
      /* next peer */
    }
  }
  return undefined;
}
