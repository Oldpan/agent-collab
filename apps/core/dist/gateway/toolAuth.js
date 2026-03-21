import path from 'node:path';
import { resolveWorkspacePath } from '../tools/workspace.js';
export const TOOL_KINDS = [
    'read',
    'edit',
    'delete',
    'move',
    'search',
    'execute',
    'think',
    'fetch',
    'switch_mode',
    'other',
];
export function parseToolKind(value) {
    if (typeof value !== 'string')
        return null;
    const normalized = value.trim().toLowerCase();
    return TOOL_KINDS.includes(normalized)
        ? normalized
        : null;
}
const PATH_PREFIX_TOOL_KINDS = new Set([
    'read',
    'edit',
    'delete',
    'move',
]);
export class ToolAuth {
    db;
    onceGrants = new Map();
    constructor(db) {
        this.db = db;
    }
    grantOnce(sessionKey, toolKind, count = 1) {
        const perSession = this.onceGrants.get(sessionKey) ?? new Map();
        perSession.set(toolKind, (perSession.get(toolKind) ?? 0) + count);
        this.onceGrants.set(sessionKey, perSession);
    }
    setPersistentPolicy(bindingKey, toolKind, policy) {
        const now = Date.now();
        this.db
            .prepare(`
        INSERT INTO tool_policies(binding_key, tool_kind, policy, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(binding_key, tool_kind) DO UPDATE SET
          policy = excluded.policy,
          updated_at = excluded.updated_at
        `)
            .run(bindingKey, toolKind, policy, now, now);
    }
    getPersistentPolicy(bindingKey, toolKind) {
        const row = this.db
            .prepare('SELECT policy FROM tool_policies WHERE binding_key = ? AND tool_kind = ? LIMIT 1')
            .get(bindingKey, toolKind);
        return row?.policy ?? null;
    }
    listPersistentPolicies(bindingKey, policy) {
        const rows = policy
            ? this.db
                .prepare(`
            SELECT tool_kind as toolKind, policy
            FROM tool_policies
            WHERE binding_key = ? AND policy = ?
            ORDER BY tool_kind ASC
            `)
                .all(bindingKey, policy)
            : this.db
                .prepare(`
            SELECT tool_kind as toolKind, policy
            FROM tool_policies
            WHERE binding_key = ?
            ORDER BY tool_kind ASC
            `)
                .all(bindingKey);
        return rows
            .map((row) => {
            const toolKind = parseToolKind(row.toolKind);
            if (!toolKind)
                return null;
            return { toolKind, policy: row.policy };
        })
            .filter(Boolean);
    }
    clearPersistentPolicy(bindingKey, toolKind, policy) {
        const result = policy
            ? this.db
                .prepare(`
            DELETE FROM tool_policies
            WHERE binding_key = ? AND tool_kind = ? AND policy = ?
            `)
                .run(bindingKey, toolKind, policy)
            : this.db
                .prepare(`
            DELETE FROM tool_policies
            WHERE binding_key = ? AND tool_kind = ?
            `)
                .run(bindingKey, toolKind);
        return result.changes > 0;
    }
    clearPersistentPolicies(bindingKey, policy) {
        const result = policy
            ? this.db
                .prepare(`
            DELETE FROM tool_policies
            WHERE binding_key = ? AND policy = ?
            `)
                .run(bindingKey, policy)
            : this.db
                .prepare(`
            DELETE FROM tool_policies
            WHERE binding_key = ?
            `)
                .run(bindingKey);
        return result.changes;
    }
    setAllowPrefixRule(bindingKey, toolKind, argPrefix) {
        const normalizedPrefix = normalizeStoredPrefix(toolKind, argPrefix);
        if (!normalizedPrefix) {
            throw new Error('Invalid allow prefix.');
        }
        const now = Date.now();
        this.db
            .prepare(`
        INSERT INTO tool_allow_prefixes(binding_key, tool_kind, arg_prefix, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(binding_key, tool_kind, arg_prefix) DO UPDATE SET
          updated_at = excluded.updated_at
        `)
            .run(bindingKey, toolKind, normalizedPrefix, now, now);
    }
    listAllowPrefixRules(bindingKey, toolKind) {
        const rows = toolKind
            ? this.db
                .prepare(`
            SELECT tool_kind as toolKind, arg_prefix as argPrefix
            FROM tool_allow_prefixes
            WHERE binding_key = ? AND tool_kind = ?
            ORDER BY tool_kind ASC, arg_prefix ASC
            `)
                .all(bindingKey, toolKind)
            : this.db
                .prepare(`
            SELECT tool_kind as toolKind, arg_prefix as argPrefix
            FROM tool_allow_prefixes
            WHERE binding_key = ?
            ORDER BY tool_kind ASC, arg_prefix ASC
            `)
                .all(bindingKey);
        return rows
            .map((row) => {
            const parsedKind = parseToolKind(row.toolKind);
            if (!parsedKind)
                return null;
            const normalizedPrefix = normalizeStoredPrefix(parsedKind, row.argPrefix);
            if (!normalizedPrefix)
                return null;
            return {
                toolKind: parsedKind,
                argPrefix: normalizedPrefix,
            };
        })
            .filter(Boolean);
    }
    clearAllowPrefixRule(bindingKey, toolKind, argPrefix) {
        const normalizedPrefix = normalizeStoredPrefix(toolKind, argPrefix);
        if (!normalizedPrefix)
            return false;
        const result = this.db
            .prepare(`
        DELETE FROM tool_allow_prefixes
        WHERE binding_key = ? AND tool_kind = ? AND arg_prefix = ?
        `)
            .run(bindingKey, toolKind, normalizedPrefix);
        return result.changes > 0;
    }
    clearAllowPrefixRules(bindingKey, toolKind) {
        const result = toolKind
            ? this.db
                .prepare(`
            DELETE FROM tool_allow_prefixes
            WHERE binding_key = ? AND tool_kind = ?
            `)
                .run(bindingKey, toolKind)
            : this.db
                .prepare(`
            DELETE FROM tool_allow_prefixes
            WHERE binding_key = ?
            `)
                .run(bindingKey);
        return result.changes;
    }
    evaluatePersistentPolicy(bindingKey, toolKind, context) {
        const policy = this.getPersistentPolicy(bindingKey, toolKind);
        if (policy === 'reject')
            return 'reject';
        if (policy === 'allow')
            return 'allow';
        return this.matchesAllowPrefixRule(bindingKey, toolKind, context)
            ? 'allow'
            : null;
    }
    consume(sessionKey, toolKind, context) {
        const bindingRow = this.db
            .prepare('SELECT binding_key as bindingKey FROM bindings WHERE session_key = ? LIMIT 1')
            .get(sessionKey);
        if (!bindingRow)
            return false;
        const persistent = this.evaluatePersistentPolicy(bindingRow.bindingKey, toolKind, context);
        if (persistent === 'reject')
            return false;
        if (persistent === 'allow')
            return true;
        const perSession = this.onceGrants.get(sessionKey);
        const remaining = perSession?.get(toolKind) ?? 0;
        if (remaining <= 0)
            return false;
        perSession.set(toolKind, remaining - 1);
        return true;
    }
    matchesAllowPrefixRule(bindingKey, toolKind, context) {
        if (!context)
            return false;
        const rules = this.listAllowPrefixRules(bindingKey, toolKind);
        if (rules.length === 0)
            return false;
        const candidates = extractMatchCandidates(toolKind, context);
        if (candidates.length === 0)
            return false;
        for (const rule of rules) {
            if (candidates.some((candidate) => prefixMatches(toolKind, candidate, rule.argPrefix))) {
                return true;
            }
        }
        return false;
    }
}
function extractMatchCandidates(toolKind, context) {
    const out = [];
    const seen = new Set();
    const push = (raw) => {
        if (typeof raw !== 'string')
            return;
        const normalized = normalizeCandidate(toolKind, raw, context.workspaceRoot);
        if (!normalized || seen.has(normalized))
            return;
        seen.add(normalized);
        out.push(normalized);
    };
    const params = asRecord(context.params);
    const method = String(context.method ?? '').trim();
    if (method === 'fs/read_text_file' || method === 'fs/write_text_file') {
        push(params?.path);
    }
    if (method === 'terminal/create') {
        push(formatCommandLine(params?.command, params?.args));
    }
    const toolCall = asRecord(context.toolCall);
    if (toolCall) {
        push(toolCall.path);
        push(getPathValue(toolCall, 'arguments.path'));
        push(getPathValue(toolCall, 'input.path'));
        push(formatCommandLine(toolCall.command, toolCall.args));
        push(formatCommandLine(getPathValue(toolCall, 'arguments.command'), getPathValue(toolCall, 'arguments.args')));
        push(extractTargetFromToolTitle(toolKind, toolCall.title));
    }
    if (PATH_PREFIX_TOOL_KINDS.has(toolKind)) {
        push(params?.file);
        push(params?.target);
        push(params?.uri);
    }
    else if (toolKind === 'execute') {
        push(params?.command);
    }
    else {
        push(params?.path);
        push(params?.query);
        push(params?.pattern);
        push(params?.text);
    }
    return out;
}
function normalizeCandidate(toolKind, raw, workspaceRoot) {
    if (PATH_PREFIX_TOOL_KINDS.has(toolKind)) {
        return normalizePathPrefix(raw, workspaceRoot);
    }
    return normalizeTextPrefix(raw);
}
function normalizeStoredPrefix(toolKind, raw) {
    if (PATH_PREFIX_TOOL_KINDS.has(toolKind)) {
        return normalizePathPrefix(raw);
    }
    return normalizeTextPrefix(raw);
}
function normalizePathPrefix(raw, workspaceRoot) {
    const trimmed = raw.trim();
    if (!trimmed || !path.isAbsolute(trimmed))
        return null;
    if (workspaceRoot) {
        try {
            return resolveWorkspacePath(workspaceRoot, trimmed);
        }
        catch {
            return null;
        }
    }
    return path.resolve(trimmed);
}
function normalizeTextPrefix(raw) {
    const normalized = raw.replace(/\s+/g, ' ').trim();
    return normalized || null;
}
function prefixMatches(toolKind, candidate, prefix) {
    if (PATH_PREFIX_TOOL_KINDS.has(toolKind)) {
        return pathPrefixMatches(candidate, prefix);
    }
    return candidate.startsWith(prefix);
}
function pathPrefixMatches(candidate, prefix) {
    const normalizedCandidate = path.resolve(candidate);
    const normalizedPrefix = path.resolve(prefix);
    if (normalizedCandidate === normalizedPrefix)
        return true;
    return normalizedCandidate.startsWith(normalizedPrefix + path.sep);
}
function asRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    return value;
}
function getPathValue(source, pathExpr) {
    const parts = pathExpr.split('.');
    let current = source;
    for (const part of parts) {
        const obj = asRecord(current);
        if (!obj)
            return undefined;
        current = obj[part];
    }
    return current;
}
function formatCommandLine(commandRaw, argsRaw) {
    if (typeof commandRaw !== 'string' || !commandRaw.trim())
        return null;
    const command = commandRaw.trim();
    const args = Array.isArray(argsRaw)
        ? argsRaw.filter((item) => typeof item === 'string')
        : [];
    const full = args.length > 0 ? `${command} ${args.join(' ')}` : command;
    return normalizeTextPrefix(full);
}
function extractTargetFromToolTitle(toolKind, titleRaw) {
    if (typeof titleRaw !== 'string')
        return null;
    const title = titleRaw.trim();
    if (!title)
        return null;
    if (PATH_PREFIX_TOOL_KINDS.has(toolKind)) {
        const match = title.match(/^(?:read|edit|delete|move)\s*:\s*(.+)$/i);
        if (match) {
            return match[1]?.trim() ?? null;
        }
        return null;
    }
    if (toolKind === 'execute') {
        const match = title.match(/^run\s*:\s*(.+)$/i);
        if (match) {
            return match[1]?.trim() ?? null;
        }
    }
    return null;
}
