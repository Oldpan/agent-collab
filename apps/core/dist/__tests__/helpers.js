import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDb, migrate } from '@agent-collab/runtime-acp';
/** 创建临时内存 DB，已完成全部 migration */
export function createTestDb() {
    const dbPath = join(tmpdir(), `test-${randomUUID()}.db`);
    const db = openDb(dbPath);
    migrate(db);
    const convCols = db.prepare("PRAGMA table_info('conversations')").all();
    if (!convCols.some((col) => col.name === 'thread_kind')) {
        db.exec(`ALTER TABLE conversations ADD COLUMN thread_kind TEXT NOT NULL DEFAULT 'direct';`);
    }
    if (!convCols.some((col) => col.name === 'is_primary_thread')) {
        db.exec(`ALTER TABLE conversations ADD COLUMN is_primary_thread INTEGER NOT NULL DEFAULT 0;`);
    }
    if (!convCols.some((col) => col.name === 'thread_root_id')) {
        db.exec(`ALTER TABLE conversations ADD COLUMN thread_root_id TEXT;`);
    }
    db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_prompt_queue (
      queue_id         INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id         TEXT NOT NULL,
      conversation_id  TEXT NOT NULL,
      prompt_text      TEXT NOT NULL,
      record_as_user_message INTEGER NOT NULL DEFAULT 1,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
  `);
    const queueCols = db.prepare("PRAGMA table_info('conversation_prompt_queue')").all();
    if (!queueCols.some((col) => col.name === 'record_as_user_message')) {
        db.exec(`ALTER TABLE conversation_prompt_queue ADD COLUMN record_as_user_message INTEGER NOT NULL DEFAULT 1;`);
    }
    const channelMessageCols = db.prepare("PRAGMA table_info('channel_messages')").all();
    if (!channelMessageCols.some((col) => col.name === 'run_id')) {
        db.exec(`ALTER TABLE channel_messages ADD COLUMN run_id TEXT;`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_channel_messages_run ON channel_messages(run_id, created_at);`);
    }
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
