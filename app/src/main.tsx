import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider } from "@privy-io/react-auth";
import { App } from "./App";
import { loadConfig, type Config } from "./api";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

function Unconfigured({ error }: { error?: string }) {
  return (
    <div className="center">
      <div className="card narrow">
        <div className="brand-lg">
          Decentralised<span>.si</span>
        </div>
        <p className="muted">{error ? `Could not reach the Decentralised.si API: ${error}` : "Sign-in is not configured on this deployment yet (no Privy app id). Developers can still use the API with a ds_ key."}</p>
        <p>
          <a href="/">Back to the site</a> · <a href="/dashboard">API-key dashboard</a>
        </p>
      </div>
    </div>
  );
}

loadConfig()
  .then((cfg: Config) => {
    if (!cfg.privyAppId) return root.render(<Unconfigured />);
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    root.render(
      <StrictMode>
        <PrivyProvider
          appId={cfg.privyAppId}
          config={{
            loginMethods: ["email", "google", "apple", "github", "wallet"],
            appearance: { theme: dark ? "dark" : "light", accentColor: dark ? "#4cc3a0" : "#1f6f5c", walletChainType: "ethereum-and-solana", landingHeader: "Sign in to Decentralised.si" },
            // Every user gets a self-custodial wallet (EVM + Solana) to pay for AI with crypto.
            embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" }, solana: { createOnLogin: "users-without-wallets" } },
          }}
        >
          <App config={cfg} />
        </PrivyProvider>
      </StrictMode>,
    );
  })
  .catch((e) => root.render(<Unconfigured error={String(e?.message ?? e)} />));
