#!/usr/bin/env node

// src/cli.ts
import { mkdirSync, readFileSync as readFileSync2, writeFileSync, chmodSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join as join2 } from "node:path";

// src/knowledge.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
var STOP = new Set(
  "a an the and or of to in on for with is are was were be been by as at it its this that these those from what which who how why when where do does did can could should would will shall may might must not no yes if then than so such into about over under your you i we they he she them our their my me us".split(" ")
);
function tokens(s) {
  return s.toLowerCase().replace(/[^a-z0-9§.\s-]/g, " ").split(/[\s-]+/).map((t) => t.replace(/^\.+|\.+$/g, "")).filter((t) => t.length > 1 && !STOP.has(t)).map((t) => t.length > 4 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t);
}
function splitMarkdown(file, md) {
  const title = /^#\s+(.+)$/m.exec(md)?.[1]?.trim() ?? basename(file, ".md");
  const out = [];
  let heading = title;
  let buf = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text.length > 40) out.push({ source: heading === title ? title : `${title} \u203A ${heading}`, text });
    buf = [];
  };
  for (const line of md.split("\n")) {
    const h = /^#{2,3}\s+(.+)$/.exec(line);
    if (h) {
      flush();
      heading = h[1].trim();
    } else if (!/^#\s/.test(line)) {
      buf.push(line);
    }
  }
  flush();
  return out;
}
var KnowledgeBase = class _KnowledgeBase {
  docs = [];
  df = /* @__PURE__ */ new Map();
  avgLen = 1;
  constructor(passages) {
    for (const p of passages) {
      const toks = tokens(`${p.source} ${p.text}`);
      const tf = /* @__PURE__ */ new Map();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ p, tf, len: toks.length });
    }
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / Math.max(1, this.docs.length);
  }
  static fromDir(dir) {
    const passages = [];
    const walk = (d) => {
      for (const name of readdirSync(d).sort()) {
        const full = join(d, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".md")) passages.push(...splitMarkdown(relative(dir, full), readFileSync(full, "utf8")));
      }
    };
    walk(dir);
    return new _KnowledgeBase(passages);
  }
  get size() {
    return this.docs.length;
  }
  /** Top passages for a question (BM25, k1 = 1.2, b = 0.75); empty when nothing is relevant. */
  search(query, k = 3, minScore = 1.5) {
    const q = [...new Set(tokens(query))];
    const N = this.docs.length;
    const scored = this.docs.map((d) => {
      let s = 0;
      for (const t of q) {
        const f = d.tf.get(t);
        if (!f) continue;
        const idf = Math.log(1 + (N - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5));
        s += idf * (f * 2.2 / (f + 1.2 * (1 - 0.75 + 0.75 * d.len / this.avgLen)));
      }
      return { ...d.p, score: s };
    });
    return scored.filter((x) => x.score >= minScore).sort((a, b) => b.score - a.score).slice(0, k);
  }
};
function expertSystemMessage(persona, notes) {
  if (!persona && !notes.length) return void 0;
  const parts = [];
  if (persona) parts.push(persona.trim());
  if (notes.length) {
    parts.push(
      "Reference notes from your knowledge base follow. Base your answer on them where they apply, cite them as [1], [2] \u2026, and say plainly when the notes do not cover something."
    );
    notes.forEach((n, i) => parts.push(`[${i + 1}] ${n.source}
${n.text}`));
  }
  return parts.join("\n\n");
}

// src/index.ts
import { createServer } from "node:http";
import { execFile } from "node:child_process";

// ../core/src/catalog.ts
var CLAUDE_BASE = ["tools", "parallel_tools", "vision", "system", "streaming", "prompt_caching", "stop_sequences", "json_schema", "reasoning"];
var OPENAI_BASE = ["tools", "parallel_tools", "tool_choice_required", "vision", "system", "streaming", "prompt_caching", "stop_sequences", "json_object", "json_schema"];
var GEMINI_BASE = ["tools", "parallel_tools", "tool_choice_required", "vision", "system", "streaming", "prompt_caching", "stop_sequences", "json_object", "json_schema", "reasoning", "sampling"];
function claude(id, quality, inP, outP, opts = {}) {
  const features = [...CLAUDE_BASE];
  if (opts.forcedTools !== false) features.push("tool_choice_required");
  if (opts.sampling) features.push("sampling");
  return {
    id,
    provider: "anthropic",
    providerGroup: "anthropic",
    market: "byok",
    kind: "chat",
    quality,
    inputPer1M: inP,
    outputPer1M: outP,
    cacheReadPer1M: inP / 10,
    ttftMs: 1200,
    tokensPerSec: 70,
    contextWindow: 1e6,
    maxOutput: 128e3,
    features,
    privacy: "standard",
    decentralised: false,
    verified: true,
    specialties: ["general", "coding"],
    operator: "Anthropic",
    ...opts
  };
}
function openai(id, quality, inP, outP, opts = {}) {
  const features = [...OPENAI_BASE];
  if (opts.sampling) features.push("sampling");
  if (opts.reasoning) features.push("reasoning");
  return {
    id,
    provider: "openai",
    providerGroup: "openai",
    market: "byok",
    kind: "chat",
    quality,
    inputPer1M: inP,
    outputPer1M: outP,
    cacheReadPer1M: inP / 10,
    ttftMs: 900,
    tokensPerSec: 90,
    contextWindow: 4e5,
    maxOutput: 128e3,
    features,
    privacy: "standard",
    decentralised: false,
    verified: true,
    specialties: ["general", "coding"],
    operator: "OpenAI",
    ...opts
  };
}
function gemini(id, quality, inP, outP, opts = {}) {
  return {
    id,
    provider: "gemini",
    providerGroup: "gemini",
    market: "byok",
    kind: "chat",
    quality,
    inputPer1M: inP,
    outputPer1M: outP,
    cacheReadPer1M: inP / 4,
    ttftMs: 800,
    tokensPerSec: 120,
    contextWindow: 1e6,
    maxOutput: 65536,
    features: [...GEMINI_BASE],
    privacy: "standard",
    decentralised: false,
    verified: true,
    specialties: ["general"],
    operator: "Google",
    ...opts
  };
}
function workersAi(id, quality, inP, outP, opts = {}) {
  return {
    id,
    provider: "workers-ai",
    providerGroup: "network",
    market: "network",
    kind: "chat",
    quality,
    inputPer1M: inP,
    outputPer1M: outP,
    ttftMs: 350,
    tokensPerSec: 80,
    contextWindow: 24e3,
    maxOutput: 4096,
    features: ["tools", "system", "streaming", "stop_sequences", "json_object", "json_schema", "sampling"],
    // Cloudflare does not train on or retain Workers AI inputs.
    privacy: "strict",
    decentralised: false,
    verified: true,
    specialties: ["general"],
    operator: "Cloudflare Workers AI (open-weight models)",
    ...opts
  };
}
var BUILTIN_CATALOG = [
  claude("claude-fable-5-1", 0.97, 10, 50, { forcedTools: false, ttftMs: 2500, tokensPerSec: 50 }),
  claude("claude-fable-5", 0.965, 10, 50, { ttftMs: 2500, tokensPerSec: 50 }),
  claude("claude-opus-5-5", 0.955, 4, 20, { forcedTools: false, ttftMs: 1800, tokensPerSec: 60 }),
  claude("claude-opus-5", 0.95, 5, 25, { ttftMs: 1800, tokensPerSec: 60 }),
  claude("claude-opus-4-8", 0.94, 5, 25, { ttftMs: 1800, tokensPerSec: 60 }),
  claude("claude-sonnet-5", 0.93, 2, 10, { ttftMs: 1100, tokensPerSec: 80 }),
  claude("claude-sonnet-4-6", 0.91, 3, 15, { ttftMs: 1100, tokensPerSec: 80, sampling: true }),
  claude("claude-haiku-4-5", 0.85, 1, 5, { ttftMs: 600, tokensPerSec: 150, contextWindow: 2e5, maxOutput: 64e3, sampling: true }),
  openai("gpt-5", 0.93, 1.25, 10, { reasoning: true, ttftMs: 2e3, tokensPerSec: 70 }),
  openai("gpt-5-mini", 0.87, 0.25, 2, { reasoning: true, ttftMs: 800, tokensPerSec: 120 }),
  openai("gpt-5-nano", 0.79, 0.05, 0.4, { reasoning: true, ttftMs: 500, tokensPerSec: 180 }),
  openai("gpt-4.1", 0.86, 2, 8, { sampling: true, contextWindow: 1e6, maxOutput: 32768 }),
  openai("gpt-4.1-mini", 0.82, 0.4, 1.6, { sampling: true, contextWindow: 1e6, maxOutput: 32768, ttftMs: 500 }),
  openai("gpt-4o-mini", 0.78, 0.15, 0.6, { sampling: true, contextWindow: 128e3, maxOutput: 16384, ttftMs: 450 }),
  gemini("gemini-2.5-pro", 0.92, 1.25, 10, { ttftMs: 1800, tokensPerSec: 90 }),
  gemini("gemini-2.5-flash", 0.87, 0.3, 2.5, { ttftMs: 600, tokensPerSec: 180 }),
  gemini("gemini-2.5-flash-lite", 0.8, 0.1, 0.4, { ttftMs: 400, tokensPerSec: 250 }),
  workersAi("@cf/meta/llama-3.3-70b-instruct-fp8-fast", 0.82, 0.29, 2.25),
  workersAi("@cf/meta/llama-3.1-8b-instruct-fast", 0.7, 0.045, 0.384, { ttftMs: 200, tokensPerSec: 150, features: ["system", "streaming", "stop_sequences", "sampling"] }),
  workersAi("@cf/qwen/qwen2.5-coder-32b-instruct", 0.8, 0.66, 1, {
    specialties: ["coding"],
    contextWindow: 32e3,
    features: ["system", "streaming", "stop_sequences", "sampling"]
  }),
  // Embeddings
  { ...openai("text-embedding-3-small", 0.8, 0.02, 0), kind: "embedding", features: ["embeddings"], embeddingDims: 1536, contextWindow: 8191, maxOutput: 0 },
  { ...openai("text-embedding-3-large", 0.9, 0.13, 0), kind: "embedding", features: ["embeddings"], embeddingDims: 3072, contextWindow: 8191, maxOutput: 0 },
  { ...gemini("gemini-embedding-001", 0.9, 0.15, 0), kind: "embedding", features: ["embeddings"], embeddingDims: 3072, contextWindow: 2048, maxOutput: 0 },
  { ...workersAi("@cf/baai/bge-m3", 0.78, 0.012, 0), kind: "embedding", features: ["embeddings"], embeddingDims: 1024, contextWindow: 8192, maxOutput: 0 }
];

// ../core/src/capabilities.ts
var CapabilityCompatibilityEngine = class {
  check(candidate, req) {
    const missing = [];
    const have = new Set(candidate.features);
    for (const f of req.requiredFeatures) {
      if (have.has(f)) continue;
      if (f === "json_object" && have.has("json_schema")) continue;
      missing.push(f);
    }
    const needed = req.contextTokens + (req.maxOutputTokens ?? 0);
    if (candidate.kind === "chat" && needed > candidate.contextWindow) missing.push(`context_window(${needed}>${candidate.contextWindow})`);
    if (req.maxOutputTokens && candidate.kind === "chat" && req.maxOutputTokens > candidate.maxOutput)
      missing.push(`max_output(${req.maxOutputTokens}>${candidate.maxOutput})`);
    if (req.privacy === "strict" && candidate.privacy !== "strict") missing.push("privacy:strict");
    if (req.verification === "strict" && !candidate.verified) missing.push("verification:strict");
    if (req.vendorLock && candidate.providerGroup !== req.vendorLock) missing.push(`vendor_lock:${req.vendorLock}`);
    return { compatible: missing.length === 0, missing };
  }
  filter(candidates, req) {
    const compatible = [];
    const rejected = [];
    for (const c of candidates) {
      const r = this.check(c, req);
      if (r.compatible) compatible.push(c);
      else rejected.push({ model: c.id, provider: c.provider, reasons: r.missing });
    }
    return { compatible, rejected };
  }
};

// ../pai/src/index.ts
var GENESIS_MS = Date.UTC(2026, 8, 26);
var ALLOCATION = {
  /** Minted per epoch for verified work only. */
  networkRewards: 5e8,
  ecosystemTreasury: 15e7,
  contributors: 15e7,
  community: 12e7,
  liquidity: 8e7,
  /** Locked: minted in tranches as cumulative network fees pass INVESTOR_UNLOCKS milestones. */
  investorsAndFounders: 9e9
};
var NETWORK_REWARD_POOL = ALLOCATION.networkRewards;
var HALVING_EPOCHS = 730;
var INITIAL_EPOCH_EMISSION = NETWORK_REWARD_POOL * (1 - 2 ** (-1 / HALVING_EPOCHS));
var GENESIS_SUPPLY = ALLOCATION.ecosystemTreasury + ALLOCATION.contributors + ALLOCATION.community + ALLOCATION.liquidity;

// ../core/src/router.ts
var engine = new CapabilityCompatibilityEngine();

// ../core/src/secrets.ts
var te = new TextEncoder();
var td = new TextDecoder();

// ../core/src/network.ts
var HEARTBEAT_TTL_MS = 3 * 6e4;
var enc = new TextEncoder();
async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256HexStr(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function verifyNodeRequest(secret, body, headers, now = Date.now(), maxSkewMs = 5 * 6e4) {
  const ts = Number(headers.timestamp);
  if (!headers.signature || !Number.isFinite(ts) || Math.abs(now - ts) > maxSkewMs) return false;
  const expected = await hmacHex(secret, `${headers.timestamp}.${await sha256HexStr(body)}`);
  if (expected.length !== headers.signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ headers.signature.charCodeAt(i);
  return diff === 0;
}

// src/index.ts
function detectReasoningLevel(model) {
  const m = model.toLowerCase();
  if (/(^|[^a-z])(r1|qwq|reason|think|o\d)([^a-z]|$)/.test(m) && !/(1\.5|3|7|8)b/.test(m)) return 2;
  const b = /(\d+(?:\.\d+)?)\s*b\b/.exec(m.replace(/[:_-]/g, " "));
  const size = b ? Number(b[1]) : NaN;
  if (Number.isNaN(size)) return 1;
  if (size <= 8.5) return 0;
  if (size <= 72) return size >= 65 ? 2 : 1;
  return 2;
}
function detectGpu() {
  return new Promise((resolve) => {
    execFile("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], { timeout: 3e3 }, (err, stdout) => {
      if (err || !stdout.trim()) return resolve({});
      const [name, mem] = stdout.trim().split("\n")[0].split(",").map((s) => s.trim());
      resolve({ gpu: name, vramGb: Math.round(Number(mem) / 1024) });
    });
  });
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
var ProviderNode = class {
  constructor(cfg) {
    this.cfg = cfg;
  }
  cfg;
  server;
  inflight = 0;
  queueMs = 0;
  heartbeat;
  state;
  stats = { served: 0, rejected: 0, errors: 0 };
  get f() {
    return this.cfg.fetch ?? fetch;
  }
  log(m) {
    (this.cfg.log ?? ((s) => console.log(`[dsi-node] ${s}`)))(m);
  }
  /** Models the local LLM server offers. */
  async localModels() {
    const res = await this.f(`${this.cfg.llmBaseUrl.replace(/\/$/, "")}/models`, { headers: this.cfg.llmApiKey ? { authorization: `Bearer ${this.cfg.llmApiKey}` } : {} });
    if (!res.ok) throw new Error(`local LLM server at ${this.cfg.llmBaseUrl} returned ${res.status}`);
    const j = await res.json();
    const ids = (j.data ?? []).map((m) => m.id);
    return this.cfg.models?.length ? ids.filter((id) => this.cfg.models.includes(id)) : ids;
  }
  async verified(req, body) {
    if (!this.state) return false;
    return verifyNodeRequest(this.state.secret, body, { timestamp: req.headers["x-dsi-timestamp"], signature: req.headers["x-dsi-signature"] });
  }
  async handle(req, res) {
    const url = new URL(req.url ?? "/", "http://node");
    const path = url.pathname.replace(/^\/v1/, "");
    if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true, inflight: this.inflight, registered: !!this.state });
    const body = req.method === "POST" ? await readBody(req) : "";
    const registrationProbe = this.pendingSecretCheck && req.method === "GET" && path === "/models";
    if (!registrationProbe && !await this.verified(req, body)) {
      this.stats.rejected++;
      return json(res, 401, { error: { message: "requests must be signed by the Decentralised.si router" } });
    }
    if (req.method === "GET" && path === "/models") return json(res, 200, { object: "list", data: (await this.localModels()).map((id) => ({ id, object: "model", owned_by: this.cfg.name })) });
    if (req.method !== "POST" || !["/chat/completions", "/embeddings"].includes(path)) return json(res, 404, { error: { message: "not found" } });
    if (this.paused) return json(res, 503, { error: { message: `node paused (${this.pausedReason})` } });
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return json(res, 400, { error: { message: "invalid JSON" } });
    }
    delete payload.user;
    delete payload.metadata;
    const consulted = path === "/chat/completions" ? this.addExpertContext(payload) : [];
    if (path === "/chat/completions" && this.cfg.minMaxTokens) {
      for (const k of ["max_tokens", "max_completion_tokens"]) if (typeof payload[k] === "number" && payload[k] < this.cfg.minMaxTokens) payload[k] = this.cfg.minMaxTokens;
    }
    const started = Date.now();
    if (this.inflight < this.cfg.maxConcurrency) this.inflight++;
    else if (!await this.waitForSlot(res)) return json(res, 503, { error: { message: "node at capacity" } });
    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) ac.abort();
    });
    let keepalive;
    if (!payload.stream)
      keepalive = setInterval(() => {
        if (!res.headersSent) res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
        res.write(" ");
      }, this.keepaliveMs);
    try {
      const upstream = await this.f(`${this.cfg.llmBaseUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.cfg.llmApiKey ? { authorization: `Bearer ${this.cfg.llmApiKey}` } : {} },
        body: JSON.stringify(payload),
        signal: ac.signal
      });
      if (keepalive && res.headersSent) {
        clearInterval(keepalive);
        const text = await upstream.text();
        res.end(upstream.ok ? text : JSON.stringify({ error: { message: `local LLM returned ${upstream.status}: ${text.slice(0, 300)}` } }));
        if (upstream.ok) this.stats.served++;
        else this.stats.errors++;
        return;
      }
      clearInterval(keepalive);
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-cache" });
      const trace = upstream.ok && this.cfg.traceRetrieval && consulted.length ? traceNote(consulted) : "";
      if (trace && payload.stream) {
        res.write(`data: ${JSON.stringify({ id: "trace", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1e3), model: String(payload.model ?? ""), choices: [{ index: 0, delta: { role: "assistant", content: trace }, finish_reason: null }] })}

`);
      }
      if (trace && !payload.stream) {
        const j = await upstream.json();
        const m = j.choices?.[0]?.message;
        if (m) m.content = trace + (m.content ?? "");
        res.end(JSON.stringify(j));
      } else {
        if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
        res.end();
      }
      if (upstream.ok) this.stats.served++;
      else this.stats.errors++;
    } catch (e) {
      clearInterval(keepalive);
      this.stats.errors++;
      const message = `local LLM error: ${e instanceof Error ? e.message : String(e)}`;
      if (!res.headersSent) json(res, 502, { error: { message } });
      else res.end(keepalive ? JSON.stringify({ error: { message } }) : void 0);
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.inflight--;
      this.queueMs = Math.round(0.8 * this.queueMs + 0.2 * (Date.now() - started) * (this.inflight / Math.max(1, this.cfg.maxConcurrency)));
    }
  }
  pendingSecretCheck = false;
  /** How often a slow non-streaming answer sends keep-alive whitespace. */
  keepaliveMs = 15e3;
  paused = false;
  pausedReason = "";
  powerTimer;
  /** Pause or resume taking work; routers are told at once with a heartbeat. */
  async setPaused(paused, reason = "") {
    if (paused === this.paused) return;
    this.paused = paused;
    this.pausedReason = reason;
    this.log(paused ? `paused: ${reason}` : "resumed");
    await this.sendHeartbeat().catch((e) => this.log(`heartbeat failed: ${e.message}`));
  }
  /** Watches the power source and pauses while on battery. */
  watchPower(intervalMs = 3e4) {
    const check = async () => {
      const onBattery = await isOnBattery();
      if (onBattery !== void 0) await this.setPaused(onBattery, "running on battery");
    };
    void check();
    this.powerTimer = setInterval(check, intervalMs);
  }
  waiters = [];
  /** Queues a request for a free slot (bounded wait, first come first served). */
  waitForSlot(res) {
    const max = this.cfg.maxQueueMs ?? 3e4;
    if (max <= 0 || this.waiters.length >= this.cfg.maxConcurrency * 4) return Promise.resolve(false);
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== wake);
        resolve(false);
      }, max);
      res.on("close", () => {
        if (!this.waiters.includes(wake)) return;
        this.waiters = this.waiters.filter((w) => w !== wake);
        clearTimeout(timer);
        resolve(false);
      });
      this.waiters.push(wake);
    });
  }
  /** Puts the expert persona and the most relevant knowledge passages in front of the conversation. */
  addExpertContext(payload) {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const question = typeof lastUser?.content === "string" ? lastUser.content : Array.isArray(lastUser?.content) ? lastUser.content.map((p) => p.text ?? "").join(" ") : "";
    const notes = this.cfg.knowledge && question ? this.cfg.knowledge.search(question, 3) : [];
    const system = expertSystemMessage(this.cfg.persona, notes);
    if (system) {
      const existing = messages.filter((m) => m.role === "system").map((m) => typeof m.content === "string" ? m.content : "").join("\n\n");
      payload.messages = [{ role: "system", content: existing ? `${system}

${existing}` : system }, ...messages.filter((m) => m.role !== "system")];
    }
    return notes;
  }
  async listen() {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        this.log(`handler error: ${e instanceof Error ? e.message : e}`);
        if (!res.headersSent) json(res, 500, { error: { message: "internal error" } });
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once(
        "error",
        (e) => reject(e.code === "EADDRINUSE" ? new Error(`port ${this.cfg.port} is already in use (is another node running? set PORT to use a different one)`) : e)
      );
      this.server.listen(this.cfg.port, resolve);
    });
    const port = this.server.address().port;
    this.log(`listening on :${port}, forwarding to ${this.cfg.llmBaseUrl}`);
    return port;
  }
  async router(path, init = {}) {
    const res = await this.f(`${this.cfg.router.replace(/\/$/, "")}${path}`, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: { authorization: `Bearer ${this.cfg.apiKey}`, "content-type": "application/json" },
      body: init.body ? JSON.stringify(init.body) : void 0
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.error?.message ?? `router returned ${res.status}`);
    return j;
  }
  /** Register with the network (or update the endpoint of an existing registration). */
  async register(existing) {
    if (!this.cfg.publicUrl) throw new Error("publicUrl is required: expose this node over https (e.g. `cloudflared tunnel --url http://localhost:8787`)");
    const endpoint = this.cfg.publicUrl.replace(/\/$/, "").replace(/(\/v1)?$/, "/v1");
    if (existing) {
      this.state = existing;
      try {
        const models2 = await this.localModels();
        await this.router(`/api/nodes/${existing.nodeId}`, {
          method: "PATCH",
          body: { endpoint, ...models2.length ? { models: this.declare(models2) } : {}, ...this.cfg.domains ? { domains: this.cfg.domains } : {} }
        });
        this.state = { ...existing, endpoint };
        return this.state;
      } catch (e) {
        if (!/not found/i.test(e instanceof Error ? e.message : String(e))) throw e;
        this.log(`saved node ${existing.nodeId} is gone; registering a new one`);
        this.state = void 0;
      }
    }
    const models = await this.localModels();
    if (!models.length) throw new Error("the local LLM server reports no models; pull one first (e.g. `ollama pull llama3.1:8b`)");
    const hardware = await detectGpu();
    this.pendingSecretCheck = true;
    try {
      const r = await this.router("/api/nodes", {
        body: {
          name: this.cfg.name,
          endpoint,
          models: this.declare(models),
          hardware,
          region: this.cfg.region,
          location: this.cfg.location,
          domains: this.cfg.domains
        }
      });
      this.state = { nodeId: r.node.id, secret: r.node_secret, endpoint };
    } finally {
      this.pendingSecretCheck = false;
    }
    this.log(`registered as ${this.state.nodeId} with ${models.length} model(s); status: probation until canaries pass`);
    return this.state;
  }
  /** How this node describes its models to the router. */
  declare(models) {
    return models.map((id) => ({ id, reasoningLevel: this.cfg.levels?.[id] ?? detectReasoningLevel(id), features: ["system", "streaming", "stop_sequences", "sampling"], ...this.cfg.ttftMs ? { ttftMs: this.cfg.ttftMs } : {} }));
  }
  async sendHeartbeat() {
    if (!this.state) return;
    return this.router(`/api/nodes/${this.state.nodeId}/heartbeat`, { body: { load: this.inflight / Math.max(1, this.cfg.maxConcurrency), queue_ms: this.queueMs, ...this.paused ? { paused: true } : {} } });
  }
  startHeartbeat(intervalMs = 3e4) {
    this.heartbeat = setInterval(() => this.sendHeartbeat().catch((e) => this.log(`heartbeat failed: ${e.message}`)), intervalMs);
  }
  async earnings() {
    return this.router("/api/nodes");
  }
  async close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.powerTimer) clearInterval(this.powerTimer);
    await new Promise((r) => this.server ? this.server.close(() => r()) : r());
  }
};
async function isOnBattery() {
  try {
    if (process.platform === "darwin") {
      const out = await run("pmset", ["-g", "batt"]);
      return out.includes("'Battery Power'") ? true : out.includes("'AC Power'") ? false : void 0;
    }
    if (process.platform === "linux") {
      const { readdirSync: readdirSync2, readFileSync: readFileSync3 } = await import("node:fs");
      const base = "/sys/class/power_supply";
      const mains = readdirSync2(base).filter((d) => readFileSync3(`${base}/${d}/type`, "utf8").trim() === "Mains");
      if (!mains.length) return void 0;
      return mains.every((d) => readFileSync3(`${base}/${d}/online`, "utf8").trim() === "0");
    }
    if (process.platform === "win32") {
      const out = (await run("powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Battery | Select-Object -First 1).BatteryStatus"])).trim();
      return out === "" ? void 0 : out === "1";
    }
  } catch {
  }
  return void 0;
}
function run(cmd, args) {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: 5e3 }, (e, out) => e ? reject(e) : resolve(String(out))));
}
function traceNote(notes) {
  return `<think>Knowledge consulted by this node:
${notes.map((n, i) => `[${i + 1}] ${n.source}`).join("\n")}
</think>

`;
}
function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// src/cli.ts
var env = process.env;
var statePath = env.DSI_NODE_STATE ?? join2(homedir(), ".dsi-node", "state.json");
function loadState() {
  try {
    if (env.DSI_NODE_STATE_JSON) return JSON.parse(env.DSI_NODE_STATE_JSON);
  } catch {
    console.log("[dsi-node] ignoring DSI_NODE_STATE_JSON: not valid JSON");
  }
  try {
    return JSON.parse(readFileSync2(statePath, "utf8"));
  } catch {
    return void 0;
  }
}
function saveState(s) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(s, null, 2));
  chmodSync(statePath, 384);
}
async function discoverTunnel() {
  if (!env.CLOUDFLARED_METRICS) return void 0;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${env.CLOUDFLARED_METRICS.replace(/\/$/, "")}/quicktunnel`);
      const j = await r.json();
      if (j.hostname) return `https://${j.hostname}`;
    } catch {
    }
    await new Promise((r) => setTimeout(r, 2e3));
  }
  throw new Error("could not discover the cloudflared quick-tunnel URL");
}
function levels() {
  const out = {};
  for (const pair of (env.DSI_LEVELS ?? "").split(",").filter(Boolean)) {
    const [k, v] = pair.split("=");
    if (k && ["0", "1", "2", "3"].includes(v)) out[k.trim()] = Number(v);
  }
  return out;
}
async function node(publicUrl) {
  if (!env.DSI_API_KEY) throw new Error("DSI_API_KEY is required (create one at https://decentralised.si/app/#/console/keys)");
  return new ProviderNode({
    router: env.DSI_ROUTER ?? "https://api.decentralised.si",
    apiKey: env.DSI_API_KEY,
    llmBaseUrl: env.LLM_BASE_URL ?? "http://localhost:11434/v1",
    llmApiKey: env.LLM_API_KEY,
    publicUrl,
    name: env.NODE_NAME ?? `node-${hostname()}`,
    port: Number(env.PORT ?? 8787),
    maxConcurrency: Number(env.MAX_CONCURRENCY ?? 4),
    levels: levels(),
    models: env.DSI_MODELS?.split(",").map((s) => s.trim()).filter(Boolean),
    location: env.DSI_NODE_LOCATION === "hidden" ? "hidden" : "auto",
    domains: parseDomains(env.DSI_DOMAINS),
    persona: env.DSI_PERSONA ?? (env.DSI_PERSONA_FILE ? readFileSync2(env.DSI_PERSONA_FILE, "utf8") : void 0),
    knowledge: env.DSI_KNOWLEDGE_DIR ? KnowledgeBase.fromDir(env.DSI_KNOWLEDGE_DIR) : void 0,
    traceRetrieval: env.DSI_TRACE_RETRIEVAL === "1",
    minMaxTokens: env.DSI_MIN_MAX_TOKENS ? Number(env.DSI_MIN_MAX_TOKENS) : void 0,
    ttftMs: env.DSI_TTFT_MS ? Number(env.DSI_TTFT_MS) : void 0,
    maxQueueMs: env.DSI_MAX_QUEUE_MS ? Number(env.DSI_MAX_QUEUE_MS) : void 0,
    pauseOnBattery: env.DSI_PAUSE_ON_BATTERY === "1"
  });
}
async function main() {
  const cmd = process.argv[2] ?? "up";
  if (cmd === "models") {
    const n2 = await node();
    for (const m of await n2.localModels()) console.log(`${m}	L${levels()[m] ?? detectReasoningLevel(m)}`);
    return;
  }
  if (cmd === "earnings") {
    const n2 = await node();
    console.log(JSON.stringify(await n2.earnings(), null, 2));
    return;
  }
  if (cmd !== "up") {
    console.log("usage: dsi-node [up|models|earnings]");
    process.exit(1);
  }
  const publicUrl = env.PUBLIC_URL ?? await discoverTunnel();
  const n = await node(publicUrl);
  await n.listen();
  let state;
  for (let attempt = 1; ; attempt++) {
    try {
      state = await n.register(loadState());
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt >= 12 || !/not reachable|fetch failed|ECONN|5\d\d/.test(msg)) throw e;
      console.log(`[dsi-node] ${msg} Retrying in ${attempt * 5}s (attempt ${attempt}/12)...`);
      await new Promise((r) => setTimeout(r, attempt * 5e3));
    }
  }
  saveState(state);
  if (env.DSI_STATE_SYNC_URL) {
    const r = await fetch(env.DSI_STATE_SYNC_URL, { method: "POST", headers: { authorization: `Bearer ${env.DSI_STATE_SYNC_TOKEN ?? ""}`, "content-type": "application/json" }, body: JSON.stringify(state) }).catch((e) => e);
    console.log(`[dsi-node] state sync: ${r instanceof Error ? r.message : r.status}`);
  }
  await n.sendHeartbeat();
  n.startHeartbeat();
  if (env.DSI_PAUSE_ON_BATTERY === "1") n.watchPower();
  console.log(`[dsi-node] live at ${state.endpoint} as ${state.nodeId}. Earnings: dsi-node earnings`);
  const stop = async () => {
    await n.setPaused(true, "shutting down").catch(() => {
    });
    await n.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
function parseDomains(s) {
  if (!s) return void 0;
  const out = {};
  for (const pair of s.split(",").map((p) => p.trim()).filter(Boolean)) {
    const [d, v] = pair.split(":");
    const n = Number(v ?? 0.9);
    if (d && n > 0 && n <= 1) out[d.trim()] = n;
  }
  return Object.keys(out).length ? out : void 0;
}
main().catch((e) => {
  console.error(`[dsi-node] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
