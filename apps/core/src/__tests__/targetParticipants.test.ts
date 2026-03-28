import { describe, it, expect } from 'vitest';
import { createTestDb, createTestConfig } from './helpers.js';
import { ConversationManager } from '../web/conversationManager.js';
import { listTargetParticipants, upsertTargetParticipant } from '../web/targetParticipants.js';

describe('targetParticipants', () => {
  it('应记录并按 owner 优先返回 thread participants', () => {
    const db = createTestDb();
    const manager = new ConversationManager({ db, config: createTestConfig() });
    manager.start();

    const alice = manager.createAgent({
      name: 'AliceTP',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/alice-tp',
    });
    const bob = manager.createAgent({
      name: 'BobTP',
      agentType: 'claude_acp',
      nodeId: 'node-1',
      workspacePath: '/tmp/bob-tp',
    });

    upsertTargetParticipant(db, {
      agentId: bob.agentId,
      channelId: 'default',
      threadRootId: 'abcd1234',
      role: 'participant',
      lastActiveAt: 10,
    });
    upsertTargetParticipant(db, {
      agentId: alice.agentId,
      channelId: 'default',
      threadRootId: 'abcd1234',
      role: 'owner',
      lastActiveAt: 5,
    });

    const participants = listTargetParticipants(db, {
      channelId: 'default',
      threadRootId: 'abcd1234',
    });

    expect(participants.map((participant) => participant.name)).toEqual(['AliceTP', 'BobTP']);
    expect(participants.map((participant) => participant.role)).toEqual(['owner', 'participant']);

    manager.close();
    db.close();
  });
});
