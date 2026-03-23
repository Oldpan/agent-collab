// ─── 服务端 → 客户端 事件 ───
export const RUNTIME_DRIVERS = {
    claude_acp: {
        agentType: 'claude_acp',
        command: 'npx',
        args: ['-y', '@zed-industries/claude-code-acp@latest'],
        supportsResume: true,
        supportsPushNotifications: true,
        nativeMemoryBackend: 'workspace',
        defaultEnv: {
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        },
    },
    codex_acp: {
        agentType: 'codex_acp',
        command: 'npx',
        args: ['-y', '@zed-industries/codex-acp@latest'],
        supportsResume: true,
        supportsPushNotifications: false,
        nativeMemoryBackend: 'workspace',
    },
};
export function getRuntimeDriver(agentType) {
    return RUNTIME_DRIVERS[agentType];
}
export function listRuntimeDrivers() {
    return Object.values(RUNTIME_DRIVERS);
}
