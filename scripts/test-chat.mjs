#!/usr/bin/env node
/**
 * 模拟前端测试脚本
 * 用法:
 *   node scripts/test-chat.mjs                        # 创建本地对话并发消息
 *   node scripts/test-chat.mjs --nodeId local-node-1  # 使用远端节点
 *   node scripts/test-chat.mjs --convId <id>          # 复用已有对话
 *
 * 环境变量:
 *   CORE_URL=http://localhost:3100  (默认)
 *   PROMPT="你好"                   (默认)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
// ws lives in pnpm's content-addressable store — resolve from project root
const WebSocket = require('/ai/code/agi/agent-collab/node_modules/.pnpm/ws@8.19.0/node_modules/ws');

const CORE_URL = process.env.CORE_URL ?? 'http://localhost:3100';
const WS_URL = CORE_URL.replace(/^http/, 'ws');

// 解析命令行参数
const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
};
const nodeId = getArg('--nodeId');
const existingConvId = getArg('--convId');
const prompt = process.env.PROMPT ?? '你好，你是谁？';

async function createConversation() {
  const body = { agentType: 'claude_acp' };
  if (nodeId) body.nodeId = nodeId;

  const res = await fetch(`${CORE_URL}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Create conversation failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  let convId = existingConvId;

  if (!convId) {
    const conv = await createConversation();
    convId = conv.id;
    console.log(`[created] conversation ${convId}${nodeId ? ` → node ${nodeId}` : ' (local)'}`);
  } else {
    console.log(`[reuse] conversation ${convId}`);
  }

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}/api/conversations/${convId}/stream`);
    let historyDone = false;

    ws.on('open', () => {
      console.log('[ws] connected');
    });

    ws.on('message', (raw) => {
      const event = JSON.parse(String(raw));

      // 历史回放完成后发送 prompt
      if (event.type === 'history.complete') {
        historyDone = true;
        console.log(`[ws] history complete, sending prompt: "${prompt}"`);
        ws.send(JSON.stringify({ type: 'prompt', text: prompt }));
        return;
      }

      // 打印所有事件（跳过历史回放的冗余事件）
      if (!historyDone && event.type !== 'conversation.status') {
        console.log(`[history] ${JSON.stringify(event)}`);
        return;
      }

      switch (event.type) {
        case 'conversation.status':
          console.log(`[status] ${event.status}`);
          break;
        case 'turn.begin':
          console.log(`[turn.begin] ${event.turnId}`);
          break;
        case 'content.delta':
          process.stdout.write(event.text ?? '');
          break;
        case 'thinking.delta':
          process.stdout.write(`\x1b[2m${event.text ?? ''}\x1b[0m`); // dim
          break;
        case 'tool.call':
          console.log(`\n[tool] ${event.name}(${JSON.stringify(event.input)})`);
          break;
        case 'tool.result':
          console.log(`[tool.result] ${JSON.stringify(event.output).slice(0, 200)}`);
          break;
        case 'approval.request':
          console.log(`[approval] tool=${event.toolName} requestId=${event.requestId}`);
          // 自动允许（测试用）
          ws.send(JSON.stringify({ type: 'approval.response', requestId: event.requestId, decision: 'allow' }));
          break;
        case 'turn.end':
          console.log(`\n[turn.end] stopReason=${event.stopReason}`);
          ws.close();
          resolve();
          break;
        case 'error':
          console.error(`[error] ${event.message}`);
          ws.close();
          reject(new Error(event.message));
          break;
        default:
          console.log(`[event] ${JSON.stringify(event)}`);
      }
    });

    ws.on('error', (err) => {
      console.error('[ws error]', err.message);
      reject(err);
    });

    ws.on('close', () => {
      console.log('[ws] closed');
      resolve();
    });

    // 超时保护
    setTimeout(() => {
      console.error('[timeout] no turn.end received in 120s');
      ws.close();
      reject(new Error('timeout'));
    }, 120_000);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
