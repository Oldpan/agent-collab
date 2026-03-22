import path from 'node:path';
import fs from 'node:fs';
import { openDb, migrate, log } from '@agent-collab/runtime-acp';
import { loadConfig } from './config.js';
import { CoreConnection } from './connection.js';
import { Executor } from './executor.js';
import { listWorkspaceDirectory, readWorkspaceFile, WorkspaceFsError } from './workspaceFs.js';
async function main() {
    const config = loadConfig();
    // Ensure DB directory exists
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    const db = openDb(config.dbPath);
    migrate(db);
    let executor;
    const handleMessage = (msg) => {
        switch (msg.type) {
            case 'node.ack':
                log.info(`[agent-node] registered with core as ${msg.nodeId}`);
                break;
            case 'run.dispatch':
                executor.dispatch(msg).catch((err) => {
                    log.warn('[agent-node] dispatch error', err);
                });
                break;
            case 'run.cancel':
                executor.cancelRun(msg.runId).then((handled) => {
                    if (!handled) {
                        log.warn('[agent-node] run.cancel had no active runtime', msg.runId);
                    }
                }).catch((err) => {
                    log.warn('[agent-node] run.cancel error', err);
                });
                break;
            case 'permission.response':
                executor.handlePermissionResponse(msg.requestId, msg.decision).then((handled) => {
                    if (!handled) {
                        log.warn('[agent-node] permission.response had no pending request', msg.requestId);
                    }
                }).catch((err) => {
                    log.warn('[agent-node] permission.response error', err);
                });
                break;
            case 'workspace.list.request':
                try {
                    const result = listWorkspaceDirectory(msg.workspaceRoot, msg.relativePath);
                    connection.send({
                        type: 'workspace.list.response',
                        requestId: msg.requestId,
                        relativePath: result.relativePath,
                        entries: result.entries,
                    });
                }
                catch (error) {
                    connection.send(workspaceErrorResponse('workspace.list.response', msg.requestId, msg.relativePath, error));
                }
                break;
            case 'workspace.read.request':
                try {
                    const result = readWorkspaceFile(msg.workspaceRoot, msg.relativePath);
                    connection.send({
                        type: 'workspace.read.response',
                        requestId: msg.requestId,
                        relativePath: result.relativePath,
                        content: result.content,
                        mimeType: result.mimeType,
                        size: result.size,
                        modifiedAt: result.modifiedAt,
                    });
                }
                catch (error) {
                    connection.send(workspaceErrorResponse('workspace.read.response', msg.requestId, msg.relativePath, error));
                }
                break;
            default: {
                const _exhaustive = msg;
                log.warn('[agent-node] unknown message', _exhaustive);
            }
        }
    };
    const connection = new CoreConnection(config, handleMessage);
    executor = new Executor({ db, config, send: (msg) => connection.send(msg) });
    await connection.connect();
    log.info(`[agent-node] connected to ${config.coreUrl} as ${config.nodeId}`);
    executor.resumePendingDispatches();
    const shutdown = () => {
        log.warn('[agent-node] shutting down');
        executor.close();
        connection.close();
        db.close();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
await main();
function workspaceErrorResponse(type, requestId, relativePath, error) {
    if (error instanceof WorkspaceFsError) {
        return {
            type,
            requestId,
            relativePath,
            error: error.message,
            errorCode: error.code,
        };
    }
    return {
        type,
        requestId,
        relativePath,
        error: String(error?.message ?? error),
        errorCode: 'io_error',
    };
}
