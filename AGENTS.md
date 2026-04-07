# Repo Notes

- After important code changes, restart the affected local services before considering the task complete. This includes at least `core`, and also `agent-node` / `web` when the change impacts them.
- When restarting `agent-node`, do not start it with a random node identity. Use the existing local-node startup environment:
  - `https_proxy=http://127.0.0.1:7893`
  - `CORE_URL=ws://localhost:3100`
  - `NODE_ID=local-node-1`
  - `NODE_HOSTNAME=H20-253`
