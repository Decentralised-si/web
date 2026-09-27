#!/bin/sh
# Installs oifd, the Decentralised.si local router, on macOS or Linux.
#   curl -fsSL https://decentralise.si/install/oifd.sh | sh
# Options (environment variables):
#   OIFD_VERSION=oifd-v0.1.0     install a specific release (default: latest)
#   OIFD_INSTALL_DIR=/usr/local/bin   install location (default: ~/.local/bin)
#   OIFD_NO_INIT=1               do not create ~/.oif config files
# Source: https://github.com/Decentralised-si/Smart-LLM-Router/tree/main/oif-router
set -eu

REPO="Decentralised-si/Smart-LLM-Router"
VERSION="${OIFD_VERSION:-latest}"
INSTALL_DIR="${OIFD_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
fail() { printf 'oifd install: %s\n' "$*" >&2; exit 1; }

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os_part="apple-darwin" ;;
  Linux) os_part="unknown-linux-musl" ;;
  *) fail "unsupported OS '$os'. On Windows run in PowerShell: irm https://decentralise.si/install/oifd.ps1 | iex" ;;
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
asset="oifd-$target.tar.gz"
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
cp "$tmp/oifd-$target/oifd" "$INSTALL_DIR/oifd.tmp"
chmod 755 "$INSTALL_DIR/oifd.tmp"
mv "$INSTALL_DIR/oifd.tmp" "$INSTALL_DIR/oifd"
[ "$os" = Darwin ] && xattr -d com.apple.quarantine "$INSTALL_DIR/oifd" 2>/dev/null || true
say "Installed $("$INSTALL_DIR/oifd" --version) to $INSTALL_DIR/oifd"

if [ "${OIFD_NO_INIT:-0}" != 1 ]; then
  "$INSTALL_DIR/oifd" init
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
say "Next: run 'oifd', then open https://decentralise.si/download#first-run"
