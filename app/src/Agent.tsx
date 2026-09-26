import { useState } from "react";

const API = "https://api.decentralised.si";

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="code">
      <pre>{text}</pre>
      <button
        className="copy"
        onClick={() => {
          navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }}
      >
        {done ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function Agent() {
  const [os, setOs] = useState<"unix" | "windows">(navigator.userAgent.includes("Windows") ? "windows" : "unix");
  return (
    <div className="page">
      <div className="page-head">
        <h1>Agent terminal</h1>
      </div>
      <section className="card hero">
        <h2>Hermes Agent — the default harness</h2>
        <p>
          <a href="https://github.com/NousResearch/hermes-agent" target="_blank" rel="noreferrer">
            Hermes Agent
          </a>{" "}
          by Nous Research is an open-source (MIT) agent for your terminal: it runs tools, edits files and works through tasks. Point it at Decentralised.si and every step is routed to the best model for the job, paid from your credit or your own keys.
        </p>
        <div className="tabs small">
          <a className={os === "unix" ? "on" : ""} onClick={() => setOs("unix")} href="#/agent">
            macOS · Linux · WSL
          </a>
          <a className={os === "windows" ? "on" : ""} onClick={() => setOs("windows")} href="#/agent">
            Windows
          </a>
        </div>
        <h3>1 · Install</h3>
        {os === "unix" ? <Copy text={"curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash\nsource ~/.bashrc   # or ~/.zshrc"} /> : <Copy text={"iex (irm https://hermes-agent.nousresearch.com/install.ps1)"} />}
        <p className="fine">
          <a className="button primary" href="https://github.com/NousResearch/hermes-agent" target="_blank" rel="noreferrer">
            Get Hermes Agent on GitHub
          </a>{" "}
          <span className="muted">Linux, macOS, WSL2, Windows and Android (Termux).</span>
        </p>
        <h3>2 · Use Decentralised.si as its model provider</h3>
        <p className="small muted">
          Create a key in <a href="#/console/keys">Console → API keys</a>, then add it to <code>~/.hermes/.env</code> and <code>~/.hermes/config.yaml</code>:
        </p>
        <Copy text={"echo 'DSI_API_KEY=ds_live_...' >> ~/.hermes/.env"} />
        <Copy
          text={`# ~/.hermes/config.yaml
model:
  default: auto                # let the router pick per step; or name a model, e.g. claude-sonnet-5
  provider: custom
  base_url: ${API}/openai/v1
  key_env: DSI_API_KEY`}
        />
        <p className="small muted">
          Or interactively: run <code>hermes model</code>, choose <em>Custom endpoint</em>, and enter <code>{API}/openai/v1</code> and your key. Routing headers are optional; your organization's default policy (Console → Routing) applies.
        </p>
        <h3>3 · Keep your memory on your device (optional)</h3>
        <p className="small muted">
          The <code>dsi</code> harness gives Hermes private, on-device memory and preferences over MCP; nothing it stores leaves your machine except what a request needs.
        </p>
        <Copy
          text={`mkdir -p ~/.local/bin && curl -fsSL https://decentralised.si/dl/dsi.mjs -o ~/.local/bin/dsi && chmod +x ~/.local/bin/dsi
dsi login ds_live_...
hermes mcp add dsi --command dsi --args mcp`}
        />
        <Copy
          text={`# or in ~/.hermes/config.yaml
mcp_servers:
  dsi:
    command: dsi
    args: ["mcp"]`}
        />
        <p className="fine muted">
          Hermes also works with the network MCP endpoint directly: <code>{API}/mcp</code> (Streamable HTTP, <code>Authorization: Bearer ds_…</code>).
        </p>
      </section>
      <section className="card">
        <h2>Other harnesses</h2>
        <ul className="small">
          <li>
            <strong>Claude Code</strong>: <code>ANTHROPIC_BASE_URL={API}/anthropic</code> and <code>ANTHROPIC_API_KEY=ds_live_...</code>; add memory with <code>claude mcp add dsi -- dsi mcp</code>.
          </li>
          <li>
            <strong>Any OpenAI-compatible tool</strong>: base URL <code>{API}/openai/v1</code>, or run <code>dsi proxy</code> for a local endpoint with your memory.
          </li>
          <li>
            <strong>Run a node</strong> and earn PAI with your GPU: see the <a href="/whitepaper#8-the-provider-network-fire-up-a-server-earn-pai">whitepaper</a>.
          </li>
        </ul>
      </section>
    </div>
  );
}
