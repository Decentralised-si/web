// Preview only: answer /api/session locally (Privy is mocked) using the key's organization.
const real = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  // No ?key=: answer the org and model list locally so the chat layout can be previewed offline.
  if (!new URLSearchParams(location.search).get("key")) {
    if (url.endsWith("/api/org")) return Response.json({ id: "org_preview", name: "Preview organisation", creditUsd: 12.5, freeChat: { activeNodes: 1, probationNodes: 0, dailyTokens: 20000, dailyRemaining: 18200, earnedTokens: 3400, available: 21600 } });
    if (url.includes("/chat/completions")) {
      const words = "**Implied volatility** is the volatility that, fed into Black-Scholes, reproduces an option's market price.\n\nIt is the market's forecast of how much the underlying will move, backed out from prices rather than measured from history.".split(" ");
      const body = words.map((w, i) => `data: ${JSON.stringify({ choices: [{ delta: { content: (i ? " " : "") + w } }] })}\n\n`).join("") + "data: [DONE]\n\n";
      return new Response(body, { headers: { "content-type": "text/event-stream", "x-decentralise-actual-provider": "general-local", "x-decentralise-actual-model": "general-8b", "x-decentralise-market": "network" } });
    }
    if (url.includes("/models")) return Response.json({ data: [{ id: "auto" }, { id: "general-8b" }, { id: "coder-32b" }, { id: "claude-sonnet-5" }] });
  }
  if (url.endsWith("/api/session")) {
    const me = await (await window.fetch(url.replace("/api/session", "/api/org"), { headers: init?.headers })).json();
    return Response.json({ user: { id: "preview-user", email: "you@example.com", wallets: [{ address: "0x7a3b9c2d1e0f4a5b6c7d8e9f0a1b2c3d4e5f6a7b", chain: "ethereum", type: "embedded" }] }, organizations: [{ id: me.id, name: me.name ?? "My organization", role: "owner" }], defaultOrganization: me.id });
  }
  if (url.endsWith("/api/config")) return Response.json({ privyAppId: "preview", deposits: { evm: true, solana: true, minUsd: 1 }, checkout: true, platformVendors: [] });
  if (url.endsWith("/api/billing")) {
    const b = await (await real(url, { headers: init?.headers })).json();
    return Response.json({ ...b, prices: { ETH: 2680, SOL: 120 }, chains: [{ id: "base", name: "Base", chainId: 8453, treasury: "0x1111111111111111111111111111111111111111", assets: [{ symbol: "USDC", decimals: 6, native: false, address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" }, { symbol: "ETH", decimals: 18, native: true }], explorerTx: "https://basescan.org/tx/" }, { id: "solana", name: "Solana", treasury: "Treasury11111111111111111111111111111111111", assets: [{ symbol: "USDC", decimals: 6, native: false }, { symbol: "SOL", decimals: 9, native: true }], explorerTx: "https://solscan.io/tx/" }] });
  }
  return real(input, init);
};
