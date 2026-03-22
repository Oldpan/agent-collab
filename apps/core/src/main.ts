import path from 'node:path';

import { acquireProcessLock, openDb, migrate, log } from '@agent-collab/runtime-acp';
import { resolveGatewayHomeDir, loadConfig } from './config.js';
import { ConversationManager } from './web/conversationManager.js';
import { startServer } from './web/server.js';
import { NodeRegistry } from './services/nodeRegistry.js';

async function main(): Promise<void> {
  const gatewayHome = resolveGatewayHomeDir();
  const lock = acquireProcessLock(path.join(gatewayHome, 'gateway.lock'));

  const cleanup = () => {
    lock.release();
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  const config = await loadConfig({ interactiveBootstrap: true });

  const db = openDb(config.dbPath);
  migrate(db);

  const nodeRegistry = new NodeRegistry();
  const manager = new ConversationManager({ db, config, nodeRegistry });
  manager.start();

  await startServer({
    port: config.webPort,
    host: config.webHost,
    conversationManager: manager,
    db,
    nodeRegistry,
  });

  log.info('agent-node started', {
    port: config.webPort,
    host: config.webHost,
    workspaceRoot: config.workspaceRoot,
    dbPath: path.resolve(config.dbPath),
  });

  const shutdown = () => {
    log.warn('Shutting down...');
    manager.close();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main();
