import path from 'node:path';

import { acquireProcessLock, openDb, migrate, log } from '@agent-collab/runtime-acp';
import { resolveGatewayHomeDir, loadConfig } from './config.js';
import { ConversationManager } from './web/conversationManager.js';
import { startServer } from './web/server.js';
import { NodeRegistry } from './services/nodeRegistry.js';
import { AgentWorkspaceBroker } from './services/agentWorkspaceBroker.js';
import { reconcileNodeStateOnStartup } from './services/nodeStateReconciler.js';
import { hasAdminUser, createInviteToken } from './services/auth.js';

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
  reconcileNodeStateOnStartup(db);

  // On first startup with no admin user, generate an invite token and print it
  if (!hasAdminUser(db)) {
    const invite = createInviteToken(db);
    const inviteUrl = `http://localhost:${config.webPort}/?invite=${invite.token}`;
    log.info('');
    log.info('═══════════════════════════════════════════════════');
    log.info('  No admin account found. Complete initial setup:');
    log.info(`  ${inviteUrl}`);
    log.info(`  Token expires in 24 hours.`);
    log.info('═══════════════════════════════════════════════════');
    log.info('');
  }

  const nodeRegistry = new NodeRegistry();
  const workspaceBroker = new AgentWorkspaceBroker({ nodeRegistry });
  const manager = new ConversationManager({ db, config, nodeRegistry });
  manager.start();

  await startServer({
    port: config.webPort,
    host: config.webHost,
    conversationManager: manager,
    db,
    nodeRegistry,
    workspaceBroker,
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
