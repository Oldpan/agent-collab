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

  it('schema_version 应为最新版本 22', () => {
    const db = createTestDb();
    const row = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(row.version).toBe(22);
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
    db.close();
  });

  it('agents 表应包含 disabled_tool_kinds 列', () => {
    const db = createTestDb();
    const agentCols = db.prepare("PRAGMA table_info('agents')").all() as Array<{ name: string }>;
    expect(agentCols.map((c) => c.name)).toContain('disabled_tool_kinds');
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
});
