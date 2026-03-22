import {
  BindingRuntime,
  ToolAuth,
  createRun,
  createSession,
  finishRun,
  getSession,
  upsertBinding,
  getUiMode,
  log,
} from '@agent-collab/runtime-acp';
import type { Db, UiMode } from '@agent-collab/runtime-acp';
import type { RunDispatchMsg, NodeToCore } from '@agent-collab/protocol';
import type { AgentNodeConfig } from './config.js';
import { NodeSink } from './nodeSink.js';

type SendFn = (msg: NodeToCore) => void;

export class Executor {
  private readonly db: Db;
  private readonly config: AgentNodeConfig;
  private readonly toolAuth: ToolAuth;
  private readonly runtimes = new Map<string, BindingRuntime>();
  private readonly send: SendFn;

  constructor(params: { db: Db; config: AgentNodeConfig; send: SendFn }) {
    this.db = params.db;
    this.config = params.config;
    this.toolAuth = new ToolAuth(params.db);
    this.send = params.send;
  }

  async dispatch(msg: RunDispatchMsg): Promise<void> {
    const { runId, conversationId, sessionKey, prompt } = msg;
    const bindingKey = `node:${conversationId}:-:node_user`;

    log.info('[executor] dispatch received', { runId, conversationId, sessionKey });

    // Ensure local session row exists (bindings has FK → sessions)
    const existingSession = getSession(this.db, sessionKey);
    if (!existingSession) {
      createSession(this.db, {
        sessionKey,
        agentCommand: this.config.acpAgentCommand,
        agentArgs: this.config.acpAgentArgs,
        cwd: msg.workspacePath ?? this.config.workspaceRoot,
        loadSupported: false,
      });
      log.debug('[executor] created local session', { sessionKey, conversationId });
    }

    // Ensure binding exists
    upsertBinding(
      this.db,
      { platform: 'node', chatId: conversationId, threadId: null, userId: 'node_user' },
      sessionKey,
    );

    const sess = getSession(this.db, sessionKey)!;

    let runtime = this.runtimes.get(sessionKey);
    if (!runtime) {
      runtime = new BindingRuntime({
        db: this.db,
        config: this.config,
        toolAuth: this.toolAuth,
        sessionKey,
        bindingKey,
        workspaceRoot: msg.workspacePath ?? this.config.workspaceRoot,
        agentCommand: this.config.acpAgentCommand,
        agentArgs: this.config.acpAgentArgs,
        env: msg.envVars,
      });
      this.runtimes.set(sessionKey, runtime);
    }

    const sink = new NodeSink(runId, conversationId, this.send);
    createRun(this.db, { runId, sessionKey, promptText: prompt });

    // Signal turn lifecycle to core
    this.send({
      type: 'run.event',
      runId,
      conversationId,
      event: { type: 'turn.begin', turnId: runId },
    });
    this.send({
      type: 'run.event',
      runId,
      conversationId,
      event: { type: 'conversation.status', conversationId, status: 'busy' },
    });

    try {
      const uiMode: UiMode = getUiMode(this.db, bindingKey) ?? 'summary';
      const result = await runtime.prompt({
        runId,
        promptText: prompt,
        sink,
        uiMode,
        actorUserId: 'node_user',
      });
      finishRun(this.db, { runId, stopReason: result.stopReason });
      log.info('[executor] run finished', { runId, conversationId, stopReason: result.stopReason });
      this.send({ type: 'run.end', runId, conversationId, stopReason: result.stopReason });
    } catch (error: any) {
      const errMsg = String(error?.message ?? error);
      log.warn('[executor] run error', { runId, conversationId, error: errMsg });
      finishRun(this.db, { runId, error: errMsg });
      this.send({ type: 'run.end', runId, conversationId, error: errMsg });
    }
  }

  close(): void {
    for (const rt of this.runtimes.values()) {
      rt.close();
    }
    this.runtimes.clear();
  }
}
