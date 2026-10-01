// Local visual preview only (never shipped): stands in for Privy using a ds_ key as the token.
import type { ReactNode } from "react";
const noop = () => {};
const KEY = new URLSearchParams(location.search).get("key") ?? "";
export const PrivyProvider = ({ children }: { children: ReactNode }) => <>{children}</>;
const privy = { ready: true, authenticated: true, login() {}, logout() {}, getAccessToken: async () => KEY, user: { id: "preview", linkedAccounts: [{ type: "email", email: "preview@example.com" }] }, linkEmail: noop, linkWallet: noop, linkGoogle: noop, linkGithub: noop };
export const usePrivy = () => ({ ...privy, getAccessToken: async () => KEY }); // deliberately unstable, like a worst-case SDK
export const useIdentityToken = () => ({ identityToken: null });
export const useWallets = () => ({ wallets: [{ address: "0x7a3b9c2d1e0f4a5b6c7d8e9f0a1b2c3d4e5f6a7b", walletClientType: "privy" }] });
export const useSendTransaction = () => ({ sendTransaction: async () => ({ hash: "0x" }) });
export const useAddFunds = () => ({ addFunds: async () => ({ method: "crypto", status: "completed" }) });
export const useSignAndSendTransaction = () => ({ signAndSendTransaction: async () => ({ signature: new Uint8Array(64) }) });
export const useLoginWithOAuth = (_opts?: unknown) => ({ initOAuth: async () => {}, state: { status: "initial" as const } });
export const useSolanaWallets = () => ({ wallets: [] });
