import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, createTestConfig } from './helpers.js';
import { ConversationManager } from '../web/conversationManager.js';
describe('ConversationManager', () => {
    let db;
    let manager;
    beforeEach(() => {
        db = createTestDb();
        manager = new ConversationManager({ db, config: createTestConfig() });
        manager.start();
    });
    afterEach(() => {
        manager.close();
        db.close();
    });
    // ─── CRUD ───
    describe('createConversation', () => {
        it('应创建会话并返回正确结构', () => {
            const conv = manager.createConversation({ title: 'Test' });
            expect(conv.id).toBeTruthy();
            expect(conv.channelId).toBe('default');
            expect(conv.title).toBe('Test');
            expect(conv.agentType).toBe('claude_acp'); // 默认
            expect(conv.status).toBe('idle');
            expect(conv.workspacePath).toBe('/tmp');
            expect(conv.createdAt).toBeGreaterThan(0);
            expect(conv.updatedAt).toBe(conv.createdAt);
        });
        it('应支持指定 agentType', () => {
            const conv = manager.createConversation({ agentType: 'codex_acp', title: 'Codex' });
            expect(conv.agentType).toBe('codex_acp');
            const row = db
                .prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?')
                .get(conv.id);
            const session = db
                .prepare('SELECT agent_command as agentCommand, agent_args_json as agentArgsJson FROM sessions WHERE session_key = ?')
                .get(row.sessionKey);
            expect(session.agentCommand).toBe('npx');
            expect(JSON.parse(session.agentArgsJson)).toEqual(['-y', '@zed-industries/codex-acp@latest']);
        });
        it('不传参数时使用默认值', () => {
            const conv = manager.createConversation({});
            expect(conv.agentType).toBe('claude_acp');
            expect(conv.title).toBe('');
        });
    });
    describe('listConversations', () => {
        it('空列表时返回空数组', () => {
            expect(manager.listConversations()).toEqual([]);
        });
        it('应返回所有会话，按 updatedAt 降序', () => {
            // 手动设置不同的 updatedAt 以确保排序
            const c1 = manager.createConversation({ title: 'First' });
            const c2 = manager.createConversation({ title: 'Second' });
            const c3 = manager.createConversation({ title: 'Third' });
            // 手动更新 updatedAt 确保顺序
            db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(1000, c1.id);
            db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(2000, c2.id);
            db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(3000, c3.id);
            const list = manager.listConversations();
            expect(list).toHaveLength(3);
            expect(list[0].title).toBe('Third');
            expect(list[1].title).toBe('Second');
            expect(list[2].title).toBe('First');
        });
    });
    describe('getConversation', () => {
        it('存在的 id 应返回会话', () => {
            const created = manager.createConversation({ title: 'Find me' });
            const found = manager.getConversation(created.id);
            expect(found).not.toBeNull();
            expect(found.id).toBe(created.id);
            expect(found.title).toBe('Find me');
        });
        it('不存在的 id 应返回 null', () => {
            expect(manager.getConversation('non-existent')).toBeNull();
        });
    });
    describe('deleteConversation', () => {
        it('应删除指定会话', () => {
            const conv = manager.createConversation({ title: 'To delete' });
            expect(manager.getConversation(conv.id)).not.toBeNull();
            manager.deleteConversation(conv.id);
            expect(manager.getConversation(conv.id)).toBeNull();
        });
        it('删除不存在的会话不应报错', () => {
            expect(() => manager.deleteConversation('non-existent')).not.toThrow();
        });
        it('删除后列表数量应减少', () => {
            const c1 = manager.createConversation({ title: 'A' });
            manager.createConversation({ title: 'B' });
            expect(manager.listConversations()).toHaveLength(2);
            manager.deleteConversation(c1.id);
            expect(manager.listConversations()).toHaveLength(1);
        });
    });
    // ─── channels ───
    describe('channels', () => {
        it('listChannels 应包含 default channel', () => {
            const channels = manager.listChannels();
            expect(channels.some((c) => c.channelId === 'default')).toBe(true);
        });
        it('createChannel 应创建新 channel', () => {
            const ch = manager.createChannel({ name: 'my-channel' });
            expect(ch.channelId).toBeTruthy();
            expect(ch.name).toBe('my-channel');
            expect(ch.workspacePath).toBeNull();
        });
        it('getChannel 应返回存在的 channel', () => {
            const ch = manager.createChannel({ name: 'find-me' });
            const found = manager.getChannel(ch.channelId);
            expect(found).not.toBeNull();
            expect(found.name).toBe('find-me');
        });
        it('getChannel 不存在时返回 null', () => {
            expect(manager.getChannel('non-existent')).toBeNull();
        });
        it('listConversations 可按 channelId 过滤', () => {
            const chanA = manager.createChannel({ name: 'chan-a' });
            const c1 = manager.createConversation({ title: 'In default', channelId: 'default' });
            const c2 = manager.createConversation({ title: 'In chan-a', channelId: chanA.channelId });
            const inDefault = manager.listConversations({ channelId: 'default' });
            const inChanA = manager.listConversations({ channelId: chanA.channelId });
            expect(inDefault.some((c) => c.id === c1.id)).toBe(true);
            expect(inDefault.some((c) => c.id === c2.id)).toBe(false);
            expect(inChanA.some((c) => c.id === c2.id)).toBe(true);
            expect(inChanA.some((c) => c.id === c1.id)).toBe(false);
        });
    });
    // ─── envVars ───
    describe('envVars', () => {
        it('创建时传入 envVars 应存入 DB', () => {
            const conv = manager.createConversation({
                title: 'With Env',
                envVars: { ANTHROPIC_API_KEY: 'sk-test', MY_VAR: 'hello' },
            });
            const row = db
                .prepare('SELECT env_vars FROM conversations WHERE id = ?')
                .get(conv.id);
            expect(row.env_vars).not.toBeNull();
            const parsed = JSON.parse(row.env_vars);
            expect(parsed).toEqual({ ANTHROPIC_API_KEY: 'sk-test', MY_VAR: 'hello' });
        });
        it('不传 envVars 时 DB 中为 null', () => {
            const conv = manager.createConversation({ title: 'No Env' });
            const row = db
                .prepare('SELECT env_vars FROM conversations WHERE id = ?')
                .get(conv.id);
            expect(row.env_vars).toBeNull();
        });
        it('传空对象时 DB 中为 null', () => {
            const conv = manager.createConversation({ title: 'Empty Env', envVars: {} });
            const row = db
                .prepare('SELECT env_vars FROM conversations WHERE id = ?')
                .get(conv.id);
            expect(row.env_vars).toBeNull();
        });
    });
});
