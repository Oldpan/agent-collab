import path from 'node:path';
import fs from 'node:fs';

import { openDb, migrate, log } from '@agent-collab/runtime-acp';
import type { CoreToNode } from '@agent-collab/protocol';
import { loadConfig } from './config.js';
import { CoreConnection } from './connection.js';
import { Executor } from './executor.js';
import { listWorkspaceDirectory, readWorkspaceFile, resetWorkspaceDirectory, WorkspaceFsError } from './workspaceFs.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // Ensure DB directory exists
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

  const db = openDb(config.dbPath);
  migrate(db);

  let executor: Executor;

  const handleMessage = (msg: CoreToNode): void => {
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
        } catch (error) {
          connection.send(workspacePathErrorResponse('workspace.list.response', msg.requestId, msg.relativePath, error));
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
        } catch (error) {
          connection.send(workspacePathErrorResponse('workspace.read.response', msg.requestId, msg.relativePath, error));
        }
        break;

      case 'host.close':
        executor.closeHost(msg.hostKey);
        log.info('[agent-node] host closed', { hostKey: msg.hostKey });
        break;

      case 'workspace.reset.request':
        try {
          executor.resetWorkspace(msg.workspaceRoot);
          resetWorkspaceDirectory(msg.workspaceRoot);
          connection.send({
            type: 'workspace.reset.response',
            requestId: msg.requestId,
            workspaceRoot: msg.workspaceRoot,
            ok: true,
          });
        } catch (error) {
          connection.send(workspaceResetErrorResponse(msg.requestId, msg.workspaceRoot, error));
        }
        break;

      default: {
        const _exhaustive: never = msg;
        log.warn('[agent-node] unknown message', _exhaustive);
      }
    }
  };

  const connection = new CoreConnection(config, handleMessage);
  executor = new Executor({ db, config, send: (msg) => connection.send(msg) });

  await connection.connect();
  log.info(`[agent-node] connected to ${config.coreUrl} as ${config.nodeId}`);
  executor.resumePendingDispatches();

  const shutdown = (): void => {
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

function workspacePathErrorResponse(
  type: 'workspace.list.response' | 'workspace.read.response',
  requestId: string,
  relativePath: string,
  error: unknown,
) {
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
    error: String((error as Error)?.message ?? error),
    errorCode: 'io_error' as const,
  };
}

function workspaceResetErrorResponse(
  requestId: string,
  workspaceRoot: string,
  error: unknown,
) {
  if (error instanceof WorkspaceFsError) {
    return {
      type: 'workspace.reset.response' as const,
      requestId,
      workspaceRoot,
      error: error.message,
      errorCode: error.code,
    };
  }

  return {
    type: 'workspace.reset.response' as const,
    requestId,
    workspaceRoot,
    error: String((error as Error)?.message ?? error),
    errorCode: 'io_error' as const,
  };
}
