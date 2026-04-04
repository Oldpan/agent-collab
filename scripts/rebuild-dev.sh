#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_HOME="${AGENT_COLLAB_BUILD_HOME:-/tmp}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/rebuild-dev.sh [all|core|web|node|protocol|memory|runtime-acp]... [--restart]

Examples:
  bash scripts/rebuild-dev.sh all
  bash scripts/rebuild-dev.sh memory core --restart
  bash scripts/rebuild-dev.sh runtime-acp node --restart

Notes:
  - protocol / memory / runtime-acp are built from src -> dist
  - core / web / node run TypeScript validation
  - --restart restarts the affected local services after successful rebuild/checks
EOF
}

if [[ $# -eq 0 ]]; then
  set -- all
fi

declare -a requested_targets=()
restart=false

for arg in "$@"; do
  case "$arg" in
    --restart)
      restart=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    all|core|web|node|protocol|memory|runtime-acp)
      requested_targets+=("$arg")
      ;;
    *)
      echo "[rebuild] unknown target: $arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

declare -A seen_targets=()
declare -a targets=()

add_target() {
  local target="$1"
  if [[ -n "${seen_targets[$target]:-}" ]]; then
    return
  fi
  seen_targets["$target"]=1
  targets+=("$target")
}

expand_target() {
  local target="$1"
  case "$target" in
    all)
      add_target protocol
      add_target memory
      add_target runtime-acp
      add_target core
      add_target node
      add_target web
      ;;
    *)
      add_target "$target"
      ;;
  esac
}

for target in "${requested_targets[@]}"; do
  expand_target "$target"
done

declare -A restart_services_map=()
declare -a restart_services=()

add_restart_service() {
  local service="$1"
  if [[ -n "${restart_services_map[$service]:-}" ]]; then
    return
  fi
  restart_services_map["$service"]=1
  restart_services+=("$service")
}

run_pnpm() {
  local label="$1"
  shift
  echo "[rebuild] $label"
  (
    cd "$ROOT_DIR"
    HOME="$BUILD_HOME" pnpm "$@"
  )
}

for target in "${targets[@]}"; do
  case "$target" in
    protocol)
      run_pnpm "building @agent-collab/protocol" --filter @agent-collab/protocol build
      add_restart_service core
      add_restart_service node
      add_restart_service web
      ;;
    memory)
      run_pnpm "building @agent-collab/memory" --filter @agent-collab/memory build
      add_restart_service core
      ;;
    runtime-acp)
      run_pnpm "building @agent-collab/runtime-acp" --filter @agent-collab/runtime-acp build
      add_restart_service core
      add_restart_service node
      ;;
    core)
      run_pnpm "type-checking @agent-collab/core" --filter @agent-collab/core exec tsc --noEmit
      add_restart_service core
      ;;
    node)
      run_pnpm "type-checking @agent-collab/agent-node" --filter @agent-collab/agent-node exec tsc --noEmit
      add_restart_service node
      ;;
    web)
      run_pnpm "type-checking @agent-collab/web" --filter @agent-collab/web exec tsc --noEmit
      add_restart_service web
      ;;
  esac
done

if [[ "$restart" == true && "${#restart_services[@]}" -gt 0 ]]; then
  echo "[rebuild] restarting affected services: ${restart_services[*]}"
  (
    cd "$ROOT_DIR"
    for service in core node web; do
      if [[ -n "${restart_services_map[$service]:-}" ]]; then
        node scripts/restart-dev.mjs "$service"
      fi
    done
  )
fi

echo "[rebuild] done"
