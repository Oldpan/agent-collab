import { execFileSync, spawnSync } from "node:child_process";

const session = process.env.AGENT_COLLAB_TMUX_SESSION ?? "agent-collab";
const target = process.argv[2];

const SERVICES = {
  core: {
    window: "0",
    command: "cd /ai/code/agi/agent-collab && pnpm --filter @agent-collab/core dev",
  },
  web: {
    window: "1",
    command: "cd /ai/code/agi/agent-collab && pnpm --filter @agent-collab/web dev",
  },
  node: {
    window: "2",
    command: "cd /ai/code/agi/agent-collab && pnpm --filter @agent-collab/agent-node dev",
  },
};

const ORDER = ["core", "node", "web"];

if (!target || (target !== "all" && !Object.hasOwn(SERVICES, target))) {
  console.error("Usage: node scripts/restart-dev.mjs <core|node|web|all>");
  process.exit(1);
}

ensureSessionExists(session);

if (target === "all") {
  for (const service of ORDER) {
    await restartService(service);
  }
  process.exit(0);
}

await restartService(target);

async function restartService(name) {
  const service = SERVICES[name];
  const tmuxTarget = `${session}:${service.window}`;
  ensureWindowExists(session, service.window, name);

  console.log(`[restart] ${name} -> ${tmuxTarget}`);
  execTmux(["send-keys", "-t", tmuxTarget, "C-c"]);
  await sleep(400);
  execTmux(["send-keys", "-t", tmuxTarget, service.command, "C-m"]);
  await sleep(700);
}

function ensureSessionExists(sessionName) {
  const result = spawnSync("tmux", ["has-session", "-t", sessionName], { stdio: "ignore" });
  if (result.status !== 0) {
    console.error(`[restart] tmux session not found: ${sessionName}`);
    process.exit(1);
  }
}

function ensureWindowExists(sessionName, windowId, serviceName) {
  const result = spawnSync("tmux", ["list-windows", "-t", sessionName], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const output = result.stdout ?? "";
  const exists = output
    .split("\n")
    .some((line) => line.trimStart().startsWith(`${windowId}:`));
  if (!exists) {
    console.error(`[restart] tmux window ${windowId} for ${serviceName} not found in session ${sessionName}`);
    process.exit(1);
  }
}

function execTmux(args) {
  execFileSync("tmux", args, { stdio: "inherit" });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
