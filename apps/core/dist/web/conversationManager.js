import { randomUUID } from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { log, createSession, upsertBinding, } from '@agent-collab/runtime-acp';
import { getRuntimeDriver } from '@agent-collab/protocol';
import { ExecutionDispatcher } from '../execution/executionDispatcher.js';
function slugifyAgentName(name) {
    return name
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/[\s_]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40);
}
export class ConversationManager {
    db;
    config;
    nodeRegistry;
    executionDispatcher;
    constructor(params) {
        this.db = params.db;
        this.config = params.config;
        this.nodeRegistry = params.nodeRegistry;
        this.executionDispatcher = new ExecutionDispatcher({
            db: params.db,
            config: params.config,
            nodeRegistry: params.nodeRegistry,
            getAgentById: (agentId) => this.getAgent(agentId),
        });
    }
    getDb() {
        return this.db;
    }
    start() {
        log.info('ConversationManager ready');
    }
    close() {
        // no-op: all execution happens on agent-nodes
    }
    // ─── Agent CRUD ───
    createAgent(params) {
        const agentId = randomUUID();
        const agentType = params.agentType ?? 'claude_acp';
        const channelId = params.channelId ?? 'default';
        const envVarsJson = params.envVars && Object.keys(params.envVars).length > 0
            ? JSON.stringify(params.envVars)
            : null;
        const now = Date.now();
        const workspacePath = params.workspacePath
            ?? path.join(os.homedir(), '.agent-collab', 'agents', `${agentId}-${slugifyAgentName(params.name)}`);
        fs.mkdirSync(workspacePath, { recursive: true });
        this.db.prepare(`INSERT INTO agents(agent_id, name, agent_type, channel_id, system_prompt, memory, env_vars, node_id, workspace_path, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(agentId, params.name, agentType, channelId, params.systemPrompt ?? '', '', envVarsJson, params.nodeId ?? null, workspacePath, now, now);
        return {
            agentId, name: params.name, agentType, channelId,
            systemPrompt: params.systemPrompt ?? '',
            envVars: params.envVars, nodeId: params.nodeId ?? null,
            workspacePath, createdAt: now, updatedAt: now,
        };
    }
    listAgents(channelId) {
        const sql = channelId
            ? `SELECT agent_id as agentId, name, agent_type as agentType, channel_id as channelId,
                system_prompt as systemPrompt, env_vars as envVarsJson,
                node_id as nodeId, workspace_path as workspacePath,
                created_at as createdAt, updated_at as updatedAt
         FROM agents WHERE channel_id = ? ORDER BY updated_at DESC`
            : `SELECT agent_id as agentId, name, agent_type as agentType, channel_id as channelId,
                system_prompt as systemPrompt, env_vars as envVarsJson,
                node_id as nodeId, workspace_path as workspacePath,
                created_at as createdAt, updated_at as updatedAt
         FROM agents ORDER BY updated_at DESC`;
        const rows = channelId
            ? this.db.prepare(sql).all(channelId)
            : this.db.prepare(sql).all();
        return rows.map(rowToAgentInfo);
    }
    getAgent(agentId) {
        const row = this.db.prepare(`SELECT agent_id as agentId, name, agent_type as agentType, channel_id as channelId,
              system_prompt as systemPrompt, env_vars as envVarsJson,
              node_id as nodeId, workspace_path as workspacePath,
              created_at as createdAt, updated_at as updatedAt
       FROM agents WHERE agent_id = ?`).get(agentId);
        return row ? rowToAgentInfo(row) : null;
    }
    updateAgent(agentId, req) {
        const existing = this.getAgent(agentId);
        if (!existing)
            return null;
        const now = Date.now();
        const name = req.name ?? existing.name;
        const systemPrompt = req.systemPrompt ?? existing.systemPrompt;
        this.db.prepare(`UPDATE agents SET name = ?, system_prompt = ?, updated_at = ? WHERE agent_id = ?`).run(name, systemPrompt, now, agentId);
        return { ...existing, name, systemPrompt, updatedAt: now };
    }
    deleteAgent(agentId) {
        this.db.prepare(`DELETE FROM conversation_prompt_queue WHERE agent_id = ?`).run(agentId);
        // Nullify agent_id on conversations before deleting the agent
        this.db.prepare(`UPDATE conversations SET agent_id = NULL WHERE agent_id = ?`).run(agentId);
        this.db.prepare(`DELETE FROM agents WHERE agent_id = ?`).run(agentId);
    }
    // ─── CRUD ───
    createConversation(params) {
        const id = randomUUID();
        // If agentId provided, inherit agent's settings as defaults
        const agent = params.agentId ? this.getAgent(params.agentId) : null;
        const agentType = params.agentType ?? (agent?.agentType ?? 'claude_acp');
        const workspacePath = params.workspacePath ?? agent?.workspacePath ?? this.config.workspaceRoot;
        const title = params.title ?? '';
        const channelId = params.channelId ?? agent?.channelId ?? 'default';
        const nodeId = params.nodeId ?? agent?.nodeId ?? null;
        const threadKind = params.threadKind ?? 'direct';
        const isPrimaryThread = params.isPrimaryThread ?? false;
        const envVarsJson = (() => {
            const ev = params.envVars ?? agent?.envVars;
            return ev && Object.keys(ev).length > 0 ? JSON.stringify(ev) : null;
        })();
        const now = Date.now();
        const sessionKey = randomUUID();
        const preset = getRuntimeDriver(agentType);
        // Create session row
        createSession(this.db, {
            sessionKey,
            agentCommand: preset.command,
            agentArgs: preset.args,
            cwd: workspacePath,
            loadSupported: false,
        });
        // bindingKey = web:{channelId}:{conversationId}:{agentType}
        // → each agent type in each thread gets its own isolated session
        upsertBinding(this.db, { platform: 'web', chatId: channelId, threadId: id, userId: agentType }, sessionKey);
        // Create conversations row
        this.db
            .prepare(`INSERT INTO conversations(id, channel_id, title, agent_type, workspace_path, session_key, status, thread_kind, is_primary_thread, env_vars, node_id, agent_id, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, channelId, title, agentType, workspacePath, sessionKey, threadKind, isPrimaryThread ? 1 : 0, envVarsJson, nodeId, params.agentId ?? null, now, now);
        return {
            id,
            channelId,
            title,
            agentType,
            threadKind,
            isPrimaryThread,
            workspacePath,
            status: 'idle',
            createdAt: now,
            updatedAt: now,
            nodeId,
            agentId: params.agentId ?? null,
        };
    }
    openAgentThread(agentId) {
        const agent = this.getAgent(agentId);
        if (!agent)
            return null;
        const existing = this.db.prepare(`SELECT id, channel_id as channelId, title, agent_type as agentType,
              thread_kind as threadKind, is_primary_thread as isPrimaryThread,
              workspace_path as workspacePath, status, node_id as nodeId,
              agent_id as agentId, created_at as createdAt, updated_at as updatedAt
       FROM conversations
       WHERE agent_id = ? AND is_primary_thread = 1
       ORDER BY updated_at DESC
       LIMIT 1`).get(agentId);
        if (existing) {
            return { ...existing, isPrimaryThread: !!existing.isPrimaryThread };
        }
        const fallback = this.db.prepare(`SELECT id, channel_id as channelId, title, agent_type as agentType,
              thread_kind as threadKind, is_primary_thread as isPrimaryThread,
              workspace_path as workspacePath, status, node_id as nodeId,
              agent_id as agentId, created_at as createdAt, updated_at as updatedAt
       FROM conversations
       WHERE agent_id = ?
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1`).get(agentId);
        if (fallback) {
            this.db.prepare(`UPDATE conversations
         SET thread_kind = 'direct', is_primary_thread = 1, updated_at = ?
         WHERE id = ?`).run(Date.now(), fallback.id);
            return { ...fallback, threadKind: 'direct', isPrimaryThread: true };
        }
        return this.createConversation({
            agentId,
            agentType: agent.agentType,
            workspacePath: agent.workspacePath ?? undefined,
            channelId: agent.channelId,
            nodeId: agent.nodeId ?? undefined,
            threadKind: 'direct',
            isPrimaryThread: true,
            title: '',
        });
    }
    listConversations(filter) {
        const convSelect = `SELECT id, channel_id as channelId, title, agent_type as agentType,
                thread_kind as threadKind, is_primary_thread as isPrimaryThread,
                workspace_path as workspacePath, status, node_id as nodeId,
                agent_id as agentId, created_at as createdAt, updated_at as updatedAt
         FROM conversations`;
        const mapRows = (rows) => rows.map((row) => ({
            ...row,
            isPrimaryThread: !!row.isPrimaryThread,
        }));
        if (filter?.channelId && filter?.agentId) {
            return mapRows(this.db.prepare(`${convSelect} WHERE channel_id = ? AND agent_id = ? ORDER BY is_primary_thread DESC, updated_at DESC`)
                .all(filter.channelId, filter.agentId));
        }
        if (filter?.channelId) {
            return mapRows(this.db.prepare(`${convSelect} WHERE channel_id = ? ORDER BY updated_at DESC`)
                .all(filter.channelId));
        }
        if (filter?.agentId) {
            return mapRows(this.db.prepare(`${convSelect} WHERE agent_id = ? ORDER BY is_primary_thread DESC, updated_at DESC`)
                .all(filter.agentId));
        }
        return mapRows(this.db.prepare(`${convSelect} ORDER BY updated_at DESC`).all());
    }
    getConversation(id) {
        const row = this.db
            .prepare(`SELECT id, channel_id as channelId, title, agent_type as agentType,
                thread_kind as threadKind, is_primary_thread as isPrimaryThread,
                workspace_path as workspacePath, status, node_id as nodeId,
                agent_id as agentId, created_at as createdAt, updated_at as updatedAt
         FROM conversations WHERE id = ?`)
            .get(id);
        return row ? { ...row, isPrimaryThread: !!row.isPrimaryThread } : null;
    }
    deleteConversation(id) {
        this.db.prepare('DELETE FROM conversation_prompt_queue WHERE conversation_id = ?').run(id);
        this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    }
    async dispatchToNode(conversationId, promptText) {
        await this.executionDispatcher.dispatchPrompt(conversationId, promptText);
    }
    async submitPrompt(conversationId, promptText) {
        return this.executionDispatcher.submitPrompt(conversationId, promptText);
    }
    async onConversationSettled(conversationId) {
        await this.executionDispatcher.handleConversationSettled(conversationId);
    }
    clearQueuedPromptsForNode(nodeId) {
        this.executionDispatcher.clearQueuedPromptsForNode(nodeId);
    }
    // ─── Channel CRUD ───
    createChannel(params) {
        const channelId = params.name === 'default' ? 'default' : randomUUID();
        const now = Date.now();
        this.db
            .prepare(`INSERT INTO channels(channel_id, name, workspace_path, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?)`)
            .run(channelId, params.name, params.workspacePath ?? null, now, now);
        return {
            channelId,
            name: params.name,
            workspacePath: params.workspacePath ?? null,
            createdAt: now,
            updatedAt: now,
        };
    }
    listChannels() {
        return this.db
            .prepare(`SELECT channel_id as channelId, name, workspace_path as workspacePath,
                created_at as createdAt, updated_at as updatedAt
         FROM channels ORDER BY created_at ASC`)
            .all();
    }
    getChannel(channelId) {
        const row = this.db
            .prepare(`SELECT channel_id as channelId, name, workspace_path as workspacePath,
                created_at as createdAt, updated_at as updatedAt
         FROM channels WHERE channel_id = ?`)
            .get(channelId);
        return row ?? null;
    }
    async handleApproval(conversationId, requestId, decision) {
        return this.executionDispatcher.handleApproval(conversationId, requestId, decision);
    }
    cancelConversationRun(conversationId) {
        return this.executionDispatcher.cancelConversationRun(conversationId);
    }
    updateStatus(conversationId, status) {
        this.db
            .prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?')
            .run(status, Date.now(), conversationId);
    }
    // ─── Machine CRUD ───
    createMachine(params) {
        const nodeId = randomUUID();
        const now = Date.now();
        const envVarKeysJson = JSON.stringify(params.envVarKeys ?? []);
        this.db.prepare(`INSERT INTO nodes(node_id, hostname, agent_types_json, version, status, last_seen, created_at, display_name, env_var_keys, provisioned_at)
       VALUES(?, '', '[]', '', 'pending', 0, 0, ?, ?, ?)`).run(nodeId, params.name, envVarKeysJson, now);
        return {
            nodeId,
            name: params.name,
            hostname: null,
            agentTypes: [],
            version: null,
            status: 'pending',
            envVarKeys: params.envVarKeys ?? [],
            lastSeen: null,
            provisionedAt: now,
            createdAt: 0,
        };
    }
    listMachines() {
        const rows = this.db.prepare(`SELECT node_id as nodeId, hostname, agent_types_json as agentTypesJson, version,
              status, last_seen as lastSeen, created_at as createdAt,
              display_name as displayName, env_var_keys as envVarKeysJson, provisioned_at as provisionedAt
       FROM nodes ORDER BY provisioned_at DESC, created_at ASC`).all();
        return rows.map((row) => {
            const isOnline = !!this.nodeRegistry?.getNode(row.nodeId);
            return rowToMachineInfo(row, isOnline);
        });
    }
    getMachine(nodeId) {
        const row = this.db.prepare(`SELECT node_id as nodeId, hostname, agent_types_json as agentTypesJson, version,
              status, last_seen as lastSeen, created_at as createdAt,
              display_name as displayName, env_var_keys as envVarKeysJson, provisioned_at as provisionedAt
       FROM nodes WHERE node_id = ?`).get(nodeId);
        if (!row)
            return null;
        const isOnline = !!this.nodeRegistry?.getNode(nodeId);
        return rowToMachineInfo(row, isOnline);
    }
    deleteMachine(nodeId) {
        this.db.prepare(`UPDATE agents SET node_id = NULL WHERE node_id = ?`).run(nodeId);
        this.db.prepare(`DELETE FROM nodes WHERE node_id = ?`).run(nodeId);
    }
}
function rowToAgentInfo(row) {
    return {
        agentId: row.agentId,
        name: row.name,
        agentType: row.agentType,
        channelId: row.channelId,
        systemPrompt: row.systemPrompt,
        envVars: parseEnvVars(row.envVarsJson),
        nodeId: row.nodeId,
        workspacePath: row.workspacePath,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
function rowToMachineInfo(row, isOnline) {
    let agentTypes = [];
    try {
        agentTypes = JSON.parse(row.agentTypesJson);
    }
    catch { /* ignore */ }
    let envVarKeys = [];
    try {
        const parsed = JSON.parse(row.envVarKeysJson ?? '[]');
        if (Array.isArray(parsed))
            envVarKeys = parsed;
    }
    catch { /* ignore */ }
    const status = isOnline ? 'online'
        : (row.status === 'pending' ? 'pending' : 'offline');
    return {
        nodeId: row.nodeId,
        name: row.displayName || row.hostname || row.nodeId,
        hostname: row.hostname || null,
        agentTypes,
        version: row.version || null,
        status,
        envVarKeys,
        lastSeen: row.lastSeen || null,
        provisionedAt: row.provisionedAt,
        createdAt: row.createdAt,
    };
}
function parseEnvVars(raw) {
    if (!raw)
        return undefined;
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
    }
    catch {
        // ignore
    }
    return undefined;
}
