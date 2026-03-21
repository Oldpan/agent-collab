import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { log } from '../logging.js';
import { resolveWorkspacePath } from '../tools/workspace.js';
import { isNotification, isRequest, isResponse, } from './jsonrpc.js';
import { spawnAcpAgent } from './stdio.js';
const ACP_BOOTSTRAP_TIMEOUT_MS = 30_000;
export class AcpClient {
    db;
    workspaceRoot;
    agentCommand;
    agentArgs;
    toolAuth;
    rpc;
    nextId = 1;
    pending = new Map();
    // run-scoped state
    currentRun = null;
    runSeq = new Map();
    pendingLocalPermissions = new Map();
    events;
    constructor(params) {
        this.db = params.db;
        this.workspaceRoot = params.workspaceRoot;
        this.agentCommand = params.agentCommand;
        this.agentArgs = params.agentArgs;
        this.toolAuth = params.toolAuth ?? null;
        this.events = params.events ?? {};
        this.rpc =
            params.rpc ?? spawnAcpAgent(this.agentCommand, this.agentArgs, params.env);
        this.rpc.onMessage((m) => this.handleMessage(m));
        this.rpc.onStderr((line) => this.events.onAgentStderr?.(line));
        this.rpc.onExit?.((info) => {
            this.rejectAllPending(this.makeTransportError('ACP agent exited (code=' +
                String(info.code) +
                ', signal=' +
                String(info.signal) +
                ')'));
            this.rejectAllLocalPermissions(this.makeTransportError('ACP agent exited while waiting for permission response'));
        });
    }
    close() {
        this.rejectAllPending(this.makeTransportError('ACP client closed'));
        this.rejectAllLocalPermissions(this.makeTransportError('ACP client closed'));
        this.rpc.kill();
    }
    initPromise = null;
    async initialize() {
        if (this.initPromise)
            return this.initPromise;
        const params = {
            protocolVersion: 1,
            clientCapabilities: {
                fs: { readTextFile: true, writeTextFile: true },
                terminal: true,
            },
            clientInfo: {
                name: 'cli-gateway',
                title: 'cli-gateway',
                version: '0.1.0',
            },
        };
        this.initPromise = this.request('initialize', params, ACP_BOOTSTRAP_TIMEOUT_MS);
        return this.initPromise;
    }
    async newSession(params) {
        return this.request('session/new', params, ACP_BOOTSTRAP_TIMEOUT_MS);
    }
    async prompt(run, params) {
        this.currentRun = run;
        this.runSeq.set(run.runId, 0);
        try {
            const result = await this.request('session/prompt', params);
            return result;
        }
        finally {
            this.currentRun = null;
            this.runSeq.delete(run.runId);
        }
    }
    notifyCancel(sessionId) {
        this.rpc.write({
            jsonrpc: '2.0',
            method: 'session/cancel',
            params: { sessionId },
        });
    }
    async respondPermission(req, decision) {
        const local = this.pendingLocalPermissions.get(req.requestId);
        if (local) {
            this.pendingLocalPermissions.delete(req.requestId);
            local.resolve(decision);
            return;
        }
        const outcome = decision.kind === 'cancelled'
            ? { outcome: 'cancelled' }
            : { outcome: 'selected', optionId: decision.optionId };
        const msg = {
            jsonrpc: '2.0',
            id: req.requestId,
            result: { outcome },
        };
        this.rpc.write(msg);
    }
    handleMessage(message) {
        if (isResponse(message)) {
            const pending = this.pending.get(message.id);
            if (pending) {
                this.pending.delete(message.id);
                if (pending.timer) {
                    clearTimeout(pending.timer);
                }
                pending.resolve(message);
            }
            return;
        }
        if (isNotification(message)) {
            if (message.method === 'session/update') {
                const params = message.params;
                const sessionId = params?.sessionId;
                const update = params?.update;
                if (this.currentRun && sessionId) {
                    const eventSeq = this.appendEvent(this.currentRun.runId, 'session/update', params);
                    void this.events.onSessionUpdate?.(this.currentRun, sessionId, update, eventSeq);
                }
            }
            return;
        }
        if (isRequest(message)) {
            // Agent -> Client requests
            void this.handleAgentRequest(message);
            return;
        }
    }
    async handleAgentRequest(req) {
        const run = this.currentRun;
        const emitTool = (event) => {
            if (!run)
                return;
            this.events.onClientTool?.(run, event);
        };
        try {
            switch (req.method) {
                case 'session/request_permission': {
                    const params = req.params;
                    const sessionKey = this.currentRun?.sessionKey ?? 'unknown';
                    const pr = {
                        requestId: req.id,
                        sessionKey,
                        sessionId: params.sessionId,
                        params,
                        createdAtMs: Date.now(),
                    };
                    this.events.onPermissionRequest?.(pr);
                    return;
                }
                case 'fs/read_text_file': {
                    const params = req.params;
                    emitTool({ phase: 'start', method: req.method, params });
                    await this.ensureAuthorized({
                        kind: 'read',
                        method: req.method,
                        params,
                    });
                    const resolvedPath = resolveWorkspacePath(this.workspaceRoot, params.path);
                    const content = readTextFileWithLimit(resolvedPath, params.line, params.limit);
                    this.respond(req.id, { content });
                    emitTool({
                        phase: 'end',
                        method: req.method,
                        params,
                        result: { bytes: content.length },
                    });
                    return;
                }
                case 'fs/write_text_file': {
                    const params = req.params;
                    emitTool({ phase: 'start', method: req.method, params: { path: params.path } });
                    await this.ensureAuthorized({
                        kind: 'edit',
                        method: req.method,
                        params,
                    });
                    const resolvedPath = resolveWorkspacePath(this.workspaceRoot, params.path);
                    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
                    fs.writeFileSync(resolvedPath, params.content, 'utf8');
                    this.respond(req.id, {});
                    emitTool({
                        phase: 'end',
                        method: req.method,
                        params: { path: params.path },
                        result: { bytes: params.content.length },
                    });
                    return;
                }
                case 'terminal/create': {
                    const params = req.params;
                    emitTool({
                        phase: 'start',
                        method: req.method,
                        params: {
                            command: params.command,
                            args: params.args,
                            cwd: params.cwd,
                        },
                    });
                    await this.ensureAuthorized({
                        kind: 'execute',
                        method: req.method,
                        params,
                    });
                    const terminalId = await this.terminalCreate(params);
                    this.respond(req.id, { terminalId });
                    emitTool({
                        phase: 'end',
                        method: req.method,
                        params: {
                            command: params.command,
                            args: params.args,
                            cwd: params.cwd,
                        },
                        result: { terminalId },
                    });
                    return;
                }
                case 'terminal/output': {
                    const params = req.params;
                    const out = this.terminalOutput(params);
                    this.respond(req.id, out);
                    return;
                }
                case 'terminal/wait_for_exit': {
                    const params = req.params;
                    emitTool({
                        phase: 'start',
                        method: req.method,
                        params: { terminalId: params.terminalId },
                    });
                    const res = await this.terminalWaitForExit(params);
                    this.respond(req.id, res);
                    emitTool({
                        phase: 'end',
                        method: req.method,
                        params: { terminalId: params.terminalId },
                        result: res,
                    });
                    return;
                }
                case 'terminal/kill': {
                    const params = req.params;
                    await this.ensureAuthorized({
                        kind: 'execute',
                        method: req.method,
                        params,
                    });
                    this.terminalKill(params);
                    this.respond(req.id, {});
                    return;
                }
                case 'terminal/release': {
                    const params = req.params;
                    this.terminalRelease(params);
                    this.respond(req.id, {});
                    return;
                }
                default: {
                    this.respondError(req.id, -32601, `Method not found: ${req.method}`);
                }
            }
        }
        catch (error) {
            log.error('Agent request handler error', req.method, error);
            emitTool({
                phase: 'error',
                method: req.method,
                params: req.params,
                error: String(error?.message ?? error),
            });
            this.respondError(req.id, -32000, String(error?.message ?? error));
        }
    }
    request(method, params, timeoutMs) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = timeoutMs && timeoutMs > 0
                ? setTimeout(() => {
                    this.rejectPendingRequest(id, this.makeTransportError('ACP request timed out: ' + method + ' (' + String(timeoutMs) + 'ms)'));
                }, timeoutMs)
                : null;
            this.pending.set(id, {
                method,
                resolve: (res) => {
                    if ('error' in res) {
                        const code = typeof res.error?.code === 'number'
                            ? ' (code ' + String(res.error.code) + ')'
                            : '';
                        const data = res.error?.data !== undefined
                            ? '; data=' + String(res.error.data)
                            : '';
                        reject(new Error(String(res.error.message) + code + data));
                        return;
                    }
                    resolve(res.result);
                },
                reject,
                timer,
            });
            try {
                const req = { jsonrpc: '2.0', id, method, params };
                this.rpc.write(req);
            }
            catch (error) {
                this.rejectPendingRequest(id, this.makeTransportError(String(error?.message ?? error)));
            }
        });
    }
    rejectPendingRequest(id, error) {
        const pending = this.pending.get(id);
        if (!pending)
            return;
        this.pending.delete(id);
        if (pending.timer) {
            clearTimeout(pending.timer);
        }
        pending.reject(error);
    }
    rejectAllPending(error) {
        for (const id of this.pending.keys()) {
            const detail = this.makeTransportError(error.message + '; pending_id=' + String(id));
            this.rejectPendingRequest(id, detail);
        }
    }
    rejectAllLocalPermissions(error) {
        for (const [id, pending] of this.pendingLocalPermissions.entries()) {
            this.pendingLocalPermissions.delete(id);
            const detail = this.makeTransportError(error.message + '; permission_request_id=' + String(id));
            pending.reject(detail);
        }
    }
    makeTransportError(message) {
        const err = new Error(message);
        err.name = 'AcpTransportError';
        return err;
    }
    respond(id, result) {
        this.rpc.write({ jsonrpc: '2.0', id, result });
    }
    respondError(id, code, message) {
        this.rpc.write({ jsonrpc: '2.0', id, error: { code, message } });
    }
    appendEvent(runId, method, payload) {
        const prev = this.runSeq.get(runId) ?? 0;
        const seq = prev + 1;
        this.runSeq.set(runId, seq);
        this.db
            .prepare('INSERT INTO events(run_id, seq, method, payload_json, created_at) VALUES(?, ?, ?, ?, ?)')
            .run(runId, seq, method, JSON.stringify(payload), Date.now());
        return seq;
    }
    async ensureAuthorized(params) {
        const { kind } = params;
        const sessionKey = this.currentRun?.sessionKey;
        // Tool calls should only occur within a prompt turn.
        if (!sessionKey) {
            throw new Error(`Tool call not allowed outside prompt turn (kind=${kind})`);
        }
        // If auth is not wired, default deny (secure by default).
        if (!this.toolAuth) {
            throw new Error(`Tool call denied (no ToolAuth): ${kind}`);
        }
        if (this.toolAuth.consume(sessionKey, kind, {
            method: params.method,
            params: params.params,
            workspaceRoot: this.workspaceRoot,
        })) {
            return;
        }
        if (!this.events.onPermissionRequest) {
            throw new Error(`Tool call denied by policy: ${kind}. Approve in permission UI (Allow) or use /allow <n>.`);
        }
        const req = buildLocalPermissionRequest({
            sessionKey,
            kind,
            method: params.method,
            params: params.params,
        });
        const decision = await new Promise((resolve, reject) => {
            this.pendingLocalPermissions.set(req.requestId, { resolve, reject });
            try {
                this.events.onPermissionRequest?.(req);
            }
            catch (error) {
                this.pendingLocalPermissions.delete(req.requestId);
                reject(new Error(String(error?.message ?? error)));
            }
        });
        if (decision.kind === 'cancelled') {
            throw new Error(`Tool call denied by policy: ${kind}. Approve in permission UI (Allow) or use /allow <n>.`);
        }
        if (this.toolAuth.consume(sessionKey, kind, {
            method: params.method,
            params: params.params,
            workspaceRoot: this.workspaceRoot,
        })) {
            return;
        }
        throw new Error(`Tool call denied by policy: ${kind}. Approve in permission UI (Allow) or use /allow <n>.`);
    }
    // terminal management (minimal)
    terminals = new Map();
    async terminalCreate(params) {
        const terminalId = randomUUID();
        const cwd = params.cwd
            ? resolveWorkspacePath(this.workspaceRoot, params.cwd)
            : this.workspaceRoot;
        const byteLimit = params.outputByteLimit ?? 256_000;
        const child = spawn(params.command, params.args ?? [], {
            cwd,
            env: {
                ...process.env,
                ...(params.env ?? []).reduce((acc, kv) => {
                    acc[kv.name] = kv.value;
                    return acc;
                }, {}),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const state = { child, output: '', truncated: false, byteLimit };
        this.terminals.set(terminalId, state);
        const onData = (buf) => {
            const chunk = buf.toString('utf8');
            state.output += chunk;
            if (state.output.length > state.byteLimit) {
                state.output = state.output.slice(state.output.length - state.byteLimit);
                state.truncated = true;
            }
        };
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        return terminalId;
    }
    terminalOutput(params) {
        const state = this.terminals.get(params.terminalId);
        if (!state)
            throw new Error(`Unknown terminalId: ${params.terminalId}`);
        const exitStatus = state.child.exitCode !== null || state.child.signalCode !== null
            ? { exitCode: state.child.exitCode, signal: state.child.signalCode }
            : null;
        return {
            output: state.output,
            truncated: state.truncated,
            exitStatus,
        };
    }
    terminalWaitForExit(params) {
        const state = this.terminals.get(params.terminalId);
        if (!state)
            throw new Error(`Unknown terminalId: ${params.terminalId}`);
        return new Promise((resolve) => {
            state.child.once('exit', (code, signal) => {
                resolve({ exitCode: code, signal });
            });
        });
    }
    terminalKill(params) {
        const state = this.terminals.get(params.terminalId);
        if (!state)
            throw new Error(`Unknown terminalId: ${params.terminalId}`);
        state.child.kill('SIGKILL');
    }
    terminalRelease(params) {
        const state = this.terminals.get(params.terminalId);
        if (!state)
            return;
        state.child.kill('SIGKILL');
        this.terminals.delete(params.terminalId);
    }
}
function buildLocalPermissionRequest(params) {
    const sessionId = typeof params.params?.sessionId ===
        'string'
        ? String(params.params.sessionId)
        : 'unknown';
    return {
        requestId: `localperm-${randomUUID()}`,
        sessionKey: params.sessionKey,
        sessionId,
        createdAtMs: Date.now(),
        params: {
            sessionId,
            toolCall: {
                title: buildLocalToolTitle(params.method, params.params),
                kind: params.kind,
                name: params.method,
                arguments: buildLocalPermissionArgs(params.params),
            },
            options: [
                { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
                {
                    optionId: 'allow_always',
                    name: 'Always allow',
                    kind: 'allow_always',
                },
                { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
                {
                    optionId: 'reject_always',
                    name: 'Always reject',
                    kind: 'reject_always',
                },
            ],
        },
    };
}
function buildLocalToolTitle(method, rawParams) {
    const params = (rawParams ?? {});
    if (method === 'fs/read_text_file') {
        const target = stringOrFallback(params.path, '<path>');
        return truncateInline(`read: ${target}`, 180);
    }
    if (method === 'fs/write_text_file') {
        const target = stringOrFallback(params.path, '<path>');
        return truncateInline(`edit: ${target}`, 180);
    }
    if (method === 'terminal/create') {
        const command = stringOrFallback(params.command, '<command>');
        const args = Array.isArray(params.args)
            ? params.args
                .filter((item) => typeof item === 'string')
                .join(' ')
            : '';
        const full = args ? `${command} ${args}` : command;
        return truncateInline(`run: ${full}`, 180);
    }
    if (method === 'terminal/kill') {
        const terminalId = stringOrFallback(params.terminalId, '<terminal_id>');
        return truncateInline(`run: kill terminal ${terminalId}`, 180);
    }
    return truncateInline(method, 180);
}
function buildLocalPermissionArgs(rawParams) {
    if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
        return rawParams;
    }
    const source = rawParams;
    const args = {};
    for (const [key, value] of Object.entries(source)) {
        if (key === 'sessionId')
            continue;
        args[key] = sanitizePermissionArgValue(key, value);
    }
    return args;
}
function sanitizePermissionArgValue(key, value) {
    if (key === 'content' && typeof value === 'string') {
        return value.length > 240
            ? `${value.slice(0, 237)}... (${value.length} chars)`
            : value;
    }
    if (key === 'env' && Array.isArray(value)) {
        return value.map((item) => {
            if (!item || typeof item !== 'object')
                return '<env>';
            const name = item.name;
            return typeof name === 'string' && name.trim() ? name.trim() : '<env>';
        });
    }
    return value;
}
function truncateInline(text, maxLen) {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length <= maxLen)
        return clean;
    return clean.slice(0, maxLen - 3) + '...';
}
function stringOrFallback(value, fallback) {
    if (typeof value !== 'string')
        return fallback;
    const trimmed = value.trim();
    return trimmed || fallback;
}
function readTextFileWithLimit(filePath, line, limit) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (!line || !limit)
        return content;
    const lines = content.split(/\r?\n/);
    const startIndex = Math.max(0, line - 1);
    return lines.slice(startIndex, startIndex + limit).join('\n');
}
