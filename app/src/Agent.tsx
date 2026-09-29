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
        <h2>DSI Agent Terminal</h2>
        <p>
          An AI agent for your terminal that runs tools, edits files and works through tasks, connected to the network with your API key. Every step is routed to the best model for the job, paid from your credit or your own vendor keys. Built on{" "}
          <a href="https://github.com/NousResearch/hermes-agent" target="_blank" rel="noreferrer">
            Hermes Agent
          </a>{" "}
          by Nous Research (MIT).
        </p>
        <div className="tabs small">
          <a className={os === "unix" ? "on" : ""} onClick={() => setOs("unix")} href="#/agent">
            macOS · Linux · WSL · Android
          </a>
          <a className={os === "windows" ? "on" : ""} onClick={() => setOs("windows")} href="#/agent">
            Windows
          </a>
        </div>
        <h3>1 · Create an API key</h3>
        <p className="small muted">
          In <a href="#/console/keys">Console → API keys</a>. The installer asks for it and connects the agent to the network.
        </p>
        <h3>2 · Install</h3>
        {os === "unix" ? <Copy text={"curl -fsSL https://decentralised.si/install/agent.sh | bash"} /> : <Copy text={"iex (irm https://decentralised.si/install/agent.ps1)"} />}
        <p className="small muted">
          Or pass the key so the installer doesn't ask:{" "}
          <code>{os === "unix" ? "DSI_API_KEY=ds_live_... curl -fsSL https://decentralised.si/install/agent.sh | bash" : '$env:DSI_API_KEY="ds_live_..."; iex (irm https://decentralised.si/install/agent.ps1)'}</code>
        </p>
        <h3>3 · Use it</h3>
        <Copy text={'dsi-agent                        # interactive session\ndsi-agent -z "summarise README.md"   # one question\ndsi-agent config set DSI_API_KEY ds_live_...   # change key'} />
        <p className="fine">
          <a className="button primary" href="https://github.com/Decentralised-si/terminal" target="_blank" rel="noreferrer">
            DSI Agent Terminal on GitHub
          </a>{" "}
          <span className="muted">
            Provider <code>decentralised</code>, base URL <code>{API}/openai/v1</code>, model <code>auto</code>. Your organisation's default policy (Console → Routing) applies.
          </span>
        </p>
        <h3>4 · Keep your memory on your device (optional)</h3>
        <p className="small muted">
          The <code>dsi</code> harness gives the agent private, on-device memory and preferences over MCP; nothing it stores leaves your machine except what a request needs.
        </p>
        <Copy
          text={`mkdir -p ~/.local/bin && curl -fsSL https://decentralised.si/dl/dsi.mjs -o ~/.local/bin/dsi && chmod +x ~/.local/bin/dsi
dsi login ds_live_...
dsi-agent mcp add dsi --command dsi --args mcp`}
        />
        <Copy
          text={`# or in ~/.hermes/config.yaml
mcp_servers:
  dsi:
    command: dsi
    args: ["mcp"]`}
        />
        <p className="fine muted">
          The agent also works with the network MCP endpoint directly: <code>{API}/mcp</code> (Streamable HTTP, <code>Authorization: Bearer ds_…</code>).
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
