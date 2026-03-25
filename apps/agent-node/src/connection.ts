import WebSocket from 'ws';
import type { AgentNodeConfig } from './config.js';
import type { CoreToNode, NodeToCore } from '@agent-collab/protocol';
import { log } from '@agent-collab/runtime-acp';

export type MessageHandler = (msg: CoreToNode) => void;

type ConnectionHooks = {
  onConnected?: () => void;
  onDisconnected?: () => void;
};

export class CoreConnection {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly config: AgentNodeConfig;
  private readonly onMessage: MessageHandler;
  private readonly hooks: ConnectionHooks;
  private connectPromise: Promise<void> | null = null;
  private resolveInitialConnect: (() => void) | null = null;
  private connecting = false;
  private connected = false;
  private closed = false;
  private reconnectDelayMs: number;

  constructor(config: AgentNodeConfig, onMessage: MessageHandler, hooks: ConnectionHooks = {}) {
    this.config = config;
    this.onMessage = onMessage;
    this.hooks = hooks;
    this.reconnectDelayMs = config.reconnectInitialDelayMs;
  }

  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;

    this.closed = false;
    this.connectPromise = new Promise((resolve) => {
      this.resolveInitialConnect = resolve;
      this.openSocket();
    });
    return this.connectPromise;
  }

  send(msg: NodeToCore): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    this.closed = true;
    this.stopReconnect();
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
    this.connected = false;
    this.connecting = false;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private stopReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private openSocket(): void {
    if (this.closed || this.connecting || this.connected) return;

    this.connecting = true;
    const url = `${this.config.coreUrl}/api/nodes/connect`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      if (this.closed || this.ws !== ws) return;

      this.connecting = false;
      this.connected = true;
      this.reconnectDelayMs = this.config.reconnectInitialDelayMs;

      this.send({
        type: 'node.register',
        nodeId: this.config.nodeId,
        hostname: this.config.hostname,
        agentTypes: this.config.agentTypes,
        version: this.config.version,
      });

      this.heartbeatTimer = setInterval(() => {
        this.send({ type: 'node.heartbeat', nodeId: this.config.nodeId });
      }, this.config.heartbeatIntervalMs);

      if (this.resolveInitialConnect) {
        this.resolveInitialConnect();
        this.resolveInitialConnect = null;
      }

      this.hooks.onConnected?.();
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as CoreToNode;
        this.onMessage(msg);
      } catch {
        // ignore parse errors
      }
    });

    ws.on('error', (error) => {
      if (this.ws !== ws) return;
      log.warn('[agent-node] core connection error', error);
    });

    ws.on('close', () => {
      if (this.ws !== ws) return;

      const wasConnected = this.connected;
      this.stopHeartbeat();
      this.ws = null;
      this.connected = false;
      this.connecting = false;

      if (wasConnected) {
        this.hooks.onDisconnected?.();
      }

      if (!this.closed) {
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;

    const baseDelay = this.reconnectDelayMs;
    const jitter = Math.floor(baseDelay * 0.2 * Math.random());
    const delay = baseDelay + jitter;
    this.reconnectDelayMs = Math.min(baseDelay * 2, this.config.reconnectMaxDelayMs);

    log.warn('[agent-node] reconnecting to core', {
      coreUrl: this.config.coreUrl,
      delayMs: delay,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }
}
