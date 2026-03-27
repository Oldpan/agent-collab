import { randomUUID } from 'node:crypto';
export class AgentWorkspaceBroker {
    pending = new Map();
    nodeRegistry;
    timeoutMs;
    constructor(params) {
        this.nodeRegistry = params.nodeRegistry;
        this.timeoutMs = params.timeoutMs ?? 5_000;
    }
    listDirectory(nodeId, workspaceRoot, relativePath) {
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error('Workspace request timed out.'));
            }, this.timeoutMs);
            this.pending.set(requestId, {
                kind: 'list',
                nodeId,
                resolve,
                reject,
                timer,
            });
            const sent = this.nodeRegistry.send(nodeId, {
                type: 'workspace.list.request',
                requestId,
                workspaceRoot,
                relativePath,
            });
            if (!sent) {
                clearTimeout(timer);
                this.pending.delete(requestId);
                reject(new Error('Agent node is offline.'));
            }
        });
    }
    readFile(nodeId, workspaceRoot, relativePath) {
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error('Workspace request timed out.'));
            }, this.timeoutMs);
            this.pending.set(requestId, {
                kind: 'read',
                nodeId,
                resolve,
                reject,
                timer,
            });
            const sent = this.nodeRegistry.send(nodeId, {
                type: 'workspace.read.request',
                requestId,
                workspaceRoot,
                relativePath,
            });
            if (!sent) {
                clearTimeout(timer);
                this.pending.delete(requestId);
                reject(new Error('Agent node is offline.'));
            }
        });
    }
    writeFile(nodeId, workspaceRoot, relativePath, content, mode) {
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error('Workspace write request timed out.'));
            }, this.timeoutMs);
            this.pending.set(requestId, {
                kind: 'write',
                nodeId,
                resolve,
                reject,
                timer,
            });
            const sent = this.nodeRegistry.send(nodeId, {
                type: 'workspace.write.request',
                requestId,
                workspaceRoot,
                relativePath,
                content,
                mode,
            });
            if (!sent) {
                clearTimeout(timer);
                this.pending.delete(requestId);
                reject(new Error('Agent node is offline.'));
            }
        });
    }
    resetWorkspace(nodeId, workspaceRoot) {
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error('Workspace reset timed out.'));
            }, this.timeoutMs);
            this.pending.set(requestId, {
                kind: 'reset',
                nodeId,
                resolve,
                reject,
                timer,
            });
            const sent = this.nodeRegistry.send(nodeId, {
                type: 'workspace.reset.request',
                requestId,
                workspaceRoot,
            });
            if (!sent) {
                clearTimeout(timer);
                this.pending.delete(requestId);
                reject(new Error('Agent node is offline.'));
            }
        });
    }
    handleWorkspaceListResponse(msg) {
        const pending = this.pending.get(msg.requestId);
        if (!pending || pending.kind !== 'list')
            return;
        this.pending.delete(msg.requestId);
        clearTimeout(pending.timer);
        if (msg.error || !msg.entries) {
            pending.reject(new Error(this.formatErrorMessage(msg.errorCode, msg.error)));
            return;
        }
        pending.resolve({
            path: msg.relativePath,
            entries: msg.entries,
        });
    }
    handleWorkspaceReadResponse(msg) {
        const pending = this.pending.get(msg.requestId);
        if (!pending || pending.kind !== 'read')
            return;
        this.pending.delete(msg.requestId);
        clearTimeout(pending.timer);
        if (msg.error || msg.content === undefined || !msg.mimeType || msg.size === undefined) {
            pending.reject(new Error(this.formatErrorMessage(msg.errorCode, msg.error)));
            return;
        }
        pending.resolve({
            path: msg.relativePath,
            content: msg.content,
            mimeType: msg.mimeType,
            size: msg.size,
            modifiedAt: msg.modifiedAt ?? null,
        });
    }
    handleWorkspaceResetResponse(msg) {
        const pending = this.pending.get(msg.requestId);
        if (!pending || pending.kind !== 'reset')
            return;
        this.pending.delete(msg.requestId);
        clearTimeout(pending.timer);
        if (msg.error || !msg.ok) {
            pending.reject(new Error(this.formatErrorMessage(msg.errorCode, msg.error)));
            return;
        }
        pending.resolve();
    }
    handleWorkspaceWriteResponse(msg) {
        const pending = this.pending.get(msg.requestId);
        if (!pending || pending.kind !== 'write')
            return;
        this.pending.delete(msg.requestId);
        clearTimeout(pending.timer);
        if (msg.error || !msg.ok) {
            pending.reject(new Error(this.formatErrorMessage(msg.errorCode, msg.error)));
            return;
        }
        pending.resolve();
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
    formatErrorMessage(errorCode, error) {
        if (errorCode) {
            return `${errorCode}:${error ?? 'workspace request failed'}`;
        }
        return error ?? 'workspace request failed';
    }
}
