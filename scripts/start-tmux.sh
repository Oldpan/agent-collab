#!/usr/bin/env bash
set -euo pipefail

SESSION="${AGENT_COLLAB_TMUX_SESSION:-agent-collab}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

create_session_if_missing() {
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    return
  fi

  tmux new-session -d -s "$SESSION" -n core "bash"
  tmux new-window -d -t "$SESSION:1" -n web "bash"
  tmux new-window -d -t "$SESSION:2" -n agent-node "bash"
}

ensure_window() {
  local index="$1"
  local name="$2"

  if tmux list-windows -t "$SESSION" -F '#I' | grep -qx "$index"; then
    tmux rename-window -t "$SESSION:$index" "$name"
    return
  fi

  local temp_name="${name}-bootstrap-$$"
  local created_index

  tmux new-window -d -t "$SESSION:" -n "$temp_name" "bash"
  created_index=$(tmux list-windows -t "$SESSION" -F '#I:#W' | awk -F: -v temp_name="$temp_name" '$2 == temp_name { print $1 }' | tail -n 1)

  if [[ -z "$created_index" ]]; then
    echo "[tmux] failed to create window for $name" >&2
    exit 1
  fi

  if [[ "$created_index" != "$index" ]]; then
    tmux move-window -s "$SESSION:$created_index" -t "$SESSION:$index"
  fi
  tmux rename-window -t "$SESSION:$index" "$name"
}

start_service() {
  local index="$1"
  local name="$2"
  local command="$3"
  local target="${SESSION}:${index}"
  local repo_q
  local command_q
  local shell_command

  repo_q=$(printf '%q' "$REPO_ROOT")
  command_q=$(printf '%q' "$command")
  shell_command="cd ${repo_q} && clear && printf '[tmux] starting %s\\n' ${command_q} && ${command} ; status=\$?; printf '\\n[tmux] exited with status %s\\n' \"\$status\"; printf '[tmux] shell kept open in %s:%s for manual restart\\n' '${SESSION}' '${index}'"

  tmux send-keys -t "$target" C-c
  sleep 0.2
  tmux send-keys -t "$target" "$shell_command" C-m
}

create_session_if_missing
ensure_window 0 core
ensure_window 1 web
ensure_window 2 agent-node

start_service 0 core "pnpm --filter @agent-collab/core run dev"
start_service 1 web "pnpm --filter @agent-collab/web run dev"
start_service 2 agent-node "pnpm --filter @agent-collab/agent-node run dev"

tmux select-window -t "$SESSION:0"

printf '[tmux] session ready: %s\n' "$SESSION"
printf '[tmux] attach with: tmux attach -t %s\n' "$SESSION"
