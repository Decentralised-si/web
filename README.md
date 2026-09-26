# Decentralised.si — web

Landing page, migration guide and customer dashboard for [Decentralised.si](https://decentralise.si), the routing layer between applications and intelligence.

Static site served by Cloudflare Workers static assets on `decentralise.si`. The dashboard talks to the Smart LLM Router API at `https://api.decentralise.si` (see the `Decentralised-si/Smart-LLM-Router` repo).

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

The dashboard stores the customer's `ds_` key in `localStorage` for this origin only and sends it solely to `api.decentralise.si`. Provider (BYOK) keys are submitted once to the API, envelope-encrypted server-side, and never displayed again beyond their last four characters.
