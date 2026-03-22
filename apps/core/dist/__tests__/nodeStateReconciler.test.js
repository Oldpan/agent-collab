import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers.js';
import { reconcileNodeStateOnStartup } from '../services/nodeStateReconciler.js';
describe('nodeStateReconciler', () => {
    it('启动时应将旧 online 节点收敛为 offline', () => {
        const db = createTestDb();
        const now = Date.now() - 60_000;
        db.prepare(`INSERT INTO nodes(node_id, hostname, agent_types_json, version, status, last_seen, created_at, display_name, env_var_keys, provisioned_at)
       VALUES(?, ?, ?, ?, 'online', ?, ?, NULL, '[]', 0)`).run('node-stale', 'host-a', '["claude_acp"]', '0.1.0', now, now);
        const result = reconcileNodeStateOnStartup(db);
        const row = db
            .prepare(`SELECT status FROM nodes WHERE node_id = ?`)
            .get('node-stale');
        expect(result.offlinedNodes).toBe(1);
        expect(row.status).toBe('offline');
        db.close();
    });
    it('启动时应将挂起中的远端会话标为 failed', () => {
        const db = createTestDb();
        const now = Date.now();
        db.prepare(`INSERT INTO sessions(session_key, agent_command, agent_args_json, acp_session_id, load_supported, cwd, created_at, updated_at)
       VALUES(?, 'npx', '[]', NULL, 0, '/tmp', ?, ?)`).run('session-1', now, now);
        db.prepare(`INSERT INTO conversations(id, channel_id, title, agent_type, workspace_path, session_key, status, env_vars, node_id, agent_id, created_at, updated_at)
       VALUES(?, 'default', 'Conv', 'claude_acp', '/tmp', 'session-1', 'active', NULL, 'node-stale', NULL, ?, ?)`).run('conv-1', now, now);
        const result = reconcileNodeStateOnStartup(db);
        const row = db
            .prepare(`SELECT status FROM conversations WHERE id = ?`)
            .get('conv-1');
        expect(result.failedConversations).toBe(1);
        expect(row.status).toBe('failed');
        db.close();
    });
    it('启动时应为可唯一匹配的历史会话回填 agent_id', () => {
        const db = createTestDb();
        const now = Date.now();
        db.prepare(`INSERT INTO agents(agent_id, name, agent_type, channel_id, system_prompt, memory, env_vars, node_id, workspace_path, created_at, updated_at)
       VALUES(?, ?, ?, ?, '', '', NULL, ?, ?, ?, ?)`).run('agent-bob', 'Bob', 'codex_acp', 'default', 'node-1', '/tmp/bob', now, now);
        db.prepare(`INSERT INTO sessions(session_key, agent_command, agent_args_json, acp_session_id, load_supported, cwd, created_at, updated_at)
       VALUES(?, 'npx', '[]', NULL, 0, '/tmp/bob', ?, ?)`).run('session-2', now, now);
        db.prepare(`INSERT INTO conversations(id, channel_id, title, agent_type, workspace_path, session_key, status, env_vars, node_id, agent_id, created_at, updated_at)
       VALUES(?, 'default', 'Recovered thread', 'codex_acp', '/tmp/bob', 'session-2', 'idle', NULL, 'node-1', NULL, ?, ?)`).run('conv-2', now, now);
        const result = reconcileNodeStateOnStartup(db);
        const row = db
            .prepare(`SELECT agent_id as agentId FROM conversations WHERE id = ?`)
            .get('conv-2');
        expect(result.backfilledConversationAgents).toBe(1);
        expect(row.agentId).toBe('agent-bob');
        db.close();
    });
});
