npm i -g @zed-industries/claude-code-acp@latest
npm i -g @zed-industries/codex-acp@latest


echo "==> [update-node] pnpm install"
pnpm install --frozen-lockfile

# 3. Build in dependency order
echo "==> [update-node] build protocol"
pnpm --filter @agent-collab/protocol build

echo "==> [update-node] build runtime-acp"
pnpm --filter @agent-collab/runtime-acp build

echo "==> [update-node] build agent-node"
pnpm --filter @agent-collab/agent-node build

echo "==> [update-node] rebuild better-sqlite3"
cd node_modules/.pnpm/better-sqlite3@12.8.0/node_modules/better-sqlite3
npx node-gyp rebuild
cd ../../../../..