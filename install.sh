#!/usr/bin/env bash
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DST="$HOME/.agents/skills/ego-human-input"
mkdir -p "$HOME/.agents/skills"
if [ -L "$DST" ] || [ -e "$DST" ]; then
  rm -rf "$DST"
fi
ln -s "$SRC" "$DST"
echo "linked: $DST -> $SRC"
echo "verify: node --test \"$SRC/tests/*.test.mjs\""
