import path from 'node:path';
import fs from 'node:fs';

import { openDb, migrate, log, WorkspaceLockManager } from '@agent-collab/runtime-acp';
import type { CoreToNode } from '@agent-collab/protocol';
import { loadConfig } from './config.js';
import { CoreConnection } from './connection.js';
import { Executor } from './executor.js';
import { ensureNativeSkillMounts } from './nativeSkillMounts.js';
import {
  CodexTranscriptFsError,
  listCodexTranscriptFiles,
  readCodexTranscriptFile,
} from './codexTranscriptFs.js';
import {
  listWorkspaceDirectory,
  readWorkspaceFile,
  resetWorkspaceDirectory,
  writeWorkspaceFile,
  WorkspaceFsError,
} from './workspaceFs.js';
import { listSkills, readSkillFile } from './skillFs.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // Ensure DB directory exists
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

  const db = openDb(config.dbPath);
  migrate(db);
  const workspaceLockManager = new WorkspaceLockManager();

  let executor: Executor;

  const handleMessage = (msg: CoreToNode): void => {
    void (async () => {
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

      case 'skills.list.request':
        try {
          syncNativeSkillsFromRequest(msg);
          const result = listSkills(msg.skillRoots, msg.path);
          connection.send({
            type: 'skills.list.response',
            requestId: msg.requestId,
            roots: result.roots,
            path: result.path,
            skills: result.skills,
            entries: result.entries,
          });
        } catch (error) {
          connection.send(skillListErrorResponse(msg.requestId, msg.skillRoots, msg.path ?? null, error));
        }
        break;

      case 'skills.read.request':
        try {
          syncNativeSkillsFromRequest(msg);
          const result = readSkillFile(msg.skillRoots, msg.path);
          connection.send({
            type: 'skills.read.response',
            requestId: msg.requestId,
            path: result.path,
            content: result.content,
            mimeType: result.mimeType,
            size: result.size,
            modifiedAt: result.modifiedAt,
          });
        } catch (error) {
          connection.send(skillReadErrorResponse(msg.requestId, msg.path, error));
        }
        break;

      case 'codex.transcript.list.request':
        try {
          const result = listCodexTranscriptFiles(msg.maxFiles);
          connection.send({
            type: 'codex.transcript.list.response',
            requestId: msg.requestId,
            rootPath: result.rootPath,
            files: result.files,
            truncated: result.truncated,
          });
        } catch (error) {
          connection.send(codexTranscriptListErrorResponse(msg.requestId, error));
        }
        break;

      case 'codex.transcript.read.request':
        try {
          const result = readCodexTranscriptFile(msg.path);
          connection.send({
            type: 'codex.transcript.read.response',
            requestId: msg.requestId,
            rootPath: result.rootPath,
            path: result.path,
            content: result.content,
            size: result.size,
            modifiedAt: result.modifiedAt,
          });
        } catch (error) {
          connection.send(codexTranscriptReadErrorResponse(msg.requestId, msg.path, error));
        }
        break;

      case 'workspace.write.request':
        try {
          const result = await workspaceLockManager.runExclusive(msg.workspaceRoot, async () =>
            writeWorkspaceFile(msg.workspaceRoot, msg.relativePath, msg.content, msg.mode),
          );
          connection.send({
            type: 'workspace.write.response',
            requestId: msg.requestId,
            relativePath: result.relativePath,
            ok: true,
            modifiedAt: result.modifiedAt,
          });
        } catch (error) {
          connection.send(workspaceWriteErrorResponse(msg.requestId, msg.relativePath, error));
        }
        break;

      case 'host.close':
        executor.closeHost(msg.hostKey);
        log.info('[agent-node] host closed', { hostKey: msg.hostKey });
        break;

      case 'workspace.reset.request':
        try {
          executor.resetWorkspace(msg.workspaceRoot);
          await workspaceLockManager.runExclusive(msg.workspaceRoot, async () => {
            resetWorkspaceDirectory(msg.workspaceRoot);
          });
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
    })().catch((error) => {
      log.warn('[agent-node] message handler error', {
        type: msg.type,
        error: String((error as Error)?.message ?? error),
      });
    });
  };

  const connection = new CoreConnection(config, handleMessage, {
    onConnected: () => {
      log.info(`[agent-node] connected to ${config.coreUrl} as ${config.nodeId}`);
      executor.resumePendingDispatches();
    },
    onDisconnected: () => {
      log.warn('[agent-node] disconnected from core, waiting to reconnect');
    },
  });
  executor = new Executor({
    db,
    config,
    send: (msg) => connection.send(msg),
    workspaceLockManager,
  });

  await connection.connect();

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

function syncNativeSkillsFromRequest(
  msg: Extract<CoreToNode, { type: 'skills.list.request' | 'skills.read.request' }>,
): void {
  if (!msg.agentType || !msg.workspaceRoot) return;
  ensureNativeSkillMounts({
    agentType: msg.agentType,
    workspaceRoot: msg.workspaceRoot,
    skillRoots: msg.skillRoots,
  });
}

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

function workspaceWriteErrorResponse(
  requestId: string,
  relativePath: string,
  error: unknown,
) {
  if (error instanceof WorkspaceFsError) {
    return {
      type: 'workspace.write.response' as const,
      requestId,
      relativePath,
      error: error.message,
      errorCode: error.code,
    };
  }

  return {
    type: 'workspace.write.response' as const,
    requestId,
    relativePath,
    error: String((error as Error)?.message ?? error),
    errorCode: 'io_error' as const,
  };
}

function skillListErrorResponse(
  requestId: string,
  skillRoots: string[],
  skillPath: string | null,
  error: unknown,
) {
  if (error instanceof WorkspaceFsError) {
    return {
      type: 'skills.list.response' as const,
      requestId,
      roots: skillRoots,
      path: skillPath,
      error: error.message,
      errorCode: error.code,
    };
  }

  return {
    type: 'skills.list.response' as const,
    requestId,
    roots: skillRoots,
    path: skillPath,
    error: String((error as Error)?.message ?? error),
    errorCode: 'io_error' as const,
  };
}

function skillReadErrorResponse(
  requestId: string,
  skillPath: string,
  error: unknown,
) {
  if (error instanceof WorkspaceFsError) {
    return {
      type: 'skills.read.response' as const,
      requestId,
      path: skillPath,
      error: error.message,
      errorCode: error.code,
    };
  }

  return {
    type: 'skills.read.response' as const,
    requestId,
    path: skillPath,
    error: String((error as Error)?.message ?? error),
    errorCode: 'io_error' as const,
  };
}

function codexTranscriptListErrorResponse(
  requestId: string,
  error: unknown,
) {
  if (error instanceof CodexTranscriptFsError) {
    return {
      type: 'codex.transcript.list.response' as const,
      requestId,
      error: error.message,
      errorCode: error.code,
    };
  }

  return {
    type: 'codex.transcript.list.response' as const,
    requestId,
    error: String((error as Error)?.message ?? error),
    errorCode: 'io_error' as const,
  };
}

function codexTranscriptReadErrorResponse(
  requestId: string,
  transcriptPath: string,
  error: unknown,
) {
  if (error instanceof CodexTranscriptFsError) {
    return {
      type: 'codex.transcript.read.response' as const,
      requestId,
      path: transcriptPath,
      error: error.message,
      errorCode: error.code,
    };
  }

  return {
    type: 'codex.transcript.read.response' as const,
    requestId,
    path: transcriptPath,
    error: String((error as Error)?.message ?? error),
    errorCode: 'io_error' as const,
  };
}
