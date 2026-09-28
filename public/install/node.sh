#!/bin/sh
# Decentralised.si: turn this computer into a network node, and unlock free network chat.
#
#   curl -fsSL https://decentralise.si/install/node.sh | sh
#   curl -fsSL https://decentralise.si/install/node.sh | sh -s -- --uninstall
#
# What it does (macOS and Linux):
#   1. asks for your API key (create one at https://decentralised.si/app/#/console/keys)
#   2. picks an open model that fits this computer's memory and installs it with Ollama
#   3. installs what the node needs: Node.js (a private copy, if yours is older than 20) and
#      cloudflared, for a secure tunnel so no router or firewall changes are needed
#   4. downloads dsi-node, checks its SHA-256, and starts it in the background (and at login)
#
# Everything lives in ~/.dsi. The node only answers requests signed by the network, never
# learns who is asking, and pauses while the laptop runs on battery.
# Settings: DSI_API_KEY, DSI_MODEL (e.g. qwen2.5:7b), DSI_HOME, DSI_NO_SERVICE=1, DSI_BASE_URL.
set -eu

BASE="${DSI_BASE_URL:-https://decentralise.si}"
DSI_HOME="${DSI_HOME:-$HOME/.dsi}"
PORT="${PORT:-8787}"
OS=$(uname -s)
ARCH=$(uname -m)
case "$ARCH" in x86_64 | amd64) ARCH=amd64 ;; arm64 | aarch64) ARCH=arm64 ;; *) echo "Unsupported CPU: $ARCH" >&2; exit 1 ;; esac

say() { printf '%s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
sha256() { if have sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
fetch() { curl -fsSL --retry 3 "$1" -o "$2"; }

stop_service() {
  if [ "$OS" = Darwin ]; then
    launchctl unload "$HOME/Library/LaunchAgents/si.decentralised.node.plist" 2>/dev/null || true
  elif have systemctl && systemctl --user status >/dev/null 2>&1; then
    systemctl --user disable --now dsi-node.service 2>/dev/null || true
  fi
  if [ -f "$DSI_HOME/node.pid" ]; then kill "$(cat "$DSI_HOME/node.pid")" 2>/dev/null || true; rm -f "$DSI_HOME/node.pid"; fi
  # Also stop what the launcher started (node, tunnel), which outlive a killed shell.
  # Patterns come in as variables so awk never matches its own command line.
  if have ps; then
    for p in $(ps -eo pid=,args= | awk -v a="$DSI_HOME/dsi-node.mjs" -v b="$DSI_HOME/bin/dsi-node-up" -v c="cloudflared" -v m="127.0.0.1:20241" \
      'index($0, a) || index($0, b) || (index($0, c) && index($0, m)) {print $1}'); do
      [ "$p" != "$$" ] && kill "$p" 2>/dev/null || true
    done
    sleep 1
  fi
}

if [ "${1:-}" = "--uninstall" ]; then
  step "Removing the Decentralised.si node"
  stop_service
  rm -f "$HOME/Library/LaunchAgents/si.decentralised.node.plist" "$HOME/.config/systemd/user/dsi-node.service"
  if [ -f "$DSI_HOME/state.json" ] && [ -f "$DSI_HOME/node.env" ]; then
    . "$DSI_HOME/node.env"
    NODE_ID=$(sed -n 's/.*"nodeId": *"\([^"]*\)".*/\1/p' "$DSI_HOME/state.json")
    [ -n "$NODE_ID" ] && curl -fsS -X DELETE "$DSI_ROUTER/api/nodes/$NODE_ID" -H "authorization: Bearer $DSI_API_KEY" >/dev/null 2>&1 && say "Node $NODE_ID removed from the network."
  fi
  rm -rf "$DSI_HOME"
  say "Done. Ollama and its models were left in place (remove them with 'ollama rm <model>')."
  exit 0
fi

say "Decentralised.si node installer"
mkdir -p "$DSI_HOME/bin"
chmod 700 "$DSI_HOME"

# ---------------------------------------------------------------- 1. API key
KEY="${DSI_API_KEY:-}"
if [ -z "$KEY" ] && [ -f "$DSI_HOME/node.env" ]; then KEY=$(sed -n 's/^DSI_API_KEY=//p' "$DSI_HOME/node.env"); fi
if [ -z "$KEY" ]; then
  [ -r /dev/tty ] || die "set DSI_API_KEY (create a key at https://decentralised.si/app/#/console/keys)"
  say ""
  say "Sign in at https://decentralised.si/app, open Console -> API keys, create a key and paste it here."
  printf 'API key: '
  read -r KEY </dev/tty
fi
case "$KEY" in ds_*) ;; *) die "that does not look like a Decentralised.si key (they start with ds_)" ;; esac

# ---------------------------------------------------------------- 2. model for this computer
if [ "$OS" = Darwin ]; then MEM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 )); else MEM_GB=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1048576 )); fi
if [ -n "${DSI_MODEL:-}" ]; then MODEL="$DSI_MODEL"
# Non-thinking chat models (fast first answers on CPUs), with licences that allow network use.
elif [ "$MEM_GB" -lt 6 ]; then MODEL="qwen2.5:1.5b"
elif [ "$MEM_GB" -lt 12 ]; then MODEL="llama3.2:3b"
elif [ "$MEM_GB" -lt 24 ]; then MODEL="qwen2.5:7b"
else MODEL="qwen2.5:14b"; fi
step "1/4  Model: $MODEL (this computer has ${MEM_GB} GB of memory)"

# ---------------------------------------------------------------- 3. Ollama + model
OLLAMA=$(command -v ollama || true)
if [ -z "$OLLAMA" ] && [ -x "/Applications/Ollama.app/Contents/Resources/ollama" ]; then OLLAMA="/Applications/Ollama.app/Contents/Resources/ollama"; fi
if [ -z "$OLLAMA" ]; then
  say "Installing Ollama (runs the model on this computer)..."
  if [ "$OS" = Darwin ]; then
    if have brew; then brew install ollama >/dev/null; OLLAMA=$(command -v ollama)
    else
      fetch "https://ollama.com/download/Ollama-darwin.zip" "$DSI_HOME/ollama.zip"
      mkdir -p "$HOME/Applications" && ditto -xk "$DSI_HOME/ollama.zip" "$HOME/Applications" && rm -f "$DSI_HOME/ollama.zip"
      OLLAMA="$HOME/Applications/Ollama.app/Contents/Resources/ollama"
    fi
  else
    curl -fsSL https://ollama.com/install.sh | sh
    OLLAMA=$(command -v ollama)
  fi
fi
[ -x "$OLLAMA" ] || die "Ollama could not be installed; install it from https://ollama.com and run this again"
ln -sf "$OLLAMA" "$DSI_HOME/bin/ollama"
if ! curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  OLLAMA_NUM_PARALLEL=1 nohup "$OLLAMA" serve >>"$DSI_HOME/ollama.log" 2>&1 &
  i=0; until curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; do i=$((i + 1)); [ $i -gt 30 ] && die "Ollama did not start (see $DSI_HOME/ollama.log)"; sleep 1; done
fi
say "Downloading $MODEL (the first time takes a few minutes)..."
"$OLLAMA" pull "$MODEL"

# ---------------------------------------------------------------- 4. Node.js, cloudflared, dsi-node
step "2/4  Node runtime and secure tunnel"
NODE_BIN=""
if have node && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 20 ]; then NODE_BIN=$(command -v node); fi
if [ -z "$NODE_BIN" ]; then
  [ "$OS" = Darwin ] && NOS=darwin || NOS=linux
  [ "$ARCH" = amd64 ] && NARCH=x64 || NARCH=arm64
  fetch "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt" "$DSI_HOME/node.sums"
  FILE=$(grep "node-v[0-9.]*-$NOS-$NARCH.tar.gz" "$DSI_HOME/node.sums" | awk '{print $2}')
  [ -n "$FILE" ] || die "no Node.js build for $NOS-$NARCH"
  fetch "https://nodejs.org/dist/latest-v22.x/$FILE" "$DSI_HOME/node.tgz"
  [ "$(sha256 "$DSI_HOME/node.tgz")" = "$(grep " $FILE\$" "$DSI_HOME/node.sums" | awk '{print $1}')" ] || die "Node.js download failed its checksum"
  rm -rf "$DSI_HOME/node" && mkdir -p "$DSI_HOME/node" && tar -xzf "$DSI_HOME/node.tgz" -C "$DSI_HOME/node" --strip-components 1
  rm -f "$DSI_HOME/node.tgz" "$DSI_HOME/node.sums"
  NODE_BIN="$DSI_HOME/node/bin/node"
fi
ln -sf "$NODE_BIN" "$DSI_HOME/bin/node"

if have cloudflared; then ln -sf "$(command -v cloudflared)" "$DSI_HOME/bin/cloudflared"
elif [ "$OS" = Darwin ]; then
  fetch "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-$ARCH.tgz" "$DSI_HOME/cf.tgz"
  tar -xzf "$DSI_HOME/cf.tgz" -C "$DSI_HOME/bin" && rm -f "$DSI_HOME/cf.tgz"
else
  fetch "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH" "$DSI_HOME/bin/cloudflared"
fi
chmod +x "$DSI_HOME/bin/cloudflared"

fetch "$BASE/dl/dsi-node.mjs" "$DSI_HOME/dsi-node.mjs"
fetch "$BASE/dl/SHA256SUMS" "$DSI_HOME/SHA256SUMS"
[ "$(sha256 "$DSI_HOME/dsi-node.mjs")" = "$(awk '$2 == "dsi-node.mjs" {print $1}' "$DSI_HOME/SHA256SUMS")" ] || die "dsi-node.mjs failed its checksum"
rm -f "$DSI_HOME/SHA256SUMS"

# ---------------------------------------------------------------- settings + launcher
umask 077
cat >"$DSI_HOME/node.env" <<EOF
DSI_API_KEY=$KEY
DSI_ROUTER=${DSI_ROUTER:-https://api.decentralise.si}
DSI_MODELS=$MODEL
NODE_NAME=laptop-$(hostname | cut -d. -f1)
PORT=$PORT
LLM_BASE_URL=http://127.0.0.1:11434/v1
CLOUDFLARED_METRICS=http://127.0.0.1:20241
DSI_NODE_STATE=$DSI_HOME/state.json
MAX_CONCURRENCY=1
DSI_PAUSE_ON_BATTERY=${DSI_PAUSE_ON_BATTERY:-1}
EOF
umask 022
cat >"$DSI_HOME/bin/dsi-node-up" <<EOF
#!/bin/sh
# Starts Ollama (if needed), the tunnel and the node. Logs: $DSI_HOME/*.log
set -a; . "$DSI_HOME/node.env"; set +a
PATH="$DSI_HOME/bin:\$PATH"
if ! curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  OLLAMA_NUM_PARALLEL=1 ollama serve >>"$DSI_HOME/ollama.log" 2>&1 &
fi
cloudflared tunnel --no-autoupdate --protocol http2 --url "http://127.0.0.1:\$PORT" --metrics 127.0.0.1:20241 >>"$DSI_HOME/tunnel.log" 2>&1 &
TUNNEL=\$!
node "$DSI_HOME/dsi-node.mjs" up &
NODE=\$!
trap 'kill -TERM \$NODE \$TUNNEL 2>/dev/null; wait \$NODE 2>/dev/null' EXIT INT TERM
# The node and its tunnel live and die together: if either stops, stop both and let the
# service manager start a fresh pair (the node then reports its new tunnel address).
while kill -0 \$TUNNEL 2>/dev/null && kill -0 \$NODE 2>/dev/null; do sleep 5; done
exit 1
EOF
chmod +x "$DSI_HOME/bin/dsi-node-up"

# ---------------------------------------------------------------- 5. start (and start at login)
step "3/4  Starting the node"
stop_service
: >"$DSI_HOME/node.log"
if [ "${DSI_NO_SERVICE:-}" = 1 ]; then
  nohup sh -c "while :; do '$DSI_HOME/bin/dsi-node-up'; sleep 10; done" >>"$DSI_HOME/node.log" 2>&1 &
  echo $! >"$DSI_HOME/node.pid"
elif [ "$OS" = Darwin ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  cat >"$HOME/Library/LaunchAgents/si.decentralised.node.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>si.decentralised.node</string>
  <key>ProgramArguments</key><array><string>$DSI_HOME/bin/dsi-node-up</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DSI_HOME/node.log</string>
  <key>StandardErrorPath</key><string>$DSI_HOME/node.log</string>
</dict></plist>
EOF
  launchctl load "$HOME/Library/LaunchAgents/si.decentralised.node.plist"
elif have systemctl && systemctl --user status >/dev/null 2>&1; then
  mkdir -p "$HOME/.config/systemd/user"
  cat >"$HOME/.config/systemd/user/dsi-node.service" <<EOF
[Unit]
Description=Decentralised.si node
After=network-online.target

[Service]
ExecStart=$DSI_HOME/bin/dsi-node-up
Restart=always
RestartSec=10
StandardOutput=append:$DSI_HOME/node.log
StandardError=append:$DSI_HOME/node.log

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now dsi-node.service
else
  nohup sh -c "while :; do '$DSI_HOME/bin/dsi-node-up'; sleep 10; done" >>"$DSI_HOME/node.log" 2>&1 &
  echo $! >"$DSI_HOME/node.pid"
  say "(No service manager found: the node runs until you log out. Start it again with $DSI_HOME/bin/dsi-node-up)"
fi

step "4/4  Joining the network"
i=0
until grep -q "live at" "$DSI_HOME/node.log" 2>/dev/null; do
  i=$((i + 1))
  if [ $i -gt 90 ]; then say "Still starting; follow progress with: tail -f $DSI_HOME/node.log"; exit 0; fi
  if grep -q "^\[dsi-node\] .*\(required\|invalid\|rejected\|Unauthorized\)" "$DSI_HOME/node.log" 2>/dev/null; then tail -5 "$DSI_HOME/node.log"; die "the node could not join (see above)"; fi
  sleep 2
done
grep "live at" "$DSI_HOME/node.log" | tail -1
say ""
say "Your computer is now a Decentralised.si node, serving $MODEL."
say "  - Free chat: after its first checks (usually under an hour) you get 20,000 free tokens a day,"
say "    plus every token your node serves. Open https://decentralised.si/app and choose"
say "    'Free - community nodes'."
say "  - It pauses on battery, starts at login, and only answers requests signed by the network."
say "  - Logs: $DSI_HOME/node.log   Remove: curl -fsSL $BASE/install/node.sh | sh -s -- --uninstall"
