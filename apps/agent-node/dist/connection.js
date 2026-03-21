import WebSocket from 'ws';
export class CoreConnection {
    ws = null;
    heartbeatTimer = null;
    config;
    onMessage;
    constructor(config, onMessage) {
        this.config = config;
        this.onMessage = onMessage;
    }
    connect() {
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
                    const msg = JSON.parse(String(raw));
                    this.onMessage(msg);
                }
                catch {
                    // ignore parse errors
                }
            });
            this.ws.on('error', reject);
            this.ws.on('close', () => {
                this.stopHeartbeat();
            });
        });
    }
    send(msg) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }
    close() {
        this.stopHeartbeat();
        this.ws?.close();
    }
    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
}
