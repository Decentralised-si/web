#!/bin/sh
# Installs Synapse, the Decentralised.si local router, on macOS or Linux.
#   curl -fsSL https://decentralised.si/install/synapse.sh | sh
# Options (environment variables):
#   SYNAPSE_VERSION=synapse-v0.2.4     install a specific release (default: latest)
#   SYNAPSE_INSTALL_DIR=/usr/local/bin   install location (default: ~/.local/bin)
#   SYNAPSE_NO_INIT=1               do not create ~/.synapse config files
# Source: https://github.com/Decentralised-si/DSI-Synapse
set -eu

REPO="Decentralised-si/DSI-Synapse"
VERSION="${SYNAPSE_VERSION:-${OIFD_VERSION:-latest}}"
INSTALL_DIR="${SYNAPSE_INSTALL_DIR:-${OIFD_INSTALL_DIR:-$HOME/.local/bin}}"

say() { printf '%s\n' "$*"; }
fail() { printf 'synapse install: %s\n' "$*" >&2; exit 1; }

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os_part="apple-darwin" ;;
  Linux) os_part="unknown-linux-musl" ;;
  *) fail "unsupported OS '$os'. On Windows run in PowerShell: irm https://decentralised.si/install/synapse.ps1 | iex" ;;
esac
case "$arch" in
  x86_64 | amd64) arch_part="x86_64" ;;
  arm64 | aarch64) arch_part="aarch64" ;;
  *) fail "unsupported CPU architecture '$arch'" ;;
esac
# A shell running under Rosetta reports x86_64 on Apple silicon; install the native build.
if [ "$os" = Darwin ] && [ "$arch_part" = x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch_part="aarch64"
fi
target="$arch_part-$os_part"
asset="synapse-$target.tar.gz"
if [ "$VERSION" = latest ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else fail "curl or wget is required"; fi
}
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading $asset ($VERSION) ..."
fetch "$base/$asset" "$tmp/$asset" || fail "download failed: $base/$asset"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "could not download SHA256SUMS"
expected=$(awk -v f="$asset" '$2 == f {print $1}' "$tmp/SHA256SUMS")
[ -n "$expected" ] || fail "$asset is not listed in SHA256SUMS"
actual=$(sha256 "$tmp/$asset")
[ "$expected" = "$actual" ] || fail "checksum mismatch for $asset (expected $expected, got $actual)"
say "Checksum verified."

tar -xzf "$tmp/$asset" -C "$tmp"
mkdir -p "$INSTALL_DIR"
cp "$tmp/synapse-$target/synapse" "$INSTALL_DIR/synapse.tmp"
chmod 755 "$INSTALL_DIR/synapse.tmp"
mv "$INSTALL_DIR/synapse.tmp" "$INSTALL_DIR/synapse"
[ "$os" = Darwin ] && xattr -d com.apple.quarantine "$INSTALL_DIR/synapse" 2>/dev/null || true
say "Installed $("$INSTALL_DIR/synapse" --version) to $INSTALL_DIR/synapse"

if [ "${SYNAPSE_NO_INIT:-0}" != 1 ]; then
  "$INSTALL_DIR/synapse" init
fi

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    say ""
    say "$INSTALL_DIR is not on your PATH. Add it with:"
    case "${SHELL:-}" in
      */zsh) say "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc && source ~/.zshrc" ;;
      */fish) say "  fish_add_path $INSTALL_DIR" ;;
      *) say "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.bashrc && source ~/.bashrc" ;;
    esac
    ;;
esac
say ""
say "Chat and watch routing live:  run 'synapse', then open http://127.0.0.1:7766/"
say "Guide: https://decentralised.si/download#first-run"
