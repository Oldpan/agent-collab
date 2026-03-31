import { randomUUID } from 'node:crypto';
export class AgentSkillsBroker {
    pending = new Map();
    nodeRegistry;
    timeoutMs;
    constructor(params) {
        this.nodeRegistry = params.nodeRegistry;
        this.timeoutMs = params.timeoutMs ?? 5_000;
    }
    listSkills(nodeId, skillRoots, params, skillPath) {
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error('Skill request timed out.'));
            }, this.timeoutMs);
            this.pending.set(requestId, {
                kind: 'list',
                nodeId,
                resolve,
                reject,
                timer,
            });
            const sent = this.nodeRegistry.send(nodeId, {
                type: 'skills.list.request',
                requestId,
                skillRoots,
                path: skillPath ?? null,
                agentType: params?.agentType,
                workspaceRoot: params?.workspaceRoot ?? null,
            });
            if (!sent) {
                clearTimeout(timer);
                this.pending.delete(requestId);
                reject(new Error('Agent node is offline.'));
            }
        });
    }
    readSkillFile(nodeId, skillRoots, params, skillPath) {
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error('Skill request timed out.'));
            }, this.timeoutMs);
            this.pending.set(requestId, {
                kind: 'read',
                nodeId,
                resolve,
                reject,
                timer,
            });
            const sent = this.nodeRegistry.send(nodeId, {
                type: 'skills.read.request',
                requestId,
                skillRoots,
                path: skillPath,
                agentType: params.agentType,
                workspaceRoot: params.workspaceRoot ?? null,
            });
            if (!sent) {
                clearTimeout(timer);
                this.pending.delete(requestId);
                reject(new Error('Agent node is offline.'));
            }
        });
    }
    handleSkillsListResponse(msg) {
        const pending = this.pending.get(msg.requestId);
        if (!pending || pending.kind !== 'list')
            return;
        this.pending.delete(msg.requestId);
        clearTimeout(pending.timer);
        if (msg.error || !msg.skills || !msg.entries) {
            pending.reject(new Error(formatErrorMessage(msg.errorCode, msg.error)));
            return;
        }
        pending.resolve({
            path: msg.path ?? null,
            roots: msg.roots,
            skills: msg.skills,
            entries: msg.entries,
        });
    }
    handleSkillsReadResponse(msg) {
        const pending = this.pending.get(msg.requestId);
        if (!pending || pending.kind !== 'read')
            return;
        this.pending.delete(msg.requestId);
        clearTimeout(pending.timer);
        if (msg.error || msg.content === undefined || !msg.mimeType || msg.size === undefined) {
            pending.reject(new Error(formatErrorMessage(msg.errorCode, msg.error)));
            return;
        }
        pending.resolve({
            path: msg.path,
            content: msg.content,
            mimeType: msg.mimeType,
            size: msg.size,
            modifiedAt: msg.modifiedAt ?? null,
        });
    }
    rejectPendingForNode(nodeId) {
        for (const [requestId, pending] of this.pending.entries()) {
            if (pending.nodeId !== nodeId)
                continue;
            clearTimeout(pending.timer);
            pending.reject(new Error(`Agent node disconnected: ${nodeId}`));
            this.pending.delete(requestId);
        }
    }
}
function formatErrorMessage(errorCode, error) {
    if (errorCode) {
        return `${errorCode}:${error ?? 'skill request failed'}`;
    }
    return error ?? 'skill request failed';
}
