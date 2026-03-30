#!/usr/bin/env bash
# update-node.sh — Pull latest code and restart agent-node on a test machine.
# Usage: bash scripts/update-node.sh [--no-restart]
#
# Prerequisites on the test machine:
#   - git clone of this repo
#   - pnpm installed
#   - agent-node running via pm2 (recommended) or a background process named "agent-node"
#
# Env vars (can also be set in ~/.agent-node.env):
#   CORE_URL          — ws://<dev-machine-ip>:3100
#   NODE_HOSTNAME     — display name for this node (default: hostname)
#   WORKSPACE_ROOT    — where agent workspaces are stored

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NO_RESTART=false

for arg in "$@"; do
  case $arg in
    --no-restart) NO_RESTART=true ;;
  esac
done

echo "==> [update-node] repo: $REPO_DIR"
cd "$REPO_DIR"

# Load local env overrides if present
if [[ -f ~/.agent-node.env ]]; then
  # shellcheck disable=SC1090
  source ~/.agent-node.env
  echo "==> [update-node] loaded ~/.agent-node.env"
fi

# 1. Pull latest
echo "==> [update-node] git pull"
git fetch origin
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/master)

if [[ "$LOCAL" == "$REMOTE" ]]; then
  echo "==> [update-node] already up to date ($LOCAL)"
  if [[ "$NO_RESTART" == "true" ]]; then
    exit 0
  fi
else
  echo "==> [update-node] updating $LOCAL -> $REMOTE"
  git pull --ff-only origin master
fi

# 2. Install deps (only if lockfile changed)
echo "==> [update-node] pnpm install"
pnpm install --frozen-lockfile

# 3. Build in dependency order
echo "==> [update-node] build protocol"
pnpm --filter @agent-collab/protocol build

echo "==> [update-node] build runtime-acp"
pnpm --filter @agent-collab/runtime-acp build

echo "==> [update-node] build agent-node"
pnpm --filter @agent-collab/agent-node build

if [[ "$NO_RESTART" == "true" ]]; then
  echo "==> [update-node] build complete (--no-restart, skipping restart)"
  exit 0
fi

# 4. Restart agent-node
#    Supports pm2 (preferred) or a simple PID file approach.

if command -v pm2 &>/dev/null && pm2 list | grep -q "agent-node"; then
  echo "==> [update-node] restarting via pm2"
  pm2 restart agent-node
elif [[ -f /tmp/agent-node.pid ]]; then
  OLD_PID=$(cat /tmp/agent-node.pid)
  echo "==> [update-node] killing old process $OLD_PID"
  kill "$OLD_PID" 2>/dev/null || true
  sleep 1
  nohup bash -c "cd $REPO_DIR && CORE_URL=${CORE_URL:-ws://localhost:3100} \
    NODE_HOSTNAME=${NODE_HOSTNAME:-$(hostname)} \
    WORKSPACE_ROOT=${WORKSPACE_ROOT:-$HOME/.agent-node/workspace} \
    node apps/agent-node/dist/main.js >> /tmp/agent-node.log 2>&1 &
    echo \$! > /tmp/agent-node.pid" &
  echo "==> [update-node] agent-node restarted, pid=$(cat /tmp/agent-node.pid)"
else
  echo "==> [update-node] WARNING: no pm2 process or PID file found."
  echo "    Start agent-node manually:"
  echo "    CORE_URL=${CORE_URL:-ws://localhost:3100} node apps/agent-node/dist/main.js"
fi

echo "==> [update-node] done"
