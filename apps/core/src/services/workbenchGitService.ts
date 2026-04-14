import type {
  WorkbenchGitAction,
  WorkbenchGitActionResult,
  WorkbenchGitDiffMode,
  WorkbenchGitDiffResult,
  WorkbenchGitStatusResult,
} from '@agent-collab/protocol';
import type { ResolvedWorkbenchRoot } from './workbenchRootService.js';
import { WorkbenchGitBroker } from './workbenchGitBroker.js';

export class WorkbenchGitServiceError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export class WorkbenchGitService {
  private readonly broker: WorkbenchGitBroker;

  constructor(params: { broker: WorkbenchGitBroker }) {
    this.broker = params.broker;
  }

  async getStatus(root: ResolvedWorkbenchRoot): Promise<WorkbenchGitStatusResult> {
    ensureProjectRoot(root);
    try {
      return await this.broker.getGitStatus(root.nodeId!, root.rootPath);
    } catch (error) {
      throw mapWorkbenchGitError(error);
    }
  }

  async getDiff(root: ResolvedWorkbenchRoot, mode: WorkbenchGitDiffMode): Promise<WorkbenchGitDiffResult> {
    ensureProjectRoot(root);
    try {
      return await this.broker.getGitDiff(root.nodeId!, root.rootPath, mode);
    } catch (error) {
      throw mapWorkbenchGitError(error);
    }
  }

  async runAction(
    root: ResolvedWorkbenchRoot,
    action: WorkbenchGitAction,
    commitMessage?: string,
  ): Promise<WorkbenchGitActionResult> {
    ensureProjectRoot(root);
    try {
      return await this.broker.runGitAction(root.nodeId!, root.rootPath, action, commitMessage);
    } catch (error) {
      throw mapWorkbenchGitError(error);
    }
  }
}

function ensureProjectRoot(root: ResolvedWorkbenchRoot): void {
  if (root.kind !== 'project_space') {
    throw new WorkbenchGitServiceError(409, 'Git changes are only available for project roots.');
  }
  if (!root.nodeId) {
    throw new WorkbenchGitServiceError(409, 'Project root is not bound to a remote node.');
  }
}

function mapWorkbenchGitError(error: unknown): WorkbenchGitServiceError {
  const message = String((error as Error)?.message ?? error);

  if (message === 'Agent node is offline.' || message.startsWith('Agent node disconnected:')) {
    return new WorkbenchGitServiceError(409, message);
  }
  if (message.includes('request timed out.')) {
    return new WorkbenchGitServiceError(504, message);
  }
  if (message.startsWith('not_found:')) {
    return new WorkbenchGitServiceError(404, message.slice('not_found:'.length));
  }
  if (message.startsWith('not_directory:')) {
    return new WorkbenchGitServiceError(400, message.slice('not_directory:'.length));
  }
  if (message.startsWith('io_error:')) {
    return new WorkbenchGitServiceError(500, message.slice('io_error:'.length));
  }
  return new WorkbenchGitServiceError(500, message);
}
