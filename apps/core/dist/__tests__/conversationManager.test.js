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
            expect(conv.replyTarget).toBe('dm:@oldpan:'.concat(conv.id.slice(0, 8)));
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
            expect(session.agentCommand).toBe('codex-acp');
            expect(JSON.parse(session.agentArgsJson)).toEqual([]);
        });
        it('不传参数时使用默认值', () => {
            const conv = manager.createConversation({});
            expect(conv.agentType).toBe('claude_acp');
            expect(conv.title).toBe('');
            expect(conv.replyTarget).toBe(`dm:@oldpan:${conv.id.slice(0, 8)}`);
        });
        it('agent 主私聊 thread 应绑定到稳定的 DM reply target', () => {
            const agent = manager.createAgent({
                name: 'Target Bob',
                agentType: 'claude_acp',
                nodeId: 'node-1',
                workspacePath: '/tmp/target-bob',
            });
            const conv = manager.openAgentThread(agent.agentId);
            expect(conv?.replyTarget).toBe('dm:@oldpan');
        });
        it('channel branch thread 应绑定到稳定的 channel/thread reply target', () => {
            const agent = manager.createAgent({
                name: 'Channel Bob',
                agentType: 'claude_acp',
                nodeId: 'node-1',
                workspacePath: '/tmp/channel-target-bob',
            });
            const channelConv = manager.openAgentChannelThread(agent.agentId, 'default', null);
            const threadConv = manager.openAgentChannelThread(agent.agentId, 'default', 'abcd1234');
            expect(channelConv?.replyTarget).toBe('#default');
            expect(threadConv?.replyTarget).toBe('#default:abcd1234');
        });
    });
    describe('channels', () => {
        it('createChannel 应保存 collaborationMode，并默认 mention_only', () => {
            const defaultChannel = manager.createChannel({ name: 'ops-default' });
            const subscribedChannel = manager.createChannel({
                name: 'ops-subscribed',
                collaborationMode: 'subscribed_agents',
            });
            expect(defaultChannel.collaborationMode).toBe('mention_only');
            expect(subscribedChannel.collaborationMode).toBe('subscribed_agents');
            expect(manager.getChannel(subscribedChannel.channelId)?.collaborationMode).toBe('subscribed_agents');
        });
        it('updateChannel 应支持更新 collaborationMode', () => {
            const channel = manager.createChannel({ name: 'ops-update' });
            const updated = manager.updateChannel(channel.channelId, {
                collaborationMode: 'subscribed_agents',
            });
            expect(updated?.collaborationMode).toBe('subscribed_agents');
            expect(manager.getChannel(channel.channelId)?.collaborationMode).toBe('subscribed_agents');
        });
        it('joinChannel/leaveChannel 应同步维护 subscribedAgents', () => {
            const channel = manager.createChannel({ name: 'ops-subscribers' });
            const agent = manager.createAgent({
                name: 'SubBob',
                agentType: 'claude_acp',
                nodeId: 'node-1',
                workspacePath: '/tmp/sub-bob',
            });
            manager.joinChannel(agent.agentId, channel.channelId);
            expect(manager.getChannel(channel.channelId)?.subscribedAgents).toEqual([
                { agentId: agent.agentId, name: 'SubBob' },
            ]);
            manager.leaveChannel(agent.agentId, channel.channelId);
            expect(manager.getChannel(channel.channelId)?.subscribedAgents).toEqual([]);
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
    describe('resetAgent', () => {
        it('应重置 agent workspace 相关会话历史并换新 session_key', () => {
            const agent = manager.createAgent({
                name: 'Resettable',
                agentType: 'claude_acp',
                nodeId: 'node-1',
                workspacePath: '/tmp/resettable-agent',
            });
            const conv = manager.openAgentThread(agent.agentId);
            expect(conv).not.toBeNull();
            if (!conv)
                throw new Error('missing conversation');
            const before = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?').get(conv.id);
            db.prepare('INSERT INTO runs(run_id, session_key, prompt_text, started_at) VALUES(?, ?, ?, ?)').run('run-reset-1', before.sessionKey, 'remember this', Date.now());
            db.prepare('INSERT INTO events(run_id, seq, method, payload_json, created_at) VALUES(?, ?, ?, ?, ?)').run('run-reset-1', 1, 'node/event', JSON.stringify({ type: 'content.delta', text: 'hi' }), Date.now());
            db.prepare('INSERT INTO conversation_prompt_queue(agent_id, conversation_id, prompt_text, created_at, updated_at) VALUES(?, ?, ?, ?, ?)').run(agent.agentId, conv.id, 'queued prompt', Date.now(), Date.now());
            const resetConversations = manager.resetAgent(agent.agentId);
            const resetConv = resetConversations.find((item) => item.id === conv.id);
            expect(resetConv).toBeTruthy();
            expect(resetConv?.status).toBe('idle');
            const after = db.prepare('SELECT session_key as sessionKey, status, title FROM conversations WHERE id = ?').get(conv.id);
            expect(after.sessionKey).not.toBe(before.sessionKey);
            expect(after.status).toBe('idle');
            expect(after.title).toBe('');
            const oldRuns = db.prepare('SELECT count(*) as count FROM runs WHERE session_key = ?').get(before.sessionKey);
            const oldEvents = db.prepare('SELECT count(*) as count FROM events WHERE run_id = ?').get('run-reset-1');
            const queueRows = db.prepare('SELECT count(*) as count FROM conversation_prompt_queue WHERE agent_id = ?').get(agent.agentId);
            const newSession = db.prepare('SELECT count(*) as count FROM sessions WHERE session_key = ?').get(after.sessionKey);
            expect(oldRuns.count).toBe(0);
            expect(oldEvents.count).toBe(0);
            expect(queueRows.count).toBe(0);
            expect(newSession.count).toBe(1);
        });
    });
    describe('clearChannelChat', () => {
        it('应清空 channel 消息与 checkpoints，并仅重置该 channel 的 branch 会话历史', () => {
            const agent = manager.createAgent({
                name: 'ChannelBob',
                agentType: 'claude_acp',
                nodeId: 'node-1',
                workspacePath: '/tmp/channel-bob',
            });
            manager.joinChannel(agent.agentId, 'default');
            const opsChannel = manager.createChannel({ name: 'ops-room' });
            manager.joinChannel(agent.agentId, opsChannel.channelId);
            const direct = manager.openAgentThread(agent.agentId);
            const defaultBranch = manager.openAgentChannelThread(agent.agentId, 'default', null);
            const opsBranch = manager.openAgentChannelThread(agent.agentId, opsChannel.channelId, null);
            expect(direct).not.toBeNull();
            expect(defaultBranch).not.toBeNull();
            expect(opsBranch).not.toBeNull();
            if (!direct || !defaultBranch || !opsBranch)
                throw new Error('missing conversations');
            const directSession = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?').get(direct.id);
            const defaultSession = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?').get(defaultBranch.id);
            const opsSession = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?').get(opsBranch.id);
            db.prepare(`INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id)
         VALUES(?, 'default', 'user', 'User', 'user', '#default', 'hello', 1, ?, NULL)`).run('msg-default-1', Date.now());
            db.prepare(`INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id)
         VALUES(?, 'default', 'user', 'User', 'user', '#default:abc12345', 'thread hello', 2, ?, 'abc12345')`).run('msg-default-2', Date.now());
            db.prepare(`INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id)
         VALUES(?, ?, 'user', 'User', 'user', ?, 'dm hello', 1, ?, NULL)`).run('msg-dm-1', `dm:${agent.agentId}`, 'dm:@User', Date.now());
            db.prepare(`INSERT INTO channel_messages(message_id, channel_id, sender_id, sender_name, sender_type, target, content, seq, created_at, thread_root_id)
         VALUES(?, ?, 'user', 'User', 'user', ?, 'keep me', 1, ?, NULL)`).run('msg-ops-1', opsChannel.channelId, `#${opsChannel.name}`, Date.now());
            db.prepare(`INSERT INTO agent_message_checkpoints(agent_id, channel_id, thread_root_id, last_seq) VALUES(?, 'default', '', 2)`).run(agent.agentId);
            db.prepare(`INSERT INTO agent_message_checkpoints(agent_id, channel_id, thread_root_id, last_seq) VALUES(?, ?, '', 1)`).run(agent.agentId, `dm:${agent.agentId}`);
            db.prepare(`INSERT INTO agent_message_checkpoints(agent_id, channel_id, thread_root_id, last_seq) VALUES(?, ?, '', 1)`).run(agent.agentId, opsChannel.channelId);
            db.prepare('INSERT INTO runs(run_id, session_key, prompt_text, started_at) VALUES(?, ?, ?, ?)').run('run-default-1', defaultSession.sessionKey, 'default run', Date.now());
            db.prepare('INSERT INTO events(run_id, seq, method, payload_json, created_at) VALUES(?, ?, ?, ?, ?)').run('run-default-1', 1, 'node/event', JSON.stringify({ type: 'content.delta', text: 'default output' }), Date.now());
            db.prepare('INSERT INTO conversation_prompt_queue(agent_id, conversation_id, prompt_text, created_at, updated_at) VALUES(?, ?, ?, ?, ?)').run(agent.agentId, defaultBranch.id, 'queued default', Date.now(), Date.now());
            db.prepare('INSERT INTO runs(run_id, session_key, prompt_text, started_at) VALUES(?, ?, ?, ?)').run('run-direct-1', directSession.sessionKey, 'direct run', Date.now());
            db.prepare('INSERT INTO runs(run_id, session_key, prompt_text, started_at) VALUES(?, ?, ?, ?)').run('run-ops-1', opsSession.sessionKey, 'ops run', Date.now());
            const result = manager.clearChannelChat('default');
            const resetConv = result.find((item) => item.id === defaultBranch.id);
            expect(resetConv).toBeTruthy();
            expect(resetConv?.status).toBe('idle');
            const defaultMessages = db.prepare(`SELECT count(*) as count FROM channel_messages WHERE channel_id = 'default'`).get();
            const dmMessages = db.prepare(`SELECT count(*) as count FROM channel_messages WHERE channel_id = ?`).get(`dm:${agent.agentId}`);
            const opsMessages = db.prepare(`SELECT count(*) as count FROM channel_messages WHERE channel_id = ?`).get(opsChannel.channelId);
            expect(defaultMessages.count).toBe(0);
            expect(dmMessages.count).toBe(1);
            expect(opsMessages.count).toBe(1);
            const defaultCheckpoint = db.prepare(`SELECT count(*) as count FROM agent_message_checkpoints WHERE channel_id = 'default'`).get();
            const dmCheckpoint = db.prepare(`SELECT count(*) as count FROM agent_message_checkpoints WHERE channel_id = ?`).get(`dm:${agent.agentId}`);
            const opsCheckpoint = db.prepare(`SELECT count(*) as count FROM agent_message_checkpoints WHERE channel_id = ?`).get(opsChannel.channelId);
            expect(defaultCheckpoint.count).toBe(0);
            expect(dmCheckpoint.count).toBe(1);
            expect(opsCheckpoint.count).toBe(1);
            const branchAfter = db.prepare('SELECT session_key as sessionKey, status, title FROM conversations WHERE id = ?').get(defaultBranch.id);
            expect(branchAfter.sessionKey).not.toBe(defaultSession.sessionKey);
            expect(branchAfter.status).toBe('idle');
            expect(branchAfter.title).toBe('');
            const oldDefaultRuns = db.prepare('SELECT count(*) as count FROM runs WHERE session_key = ?').get(defaultSession.sessionKey);
            const oldDefaultEvents = db.prepare('SELECT count(*) as count FROM events WHERE run_id = ?').get('run-default-1');
            const defaultQueue = db.prepare('SELECT count(*) as count FROM conversation_prompt_queue WHERE conversation_id = ?').get(defaultBranch.id);
            const directRuns = db.prepare('SELECT count(*) as count FROM runs WHERE session_key = ?').get(directSession.sessionKey);
            const opsRuns = db.prepare('SELECT count(*) as count FROM runs WHERE session_key = ?').get(opsSession.sessionKey);
            expect(oldDefaultRuns.count).toBe(0);
            expect(oldDefaultEvents.count).toBe(0);
            expect(defaultQueue.count).toBe(0);
            expect(directRuns.count).toBe(1);
            expect(opsRuns.count).toBe(1);
        });
    });
    describe('deleteMachine', () => {
        it('应级联删除机器下的 agents、会话和运行数据', () => {
            db.prepare(`INSERT INTO nodes(node_id, hostname, agent_types_json, version, status, last_seen, created_at, display_name, env_var_keys, provisioned_at)
         VALUES(?, ?, '[]', '', 'offline', 0, ?, NULL, '[]', 0)`).run('node-old', 'oldpan-ai', Date.now());
            const agent = manager.createAgent({
                name: 'Tabb',
                agentType: 'claude_acp',
                nodeId: 'node-old',
                workspacePath: '/tmp/tabb',
            });
            const conv = manager.openAgentThread(agent.agentId);
            expect(conv).not.toBeNull();
            if (!conv)
                throw new Error('missing conversation');
            const sessionRow = db.prepare('SELECT session_key as sessionKey FROM conversations WHERE id = ?').get(conv.id);
            db.prepare('INSERT INTO runs(run_id, session_key, prompt_text, started_at) VALUES(?, ?, ?, ?)').run('run-delete-machine', sessionRow.sessionKey, 'hello', Date.now());
            db.prepare('INSERT INTO events(run_id, seq, method, payload_json, created_at) VALUES(?, ?, ?, ?, ?)').run('run-delete-machine', 1, 'node/event', JSON.stringify({ type: 'content.delta', text: 'hi' }), Date.now());
            manager.deleteMachine('node-old');
            const nodeRow = db.prepare('SELECT status FROM nodes WHERE node_id = ?').get('node-old');
            const agentRow = db.prepare('SELECT agent_id as agentId FROM agents WHERE agent_id = ?').get(agent.agentId);
            const conversationCount = db.prepare('SELECT count(*) as count FROM conversations WHERE agent_id = ?').get(agent.agentId);
            const runCount = db.prepare('SELECT count(*) as count FROM runs WHERE run_id = ?').get('run-delete-machine');
            const eventCount = db.prepare('SELECT count(*) as count FROM events WHERE run_id = ?').get('run-delete-machine');
            expect(nodeRow?.status).toBe('deleted');
            expect(agentRow).toBeUndefined();
            expect(conversationCount.count).toBe(0);
            expect(runCount.count).toBe(0);
            expect(eventCount.count).toBe(0);
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
        it('agent 可加入并离开任意 channel，listAgents 仅按 memberships 过滤', () => {
            const chanA = manager.createChannel({ name: 'chan-members-a' });
            const chanB = manager.createChannel({ name: 'chan-members-b' });
            const agent = manager.createAgent({
                name: 'MultiChannel',
                channelId: chanA.channelId,
            });
            expect(manager.getAgent(agent.agentId)?.channelIds).toEqual([chanA.channelId]);
            expect(manager.listAgents(chanA.channelId).map((item) => item.agentId)).toContain(agent.agentId);
            manager.joinChannel(agent.agentId, chanB.channelId);
            expect(manager.getAgent(agent.agentId)?.channelIds.sort()).toEqual([chanA.channelId, chanB.channelId].sort());
            expect(manager.listAgents(chanB.channelId).map((item) => item.agentId)).toContain(agent.agentId);
            manager.leaveChannel(agent.agentId, chanA.channelId);
            expect(manager.getAgent(agent.agentId)?.channelIds).toEqual([chanB.channelId]);
            expect(manager.listAgents(chanA.channelId).map((item) => item.agentId)).not.toContain(agent.agentId);
            manager.leaveChannel(agent.agentId, chanB.channelId);
            expect(manager.getAgent(agent.agentId)?.channelIds).toEqual([]);
            expect(manager.listAgents(chanB.channelId).map((item) => item.agentId)).not.toContain(agent.agentId);
        });
        it('createChannel 应保留 description', () => {
            const ch = manager.createChannel({ name: 'with-desc', description: 'channel description' });
            expect(ch.description).toBe('channel description');
            expect(manager.getChannel(ch.channelId)?.description).toBe('channel description');
        });
        it('openAgentChannelThread 应为同一 agent/channel/threadRootId 复用 branch thread', () => {
            const channel = manager.createChannel({ name: 'eng-thread' });
            const agent = manager.createAgent({
                name: 'Bob',
                agentType: 'claude_acp',
                nodeId: 'node-1',
                workspacePath: '/tmp/bob-eng-thread',
            });
            manager.joinChannel(agent.agentId, channel.channelId);
            const first = manager.openAgentChannelThread(agent.agentId, channel.channelId, 'abcd1234');
            const second = manager.openAgentChannelThread(agent.agentId, channel.channelId, 'abcd1234');
            const third = manager.openAgentChannelThread(agent.agentId, channel.channelId, 'efgh5678');
            expect(first).not.toBeNull();
            expect(second).not.toBeNull();
            expect(third).not.toBeNull();
            expect(first?.id).toBe(second?.id);
            expect(first?.id).not.toBe(third?.id);
            expect(first?.threadKind).toBe('branch');
            expect(first?.isPrimaryThread).toBe(false);
            expect(first?.channelId).toBe(channel.channelId);
            expect(first?.threadRootId).toBe('abcd1234');
            expect(third?.threadRootId).toBe('efgh5678');
        });
        it('openAgentChannelThread 在无 threadRootId 时应复用同一个 channel root branch', () => {
            const channel = manager.createChannel({ name: 'eng-root' });
            const agent = manager.createAgent({
                name: 'BobRoot',
                agentType: 'claude_acp',
                nodeId: 'node-1',
                workspacePath: '/tmp/bob-eng-root',
            });
            manager.joinChannel(agent.agentId, channel.channelId);
            const first = manager.openAgentChannelThread(agent.agentId, channel.channelId, null);
            const second = manager.openAgentChannelThread(agent.agentId, channel.channelId);
            expect(first).not.toBeNull();
            expect(second).not.toBeNull();
            expect(first?.id).toBe(second?.id);
            expect(first?.threadKind).toBe('branch');
            expect(first?.threadRootId).toBeNull();
        });
    });
    // ─── envVars ───
    describe('envVars', () => {
        it('创建 agent 时传入 envVars 应存入 DB', () => {
            const agent = manager.createAgent({
                name: 'Env Agent',
                envVars: { https_proxy: 'http://127.0.0.1:7893', ANTHROPIC_MODEL: 'GLM-4.7' },
            });
            const row = db
                .prepare('SELECT env_vars FROM agents WHERE agent_id = ?')
                .get(agent.agentId);
            expect(JSON.parse(row.env_vars)).toEqual({
                https_proxy: 'http://127.0.0.1:7893',
                ANTHROPIC_MODEL: 'GLM-4.7',
            });
        });
        it('更新 agent 时应覆盖 envVars', () => {
            const agent = manager.createAgent({
                name: 'Update Env Agent',
                envVars: { OLD_KEY: 'old' },
            });
            const updated = manager.updateAgent(agent.agentId, {
                envVars: { ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_MODEL: 'GLM-4.7' },
            });
            expect(updated?.envVars).toEqual({
                ANTHROPIC_AUTH_TOKEN: 'secret',
                ANTHROPIC_MODEL: 'GLM-4.7',
            });
            const row = db
                .prepare('SELECT env_vars FROM agents WHERE agent_id = ?')
                .get(agent.agentId);
            expect(JSON.parse(row.env_vars)).toEqual({
                ANTHROPIC_AUTH_TOKEN: 'secret',
                ANTHROPIC_MODEL: 'GLM-4.7',
            });
        });
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
    describe('disabledToolKinds', () => {
        it('创建 agent 时传入 disabledToolKinds 应存入 DB', () => {
            const agent = manager.createAgent({
                name: 'Restricted Agent',
                disabledToolKinds: ['execute', 'fetch'],
            });
            const row = db
                .prepare('SELECT disabled_tool_kinds FROM agents WHERE agent_id = ?')
                .get(agent.agentId);
            expect(JSON.parse(row.disabled_tool_kinds)).toEqual(['execute', 'fetch']);
            expect(agent.disabledToolKinds).toEqual(['execute', 'fetch']);
        });
        it('更新 agent 时应覆盖 disabledToolKinds', () => {
            const agent = manager.createAgent({
                name: 'Updated Restricted Agent',
                disabledToolKinds: ['read'],
            });
            const updated = manager.updateAgent(agent.agentId, {
                disabledToolKinds: ['edit', 'delete'],
            });
            expect(updated?.disabledToolKinds).toEqual(['edit', 'delete']);
            const row = db
                .prepare('SELECT disabled_tool_kinds FROM agents WHERE agent_id = ?')
                .get(agent.agentId);
            expect(JSON.parse(row.disabled_tool_kinds)).toEqual(['edit', 'delete']);
        });
    });
    describe('skillRoots', () => {
        it('创建 agent 时应保留 skillRoots', () => {
            const agent = manager.createAgent({
                name: 'Skilled Agent',
                skillRoots: ['/skills/alpha', '/skills/beta'],
            });
            expect(agent.skillRoots).toEqual(['/skills/alpha', '/skills/beta']);
            const row = db
                .prepare('SELECT skill_roots FROM agents WHERE agent_id = ?')
                .get(agent.agentId);
            expect(JSON.parse(row.skill_roots ?? '[]')).toEqual(['/skills/alpha', '/skills/beta']);
            expect(manager.getAgent(agent.agentId)?.skillRoots).toEqual(['/skills/alpha', '/skills/beta']);
        });
        it('更新 agent 时应覆盖 skillRoots', () => {
            const agent = manager.createAgent({
                name: 'Updated Skilled Agent',
                skillRoots: ['/skills/old'],
            });
            const updated = manager.updateAgent(agent.agentId, {
                skillRoots: ['/skills/new', '/skills/tools'],
            });
            expect(updated?.skillRoots).toEqual(['/skills/new', '/skills/tools']);
            const row = db
                .prepare('SELECT skill_roots FROM agents WHERE agent_id = ?')
                .get(agent.agentId);
            expect(JSON.parse(row.skill_roots ?? '[]')).toEqual(['/skills/new', '/skills/tools']);
        });
    });
});
