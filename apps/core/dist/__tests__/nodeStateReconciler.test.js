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
});
