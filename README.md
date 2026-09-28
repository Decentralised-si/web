# Decentralised.si — web

Landing page, migration guide and customer dashboard for [Decentralised.si](https://decentralised.si), the routing layer between applications and intelligence.

Static site served by Cloudflare Workers static assets on `decentralised.si`. The dashboard talks to the DSI Axon API at `https://api.decentralised.si` (see the [`Decentralised-si/DSI-AXON`](https://github.com/Decentralised-si/DSI-AXON) repo; the router for your device is [`Decentralised-si/DSI-Synapse`](https://github.com/Decentralised-si/DSI-Synapse)).

| Path | Content |
|---|---|
| `/app` | **Main app** (React + Privy, built from `app/`): Claude-style chat with local conversation history, Console (usage & cost, API keys, rate/spend limits, logs, members & roles, providers, routing, settings), Wallet & billing (Privy embedded EVM + Solana wallets, pay for AI with crypto, any-coin top-up), Agent terminal (Hermes Agent as the default harness) |
| `/` | Product overview, one-line migration snippets (Anthropic, OpenAI, Gemini SDKs), routing modes |
| `/dashboard` | Sign up / sign in with a `ds_` API key; Providers (BYOK add/test/disable/rotate/delete), routing policy, shadow savings, request receipts, API keys |

## App

```sh
npm install
npm run build        # builds app/ into public/app (git-ignored)
npm run dev          # Vite dev server for the app
```

The app reads `/api/config` at runtime: set `PRIVY_APP_ID` on the router Worker to enable sign-in (and allow `https://decentralised.si` in the Privy dashboard). Local visual preview without Privy: `npx vite --config app/preview/vite.preview.config.ts`, then open `/preview/index.html?api=<router>&key=<ds_ key>`.

## Develop

```sh
npx wrangler dev          # http://localhost:8787
# point the local dashboard at a local router:
open "http://localhost:8787/dashboard?api=http://localhost:8788"
```

The `?api=` override is honoured only on `localhost`, so a crafted link cannot redirect a customer's API key to another host.

## Deploy

```sh
npx wrangler deploy
```

The dashboard stores the customer's `ds_` key in `localStorage` for this origin only and sends it solely to the Decentralised.si API. Provider (BYOK) keys are submitted once to the API, envelope-encrypted server-side, and never displayed again beyond their last four characters.

## Domains

**`decentralised.si` is the canonical website.** The same Worker also answers on `www.decentralised.si`, `decentralise.si`, `www.decentralise.si`, `decentralised.ai`, `www.decentralised.ai` (and `decentralise.ai` once its zone is added). The `.si` domains serve the product landing page (`public/index.html`); the `.ai` domains serve the network landing page (`public/ai/index.html`) at `/`. When the `CANONICAL_LIVE` var is `"true"`, every other path on an alias domain returns a 301 to `https://decentralised.si` with the same path (`src/index.js`), so there is one origin and one app session.

The API is `https://api.decentralised.si`. `api.decentralise.si` and `api.decentralised.ai` serve the same router Worker and D1 database, so existing integrations keep working.

A new domain has to be an active zone in the Cloudflare account before its route can be attached: add it to `ALIASES` in `src/index.js` and to `routes` in `wrangler.jsonc` (and `api.<domain>` in the router's `apps/gateway/wrangler.toml`), then redeploy.
