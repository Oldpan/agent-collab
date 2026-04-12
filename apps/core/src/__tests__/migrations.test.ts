import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildThreadShortId } from '@agent-collab/protocol';
import { openDb, migrate } from '@agent-collab/runtime-acp';
import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';

describe('migrations', () => {
  it('应创建 conversations 表并包含 channel_id 列', () => {
    const db = createTestDb();
    const cols = db.prepare("PRAGMA table_info('conversations')").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);

    expect(colNames).toContain('id');
    expect(colNames).toContain('channel_id');
    expect(colNames).toContain('title');
    expect(colNames).toContain('agent_type');
    expect(colNames).toContain('workspace_path');
    expect(colNames).toContain('session_key');
    expect(colNames).toContain('status');
    expect(colNames).toContain('env_vars');
    expect(colNames).toContain('created_at');
    expect(colNames).toContain('updated_at');

    db.close();
  });

  it('schema_version 应为最新版本', () => {
    const db = createTestDb();
    const row = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(row.version).toBeGreaterThanOrEqual(54);
    db.close();
  });

  it('users/invite_tokens/user_sessions 认证表应存在', () => {
    const db = createTestDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('users');
    expect(tableNames).toContain('invite_tokens');
    expect(tableNames).toContain('user_sessions');
    expect(tableNames).toContain('user_agent_access');
    expect(tableNames).toContain('user_channel_access');
    db.close();
  });

  it('nodes 表应包含 display_name, env_var_keys, provisioned_at 列', () => {
    const db = createTestDb();
    const cols = db.prepare("PRAGMA table_info('nodes')").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('display_name');
    expect(colNames).toContain('env_var_keys');
    expect(colNames).toContain('provisioned_at');
    db.close();
  });

  it('channels 表应存在且包含 default 记录', () => {
    const db = createTestDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain('channels');

    const row = db
      .prepare('SELECT channel_id, name FROM channels WHERE channel_id = ?')
      .get('default') as { channel_id: string; name: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe('default');

    db.close();
  });

  it('conversations 表应包含 thread 元数据与 prompt queue 表', () => {
    const db = createTestDb();
    const convCols = db.prepare("PRAGMA table_info('conversations')").all() as Array<{ name: string }>;
    const convColNames = convCols.map((c) => c.name);
    expect(convColNames).toContain('thread_kind');
    expect(convColNames).toContain('is_primary_thread');

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain('conversation_prompt_queue');

    const queueCols = db.prepare("PRAGMA table_info('conversation_prompt_queue')").all() as Array<{ name: string }>;
    expect(queueCols.map((c) => c.name)).toContain('record_as_user_message');
    expect(queueCols.map((c) => c.name)).toContain('activation_context_text');
    expect(queueCols.map((c) => c.name)).toContain('replay_overlap_recent_messages_json');
    db.close();
  });

  it('agents 表应包含 description、disabled_tool_kinds、skill_roots 列', () => {
    const db = createTestDb();
    const agentCols = db.prepare("PRAGMA table_info('agents')").all() as Array<{ name: string }>;
    expect(agentCols.map((c) => c.name)).toContain('description');
    expect(agentCols.map((c) => c.name)).toContain('disabled_tool_kinds');
    expect(agentCols.map((c) => c.name)).toContain('skill_roots');
    db.close();
  });

  it('agent_channel_memberships 表应存在且 channels 含 description 列', () => {
    const db = createTestDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain('agent_channel_memberships');

    const channelCols = db.prepare("PRAGMA table_info('channels')").all() as Array<{ name: string }>;
    expect(channelCols.map((c) => c.name)).toContain('description');
    expect(channelCols.map((c) => c.name)).toContain('collaboration_mode');
    db.close();
  });

  it('target_participants 表应存在', () => {
    const db = createTestDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain('target_participants');
    expect(tables.map((t) => t.name)).toContain('thread_task_bindings');
    expect(tables.map((t) => t.name)).toContain('channel_task_sequences');
    expect(tables.map((t) => t.name)).toContain('channel_subscriptions');
    expect(tables.map((t) => t.name)).toContain('agent_mention_cooldowns');
    db.close();
  });

  it('sessions/bindings/runs/events 等表应存在', () => {
    const db = createTestDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('sessions');
    expect(tableNames).toContain('bindings');
    expect(tableNames).toContain('runs');
    expect(tableNames).toContain('events');
    expect(tableNames).toContain('conversations');
    expect(tableNames).toContain('tool_policies');
    expect(tableNames).toContain('nodes');
    expect(tableNames).toContain('channels');
    expect(tableNames).toContain('agents');
    expect(tableNames).toContain('node_dispatch_queue');
    expect(tableNames).toContain('conversation_prompt_queue');
    expect(tableNames).toContain('channel_messages');
    expect(tableNames).toContain('tasks');
    expect(tableNames).toContain('agent_message_checkpoints');

    db.close();
  });

  it('agent_message_checkpoints 表应包含 thread_root_id 列', () => {
    const db = createTestDb();
    const cols = db.prepare("PRAGMA table_info('agent_message_checkpoints')").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('thread_root_id');
    db.close();
  });

  it('channel_messages 表应包含 message_source 列', () => {
    const db = createTestDb();
    const cols = db.prepare("PRAGMA table_info('channel_messages')").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('message_source');
    db.close();
  });

  it('channel_messages_fts 应存在并与消息内容同步', () => {
    const db = createTestDb();
    const virtualTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'channel_messages_fts'")
      .all() as Array<{ name: string }>;
    expect(virtualTables.map((t) => t.name)).toContain('channel_messages_fts');

    db.prepare(
      `INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('fts-msg-1', 'default', 'user', 'User', 'user', '#default', 'searchable initial content', 1, Date.now());

    let rows = db
      .prepare(`SELECT message_id as messageId FROM channel_messages_fts WHERE channel_messages_fts MATCH ?`)
      .all('"searchable"') as Array<{ messageId: string }>;
    expect(rows.map((row) => row.messageId)).toContain('fts-msg-1');

    db.prepare(`UPDATE channel_messages SET content = ? WHERE message_id = ?`).run('updated indexed phrase', 'fts-msg-1');
    rows = db
      .prepare(`SELECT message_id as messageId FROM channel_messages_fts WHERE channel_messages_fts MATCH ?`)
      .all('"updated"') as Array<{ messageId: string }>;
    expect(rows.map((row) => row.messageId)).toContain('fts-msg-1');

    db.prepare(`DELETE FROM channel_messages WHERE message_id = ?`).run('fts-msg-1');
    rows = db
      .prepare(`SELECT message_id as messageId FROM channel_messages_fts WHERE channel_messages_fts MATCH ?`)
      .all('"updated"') as Array<{ messageId: string }>;
    expect(rows).toHaveLength(0);
    db.close();
  });

  it('v53 migration 应回填旧 channel_messages 到 FTS 索引', () => {
    const dbPath = join(tmpdir(), `migration-v53-${randomUUID()}.db`);
    const db = openDb(dbPath);

    db.exec(`
      CREATE TABLE schema_version(version INTEGER NOT NULL);
      INSERT INTO schema_version(version) VALUES(52);

      CREATE TABLE channel_messages (
        message_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        sender_type TEXT NOT NULL,
        target TEXT NOT NULL,
        content TEXT NOT NULL,
        seq INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        run_id TEXT,
        thread_root_id TEXT,
        message_kind TEXT,
        message_source TEXT,
        attachment_ids TEXT
      );

      INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id)
      VALUES
        ('legacy-root', 'default', 'user', 'User', 'user', '#default', 'legacy root searchable text', 1, 1000, NULL),
        ('legacy-thread', 'default', 'user', 'User', 'user', '#default:legac123', 'legacy thread searchable text', 2, 1001, 'legac123');
    `);

    migrate(db);

    const rows = db
      .prepare(`SELECT message_id as messageId FROM channel_messages_fts WHERE channel_messages_fts MATCH ? ORDER BY message_id`)
      .all('"legacy"') as Array<{ messageId: string }>;
    expect(rows.map((row) => row.messageId)).toEqual(['legacy-root', 'legacy-thread']);

    const versionRow = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(versionRow.version).toBe(54);
    db.close();
  });

  it('schema_version 已是 53 但 FTS 缺失时，应自愈重建 channel_messages_fts', () => {
    const dbPath = join(tmpdir(), `migration-v53-repair-${randomUUID()}.db`);
    const db = openDb(dbPath);

    db.exec(`
      CREATE TABLE schema_version(version INTEGER NOT NULL);
      INSERT INTO schema_version(version) VALUES(53);

      CREATE TABLE channel_messages (
        message_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        sender_type TEXT NOT NULL,
        target TEXT NOT NULL,
        content TEXT NOT NULL,
        seq INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        run_id TEXT,
        thread_root_id TEXT,
        message_kind TEXT,
        message_source TEXT,
        attachment_ids TEXT
      );

      INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id)
      VALUES
        ('repair-root', 'default', 'user', 'User', 'user', '#default', 'repair root searchable text', 1, 1000, NULL),
        ('repair-thread', 'default', 'user', 'User', 'user', '#default:repai123', 'repair thread searchable text', 2, 1001, 'repai123');
    `);

    migrate(db);

    const rows = db
      .prepare(`SELECT message_id as messageId FROM channel_messages_fts WHERE channel_messages_fts MATCH ? ORDER BY message_id`)
      .all('"repair"') as Array<{ messageId: string }>;
    expect(rows.map((row) => row.messageId)).toEqual(['repair-root', 'repair-thread']);

    const artifactRows = db
      .prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'channel_messages_fts%' ORDER BY name`)
      .all() as Array<{ name: string }>;
    expect(artifactRows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'channel_messages_fts',
        'channel_messages_fts_after_delete',
        'channel_messages_fts_after_insert',
        'channel_messages_fts_after_update',
      ]),
    );

    const versionRow = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(versionRow.version).toBe(54);
    db.close();
  });

  it('dm_thread_context_snapshots 表应存在并以 channel_id + thread_root_id 为主键', () => {
    const db = createTestDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain('dm_thread_context_snapshots');

    const pkRows = db.prepare(`PRAGMA table_info('dm_thread_context_snapshots')`).all() as Array<{ name: string; pk: number }>;
    const pkCols = pkRows.filter((row) => row.pk > 0).map((row) => row.name);
    expect(pkCols).toEqual(['channel_id', 'thread_root_id']);
    expect(pkRows.map((row) => row.name)).toContain('trigger_message_id');
    expect(pkRows.map((row) => row.name)).toContain('snapshot_json');
    db.close();
  });

  it('tasks 表应包含 message_id 与 thread_unbound 列', () => {
    const db = createTestDb();
    const cols = db.prepare("PRAGMA table_info('tasks')").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('message_id');
    expect(cols.map((c) => c.name)).toContain('thread_unbound');
    db.close();
  });

  it('v51 migration 应 canonicalize task-root owners 到 16-char thread id，并只 demote 明确的 non-root owner', () => {
    const dbPath = join(tmpdir(), `migration-v51-${randomUUID()}.db`);
    const db = openDb(dbPath);
    const now = Date.now();
    const task1ThreadRootId = buildThreadShortId('feedbeef-0000-0000-0000-000000000000');
    const task2ThreadRootId = buildThreadShortId('ambig001-0000-0000-0000-000000000000');

    db.exec(`
      CREATE TABLE schema_version(version INTEGER NOT NULL);
      INSERT INTO schema_version(version) VALUES(50);

      CREATE TABLE channels (
        channel_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO channels(channel_id, name, created_at, updated_at) VALUES('default', 'default', ${now}, ${now});

      CREATE TABLE agents (
        agent_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        channel_id TEXT
      );
      INSERT INTO agents(agent_id, name, agent_type, created_at, updated_at, channel_id)
      VALUES('agent-1', 'OwnerBob', 'claude_acp', ${now}, ${now}, 'default');

      CREATE TABLE channel_messages (
        message_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        sender_id TEXT,
        sender_name TEXT,
        sender_type TEXT,
        target TEXT,
        content TEXT,
        seq INTEGER,
        created_at INTEGER
      );

      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        task_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        claimed_by_agent_id TEXT,
        claimed_by_name TEXT,
        created_by_agent_id TEXT,
        created_by_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        message_id TEXT,
        thread_unbound INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE thread_task_bindings (
        channel_id TEXT NOT NULL,
        thread_root_id TEXT NOT NULL,
        task_id TEXT NOT NULL UNIQUE,
        bound_at INTEGER NOT NULL,
        PRIMARY KEY (channel_id, thread_root_id)
      );

      CREATE TABLE target_participants (
        agent_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_root_id TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'participant',
        joined_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, channel_id, thread_root_id)
      );

      -- task-1 root is 'feedbeef', task-2 root is 'ambig001' (both 8-char prefixes)
      INSERT INTO tasks(task_id, channel_id, task_number, title, status, message_id, thread_unbound, created_at, updated_at)
      VALUES
        ('task-1', 'default', 1, 'Task 1', 'todo', 'feedbeef-0000-0000-0000-000000000000', 1, ${now}, ${now}),
        ('task-2', 'default', 2, 'Task 2', 'todo', 'ambig001-0000-0000-0000-000000000000', 0, ${now}, ${now});

      -- wrongthr: task-1 explicitly bound here but root is 'feedbeef' → should demote owner
      -- ambig001: task-2 bound here and root IS 'ambig001' → ambiguous, keep owner
      INSERT INTO thread_task_bindings(channel_id, thread_root_id, task_id, bound_at)
      VALUES
        ('default', 'wrongthr', 'task-1', ${now}),
        ('default', 'ambig001', 'task-2', ${now});

      INSERT INTO target_participants(agent_id, channel_id, thread_root_id, role, joined_at, last_active_at)
      VALUES
        ('agent-1', 'default', 'wrongthr', 'owner', ${now}, ${now}),
        ('agent-1', 'default', 'ambig001', 'owner', ${now}, ${now}),
        ('agent-1', 'default', 'feedbeef', 'owner', ${now}, ${now});
    `);

    migrate(db);

    const demotedLegacyOwner = db.prepare(
      `SELECT role FROM target_participants WHERE agent_id = 'agent-1' AND channel_id = 'default' AND thread_root_id = 'wrongthr'`,
    ).get() as { role: string } | undefined;
    const canonicalizedAmbiguousOwner = db.prepare(
      `SELECT role FROM target_participants WHERE agent_id = 'agent-1' AND channel_id = 'default' AND thread_root_id = ?`,
    ).get(task2ThreadRootId) as { role: string } | undefined;
    const rootOwner = db.prepare(
      `SELECT role FROM target_participants WHERE agent_id = 'agent-1' AND channel_id = 'default' AND thread_root_id = ?`,
    ).get(task1ThreadRootId) as { role: string } | undefined;
    const staleAmbiguousOwner = db.prepare(
      `SELECT role FROM target_participants WHERE agent_id = 'agent-1' AND channel_id = 'default' AND thread_root_id = 'ambig001'`,
    ).get() as { role: string } | undefined;
    const bindingCount = db.prepare(`SELECT count(*) as count FROM thread_task_bindings`).get() as { count: number };
    const taskFlags = db.prepare(`SELECT thread_unbound as threadUnbound FROM tasks WHERE task_id = 'task-1'`).get() as { threadUnbound: number };

    expect(demotedLegacyOwner?.role).toBe('participant');
    expect(canonicalizedAmbiguousOwner?.role).toBe('owner');
    expect(rootOwner?.role).toBe('owner');
    expect(staleAmbiguousOwner).toBeUndefined();
    expect(bindingCount.count).toBe(0);
    expect(taskFlags.threadUnbound).toBe(0);

    db.close();
  });

  it('v52 migration 应为 conversation_prompt_queue 增加 replay overlap 列', () => {
    const dbPath = join(tmpdir(), `migration-v52-${randomUUID()}.db`);
    const db = openDb(dbPath);

    db.exec(`
      CREATE TABLE schema_version(version INTEGER NOT NULL);
      INSERT INTO schema_version(version) VALUES(51);

      CREATE TABLE conversation_prompt_queue (
        queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        prompt_text TEXT NOT NULL,
        record_as_user_message INTEGER NOT NULL DEFAULT 1,
        activation_context_text TEXT,
        sender_name TEXT,
        client_message_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    migrate(db);

    const queueCols = db.prepare("PRAGMA table_info('conversation_prompt_queue')").all() as Array<{ name: string }>;
    expect(queueCols.map((c) => c.name)).toContain('replay_overlap_recent_messages_json');

    const row = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(row.version).toBe(52);
    db.close();
  });
});
