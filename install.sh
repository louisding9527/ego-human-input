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

# 把 ego-browser 条目指到本仓库的兼容壳（不碰 ego lite 安装目录）
node "$SRC/tools/link-skill.mjs"
