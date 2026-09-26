// Preview only: answer /api/session locally (Privy is mocked) using the key's organization.
const real = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("/api/session")) {
    const me = await (await real(url.replace("/api/session", "/api/org"), { headers: init?.headers })).json();
    return Response.json({ user: { id: "preview-user", email: "you@example.com", wallets: [{ address: "0x7a3b9c2d1e0f4a5b6c7d8e9f0a1b2c3d4e5f6a7b", chain: "ethereum", type: "embedded" }] }, organizations: [{ id: me.id, name: me.name ?? "My organization", role: "owner" }], defaultOrganization: me.id });
  }
  if (url.endsWith("/api/config")) return Response.json({ privyAppId: "preview", deposits: { evm: true, solana: true, minUsd: 1 }, checkout: true, platformVendors: [] });
  if (url.endsWith("/api/billing")) {
    const b = await (await real(url, { headers: init?.headers })).json();
    return Response.json({ ...b, prices: { ETH: 2680, SOL: 120 }, chains: [{ id: "base", name: "Base", chainId: 8453, treasury: "0x1111111111111111111111111111111111111111", assets: [{ symbol: "USDC", decimals: 6, native: false, address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" }, { symbol: "ETH", decimals: 18, native: true }], explorerTx: "https://basescan.org/tx/" }, { id: "solana", name: "Solana", treasury: "Treasury11111111111111111111111111111111111", assets: [{ symbol: "USDC", decimals: 6, native: false }, { symbol: "SOL", decimals: 9, native: true }], explorerTx: "https://solscan.io/tx/" }] });
  }
  return real(input, init);
};
