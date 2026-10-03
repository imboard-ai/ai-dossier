#!/bin/sh
# Install the standalone ai-dossier binary (no Node.js required).
#
#   curl -fsSL https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --version 0.72.0 --dir /usr/local/bin
#
# Options / env:
#   --version <x.y.z>   install this cli version (default: latest cli-v* release)
#   --dir <path>        install directory (default: $AI_DOSSIER_INSTALL_DIR or ~/.local/bin)
#   --print-asset       print the asset name for this platform and exit
#   AI_DOSSIER_REPO     override the GitHub repo (default imboard-ai/ai-dossier)
#
# Test hooks: AI_DOSSIER_BASE_URL replaces the release download URL; AI_DOSSIER_UNAME_S / AI_DOSSIER_UNAME_M override uname output.

set -eu

REPO="${AI_DOSSIER_REPO:-imboard-ai/ai-dossier}"
VERSION=""
DIR="${AI_DOSSIER_INSTALL_DIR:-$HOME/.local/bin}"
PRINT_ASSET=0

die() { echo "install.sh: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version needs a value"; VERSION="$2"; shift 2 ;;
    --dir) [ $# -ge 2 ] || die "--dir needs a value"; DIR="$2"; shift 2 ;;
    --print-asset) PRINT_ASSET=1; shift ;;
    -h|--help) sed -n '2,13p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

detect_asset() {
  os="$(printf %s "${AI_DOSSIER_UNAME_S:-$(uname -s)}" | tr '[:upper:]' '[:lower:]')"
  m="${AI_DOSSIER_UNAME_M:-$(uname -m)}"
  case "$os" in
    linux) platform=linux ;;
    darwin) platform=darwin ;;
    mingw*|msys*|cygwin*) platform=win32 ;;
    *) die "unsupported OS: $os (supported: Linux, macOS, Windows via Git Bash)" ;;
  esac
  case "$m" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) die "unsupported architecture: $m (supported: x86_64, arm64)" ;;
  esac
  case "$platform-$arch" in
    linux-x64|linux-arm64|darwin-x64|darwin-arm64|win32-x64) ;;
    *) die "no prebuilt binary for $platform-$arch" ;;
  esac
  ext=""
  [ "$platform" = win32 ] && ext=".exe"
  echo "ai-dossier-$platform-$arch$ext"
}

ASSET="$(detect_asset)"
if [ "$PRINT_ASSET" = 1 ]; then echo "$ASSET"; exit 0; fi

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1"; }
  fetch_to() { curl -fsSL -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO- "$1"; }
  fetch_to() { wget -qO "$2" "$1"; }
else
  die "need curl or wget"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die "need sha256sum or shasum to verify the download"
fi

if [ -z "$VERSION" ]; then
  # The repo's "latest" release is not necessarily a cli release; scan for cli-v*.
  TAG="$(fetch "https://api.github.com/repos/$REPO/releases?per_page=50" \
    | grep -o '"tag_name": *"cli-v[^"]*"' | head -n 1 | sed 's/.*"\(cli-v[^"]*\)"$/\1/')" || true
  [ -n "$TAG" ] || die "no cli-v* release found in $REPO"
else
  TAG="cli-v$VERSION"
fi

BASE="${AI_DOSSIER_BASE_URL:-https://github.com/$REPO/releases/download/$TAG}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading $ASSET ($TAG)..."
fetch_to "$BASE/$ASSET" "$TMP/$ASSET" || die "download failed: $BASE/$ASSET"
fetch_to "$BASE/SHA256SUMS" "$TMP/SHA256SUMS" || die "download failed: $BASE/SHA256SUMS"

EXPECTED="$(grep " \*\{0,1\}$ASSET\$" "$TMP/SHA256SUMS" | head -n 1 | cut -d' ' -f1)"
[ -n "$EXPECTED" ] || die "$ASSET not listed in SHA256SUMS"
ACTUAL="$(sha256 "$TMP/$ASSET")"
[ "$EXPECTED" = "$ACTUAL" ] || die "checksum mismatch for $ASSET (expected $EXPECTED, got $ACTUAL)"
echo "Checksum OK."

TARGET_NAME="ai-dossier"
[ "${ASSET%.exe}" != "$ASSET" ] && TARGET_NAME="ai-dossier.exe"
mkdir -p "$DIR"
chmod +x "$TMP/$ASSET"
mv "$TMP/$ASSET" "$DIR/$TARGET_NAME"
echo "Installed $DIR/$TARGET_NAME"

case ":$PATH:" in
  *":$DIR:"*) ;;
  *) echo "Note: $DIR is not on your PATH. Add: export PATH=\"$DIR:\$PATH\"" ;;
esac
"$DIR/$TARGET_NAME" --version || true
