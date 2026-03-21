import os from 'node:os';
import path from 'node:path';
export function loadConfig() {
    const coreUrl = process.env.CORE_URL ?? 'ws://localhost:3000';
    const nodeId = process.env.NODE_ID ?? `node-${process.pid}`;
    const hostname = process.env.NODE_HOSTNAME ?? os.hostname();
    const workspaceRoot = process.env.WORKSPACE_ROOT ?? os.tmpdir();
    const dbPath = process.env.DB_PATH ?? path.join(os.homedir(), '.agent-node', 'db.sqlite');
    return {
        nodeId,
        hostname,
        coreUrl,
        agentTypes: ['claude_acp'],
        version: '0.1.0',
        workspaceRoot,
        dbPath,
        // RuntimeConfig fields
        acpAgentCommand: process.env.ACP_AGENT_COMMAND ?? 'npx',
        acpAgentArgs: process.env.ACP_AGENT_ARGS
            ? JSON.parse(process.env.ACP_AGENT_ARGS)
            : ['-y', '@zed-industries/claude-code-acp@latest'],
        uiJsonMaxChars: Number(process.env.UI_JSON_MAX_CHARS ?? 3000),
        heartbeatIntervalMs: Number(process.env.HEARTBEAT_INTERVAL_MS ?? 15_000),
    };
}
