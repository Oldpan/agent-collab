import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { migrate } from '@agent-collab/runtime-acp';

describe('migrations', () => {
  it('应创建 conversations 表并包含 env_vars 列', () => {
    const db = createTestDb();
    const cols = db.prepare("PRAGMA table_info('conversations')").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);

    expect(colNames).toContain('id');
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

  it('schema_version 应为最新版本 8', () => {
    const db = createTestDb();
    const row = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(row.version).toBe(8);
    db.close();
  });

  it('v7 migration 对旧 DB 做 ALTER TABLE 不报错（幂等）', () => {
    const db = createTestDb();
    // 再次 migrate 不应报错
    expect(() => migrate(db)).not.toThrow();
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

    db.close();
  });
});
