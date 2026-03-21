export class NodeRegistry {
    entries = new Map();
    register(entry) {
        this.entries.set(entry.nodeId, entry);
    }
    unregister(nodeId) {
        this.entries.delete(nodeId);
    }
    getNode(nodeId) {
        return this.entries.get(nodeId);
    }
    listNodes() {
        return [...this.entries.values()].map(({ ws: _ws, ...rest }) => rest);
    }
    heartbeat(nodeId) {
        const entry = this.entries.get(nodeId);
        if (entry)
            entry.lastSeen = Date.now();
    }
    send(nodeId, msg) {
        const entry = this.entries.get(nodeId);
        if (!entry || entry.ws.readyState !== 1 /* OPEN */)
            return false;
        entry.ws.send(JSON.stringify(msg));
        return true;
    }
}
