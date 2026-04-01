#!/usr/bin/env bash
# update-node.sh — Pull latest code and rebuild agent-node on a remote machine.
# Usage: bash scripts/update-node.sh
#
# Prerequisites on the remote machine:
#   - git clone of this repo
#   - pnpm installed

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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



echo "==> [update-node] done"
