import type { WebSocket } from 'ws';
import type { CoreToNode, NodeInfoRest } from '@agent-collab/protocol';

export type NodeEntry = {
  nodeId: string;
  hostname: string;
  agentTypes: string[];
  version: string;
  terminalBackendAvailable?: boolean;
  ws: WebSocket;
  lastSeen: number;
};

export class NodeRegistry {
  private readonly entries = new Map<string, NodeEntry>();

  register(entry: NodeEntry): void {
    this.entries.set(entry.nodeId, entry);
  }

  unregister(nodeId: string): void {
    this.entries.delete(nodeId);
  }

  getNode(nodeId: string): NodeEntry | undefined {
    return this.entries.get(nodeId);
  }

  listNodes(): NodeInfoRest[] {
    return [...this.entries.values()].map(({ ws: _ws, terminalBackendAvailable, ...rest }) => ({
      ...rest,
      terminalBackendAvailable: Boolean(terminalBackendAvailable),
    }));
  }

  heartbeat(nodeId: string): void {
    const entry = this.entries.get(nodeId);
    if (entry) entry.lastSeen = Date.now();
  }

  send(nodeId: string, msg: CoreToNode): boolean {
    const entry = this.entries.get(nodeId);
    if (!entry || entry.ws.readyState !== 1 /* OPEN */) return false;
    entry.ws.send(JSON.stringify(msg));
    return true;
  }
}
