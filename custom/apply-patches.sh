#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_SRC="$SCRIPT_DIR/AGENTS.md"
AGENTS_DST="${CODEX_HOME:-$HOME/.codex}/AGENTS.md"

usage() {
  cat <<EOF
Usage: $0 [--router] [--scaffold-inbox DIR] [--apply-stock ROUTER_REPO]

  --router             install global AGENTS.md rules (default)
  --scaffold-inbox DIR create DIR/.codex-agent-tasks/.gitignore
  --apply-stock REPO   apply router.patch to a stock router checkout
EOF
}

install_agents() {
  mkdir -p "$(dirname "$AGENTS_DST")"
  if [[ -f "$AGENTS_DST" ]] && ! cmp -s "$AGENTS_SRC" "$AGENTS_DST"; then
    cp "$AGENTS_DST" "$AGENTS_DST.bak.$(date +%s)"
    echo "[agents] backed up existing $AGENTS_DST"
  fi
  cp "$AGENTS_SRC" "$AGENTS_DST"
  echo "[agents] installed $AGENTS_DST"
}

scaffold_inbox() {
  local dir="$1"
  mkdir -p "$dir/.codex-agent-tasks"
  printf '*\n!.gitignore\n' > "$dir/.codex-agent-tasks/.gitignore"
  echo "[inbox] scaffolded $dir/.codex-agent-tasks"
}

apply_stock() {
  local repo="$1"
  git -C "$repo" apply --check "$SCRIPT_DIR/router.patch"
  git -C "$repo" apply "$SCRIPT_DIR/router.patch"
  echo "[router] applied custom/router.patch to $repo"
}

mode="router"
inbox_dir=""
stock_repo=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --router) mode="router" ;;
    --scaffold-inbox) inbox_dir="$2"; shift ;;
    --apply-stock) stock_repo="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 1 ;;
  esac
  shift
done

if [[ -n "$stock_repo" ]]; then
  apply_stock "$stock_repo"
fi
if [[ "$mode" == "router" ]]; then
  install_agents
fi
if [[ -n "$inbox_dir" ]]; then
  scaffold_inbox "$inbox_dir"
fi

cat <<EOF

Post steps:
1. Personal login: mkdir -p ~/.codex-personal && CODEX_HOME=~/.codex-personal codex login
2. bin/model-router codex provider-selection (enable deepseek + chatgpt-login)
3. bin/model-router codex doctor
4. Build and install the patched Codex CLI from bhsong1011/codex branch custom-v0.146.0
5. Fully restart Codex desktop
EOF
