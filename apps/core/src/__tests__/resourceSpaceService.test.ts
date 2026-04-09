import { describe, expect, it } from "vitest";

import type { NodeEntry } from "../services/nodeRegistry.js";
import { NodeRegistry } from "../services/nodeRegistry.js";
import { AgentWorkspaceBroker } from "../services/agentWorkspaceBroker.js";
import { ResourceSpaceService } from "../services/resourceSpaceService.js";

async function waitForSentRequest(
  sentByNode: Map<string, string[]>,
  nodeId: string,
  index = 0,
): Promise<{ requestId: string; scaffold?: boolean }> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    const payload = sentByNode.get(nodeId)?.[index];
    if (payload) {
      return JSON.parse(payload) as { requestId: string; scaffold?: boolean };
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for request ${index} on ${nodeId}`);
}

describe("ResourceSpaceService", () => {
  it("node_path 读取应透传 scaffold=false，避免污染共享目录", async () => {
    const registry = new NodeRegistry();
    const sent: string[] = [];

    registry.register({
      nodeId: "node-1",
      hostname: "host-1",
      agentTypes: ["codex_acp"],
      version: "0.1.0",
      ws: {
        readyState: 1,
        send(payload: string) {
          sent.push(payload);
        },
      } as unknown as NodeEntry["ws"],
      lastSeen: Date.now(),
    });

    const broker = new AgentWorkspaceBroker({ nodeRegistry: registry, timeoutMs: 500 });
    const service = new ResourceSpaceService({
      getResourceSpaceById: () => ({
        resourceSpaceId: "docs-1",
        backendType: "node_path",
        nodeId: "node-1",
        rootPath: "/shared/docs",
      }),
      broker,
      nodeRegistry: registry,
    });

    const promise = service.listTree("docs-1", "");
    const request = JSON.parse(sent[0] ?? "{}") as { requestId: string; scaffold?: boolean };

    expect(request.scaffold).toBe(false);

    broker.handleWorkspaceListResponse({
      type: "workspace.list.response",
      requestId: request.requestId,
      relativePath: "",
      entries: [
        {
          name: "README.md",
          path: "README.md",
          kind: "file",
          size: 12,
          modifiedAt: 123,
        },
      ],
    });

    await expect(promise).resolves.toEqual({
      path: "",
      entries: [
        {
          name: "README.md",
          path: "README.md",
          kind: "file",
          size: 12,
          modifiedAt: 123,
        },
      ],
    });
  });

  it("shared_mount 读取失败时应回退到下一台在线 node", async () => {
    const registry = new NodeRegistry();
    const sentByNode = new Map<string, string[]>();

    const registerNode = (nodeId: string, lastSeen: number) => {
      sentByNode.set(nodeId, []);
      registry.register({
        nodeId,
        hostname: nodeId,
        agentTypes: ["codex_acp"],
        version: "0.1.0",
        ws: {
          readyState: 1,
          send(payload: string) {
            sentByNode.get(nodeId)?.push(payload);
          },
        } as unknown as NodeEntry["ws"],
        lastSeen,
      });
    };

    registerNode("node-a", Date.now() - 1_000);
    registerNode("node-b", Date.now());

    const broker = new AgentWorkspaceBroker({ nodeRegistry: registry, timeoutMs: 500 });
    const service = new ResourceSpaceService({
      getResourceSpaceById: () => ({
        resourceSpaceId: "shared-1",
        backendType: "shared_mount",
        rootPath: "/mnt/shared/experiments",
      }),
      broker,
      nodeRegistry: registry,
    });

    const promise = service.readFile("shared-1", "summary.md");

    const firstRequest = await waitForSentRequest(sentByNode, "node-b");
    broker.handleWorkspaceReadResponse({
      type: "workspace.read.response",
      requestId: firstRequest.requestId,
      relativePath: "summary.md",
      error: "Path not found.",
      errorCode: "not_found",
    });

    const secondRequest = await waitForSentRequest(sentByNode, "node-a");
    expect(secondRequest.scaffold).toBe(false);
    broker.handleWorkspaceReadResponse({
      type: "workspace.read.response",
      requestId: secondRequest.requestId,
      relativePath: "summary.md",
      content: "# Summary\n",
      mimeType: "text/markdown",
      size: 10,
      modifiedAt: 456,
    });

    await expect(promise).resolves.toEqual({
      path: "summary.md",
      content: "# Summary\n",
      mimeType: "text/markdown",
      size: 10,
      modifiedAt: 456,
    });
  });

  it("shared_mount 图片预览遇到旧 node 的 binary_file 时应继续回退", async () => {
    const registry = new NodeRegistry();
    const sentByNode = new Map<string, string[]>();

    const registerNode = (nodeId: string, lastSeen: number) => {
      sentByNode.set(nodeId, []);
      registry.register({
        nodeId,
        hostname: nodeId,
        agentTypes: ["codex_acp"],
        version: "0.1.0",
        ws: {
          readyState: 1,
          send(payload: string) {
            sentByNode.get(nodeId)?.push(payload);
          },
        } as unknown as NodeEntry["ws"],
        lastSeen,
      });
    };

    registerNode("node-newer", Date.now());
    registerNode("node-older", Date.now() - 1_000);

    const broker = new AgentWorkspaceBroker({ nodeRegistry: registry, timeoutMs: 500 });
    const service = new ResourceSpaceService({
      getResourceSpaceById: () => ({
        resourceSpaceId: "shared-images",
        backendType: "shared_mount",
        rootPath: "/mnt/shared/images",
      }),
      broker,
      nodeRegistry: registry,
    });

    const promise = service.readFile("shared-images", "plot.png");

    const firstRequest = await waitForSentRequest(sentByNode, "node-newer");
    broker.handleWorkspaceReadResponse({
      type: "workspace.read.response",
      requestId: firstRequest.requestId,
      relativePath: "plot.png",
      error: "Binary files are not supported for preview.",
      errorCode: "binary_file",
    });

    const secondRequest = await waitForSentRequest(sentByNode, "node-older");
    broker.handleWorkspaceReadResponse({
      type: "workspace.read.response",
      requestId: secondRequest.requestId,
      relativePath: "plot.png",
      content: "data:image/png;base64,AAAA",
      mimeType: "image/png",
      size: 4,
      modifiedAt: 789,
    });

    await expect(promise).resolves.toEqual({
      path: "plot.png",
      content: "data:image/png;base64,AAAA",
      mimeType: "image/png",
      size: 4,
      modifiedAt: 789,
    });
  });

  it("shared_mount 全部失败时应返回包含节点尝试详情的错误", async () => {
    const registry = new NodeRegistry();
    const sentByNode = new Map<string, string[]>();

    const registerNode = (nodeId: string, lastSeen: number) => {
      sentByNode.set(nodeId, []);
      registry.register({
        nodeId,
        hostname: nodeId,
        agentTypes: ["codex_acp"],
        version: "0.1.0",
        ws: {
          readyState: 1,
          send(payload: string) {
            sentByNode.get(nodeId)?.push(payload);
          },
        } as unknown as NodeEntry["ws"],
        lastSeen,
      });
    };

    registerNode("node-a", Date.now());
    registerNode("node-b", Date.now() - 1_000);

    const broker = new AgentWorkspaceBroker({ nodeRegistry: registry, timeoutMs: 500 });
    const service = new ResourceSpaceService({
      getResourceSpaceById: () => ({
        resourceSpaceId: "shared-failure",
        backendType: "shared_mount",
        rootPath: "/mnt/shared/images",
      }),
      broker,
      nodeRegistry: registry,
    });

    const promise = service.readFile("shared-failure", "plot.png");

    const firstRequest = await waitForSentRequest(sentByNode, "node-a");
    broker.handleWorkspaceReadResponse({
      type: "workspace.read.response",
      requestId: firstRequest.requestId,
      relativePath: "plot.png",
      error: "Binary files are not supported for preview.",
      errorCode: "binary_file",
    });

    const secondRequest = await waitForSentRequest(sentByNode, "node-b");
    broker.handleWorkspaceReadResponse({
      type: "workspace.read.response",
      requestId: secondRequest.requestId,
      relativePath: "plot.png",
      error: "Workspace request timed out.",
    });

    await expect(promise).rejects.toThrow(
      'Unable to read shared resource space. Attempts: node-a -> Binary files are not supported for preview. | node-b -> Workspace request timed out.',
    );
  });
});
