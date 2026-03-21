import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDb, migrate } from '@agent-collab/runtime-acp';
/** 创建临时内存 DB，已完成全部 migration */
export function createTestDb() {
    const dbPath = join(tmpdir(), `test-${randomUUID()}.db`);
    const db = openDb(dbPath);
    migrate(db);
    return db;
}
/** 默认测试配置 */
export function createTestConfig(overrides) {
    return {
        webPort: 0, // 随机端口
        webHost: '127.0.0.1',
        acpAgentCommand: 'echo',
        acpAgentArgs: ['noop'],
        workspaceRoot: '/tmp',
        dbPath: ':memory:',
        runtimeIdleTtlSeconds: 900,
        maxBindingRuntimes: 30,
        uiDefaultMode: 'summary',
        uiJsonMaxChars: 12000,
        contextReplayEnabled: false,
        contextReplayRuns: 0,
        contextReplayMaxChars: 12000,
        ...overrides,
    };
}
