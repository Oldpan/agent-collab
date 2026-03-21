import WebSocket from 'ws';
import type { AgentNodeConfig } from './config.js';
import type { CoreToNode, NodeToCore } from '@agent-collab/protocol';

export type MessageHandler = (msg: CoreToNode) => void;

export class CoreConnection {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly config: AgentNodeConfig;
  private readonly onMessage: MessageHandler;

  constructor(config: AgentNodeConfig, onMessage: MessageHandler) {
    this.config = config;
    this.onMessage = onMessage;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${this.config.coreUrl}/api/nodes/connect`;
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
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

        resolve();
      });

      this.ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw)) as CoreToNode;
          this.onMessage(msg);
        } catch {
          // ignore parse errors
        }
      });

      this.ws.on('error', reject);

      this.ws.on('close', () => {
        this.stopHeartbeat();
      });
    });
  }

  send(msg: NodeToCore): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    this.stopHeartbeat();
    this.ws?.close();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
