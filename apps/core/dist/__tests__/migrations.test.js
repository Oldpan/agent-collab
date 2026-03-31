import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
describe('migrations', () => {
    it('应创建 conversations 表并包含 channel_id 列', () => {
        const db = createTestDb();
        const cols = db.prepare("PRAGMA table_info('conversations')").all();
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
    it('schema_version 应为最新版本 40', () => {
        const db = createTestDb();
        const row = db.prepare('SELECT version FROM schema_version').get();
        expect(row.version).toBeGreaterThanOrEqual(40);
        db.close();
    });
    it('users/invite_tokens/user_sessions 认证表应存在', () => {
        const db = createTestDb();
        const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all();
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
        const cols = db.prepare("PRAGMA table_info('nodes')").all();
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
            .all();
        expect(tables.map((t) => t.name)).toContain('channels');
        const row = db
            .prepare('SELECT channel_id, name FROM channels WHERE channel_id = ?')
            .get('default');
        expect(row).toBeDefined();
        expect(row.name).toBe('default');
        db.close();
    });
    it('conversations 表应包含 thread 元数据与 prompt queue 表', () => {
        const db = createTestDb();
        const convCols = db.prepare("PRAGMA table_info('conversations')").all();
        const convColNames = convCols.map((c) => c.name);
        expect(convColNames).toContain('thread_kind');
        expect(convColNames).toContain('is_primary_thread');
        const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all();
        expect(tables.map((t) => t.name)).toContain('conversation_prompt_queue');
        const queueCols = db.prepare("PRAGMA table_info('conversation_prompt_queue')").all();
        expect(queueCols.map((c) => c.name)).toContain('record_as_user_message');
        expect(queueCols.map((c) => c.name)).toContain('activation_context_text');
        db.close();
    });
    it('agents 表应包含 description、disabled_tool_kinds、skill_roots 列', () => {
        const db = createTestDb();
        const agentCols = db.prepare("PRAGMA table_info('agents')").all();
        expect(agentCols.map((c) => c.name)).toContain('description');
        expect(agentCols.map((c) => c.name)).toContain('disabled_tool_kinds');
        expect(agentCols.map((c) => c.name)).toContain('skill_roots');
        db.close();
    });
    it('agent_channel_memberships 表应存在且 channels 含 description 列', () => {
        const db = createTestDb();
        const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all();
        expect(tables.map((t) => t.name)).toContain('agent_channel_memberships');
        const channelCols = db.prepare("PRAGMA table_info('channels')").all();
        expect(channelCols.map((c) => c.name)).toContain('description');
        expect(channelCols.map((c) => c.name)).toContain('collaboration_mode');
        db.close();
    });
    it('target_participants 表应存在', () => {
        const db = createTestDb();
        const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all();
        expect(tables.map((t) => t.name)).toContain('target_participants');
        expect(tables.map((t) => t.name)).toContain('thread_task_bindings');
        expect(tables.map((t) => t.name)).toContain('channel_subscriptions');
        expect(tables.map((t) => t.name)).toContain('agent_mention_cooldowns');
        db.close();
    });
    it('sessions/bindings/runs/events 等表应存在', () => {
        const db = createTestDb();
        const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all();
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
        const cols = db.prepare("PRAGMA table_info('agent_message_checkpoints')").all();
        expect(cols.map((c) => c.name)).toContain('thread_root_id');
        db.close();
    });
    it('channel_messages 表应包含 message_source 列', () => {
        const db = createTestDb();
        const cols = db.prepare("PRAGMA table_info('channel_messages')").all();
        expect(cols.map((c) => c.name)).toContain('message_source');
        db.close();
    });
});
