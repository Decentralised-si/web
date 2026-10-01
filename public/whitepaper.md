# Decentralised Super Intelligence

**How Decentralised.si routes every question to the right intelligence, privately, and pays everyone who powers it or makes it smarter**

*Whitepaper v0.3 · 28 September 2026 · Decentralised.si*

---

## Abstract

Intelligence is becoming a utility, but today it is dispensed by a handful of vendors, each with its own API, its own prices, and a complete view of everything its users ask. Meanwhile millions of GPUs sit idle in homes, labs and data centres, and capable open-weight models are free to run.

Decentralised.si is the routing layer between applications and intelligence. Applications keep the SDK and code they already have and change one base URL. A **harness** on the user's device keeps their memory and preferences, and **DSI Synapse**, an optional router on the device, can choose between local models, the user's own keys and the network. **DSI Axon**, a **blind router** in the network, picks, for each conversation, the cheapest provider that is capable, fast and private enough: the user's own commercial API accounts, or an open network of independent GPU operators. The router works without reading the query. Anyone can join the network by running one container next to an open-source model server, and is paid in **PAI**, a token capped at 10B. Its emission falls over time and as the network grows, a share of every fee is burned, and staking it unlocks access to the most capable ("novel") intelligence. Users also earn PAI by **adding knowledge**. Through the **Learning Fabric**, a correction a user makes becomes a de-personalised learning object on their device. The network proves the object is novel, validates it, trains it into a small adapter, and pays the contributor in three stages: a little at verification, more once the model measurably improves, and a royalty while the improved model is used.

This paper describes the architecture, the privacy model, the provider network, the PAI economics and the Learning Fabric. It also states which parts run today and which are on the roadmap.

---

## 1. Design principles

1. **Drop-in, not another API.** Existing Anthropic, OpenAI and Gemini applications work unchanged, including streaming and tool calls. MCP-native agents connect directly.
2. **The user's knowledge stays with the user.** Memory, preferences and conversation history live in the harness on the user's device. The network sees one conversation at a time and nothing else.
3. **Route without reading.** The router decides from the *shape* of a request (size, tools, features) and a reasoning-level hint computed on the device. It does not inspect, log or classify prompt text.
4. **No single provider sees a user's whole life.** Each new conversation goes to a different equivalent provider. Turns within one conversation stay together.
5. **Capability before cost.** A cheaper model is never substituted if it cannot do what the request needs, such as tools, JSON schema, vision, context length or privacy level.
6. **Anyone can supply intelligence.** One command turns a GPU and an open model into a paid network node. Rewards follow verified work, not capital.
7. **Common knowledge gets cheaper; novel intelligence is earned.** Commodity answers fall in price every year. Frontier reasoning is rationed by stake, not by who you are.
8. **No provider is load-bearing.** Conversation state lives with the client, so any provider (or model family, or vendor) can fail between turns or mid-answer without interrupting the conversation.
9. **Supply follows usage.** PAI has a hard cap of 10B. Reward emission halves every two years and shrinks as the network grows. The investors-and-founders allocation unlocks only as real network fees accumulate, and fees paid in PAI and slashing burn supply.
10. **Pay for knowledge, not data.** Users can opt in to teach the network. Only a de-personalised lesson leaves the device, never the conversation, and rewards follow verified novelty, measured model improvement and real usage, not submission volume.

---

## 2. Architecture

![Decentralised.si architecture](whitepaper/architecture.svg)

*Figure 1. Layers of the system. Everything above the dashed line runs on the user's device.*

| Layer | Runs where | Responsibility | Status |
|---|---|---|---|
| **Harness** (`dsi`) | User's device | Memory, preferences, local recall, difficulty hint, session ids; MCP server; local proxy | Implemented |
| **DSI Synapse** (`synapse`) | User's device (optional) | Local routing by domain, difficulty and quality; pseudonymisation; hedging, fallback and escalation; discovery of specialist nodes | Preview |
| **Access layer** | Edge (`api.decentralised.si`) | Anthropic, OpenAI and Gemini compatible APIs; MCP over Streamable HTTP | Implemented |
| **DSI Axon** (the blind router) | Edge, stateless | Canonical translation, capability gate, scoring, session sharding, failover, stream translation, identity stripping | Implemented |
| **Provider markets** | Vendors / operators | A: customer's own commercial keys (BYOK). B: community and specialist nodes | Implemented |
| **Verification** | Router + (phase 2) verifiers | Structural checks, canary prompts, reputation, slashing | Canaries implemented; verifier market phase 2 |
| **Learning Fabric** | Device (extraction, privacy gate) + router (novelty, validation, rewards) + trainers | Turns user corrections into verified delta knowledge, trains adapters, pays contributors | Implemented; adapter serving on the roadmap |
| **PAI settlement** | Off-chain ledger → chain | Work metering, epoch emission, burn, staking, bonds | Ledger + reference contract implemented; mainnet not launched |

### 2.1 Request lifecycle

```mermaid
sequenceDiagram
    autonumber
    participant App as App / agent
    participant H as Harness (device)
    participant A as Access layer
    participant R as DSI Axon (blind router)
    participant P as Provider
    participant L as PAI ledger
    App->>H: prompt
    H->>H: recall relevant memories (local BM25)<br/>classify difficulty locally → level hint<br/>attach random session id
    H->>A: one conversation + X-Decentralise-Reasoning + X-Decentralise-Session
    A->>R: canonical request (vendor schema removed)
    R->>R: capability gate → score (cost, speed, intelligence, location)<br/>→ rendezvous-hash the session onto one provider
    R->>P: signed request, identity stripped
    P-->>R: stream
    R-->>A: canonical events, translated one by one
    A-->>App: vendor-native stream (Anthropic / OpenAI / Gemini)
    R--)L: work units for the node (no user data)
```

---

## 3. The harness layer: memory lives on the device

The harness is the only component that knows the user. It is a small open-source program (`dsi`), shipped as a CLI, a local MCP server and a local OpenAI-compatible proxy.

- **Memory and preferences** are files on the device, encrypted at rest with a passphrase (AES-GCM, PBKDF2-derived key). They are never uploaded.
- **Local recall.** For each prompt, the harness ranks memories on the device (BM25). Only the few that are relevant go into *that request's* system prompt, and only for that request. In the test suite, a request about data cleaning carries the user's "prefers pandas" memory and nothing about their dog or their city.
- **Local difficulty classification.** The harness reads the prompt, on the device, and sends only a reasoning-level hint (`X-Decentralise-Reasoning: 0–3`). The router routes on the hint.
- **Unlinkable sessions.** Each conversation gets a random session id. The history of a conversation is held by the harness and replayed each turn, so the network needs no server-side conversation state.
- **Works with everything.** `dsi mcp` gives Claude Code, Claude Desktop and IDE agents tools for memory and private network access (`ask_network`, `remember`, `recall`, `forget`, `set_preference`). `dsi proxy` gives any OpenAI-compatible app the same memory without code changes.

```mermaid
flowchart LR
  subgraph Device["User device (private)"]
    M[(memory + preferences<br/>encrypted at rest)]
    Q[prompt] --> C{local classifier}
    Q --> RC[local recall]
    M --> RC
    RC --> S[relevant memories<br/>+ preferences]
    C --> Hint[reasoning level 0–3]
  end
  S --> Out[one conversation]
  Hint --> Out
  SID[random session id] --> Out
  Out -->|HTTPS| Net[Decentralised.si]
```

---

## 4. The access layer: API and MCP

### 4.1 Drop-in vendor APIs

| Protocol | SDK base URL | Endpoints |
|---|---|---|
| Anthropic | `https://api.decentralised.si/anthropic` | `POST /v1/messages` (streaming), `/v1/messages/count_tokens`, `GET /v1/models` |
| OpenAI | `https://api.decentralised.si/openai/v1` | `/chat/completions`, `/responses`, `/embeddings`, `/models` |
| Gemini | `https://api.decentralised.si/gemini` | `:generateContent`, `:streamGenerateContent`, `:embedContent`, `:batchEmbedContents`, `:countTokens` |

Every protocol is translated to **one canonical representation** of messages, tools, tool choice, structured output, reasoning and a stream-event model (`message_start`, `content_delta`, `reasoning_delta`, `tool_call_start`, `tool_call_delta`, `usage`, `message_end`, `error`). The router only ever sees that representation. A developer using Anthropic tools receives Anthropic `tool_use` blocks even when OpenAI or Gemini generated the call. Streams are translated event by event, so time-to-first-token is preserved.

Routing is controlled without touching request bodies, via optional headers or the account's dashboard policy:

`X-Decentralise-Mode` (`passthrough`, `optimise`, `cheapest`, `fastest`, `quality`, `private`, `decentralised_only`, `byok_only`, `network_only`) · `X-Decentralise-Max-Cost` · `X-Decentralise-Max-Latency-Ms` · `X-Decentralise-Min-Quality` · `X-Decentralise-Privacy` · `X-Decentralise-Verification` · `X-Decentralise-Reasoning` · `X-Decentralise-Session`.

Every response reports its provenance (`x-decentralise-actual-provider`, `-actual-model`, `-market`, `-receipt`). The response body's `model` field always names the model that really answered.

### 4.2 MCP layer

`POST https://api.decentralised.si/mcp` speaks the Model Context Protocol (Streamable HTTP, JSON-RPC 2.0). Tools:

| Tool | Purpose |
|---|---|
| `ask` | Query the network; optional `reasoning_level`, `mode`, `session_id`, `model` |
| `explain_route` | Dry run: which providers would serve this request shape, and why others were rejected |
| `list_models` | Models the account can reach, with market, level and price |
| `network_status` | Nodes per reasoning level, utilisation, required stake, today's emission |
| `pai_account` | PAI balance and stake, and which levels the stake unlocks |

---

## 5. DSI Axon, the blind router

### 5.1 What the router is allowed to know

The router sees the request *envelope*: token counts, number of turns, declared tools, response format, requested features, the client's reasoning hint and session id, and a coarse location from the edge. It does not read message text to route. When no hint is present, it uses only structural signals and never assumes the lowest level.

### 5.2 Selection

1. **Capability gate (mandatory).** A candidate is compatible only if it supports every required feature (tools, forced tool choice, parallel tools, JSON object/schema, vision, reasoning, stop sequences, prompt caching) and satisfies the context window, output limit, privacy level, verification level, vendor lock and PAI stake gate. Incompatible candidates are never chosen, whatever their price or quality.
2. **Hard constraints.** Maximum cost, maximum latency and a caller-set minimum quality.
3. **Quality target.** Each reasoning level has a soft target (L0 0.68 · L1 0.80 · L2 0.87 · L3 0.93). Candidates above it are preferred. If none reach it, the best compatible ones are used.
4. **Score.** In `optimise` mode each candidate `c` gets

   `score(c) = w_q·q̂(c) + w_c·ĉ(c) + w_l·l̂(c) + w_d·d(c)`

   where `q̂` is normalised quality, `ĉ` normalised log-cost (cheaper is higher), `l̂` normalised expected latency (faster is higher), and `d = 1` for network or decentralised providers. The default weights are 40/30/20/10 and each account sets its own. Expected latency is `TTFT + queue + 3·distance/100 km + tokens/throughput`, so a node in Sydney wins for a user in Melbourne and a node in London wins for a user in Paris.
5. **Session sharding.** Among candidates within a small band of the best score, the router picks the provider maximising `hash(session ‖ provider)` (rendezvous hashing). A conversation stays on one provider across turns. Different conversations spread evenly over equivalent providers, so no single operator can assemble a user's history across conversations.
6. **Failover.** Up to four attempts are made on rate limits, timeouts, overloads, refused connections or bad credentials, trying the best candidate of each *other* provider first and skipping every model of a provider that is down. If a stream fails after bytes have reached the client, the answer is continued on another provider inside the same response (§7.2).

In the test suite the router reproduces this example. Suppose a user has connected three providers:

| Candidate | Quality | Expected cost | Latency |
|---|---|---|---|
| A (commercial frontier) | 0.94 | $0.018 | 2.1 s |
| B (commercial mid) | 0.87 | $0.004 | 0.8 s |
| C (network node) | 0.84 | $0.001 | 0.5 s |

A simple request goes to C, a medium one to B and a hard one to A. The developer decides nothing manually.

### 5.3 What providers receive

Network providers receive a signed request (HMAC-SHA256 over timestamp and body hash, with a per-node secret) containing the conversation and generation parameters, and nothing else: no account id, API key, end-user id, IP address or memory store. The node agent strips identifying fields again on arrival as defence in depth. Customer BYOK keys are envelope-encrypted, decrypted only inside the outbound call to that customer's own vendor, and can never reach a network node.

---

## 6. Privacy and anonymity

| Party | Sees | Never sees |
|---|---|---|
| **Harness (device)** | Everything the user chooses to store | n/a |
| **Router** | One conversation in transit; envelope metadata; the account's ds_ key; coarse location for this decision | Stored memory; other conversations' content (nothing is logged); prompts in logs or receipts (hashes only) |
| **Network provider** | One conversation (or one of its turns), signed by the router | Who is asking; the account; IP; other conversations of the same user; any memory beyond what that request carries |
| **BYOK vendor** | What the customer already sent that vendor before adopting Decentralised.si | Anything from other vendors or other users |
| **Peer on the direct path** (free chat, §12.1) | The turn it answers; the client's IP address; a random ticket id | The account; other users; anything on other peers |
| **PAI ledger** | Work units per node per epoch; payouts; stakes | Any request content or requester identity |

**Implemented today:**
- Client-side memory, recall and classification.
- Blind routing, session sharding and identity stripping.
- Signed node requests.
- Hash-only receipts: request and response content are stored as SHA-256 digests.
- Credential redaction everywhere.
- Envelope-encrypted BYOK keys bound to account and credential by AAD.

**Roadmap:**
- **Anonymous credit.** Blind-signed prepaid tokens (Privacy Pass style) so that even the router cannot link requests to an account. The ds_ key buys tokens; the tokens pay for requests.
- **Oblivious relays.** Oblivious HTTP relays in front of the access layer, so the router never learns the client IP.
- **Confidential nodes.** TEE-attested nodes (GPU confidential computing) for `X-Decentralise-Privacy: strict`, so the node operator cannot read the prompt either.

---

## 7. When a provider fails: continuity and isolation

A decentralised network is only credible if a conversation survives any single participant disappearing, and if spreading work across many participants does not spread a user's conversations with it. This section explains how Decentralised.si does both, compares it with centralised LLM services, and gives the argument, with the tests that check it, that the network does not depend on any one model, provider or vendor.

### 7.1 Where a conversation lives

The key design decision is that **no provider holds conversation state**. A conversation's context is held in two places:

| State | Held by | Lifetime |
|---|---|---|
| Full history (messages, tool calls and results) | The client (harness or application) | As long as the user keeps it |
| Long-term memory and preferences | The harness, on the device | Until the user deletes it |
| The partial answer of the turn in flight | Axon, in memory (`StreamAccumulator`) | One turn; never persisted |
| Affinity: which provider served the last turn | The client, echoed in `X-Decentralise-Affinity` | One conversation |

Every request carries the full context the provider needs for that turn, translated into that provider's native schema by the protocol adapters. A provider is a pure function from context to next message. Losing it loses nothing that cannot be reproduced.

### 7.2 What happens when a provider goes offline

| When it fails | What the network does | What the client sees |
|---|---|---|
| **Before the first byte** of a turn | Fails over down a diversified candidate list: the best candidate of each *other* provider first, and every model of a provider that refused the connection is skipped | A normal response, a little later; `x-decentralise-failovers` counts the retries |
| **In the middle of a streamed answer** | Axon keeps the partial answer, sends the conversation plus the partial answer and a one-line continuation note to the next compatible provider, and splices its stream into the same response: one `message_start`, one text block, usage summed | One uninterrupted message in its own protocol. The receipt records `resumedOn` |
| **Between turns** | The client's affinity points at a provider that is gone. The router skips it and picks the next equivalent one; the next response carries the new affinity | Nothing unusual |
| **The original provider comes back** | The client keeps echoing the new affinity, so the conversation **stays** with its replacement instead of bouncing back | Nothing |
| **A whole vendor or the whole network is down** | Candidates from other vendors and the other market remain; only an explicit `network_only` or `byok_only` policy can exclude them | An honest `5xx` only if *every* compatible provider is down |

```mermaid
sequenceDiagram
    autonumber
    participant C as Client (holds history)
    participant G as DSI Axon
    participant A as Provider A
    participant B as Provider B
    C->>G: turn n (full history, affinity=A)
    G->>A: turn n, translated to A's schema
    A-->>G: "The capital of Fra"
    G-->>C: "The capital of Fra"
    A--xG: connection lost
    Note over G: partial answer kept in memory,<br/>no tool call started → resumable
    G->>B: history + partial answer + continuation note (B's schema)
    B-->>G: "nce is Paris."
    G-->>C: "nce is Paris." (same message, same block)
    G-->>C: message end, usage = A + B
    Note over C: next turn sends affinity=B
```

Two cases are deliberately **not** papered over:

- **A tool call that was already streaming.** Its arguments are half-sent, and guessing the rest could run a real action with wrong inputs. The client receives an explicit error and retries the turn.
- **Passthrough mode.** The user asked for one specific model, so the turn is never continued on a different one.

### 7.3 Isolation: who can see a conversation

- **Exactly one recipient per turn.** A turn is sent to one provider. The only exception is shadow `benchmark` mode, which the customer must switch on explicitly.
- **Few providers per conversation.** With client-held affinity, the set of providers that ever see a conversation is the first provider plus one per failure that occurs during the conversation. In the normal case, that is one.
- **Conversations are not linkable across providers.** Session ids are random per conversation, rendezvous hashing spreads conversations over equivalent providers, and providers receive no account id, API key, end-user id or client IP. A provider cannot tell whether two conversations it served came from the same person, and it never receives conversations routed elsewhere.
- **The router keeps nothing readable.** Receipts store SHA-256 digests of content, logs contain no prompts, the partial-answer buffer lives only as long as the turn, and BYOK keys are envelope-encrypted.
- **On the wire.** Every hop uses TLS: client to edge, edge to vendor, and edge to node (through the node's tunnel). Router-to-node requests carry an HMAC over timestamp and body, so they cannot be injected, altered or replayed outside a five-minute window. A third party on the path sees ciphertext.

### 7.4 Compared with centralised LLM services

| | Centralised LLM service (one vendor, direct) | Decentralised.si |
|---|---|---|
| Where conversation history and memory live | On the vendor's servers, attached to your account | On your device. The network sees one turn's context, per request |
| One model or vendor has an outage | The service is down for everyone; streams in flight error out | The turn fails over to another provider or model family; an interrupted stream is continued in place |
| Architectural dependency | One model family, one API, one company | Any model behind any of the three vendor APIs or an OpenAI-compatible node; none is required |
| Who can see your conversations | One company sees all of them, linked to your identity and payment | Each provider sees only the conversations routed to it, without identity, and cannot link them |
| Retention | Under the vendor's policy | Router: hashes only. Nodes: the reference agent logs nothing. Strict mode: TEE nodes (roadmap) |
| Switching cost | Rewrite for another SDK, re-create memory | None: same SDK, same code; memory stays on the device |
| Who supplies intelligence | The vendor's own data centres | Commercial vendors *and* anyone with a GPU |

Multi-vendor gateways that retry on another API already exist, and they solve part of the availability problem. The differences here are that context and memory are held by the client, that routing works without reading prompts, that conversations are sharded and unlinkable across providers, that interrupted streams are continued rather than restarted, and that the supply side is open to anyone.

### 7.5 Why this works without relying on any one LLM

The claims above follow from five invariants of the design. Each is checked by the test suite in the DSI-AXON repository (`apps/gateway/test/continuity.test.ts` and the SDK compatibility suites), with real Anthropic, OpenAI, Gemini and MCP client SDKs on one side and providers speaking each vendor's wire format on the other.

**I1 · Providers are stateless with respect to the conversation.** Everything a provider needs is in the request, and nothing it holds is needed later (§7.1).
*So:* removing any provider removes no conversation state. The only thing at risk is the partial output of the turn in flight, which Axon holds.
*Test:* "provider goes offline between turns". Anthropic serves a tool call, then goes offline. The next turn, still asking for Anthropic, is served by another vendor. That vendor receives the complete history, including the tool call and its result, valid in its own schema, and not one byte of the turn reaches the offline provider.

**I2 · Every vendor schema maps to and from one canonical form.** Each adapter is a pair of translations (vendor → canonical, canonical → vendor) that preserve messages, tool calls, tool results, structured output and system instructions. The capability gate only admits providers that support every feature the conversation uses.
*So:* any conversation can move to any admitted provider.
*Test:* "one conversation across four unrelated model families". A single conversation is served turn by turn by Anthropic, then OpenAI, then Gemini, then an open-weight model on the network. Each receives the full history, including the other vendors' tool calls, and each vendor's schema validator reports zero errors.

**I3 · Failure handling covers every point in a turn.** Before the first byte: diversified failover. Mid-stream: continuation, when no tool call has started. Between turns: affinity miss, then re-route.
*So:* a turn completes whenever at least one compatible provider is reachable.
*Tests:* "provider dies in the middle of an answer" (Anthropic SDK and OpenAI SDK). The client receives one message whose text is the first provider's partial output followed by the second provider's continuation, with no error event. "Serves when every commercial vendor is down, and when the network is down" covers whole-market outages.

**I4 · One recipient per turn, few per conversation, no linkage.**
*Test:* "no sniffing". Three concurrent three-turn conversations, each carrying a secret marker. Each marker reaches exactly three provider requests (one per turn), all at a single provider. No request ever contains two conversations. No request contains the account id or key. None of the markers appears anywhere in the router's receipts, shadow records, node records, work ledger or logs.

**I5 · No component is special.** Providers are chosen per turn from whatever is compatible and reachable. The router is stateless and runs on every edge location. Clients can use any of three vendor protocols, or MCP.
*So:* there is no single model, provider or router instance whose loss ends a conversation.

**Availability, illustrated.** If a turn can be served by any of *k* independent compatible providers, each available a fraction *a* of the time, a turn fails only when all *k* are down at once: availability is `1 − (1 − a)^k`. With *a* = 99%, one provider gives 99%, two give 99.99% and three give 99.9999%. A single-vendor service is capped by that one vendor's availability. (Real outages are not perfectly independent: two nodes in the same region can fail together. Geographic and vendor diversity in the candidate list is what keeps the assumption close to true.)

### 7.6 Honest limits

- **The provider that serves a turn reads that turn's plaintext**, as every LLM provider does today. The design limits how *much* any provider sees (one conversation, unlinkable) rather than claiming it sees nothing. `X-Decentralise-Privacy: strict` with TEE-attested nodes (roadmap) closes this gap.
- **A failover provider sees the conversation's history**, because it must in order to answer. Affinity keeps this to one extra provider per failure.
- **Continuations are generated by a different model.** The text continues seamlessly and the receipt records the switch, but the style can shift slightly mid-answer. Passthrough mode never switches.
- **Hidden reasoning does not travel between vendors.** Vendor-signed reasoning (for example, Anthropic thinking signatures) is only valid on its own vendor, so it is dropped when a conversation moves. The visible conversation moves intact.
- **The router operator could, in principle, read traffic in flight**, because TLS terminates at the edge. Oblivious HTTP relays, anonymous credit and attested edge execution are the roadmap answers. Until then, the guarantee is policy and code (nothing is logged or persisted), not cryptography.

---

## 8. The provider network: fire up a server, earn PAI

### 8.1 Joining

```sh
curl -fsSLO https://decentralised.si/dl/docker-compose.yml
DSI_API_KEY=ds_live_... docker compose up -d          # Ollama + cloudflared + dsi-node
docker compose exec ollama ollama pull llama3.1:8b     # any open-weight model your GPU fits
```

Already running a model server? `node dsi-node.mjs up` with `LLM_BASE_URL` pointing at it (download from [/dl/dsi-node.mjs](/dl/dsi-node.mjs); checksums in [/dl/SHA256SUMS](/dl/SHA256SUMS)).

`dsi-node` wraps any OpenAI-compatible model server (Ollama, vLLM, llama.cpp, LM Studio, TGI). Cloudflare Tunnel gives it a public HTTPS address with no port forwarding or static IP. On start it:

- registers its models and declared reasoning levels, after the router probes the endpoint
- stores a one-time node secret
- verifies that every incoming request is signed by the router, and rejects everything else
- streams responses through without buffering
- heartbeats its load and queue depth every 30 seconds

```mermaid
flowchart LR
  G[GPU + open model<br/>Ollama / vLLM] --> N[dsi-node]
  N -->|register + heartbeat| R[Router]
  R -->|canary prompts| N
  R -->|signed user traffic| N
  N -->|work units| L[(PAI ledger)]
  L -->|epoch rewards| O[Operator wallet]
```

### 8.2 Reasoning levels

| Level | Examples | Work multiplier | Knowledge class | Provider bond |
|---|---|---|---|---|
| **L0 · recall** | ≤ 8B models: lookup, rewrite, classify | ×1 | common | none |
| **L1 · general** | 8–70B: everyday Q&A, summaries, code help | ×2 | common | none |
| **L2 · reasoning** | 70B+ and reasoning models: multi-step analysis, agents | ×4 | novel | 100 PAI |
| **L3 · frontier** | frontier-class or long-thinking models | ×8 | novel | 1,000 PAI |

### 8.3 Work units: GPU, bandwidth and quality become rewards

For each verified response a node serves:

`WU = ( (0.25·input_tokens + output_tokens)/1000 × level_multiplier + 0.01·MB_transferred ) × (0.5 + reputation)`

Output tokens weigh four times input tokens because they dominate GPU time. The level multiplier prices model size and thinking time, bandwidth is paid directly, and reputation (0–1) scales rewards between ×0.5 and ×1.5. A response that fails verification earns zero. For a typical request of 1,000 input and 500 output tokens at full reputation, that is **1.13 WU at L0, 2.25 at L1, 4.50 at L2 and 9.00 at L3**.

### 8.4 Keeping nodes honest

- **Probation.** New nodes start with reputation 0.5, and their advertised quality is capped at `0.6 + 0.4·reputation` until they earn more.
- **Canaries.** Every 15 minutes the router sends each node synthetic prompts with known answers, harder for higher levels. They are generated by the network and never drawn from user data. Three passes promote a node to *active*; persistent failures suspend it.
- **SLA and verification.** Every served response updates reputation, based on structural verification (valid tool calls, schema-valid JSON) and whether latency stayed within twice the estimate.
- **Slashing** (off-chain ledger today; on-chain once the contract is deployed). Model substitution caught by canaries: 50% of bond. False attestation by a verifier: 10%. Downtime while holding sessions: 1%. Slashed PAI is burned.

### 8.5 What an operator can earn

Illustrative figures from the reward formula, at launch-epoch emission, with 5,000 network participants and 5M work units per day across all providers. They are not a promise: earnings depend on network demand, total work and the PAI market.

| Node serving 2M output tokens/day at reputation 0.9 | Work units/day | PAI/day |
|---|---|---|
| L0 (e.g. 8B on a gaming GPU) | 4,901 | ~266 |
| L1 (e.g. 32B on a 24 GB card) | 9,801 | ~531 |
| L2 (e.g. 70B on a multi-GPU box) | 19,601 | ~1,059 |
| L3 (frontier-class open model) | 39,201 | ~2,110 |

Consumers pay for network inference in credit or PAI. Nodes earn epoch emission for verified work, and the fee flow funds operators once emission tapers.

---

## 9. PAI

### 9.1 Supply and allocation

Hard cap: **10,000,000,000 PAI**. Only 500M will exist at genesis. Another 500M can only be minted as rewards for verified work. The remaining 9B belongs to private investors and founders; it is locked and minted only as network usage grows (§9.2).

| Allocation | PAI | Share | Notes |
|---|---|---|---|
| Investors and founders | 9,000,000,000 | 90% | Locked; minted in ten tranches as cumulative network fees pass milestones (§9.2) |
| Network rewards | 500,000,000 | 5% | Minted per epoch for verified work only; never pre-minted |
| Ecosystem treasury | 150,000,000 | 1.5% | Grants, audits, public goods; 50M of it is earmarked as the Learning Fabric's incentive pool (§10.8) |
| Contributors | 150,000,000 | 1.5% | 4-year vesting |
| Community | 120,000,000 | 1.2% | Early users and early node operators |
| Liquidity | 80,000,000 | 0.8% | Market making |

### 9.2 Investors and founders unlock as volume grows

The 9B investors-and-founders allocation is not minted at genesis. It is released in ten tranches of **900M PAI**. Each tranche is minted once, when the network's cumulative fees reach its milestone. Time alone unlocks nothing: supply for investors and founders grows only as paying usage does. Unlocked tranches go to a single vault address (`investorVault`); the split between investors and founders, and any vesting after unlock, are enforced by that vault, not by the PAI contract. The split and vesting have not been decided yet; they will be published before any tranche can unlock.

| Tranche | Cumulative network fees | Unlocked in total | In the Figure 2 scenario |
|---|---|---|---|
| 1 | $1M | 900M | year 1.8 |
| 2 | $2.5M | 1.8B | year 2.3 |
| 3 | $5M | 2.7B | year 2.5 |
| 4 | $10M | 3.6B | year 2.8 |
| 5 | $25M | 4.5B | year 3.1 |
| 6 | $50M | 5.4B | year 3.5 |
| 7 | $100M | 6.3B | year 4.1 |
| 8 | $250M | 7.2B | year 5.7 |
| 9 | $500M | 8.1B | year 8.5 |
| 10 | $1B | 9.0B | not reached within 10 years |

Cumulative fees are reported by the metering oracle (the settler role), which later moves to a verifier quorum (§13). The reported figure can only increase, and a tranche can never be minted twice. Fees are real payments, and 30% of every fee paid in PAI is burned, so inflating volume to force an unlock costs the payer real money. Until the settler role moves to a verifier quorum, the reported figure is trusted: the contract does not check it against on-chain payments, so the settler appointed by the project's founders could in principle unlock tranches early. Every report and unlock is logged on-chain (`FeesReported`, `InvestorTrancheUnlocked`).

### 9.3 Emission falls over time and as the network grows

An epoch is one day. Epoch emission is

`E(e, N) = E₀ · 2^(−e/730) · √( N₀ / (N₀ + N) )`

- `E₀ = 474,533 PAI/day`, chosen so the undamped schedule sums to exactly the 500M reward pool.
- Emission **halves every two years**.
- The damping term shrinks it further as the network grows, where `N` is active providers plus weekly active requesters and `N₀ = 10,000`.

Damping values: 1.0 at N = 0, 0.71 at 10k, 0.50 at 30k, 0.30 at 100k, 0.10 at 1M. PAI that damping withholds is never minted. The Solidity contract uses the same formula, and its tests match the TypeScript values.

| Year | Base emission / day | With 1k participants | With 100k | With 1M |
|---|---|---|---|---|
| 0 | 474,533 | 452,449 | 143,077 | 47,218 |
| 1 | 335,546 | 319,930 | 101,171 | 33,388 |
| 2 | 237,267 | 226,225 | 71,539 | 23,609 |
| 4 | 118,633 | 113,112 | 35,769 | 11,804 |
| 10 | 14,829 | 14,139 | 4,471 | 1,476 |

Each epoch's emission is split **70% to providers, 20% to verifiers and 10% to relays**, pro rata to verified work within each role. A role that did no work in an epoch receives nothing, and that share is not minted.

### 9.4 Burn

**30% of every fee** paid in PAI is burned, and slashed stake is burned. Reward emission falls with time and growth while burn rises with usage, so between tranche unlocks net issuance turns negative as the network succeeds.

![PAI supply projection](whitepaper/supply.svg)

*Figure 2. One adoption scenario, not a forecast, generated from `packages/pai`. The network grows along an S-curve to 1M participants and network fees to $250k/day, and fees are converted to PAI at a notional reference rate (from $0.10, rising with the square root of fee growth) used only to size the burn; it is a modelling input, not a price expectation. The scenario assumes all fees are paid in PAI. Supply starts at the 500M genesis allocation. It steps up by 900M each time cumulative fees pass an investors-and-founders milestone: nine of the ten tranches unlock within ten years, and supply reaches ~8.7B. Fee burn overtakes reward emission around year 2.7, so supply falls slowly between unlocks.*

### 9.5 Common knowledge gets cheaper; novel intelligence requires stake

**Common knowledge (L0–L1).** The network price multiplier falls **35% per year** and with the fourth root of capacity growth, with a floor at 5% of the launch price. With serving capacity growing 16×, the multiplier is ×0.33 after one year and ×0.06 after five.

| Year | Price multiplier | …with 16× capacity |
|---|---|---|
| 0 | 1.00 | 0.50 |
| 1 | 0.65 | 0.33 |
| 2 | 0.42 | 0.21 |
| 3 | 0.27 | 0.14 |
| 5 | 0.12 | 0.06 |

**Novel intelligence (L2–L3) on the network** requires staked PAI. Stake is locked, not spent, and the requirement rises with congestion:

`required_stake(level, u) = base(level) · (1 + 4u²)`, with base L2 = 1,000 PAI, L3 = 10,000 PAI and `u` the tier's utilisation.

| Utilisation | L2 stake | L3 stake |
|---|---|---|
| 0% | 1,000 | 10,000 |
| 25% | 1,250 | 12,500 |
| 50% | 2,000 | 20,000 |
| 75% | 3,250 | 32,500 |
| 100% | 5,000 | 50,000 |

Stake also sets a daily quota (for L3, 500k tokens per 10,000 PAI staked). Unstaking unbonds over 7 days. Commercial frontier models reached through a customer's own keys are not stake-gated, because the customer already pays that vendor.

### 9.6 Roles and who secures the network

| Role | Requirement | Earns | Can be slashed for |
|---|---|---|---|
| Provider (L0–L1) | Run `dsi-node` | 70% pool, by work units | Downtime while holding sessions |
| Provider (L2 / L3) | 100 / 1,000 PAI bond | Same, higher multipliers | Model substitution (50%) |
| Verifier (phase 2) | 5,000 PAI stake | 20% pool, by verification work | False attestation (10%) |
| Relay / edge router (phase 2) | Run an access-layer edge | 10% pool, by relayed work | Tampering, downtime |
| Knowledge contributor | None (`dsi learn`) | R_verify, R_improve and usage royalties (§10.7) | Nothing to slash; invalidated objects lower domain reputation |
| Knowledge validator | 5,000 PAI stake (the verifier role) | Verification work in the 20% verifier pool (phase 2) | False attestation (10%) |
| Consumer | None for common knowledge | Cheaper answers over time | n/a |

### 9.7 The contract

`contracts/src/PAI.sol` is the reference ERC-20 in the DSI-AXON repository, to be opened for public review before any deployment. It implements the 10B capped supply, genesis allocations, the investors-and-founders tranches unlocked by reported cumulative fees, epoch settlement with the emission and damping formula, the 30% fee burn, staking with 7-day unbonding, and slashing by burn. Its Foundry test suite covers allocation, tranche unlocking (milestones only, never twice, never above the cap), halving and damping parity with the TypeScript model, pro-rata settlement, single settlement per epoch, fee burn, staking, slashing and the reward cap. Until an audited contract is deployed, the router runs the same economics on an off-chain ledger, settled daily and exposed at `/api/network`.

---

## 10. The Learning Fabric: earn PAI by adding knowledge

Serving answers is one way to earn PAI. The other is to make the network's models better. The **Learning Fabric** (protocol DIP-Learn v1) turns what users teach the network into small, verified pieces of **delta knowledge**. It trains them into lightweight adapters on top of existing open models, measures whether the models improved, and pays the people whose knowledge caused the improvement.

The network does not pay for prompts, conversations or data volume. It pays for knowledge that is verified, new to the network, fills a measured gap in a model and turns out to be useful:

`value ≈ verified novelty × model capability gap × measured model improvement × downstream usage`

Pasting a thousand chat logs earns nothing. One correction that fixes something every model in the network gets wrong can keep earning for as long as the improved model is in use.

### 10.1 From a correction to a reward

```mermaid
flowchart TD
  U[Your interaction<br/>question · model answer · your correction] --> X[Local extractor<br/>on your device]
  X --> G{De-personalisation gate<br/>on your device}
  G -->|risk too high, a preference,<br/>or confidential| K[Stays local<br/>memory / private provider]
  G -->|minimum generalisable delta| LO[Learning object<br/>content-addressed lo:hash]
  LO --> N[Proof of Novelty]
  N --> V[Claim-by-claim validation<br/>tools · sources · validators]
  V --> Q[Quality, bias and provenance vector]
  Q --> MG[Model gap test]
  MG -->|R_verify| W1[(PAI: small, immediate)]
  MG --> P[Delta knowledge package]
  P --> T[LoRA / QLoRA adapter<br/>on the base model]
  T --> B[Hidden benchmark<br/>target gain minus regressions]
  B --> C[Canary 1% → 5% → 20% → 50% → 100%]
  C -->|R_improve| W2[(PAI: after measured uplift)]
  C --> S[Serving: verified useful usage]
  S -->|R_usage| W3[(PAI: ongoing royalty)]
```

*Figure 3. The Learning Fabric pipeline. Everything above the learning object runs on the user's device.*

1. **You teach.** When a model gets something wrong, you give the correction, a counterexample, a procedure, a code fix or a tool-verified result. `dsi learn` in the harness does this from the command line.
2. **Your device extracts the lesson.** The extractor keeps only the atomic lesson: the task pattern, what the model got wrong, the correct knowledge, and probe questions with checkable answers. The conversation itself is never exported.
3. **The network proves it is new, checks it is true, and measures the gap.** It checks novelty against everything it already holds, validates each claim on its own, and asks the current base model the probe questions. If the knowledge is verified and fills a gap, you receive **R_verify** at once.
4. **The network trains on it.** Verified objects in a domain are packaged together and trained into a small adapter. The adapter goes live only if a hidden benchmark shows a net gain and a staged canary confirms it on live traffic. The package's improvement pool is then split among its contributors as **R_improve**.
5. **You keep earning while it is used.** A share of the inference fees the improved model earns from verified useful answers flows back to its contributors as **R_usage**.

### 10.2 What you can contribute

The unit is a **learning object**, never a conversation. Supported types: new fact, correction, counterexample, model failure, procedure, tool-verified result, code fix, calibration error, robustness case and new data source.

```json
{
  "id": "lo:3f9c…",
  "type": "CORRECTION",
  "domain": "finance.quant.derivatives",
  "task_pattern": "how does discrete monitoring affect barrier option prices",
  "delta": {
    "model_failure": "answered: treat it like continuous monitoring",
    "corrective_knowledge": "Discrete monitoring lowers the probability of crossing the barrier …",
    "probes": [{ "prompt": "…", "expected": "0.5826", "match": "contains" }]
  },
  "provenance": { "origin": "human", "contributor_did": "did:dsi:…", "source_hash": "…" },
  "privacy": { "personal_data": false, "reidentification_risk": 0 },
  "license": { "training_allowed": true, "spdx": "CC-BY-4.0" }
}
```

The `id` is the SHA-256 of the object's canonical form, so any mirror can host it and anyone can check it. The `contributor_did` is a one-way pseudonym of your account: rewards reach you, but the object does not identify you. The `source_hash` lets your device prove later that the lesson came from you, without revealing the source.

### 10.3 Privacy: raw personal information stays on your device

The de-personalisation gate runs **on the device**, before anything is shown or sent. It removes or generalises:

- names, emails, phone numbers and addresses
- precise locations, IP addresses, account and wallet ids, card numbers and IBANs
- credentials and keys, internal host names and ticket ids
- exact dates (generalised to the month) and large exact amounts (rounded to two significant figures)
- any terms you list as private, such as your company or your project's code name

Some things it cannot safely rewrite: personal medical history, private relationships, your age, employer or home town. These raise the **re-identification risk**. Above **0.05** the export is refused, and nothing leaves the device. Personal preferences ("I prefer…") always stay in local memory, and material marked confidential belongs with a private knowledge provider. Neither is exported.

The router runs the same gate again. It rejects any object the gate would still change, any object whose id is not its content hash, and any object carrying someone else's pseudonym. Without `--submit`, `dsi learn` prints exactly what would leave your device and sends nothing.

### 10.4 Proof of Novelty

Novelty does not mean "the text is different". It means the contribution closes a gap that the current model, the training pool, the knowledge graph and the benchmarks do not already cover:

`N = 0.20·semantic + 0.20·factual + 0.25·capability + 0.20·behavioural + 0.15·benchmark_gap`

| Component | Measured against |
|---|---|
| Semantic | Nearest existing learning objects in the domain (embedding similarity) |
| Factual | Whether each atomic claim is already in the knowledge graph |
| Capability | The model's measured score on this task (capability map or gap test) |
| Behavioural | Whether this failure mode has been reported before |
| Benchmark gap | How well existing benchmarks cover this task pattern |

A score below 0.20 counts as a duplicate and earns nothing. From 0.20 to 0.50 is low novelty, up to 0.80 useful, and above 0.80 high. **The first valid contributor to a cluster of similar knowledge gets full novelty credit.** A near-copy (similarity ≥ 0.90) keeps only (1 − similarity) of its score, and each later member of a cluster gets half the credit of the one before. Copying someone else's correction therefore earns almost nothing. Each novelty proof is hashed and signed; anchoring it on a chain is optional.

### 10.5 Validation: agreement is not truth

Each contribution is split into atomic claims, and every claim is tagged with an epistemic type: deterministic, empirical, current fact, historical, causal, prediction, interpretive, normative or preference. The type decides how a claim can be validated. Predictions stay unresolved until their outcome is known. Normative and interpretive claims are stored as perspectives, not as truths.

Evidence is ranked by method:

| Priority | Method | Strength of one independent source |
|---|---|---|
| 1 | Deterministic tool (calculator, compiler, test suite) | 0.99 |
| 2 | Primary or authoritative source | 0.90 |
| 3 | Independent structured data; qualified human review | 0.85 |
| 4 | Knowledge graph | 0.75 |
| 5 | Independent specialist model | 0.65 |
| 6 | Agreement between general models | 0.55 |

Evidence is counted by **source root**: ten articles copied from one source count as one source. Evidence from models alone can never lift a claim above 0.80, so it can never pass the truth gate. The contributor cannot validate their own contribution, and a model family cannot validate text it generated. The router runs a deterministic arithmetic checker itself. Other evidence comes from validators, who must stake **5,000 PAI** (the verifier role in §9.6), and, until the verifier market opens, from the reference operator.

Bias is kept as a vector, not folded into one truth score: source concentration, selection risk, viewpoint concentration, evaluator bias, geographic gaps and model-family monoculture. Majority opinion is not truth, minority opinion is not bias, and agreement is not validation. For contested claims, the claim, the counterclaim and the evidence for each are all kept.

**Admission gates** for positive training: truth ≥ 0.90, provenance ≥ 0.70, re-identification risk ≤ 0.05, a licence that allows training, and novelty ≥ 0.20. An uncertain object goes to the provisional pool until validators resolve it. An object shown to be false but useful as a negative example (a counterexample or a model failure) goes to the adversarial pool. Only the verified pool is used for positive factual training.

Knowledge is also **placed** where it belongs. Stable concepts and skills are trained into adapters, and procedural corrections become adapter updates. Volatile current facts go to retrieval, not into weights. Preferences stay in local memory.

### 10.6 Model gap and delta knowledge

The router asks the current base model each probe several times, and again in paraphrased form. The result is an accuracy gap, a robustness gap and, when the model states a confidence, a calibration gap. A model that already answers correctly leaves little to learn, so the object's training value is low. A model that fails consistently has a high gap.

`DK = Truth × Novelty × Provenance × Independence × ModelGap × DomainRelevance`

DK is the value an object has before training. It weights the object inside its package, but it is not the final payout.

Verified objects in a domain are grouped into a content-addressed **delta knowledge package** (`dkp:hash`). A package holds training units built from the corrective knowledge, validation units, and hidden test units. Only hashes of the hidden units are published; the units themselves stay with the benchmark service. The package also carries a Merkle root over its learning objects. A reference trainer (`packages/learning/trainer`, PyTorch and PEFT) trains a LoRA or QLoRA adapter on the package. The base model is never retrained. The candidate is then scored against the hidden benchmark:

`Improvement = TargetGain − 1·GeneralRegression − 2·BiasRegression − 1·CalibrationRegression − 4·SafetyRegression`

A candidate goes to canary only if Improvement is above 0.01 and safety regression is at most 0.005. The canary serves 1%, then 5%, 20%, 50% and 100% of matching traffic, with at least 200 samples at each stage. It rolls back automatically if quality drops by more than 2 points, the failure rate rises by more than 1 point, bias worsens, or p95 latency grows by more than 25%. A package that is rejected or rolled back returns its objects to the pool, where they can be packaged again.

### 10.7 How you are paid

`R_total = R_verify + R_improve + R_usage`

**R_verify: small and immediate.** It is paid when your object is verified and its gap is measured. Without probes, the gap is estimated from the capability map:

`R_verify = min(1, 1 PAI × Truth × Novelty × ModelGap × Provenance)`

| Truth | Novelty | Model gap | Provenance | R_verify |
|---|---|---|---|---|
| 0.99 | 0.90 | 0.90 | 0.95 | 0.76 PAI |
| 0.98 | 0.90 | 0.85 | 0.95 | 0.71 PAI |
| 0.95 | 0.60 | 0.70 | 0.85 | 0.34 PAI |
| 0.92 | 0.30 | 0.40 | 0.80 | 0.09 PAI |
| 0.99 | 0.90 | 0.03 | 0.95 | 0.03 PAI: the model already knew it |
| 0.99 | 0.15 | 0.90 | 0.95 | 0: duplicate, rejected at the gate |

**R_improve: paid after measured uplift.** When a package's adapter survives its canary, the package gets an improvement pool of **250 PAI per point** of net improvement, capped at 25,000 PAI. There is no pool unless the candidate beats its baseline. The pool is split by attribution weight:

`W_i = VerifiedDeltaContribution_i / Σ VerifiedDeltaContribution`

VerifiedDeltaContribution starts from the object's DK. When the benchmark runs leave-one-out ablations, it is blended with the object's measured marginal gain. Weights halve every 90 epochs once the knowledge is superseded, and fall to zero when the adapter is retired. Every improvement payment carries a **Proof of Useful Learning** record that links the novelty proof, the validation proof, the model gap, the measured improvement and the canary's live usage value. A payment with any of the five proofs missing is not made.

| Net improvement | 0.5 pt | 1 pt | 2 pts | 6 pts | 10 pts |
|---|---|---|---|---|---|
| Package improvement pool | 125 PAI | 250 PAI | 500 PAI | 1,500 PAI | 2,500 PAI |

**R_usage: an ongoing royalty.** **8%** of the inference fees an improved model earns goes to its training contributors (the policy range is 5–10%), split by the same weights. Only fees from **verified useful usage** count: tasks that succeeded, accepted answers, verifier passes, and measured falls in retries and escalations compared with the base model. Raw request volume does not count, and popularity is not validation.

**Worked example.** A correction scores truth 0.98, novelty 0.90, model gap 0.85 and provenance 0.95. It pays **0.71 PAI** at once. Its package lifts the target benchmark by 6 points net, which creates a 1,500 PAI improvement pool. The correction's attribution weight is 8%, so it earns **120 PAI**. The improved model then takes 100,000 PAI in inference fees with a usage value of 0.76 (90% of tasks succeed, and retries and escalations fall). The royalty pool is 100,000 × 0.76 × 8% = 6,080 PAI, and 8% of it is **486.40 PAI**. In total the correction earns about **607 PAI**. These figures come from `packages/pai`. They illustrate the formulas and are not a forecast: actual rewards depend on the budgets below and on real revenue.

### 10.8 Where the PAI comes from

No PAI is minted per submission. Learning rewards come from three bounded sources:

| Source | Size | Pays |
|---|---|---|
| Learning incentive pool | 50M PAI earmarked from the 150M ecosystem treasury (§9.1), which is already minted at genesis. At most 0.1% of what remains can be released per epoch: 50,000 PAI on day one, about 34,700 after a year of full use | R_verify and R_improve |
| Training bounties | Funded by whoever publishes a capability gap | 10% of the bounty spread over its target examples as a higher verification reward; 90% as the improvement pool of the package that closes the gap |
| Usage royalties | 8% of the inference fees of improved models (verified useful usage only) | R_usage |

When an epoch's budget is used up, further rewards are **deferred, not minted**, and paid from the next epoch's budget. The target split of contributor economics is 10% for verification, 40% for measured improvement and 50% for downstream usage. It is a starting policy, not a fixed law. Most of the value therefore arrives only after the knowledge has been shown to help.

**Training bounties** let whoever runs a model publish a weakness, for example "barrier options, 100 examples, 5,000 PAI". Matching contributions then earn up to **5 PAI** each at verification, and the adapter that closes the gap shares the remaining 4,500. The public **capability gap map** (`GET /api/learning/gaps`) lists measured weaknesses, weakest first, with their open bounties, so contributors can work where the network is weakest.

### 10.9 Keeping it honest

| Attack | Defence |
|---|---|
| Duplicate or reworded submissions | Semantic deduplication; first valid contributor takes the novelty credit; near-copies score (1 − similarity) |
| AI-generated spam and fake corrections | Truth gate needs non-model evidence; deterministic checks; tiny immediate rewards; the large rewards wait for measured uplift |
| Sybil accounts | Rewards follow verified improvement, not submission count; per-epoch submission limits that grow only with a verified track record |
| Colluding or self-serving validators | Validators stake 5,000 PAI; contributor ≠ validator; independent source roots; one model family cannot validate its own output |
| Copied datasets | Claims already in the knowledge graph score zero factual novelty; semantic deduplication against every stored object |
| Benchmark gaming | Hidden test units are never published (only their hashes); probes are never used as training prompts; regressions are subtracted; live canary |
| Privacy leaks | Gate on the device and again at the router; the risk threshold refuses export; the conversation never leaves the device |

Contributor **reputation** is tracked per domain from verified, rejected and later-invalidated objects, and from the uplift and usage they produced. It sets review priority and submission limits. It never makes a claim more likely to be true.

### 10.10 Try it

```sh
dsi learn --question "What is 37 * 41?" --answer "1337" --correction "37 * 41 = 1517." --domain mathematics.arithmetic
# prints exactly what would leave your device, and sends nothing
dsi learn --question "…" --correction "…" --private "Acme,Jane" --submit
dsi learn status          # rewards (verify / improvement / usage) and your objects
```

The API is `POST /api/learning/submit`, `GET /api/learning/me`, `GET /api/learning/gaps`, `GET /api/learning/bounties` and `GET /api/learning/objects/:id`. Novelty proofs and package manifests are public at `GET /api/learning/proofs/:id` and `GET /api/learning/packages/:id`, and contributor totals by pseudonym at `GET /api/learning/contributors/:did/rewards`.

---

## 11. Security and economic attacks

| Attack | Defence |
|---|---|
| Node claims a bigger model than it runs | Level-specific canaries; reputation-capped quality; L2/L3 bonds slashed 50% |
| Node returns garbage to farm rewards | Structural verification; unverified responses earn 0 WU; reputation decay |
| Sybil nodes | Rewards follow verified work, not node count; probation; bonds for high levels |
| Traffic from outside the router | HMAC-signed requests; nodes reject unsigned traffic |
| Node tries to profile users | Identity stripping; session sharding across operators; TEE nodes for strict privacy (roadmap) |
| Router operator profiles users | No content logging; hash-only receipts; memory on device; anonymous credit and OHTTP relays (roadmap) |
| BYOK key theft | Envelope encryption with AAD binding; decrypted only in the outbound call; redaction; never sent to nodes |
| Faking fee volume to unlock investor tranches | Fees are real payments with 30% of PAI fees burned; cumulative fees only go up and each tranche mints once; the reporting role (a trusted settler until then) moves to a verifier quorum |
| Wash trading to farm emission | Emission damped by network size; fees partly burned; paying yourself costs more than it earns once fees are burned |
| Prompt injection from a malicious node | Responses are data to the client; the harness never grants a provider tool access |
| Farming learning rewards (spam, duplicates, fake corrections, benchmark gaming) | First-valid novelty credit, a truth gate that model agreement cannot pass, staked validators, hidden benchmarks, and most of the reward paid only after measured uplift and usage (§10.9) |

---

## 12. Scalability and efficiency

- **Stateless edge router.** No per-user state. Session affinity comes from hashing, not from a table, so the router scales horizontally on a global edge (Cloudflare Workers today).
- **No buffering.** Streams are translated event by event, with failover only before the first byte.
- **Batching-friendly nodes.** Sessions are sticky per conversation, so nodes reuse KV caches across turns.
- **Geo-aware routing.** Distance enters expected latency, so the nearest adequate node wins latency-sensitive traffic.
- **Cheap control plane.** Work is metered per node per epoch, not per request. Settlement is one transaction per epoch.
- **Open protocols throughout.** Vendor-compatible APIs, MCP, OpenAI-compatible nodes and an ERC-20 token.

### 12.1 The direct path: zero cost per user

Routing every turn through the edge costs money per turn: at a million people talking four hours a day, hosted transcription, speech and answers would come to about $136M a month. The direct path (DIP-P2P, `docs/p2p.md`) takes the router off the per-turn path, the way Spotify started songs from its servers and then streamed the rest from other listeners:

- **The device listens and speaks.** Whisper runs in the browser, and replies are spoken by Kokoro or a good system voice. The models download once.
- **Peers answer.** The browser calls community nodes directly over their own tunnels. Peers also do transcription and speech for devices that cannot do it themselves.
- **The router is only the control plane.**
  - Once a month it issues a ticket bound to a key held on the device (ECDSA P-256, non-extractable). The ticket names no account.
  - Every 6 hours it gives nodes the keys and a signed peer directory, which nodes pass on to clients.
  - Once a day it settles one receipt batch per node in PAI. A 2% sample of tickets is reconciled across nodes.
- **Every request is protected.** It carries a proof signed with the device key, so a copied ticket is useless and a captured request cannot be replayed. Nodes check both offline and enforce the ticket's daily quota.

None of this scales with talking time. At a million users the whole control plane is about 9M Workers requests and 7M D1 row writes a month, inside what the $5 Workers Paid plan includes. The cost per user is zero whether people talk ten minutes a day or all day. The work is done by peers, who are paid in PAI and earn free chat for what they serve.

Capacity: about 460 gaming GPUs or 3,000 laptops (0.05–0.3% of users) carry a million people talking four hours a day.

The trade-off is that a peer sees the client's IP address, though never the account. The routed path still hides it for users who prefer that, and a relay through a second peer is on the roadmap.

---

## 13. Governance

At launch the project's founders hold the contract's owner role and operate the reference router. The legal entity that holds these roles will be named before any token launch. Governance is handed over in stages:

- the settler role (the metering oracle) moves to a verifier quorum
- the slasher role moves to verifier consensus with an appeal window
- off-chain parameters (stake bases, and the Learning Fabric's reward base, improvement pool rate, royalty rate within 5–10% and epoch release share) move to PAI-weighted governance with a time lock; the reward split and burn rate are fixed in the reference contract, and changing them requires a new, audited contract approved by that governance

Emission constants, the hard cap and the investors-and-founders unlock milestones are immutable.

---

## 14. Status

| Component | Status |
|---|---|
| Anthropic / OpenAI / Gemini drop-in APIs, streaming, tool translation | **Live** |
| Capability engine, nine routing modes, headers and account policies | **Live** |
| BYOK with envelope encryption; shadow routing (estimate / benchmark) | **Live** |
| Blind routing, client hints, session sharding, geo-aware latency, identity stripping | **Implemented** in this release |
| MCP layer (`/mcp`) | **Implemented** in this release |
| Mid-stream continuation on another provider; client-held affinity; provider-diversified failover | **Implemented** in this release |
| Harness `dsi`: local memory, preferences, recall, MCP server, proxy | **Implemented** in this release |
| `dsi-node` + Docker Compose; permissionless registration, heartbeats, signed requests | **Implemented** in this release |
| Canaries, reputation, probation, suspension | **Implemented** in this release |
| PAI off-chain ledger: staking, stake-gated L2/L3, work metering, daily settlement | **Implemented** in this release |
| Learning Fabric (`packages/learning`): on-device extraction and privacy gate (`dsi learn`), Proof of Novelty, claim validation with a deterministic checker, staked-validator attestation, model gap test, delta packages, canary control, attribution, PoUL records, R_verify / R_improve / R_usage on the off-chain ledger, bounties and the capability gap map | **Implemented** in this release |
| Reference delta trainer (LoRA / QLoRA, PEFT) | **Implemented** in this release; runs outside the router |
| Serving delta adapters on network nodes; automatic canary routing and usage metering for them | Roadmap: canary and usage results are reported by the reference operator until then |
| Direct path (DIP-P2P): tickets bound to device keys, per-request proofs, signed peer directory, node-side metering and quotas, daily receipts with sampled reconciliation, direct chat and peer voice from the browser | **Implemented** in this release; free chat uses it |
| On-device voice: Whisper and Kokoro in the browser, Cloudflare only while models download | **Implemented** in this release |
| PAI Solidity contract with tests | **Reference, unaudited, not deployed** |
| Verifier and relay markets | Phase 2 |
| Anonymous credit, OHTTP relays, TEE nodes | Roadmap |
| Token generation event / mainnet | Not scheduled |

---

## 15. Get started

**Use it.** Create a key at [decentralised.si/dashboard](/dashboard) and change one base URL:

```python
from anthropic import Anthropic
client = Anthropic(api_key="ds_live_...", base_url="https://api.decentralised.si/anthropic")
```

**Keep your memory private.**

```sh
mkdir -p ~/.local/bin && curl -fsSL https://decentralised.si/dl/dsi.mjs -o ~/.local/bin/dsi && chmod +x ~/.local/bin/dsi   # Node 20+
dsi login ds_live_...
dsi remember "I prefer concise answers with code first"
dsi chat
claude mcp add dsi -- dsi mcp     # the same memory in Claude Code
```

**Teach it and earn PAI.** When a model gets something wrong, turn your correction into delta knowledge (§10):

```sh
dsi learn --question "What is 37 * 41?" --answer "1337" --correction "37 * 41 = 1517."            # dry run: shows what would leave your device
dsi learn --question "What is 37 * 41?" --answer "1337" --correction "37 * 41 = 1517." --submit   # verify, measure the gap, earn
```

**Supply intelligence.** See §8.1. Then run `docker compose exec dsi-node node /app/dsi-node.mjs earnings`.

---

## Risk factors

- **Concentration.** 9B of the 10B cap (90%) is allocated to investors and founders. It is minted only as cumulative fees pass milestones, but once minted it can outweigh the rest of the supply in governance and in any market.
- **Trusted reporting.** Until the settler role moves to a verifier quorum, the cumulative-fee figure that unlocks tranches is reported by a role the project's founders appoint, and the contract does not verify it against payments (§9.2).
- **Unaudited, undeployed contract.** `PAI.sol` has not been audited or deployed. Rewards are recorded on an off-chain ledger operated by the project; a bug, a migration or an operator error could change recorded balances.
- **Regulatory.** A token with these features may be treated as a security or a regulated crypto-asset in some jurisdictions. That could delay, restrict or prevent issuance, or change the design described here.
- **Adoption.** Emission, burn and unlock timings depend on network usage. If fees stay low, tranches may never unlock, and rewards may be worth little or nothing.
- **Technical.** Routing, canaries and privacy measures are preview software. Providers can read the requests they serve (§6), and the network can suffer outages or attacks (§11).
- **Learning rewards.** Until the verifier market and adapter serving launch, the reference operator validates non-deterministic claims and reports benchmark, canary and usage results, so improvement and usage rewards depend on that operator (§10, §14). The privacy gate is pattern-based: it can miss an unusual identifier, so review what `dsi learn` shows before submitting. The 50M incentive pool is finite and released at most 0.1% of the remainder per epoch.
- **Governance.** The project's founders hold the contract owner role at launch, and no legal entity has been named yet (§13). The move to PAI-weighted governance is planned, not guaranteed.

---

## Disclaimer

This paper describes software and a proposed token design. PAI has not been issued, and nothing here is an offer to sell or a solicitation to buy any token or security. PAI is designed as a utility for staking, bonding and network fees, not as an investment. Figures are model outputs under stated assumptions, not forecasts or promises of return. The PAI contract is unaudited. Token launch will be subject to the laws of each relevant jurisdiction and may not occur.
