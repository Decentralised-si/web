# Decentralised.si — web

Landing page, migration guide and customer dashboard for [Decentralised.si](https://decentralised.si), the routing layer between applications and intelligence.

Static site served by Cloudflare Workers static assets on `decentralised.si`. The dashboard talks to the Smart LLM Router API at `https://api.decentralised.si` (see the `Decentralised-si/Smart-LLM-Router` repo).

| Path | Content |
|---|---|
| `/` | Product overview, one-line migration snippets (Anthropic, OpenAI, Gemini SDKs), routing modes |
| `/dashboard` | Sign up / sign in with a `ds_` API key; Providers (BYOK add/test/disable/rotate/delete), routing policy, shadow savings, request receipts, API keys |

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

**`decentralised.si` is the canonical website.** The same Worker also answers on `www.decentralised.si`, `decentralise.si`, `www.decentralise.si`, `decentralised.ai`, `www.decentralised.ai` (and `decentralise.ai` once its zone is added). Each of those returns a 301 to `https://decentralised.si` with the same path (`src/index.js`), so there is one origin and one dashboard session.

The API is `https://api.decentralised.si`. `api.decentralise.si` and `api.decentralised.ai` serve the same router Worker and D1 database, so existing integrations keep working.

A new domain has to be an active zone in the Cloudflare account before its route can be attached: add it to `ALIASES` in `src/index.js` and to `routes` in `wrangler.jsonc` (and `api.<domain>` in the router's `apps/gateway/wrangler.toml`), then redeploy.
