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
      activation_context_text TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
  `);
    const queueCols = db.prepare("PRAGMA table_info('conversation_prompt_queue')").all();
    if (!queueCols.some((col) => col.name === 'record_as_user_message')) {
        db.exec(`ALTER TABLE conversation_prompt_queue ADD COLUMN record_as_user_message INTEGER NOT NULL DEFAULT 1;`);
    }
    if (!queueCols.some((col) => col.name === 'activation_context_text')) {
        db.exec(`ALTER TABLE conversation_prompt_queue ADD COLUMN activation_context_text TEXT;`);
    }
    const channelCols = db.prepare("PRAGMA table_info('channels')").all();
    if (!channelCols.some((col) => col.name === 'collaboration_mode')) {
        db.exec(`ALTER TABLE channels ADD COLUMN collaboration_mode TEXT NOT NULL DEFAULT 'mention_only';`);
    }
    const agentCols = db.prepare("PRAGMA table_info('agents')").all();
    if (!agentCols.some((col) => col.name === 'description')) {
        db.exec(`ALTER TABLE agents ADD COLUMN description TEXT;`);
    }
    if (!agentCols.some((col) => col.name === 'skill_roots')) {
        db.exec(`ALTER TABLE agents ADD COLUMN skill_roots TEXT;`);
    }
    db.exec(`
    CREATE TABLE IF NOT EXISTS target_participants (
      agent_id       TEXT NOT NULL,
      channel_id     TEXT NOT NULL,
      thread_root_id TEXT NOT NULL DEFAULT '',
      role           TEXT NOT NULL DEFAULT 'participant',
      joined_at      INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id, channel_id, thread_root_id)
    );
  `);
    db.exec(`
    CREATE TABLE IF NOT EXISTS thread_task_bindings (
      channel_id     TEXT NOT NULL,
      thread_root_id TEXT NOT NULL,
      task_id        TEXT NOT NULL UNIQUE,
      bound_at       INTEGER NOT NULL,
      PRIMARY KEY (channel_id, thread_root_id)
    );
  `);
    db.exec(`
    CREATE TABLE IF NOT EXISTS channel_subscriptions (
      channel_id      TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      subscribed_at   INTEGER NOT NULL,
      last_active_at  INTEGER NOT NULL,
      PRIMARY KEY (channel_id, agent_id)
    );
  `);
    db.exec(`
    CREATE TABLE IF NOT EXISTS agent_mention_cooldowns (
      channel_id        TEXT NOT NULL,
      thread_root_id    TEXT NOT NULL,
      from_agent_id     TEXT NOT NULL,
      to_agent_id       TEXT NOT NULL,
      last_notified_at  INTEGER NOT NULL,
      PRIMARY KEY (channel_id, thread_root_id, from_agent_id, to_agent_id)
    );
  `);
    const channelMessageCols = db.prepare("PRAGMA table_info('channel_messages')").all();
    if (!channelMessageCols.some((col) => col.name === 'run_id')) {
        db.exec(`ALTER TABLE channel_messages ADD COLUMN run_id TEXT;`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_channel_messages_run ON channel_messages(run_id, created_at);`);
    }
    if (!channelMessageCols.some((col) => col.name === 'message_kind')) {
        db.exec(`ALTER TABLE channel_messages ADD COLUMN message_kind TEXT;`);
    }
    if (!channelMessageCols.some((col) => col.name === 'message_source')) {
        db.exec(`ALTER TABLE channel_messages ADD COLUMN message_source TEXT;`);
    }
    db.exec(`UPDATE schema_version SET version = MAX(version, 39);`);
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
        humanUserName: 'oldpan',
        ...overrides,
    };
}
