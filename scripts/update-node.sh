#!/usr/bin/env bash
# update-node.sh — Update code for an agent-node machine and optionally restart node.
# Usage: bash scripts/update-node.sh
#
# Environment:
#   AGENT_COLLAB_TMUX_SESSION   tmux session name to restart from (default: agent-collab)
#   UPDATE_NODE_ALLOW_DIRTY=1   allow running with local uncommitted changes
#   UPDATE_NODE_SKIP_RESTART=1  skip automatic tmux restart even if the window exists

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMUX_SESSION="${AGENT_COLLAB_TMUX_SESSION:-agent-collab}"
ALLOW_DIRTY="${UPDATE_NODE_ALLOW_DIRTY:-0}"
SKIP_RESTART="${UPDATE_NODE_SKIP_RESTART:-0}"

echo "==> [update-node] repo: $REPO_DIR"
cd "$REPO_DIR"

if [[ -f ~/.agent-node.env ]]; then
  # shellcheck disable=SC1090
  source ~/.agent-node.env
  echo "==> [update-node] loaded ~/.agent-node.env"
fi

if [[ "$ALLOW_DIRTY" != "1" ]] && [[ -n "$(git status --short)" ]]; then
  echo "==> [update-node] refused: working tree is dirty"
  echo "==> [update-node] commit/stash your changes first, or rerun with UPDATE_NODE_ALLOW_DIRTY=1"
  exit 1
fi

UPSTREAM_REF="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
if [[ -z "$UPSTREAM_REF" ]]; then
  UPSTREAM_REF="origin/master"
fi

echo "==> [update-node] fetch $UPSTREAM_REF"
git fetch --prune origin

LOCAL_REF="$(git rev-parse HEAD)"
REMOTE_REF="$(git rev-parse "$UPSTREAM_REF")"
BASE_REF="$(git merge-base HEAD "$UPSTREAM_REF")"

if [[ "$LOCAL_REF" == "$REMOTE_REF" ]]; then
  echo "==> [update-node] already up to date ($LOCAL_REF)"
elif [[ "$LOCAL_REF" == "$BASE_REF" ]]; then
  echo "==> [update-node] fast-forward $LOCAL_REF -> $REMOTE_REF"
  git merge --ff-only "$UPSTREAM_REF"
elif [[ "$REMOTE_REF" == "$BASE_REF" ]]; then
  echo "==> [update-node] local branch is ahead of $UPSTREAM_REF"
  echo "==> [update-node] refusing to overwrite local commits"
  exit 1
else
  echo "==> [update-node] local branch diverged from $UPSTREAM_REF"
  echo "==> [update-node] resolve the branch state manually before updating"
  exit 1
fi

echo "==> [update-node] pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile

echo "==> [update-node] build agent-node workspace packages"
pnpm --filter @agent-collab/agent-node... run build

if [[ "$SKIP_RESTART" == "1" ]]; then
  echo "==> [update-node] skipping restart (UPDATE_NODE_SKIP_RESTART=1)"
  exit 0
fi

if tmux has-session -t "$TMUX_SESSION" 2>/dev/null && tmux list-windows -t "$TMUX_SESSION" -F '#I' | grep -qx '2'; then
  echo "==> [update-node] restarting agent-node in tmux session $TMUX_SESSION"
  node scripts/restart-dev.mjs node
else
  echo "==> [update-node] tmux session/window not found, restart agent-node manually"
  echo "==> [update-node] example: cd $REPO_DIR && pnpm --filter @agent-collab/agent-node run dev"
fi

echo "==> [update-node] done"
