import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider } from "@privy-io/react-auth";
import { App } from "./App";
import { loadConfig, type Config } from "./api";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

function Unconfigured({ error }: { error?: string }) {
  if (error) console.error("config:", error);
  return (
    <div className="center">
      <div className="card narrow">
        <div className="brand-lg">
          <img className="logo" src="/brand/logo-96.png" alt="" width={34} height={34} />
          <span>
            Decentralised<span className="tld">.si</span>
          </span>
        </div>
        <p className="muted">{error ? "The Decentralised.si service did not respond. Please try again in a moment." : "Sign-in is temporarily unavailable. Developers can still use the API with a ds_ key."}</p>
        <p>
          <a href="/home">Back to the site</a> · <a href="/dashboard">API-key dashboard</a>
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
            appearance: { theme: dark ? "dark" : "light", accentColor: dark ? "#4da3ff" : "#2257e6", logo: `${location.origin}/brand/logo-96.png`, walletChainType: "ethereum-and-solana", landingHeader: "Sign in to Decentralised.si" },
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
