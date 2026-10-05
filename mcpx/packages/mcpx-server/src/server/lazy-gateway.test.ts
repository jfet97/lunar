import { createServer, Server as HttpServer } from "node:http";
import express, { RequestHandler } from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { noOpLogger } from "@mcpx/toolkit-core/logging";
import { McpxSession } from "../model/sessions.js";
import { BehaviorSetting } from "../services/behavior-service.js";
import { Services } from "../services/services.js";

let buildDownstreamTransportsRouter: (typeof import("./downstream-transports.js"))["buildDownstreamTransportsRouter"];

jest.mock("../services/local-tool-search.js", () => ({
  LocalToolSearch: class {
    async search(tools: Tool[], query: string): Promise<Tool[]> {
      return tools.filter(
        (tool) => tool.name.toLowerCase() === query.toLowerCase(),
      );
    }
  },
}));

interface ToolEntry {
  serverName: string;
  capabilityName: string;
  definition: Tool;
  origin: "internal" | "upstream";
}

interface HarnessOptions {
  entries?: ToolEntry[];
  deniedNames?: Set<string>;
  inactiveServers?: Set<string>;
  hiddenNames?: Set<string>;
  cacheEnabled?: boolean;
  persistedSessions?: Map<string, McpxSession["metadata"]>;
  toolResult?: unknown;
  onCallTool?: (...args: unknown[]) => Promise<unknown>;
}

interface Harness {
  baseUrl: string;
  server: HttpServer;
  sessions: Map<string, McpxSession>;
  upstreamCallTool: jest.Mock;
  auditLog: jest.Mock;
  systemStateTracker: {
    recordToolCall: jest.Mock;
  };
  connectClient: (
    path: "/mcp" | "/mcp/lazy",
    authorization?: string,
  ) => Promise<{
    client: Client;
    transport: StreamableHTTPClientTransport;
  }>;
  close: () => Promise<void>;
  revokeTool: (name: string) => void;
}

const ALLOWED_NAME = "docs__get_page";
const DENIED_NAME = "secrets__read";
const INACTIVE_NAME = "legacy__fetch";
const HIDDEN_NAME = "oauth__grant";

function makeTool(name: string, description = `Read ${name}`): Tool {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  };
}

function makeEntry(
  serverName: string,
  capabilityName: string,
  name: string,
  origin: ToolEntry["origin"] = "upstream",
): ToolEntry {
  return { serverName, capabilityName, definition: makeTool(name), origin };
}

function makeMetadata(): McpxSession["metadata"] {
  return {
    clientId: "restored-client",
    clientInfo: { name: "test-client", protocolVersion: "2025-11-25" },
    isProbe: false,
  };
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const entries = options.entries ?? [
    makeEntry("docs", "get_page", ALLOWED_NAME),
    makeEntry("secrets", "read", DENIED_NAME),
    makeEntry("legacy", "fetch", INACTIVE_NAME),
    makeEntry("oauth", "grant", HIDDEN_NAME, "internal"),
  ];
  const deniedNames = options.deniedNames ?? new Set([DENIED_NAME]);
  const inactiveServers = options.inactiveServers ?? new Set(["legacy"]);
  const hiddenNames = options.hiddenNames ?? new Set([HIDDEN_NAME]);
  const persistedSessions = options.persistedSessions ?? new Map();
  const sessions = new Map<string, McpxSession>();
  const auditLog = jest.fn();
  const recordToolCall = jest.fn();
  const upstreamCallTool = jest.fn(
    options.onCallTool ?? (async () => options.toolResult ?? { content: [] }),
  );
  const sessionsService = {
    addSession: async (
      sessionId: string,
      session: McpxSession,
    ): Promise<void> => {
      sessions.set(sessionId, session);
    },
    getSession: (sessionId: string): McpxSession | undefined =>
      sessions.get(sessionId),
    getConsumerContext: (sessionId: string | undefined) => {
      const session = sessionId ? sessions.get(sessionId) : undefined;
      return {
        sessionId,
        consumerTag: session?.metadata.consumerTag,
        clientName: session?.metadata.clientInfo.name,
      };
    },
    updateSessionMetadata: (
      sessionId: string,
      metadata: McpxSession["metadata"],
    ): void => {
      const session = sessions.get(sessionId);
      if (session) session.metadata = metadata;
    },
    touchSession: jest.fn(),
    markSessionUnresponsive: jest.fn(),
    closeSession: async (sessionId: string): Promise<void> => {
      sessions.delete(sessionId);
    },
    loadPersistedDownstreamSession: async (sessionId: string) => {
      const metadata = persistedSessions.get(sessionId);
      return metadata ? { metadata } : undefined;
    },
  };
  const services = {
    sessions: sessionsService,
    behaviorService: {
      get: (setting: BehaviorSetting): boolean =>
        setting === BehaviorSetting.ENABLE_TOOL_CALL_CACHE &&
        (options.cacheEnabled ?? false),
    },
    capabilityResolver: {
      getPermittedTools: () =>
        entries.filter(
          (entry) =>
            !inactiveServers.has(entry.serverName) &&
            !deniedNames.has(entry.definition.name),
        ),
      resolveToolCall: (name: string) => {
        const entry = entries.find(
          (candidate) => candidate.definition.name === name,
        );
        if (!entry) return { ok: false as const, reason: "unknown" as const };
        if (inactiveServers.has(entry.serverName)) {
          return { ok: false as const, reason: "server-inactive" as const };
        }
        if (deniedNames.has(name)) {
          return { ok: false as const, reason: "permission-denied" as const };
        }
        return { ok: true as const, entry };
      },
    },
    internalCapabilities: {
      visibleToolForListing: (entry: ToolEntry) =>
        hiddenNames.has(entry.definition.name) ? undefined : entry.definition,
      dispatchTool: jest.fn(async () => ({ content: [] })),
      visiblePromptForListing: jest.fn(),
      visibleResourceForListing: jest.fn(),
    },
    upstreamHandler: {
      callTool: upstreamCallTool,
      getPrompt: jest.fn(),
    },
    systemStateTracker: {
      trackActiveCall: async <T>(action: () => Promise<T>): Promise<T> =>
        action(),
      recordToolCall,
      recordPromptGet: jest.fn(),
    },
    auditLog: { log: auditLog },
    metricRecorder: { recordToolCallDuration: jest.fn() },
    hubService: { recordToolCall: jest.fn() },
  } as unknown as Services;

  const app = express();
  app.use(express.json());
  const allowRequests: RequestHandler = (_request, _response, next) => next();
  app.use(buildDownstreamTransportsRouter(allowRequests, services, noOpLogger));
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP listening address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const clients: Client[] = [];

  return {
    baseUrl,
    server,
    sessions,
    upstreamCallTool,
    auditLog,
    systemStateTracker: { recordToolCall },
    connectClient: async (path, authorization = "Bearer test-token") => {
      const client = new Client({ name: "gateway-test", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(
        new URL(path, baseUrl),
        {
          requestInit: {
            headers: {
              Authorization: authorization,
              "x-lunar-consumer-tag": "test-consumer",
            },
          },
        },
      );
      await client.connect(transport);
      clients.push(client);
      return { client, transport };
    },
    close: async () => {
      await Promise.all(
        clients.map((client) => client.close().catch(() => {})),
      );
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
    revokeTool: (name) => deniedNames.add(name),
  };
}

function resultText(result: unknown): string {
  if (
    typeof result !== "object" ||
    result === null ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    throw new Error("Expected a content result from the discovery tool");
  }
  const block = result.content.find(
    (content: unknown) =>
      typeof content === "object" &&
      content !== null &&
      "type" in content &&
      content["type"] === "text",
  );
  if (
    typeof block !== "object" ||
    block === null ||
    !("text" in block) ||
    typeof block["text"] !== "string"
  ) {
    throw new Error("Expected a text result from the discovery tool");
  }
  return block["text"];
}

describe("lazy Streamable HTTP gateway", () => {
  const previousVersion = process.env["VERSION"];
  const previousInstanceId = process.env["INSTANCE_ID"];

  beforeAll(async () => {
    process.env["VERSION"] = "test";
    process.env["INSTANCE_ID"] = "test-instance";
    ({ buildDownstreamTransportsRouter } = await import(
      "./downstream-transports.js"
    ));
  });

  afterAll(() => {
    if (previousVersion === undefined) delete process.env["VERSION"];
    else process.env["VERSION"] = previousVersion;
    if (previousInstanceId === undefined) delete process.env["INSTANCE_ID"];
    else process.env["INSTANCE_ID"] = previousInstanceId;
  });

  it("keeps the full catalog endpoint and advertises only the three lazy tools", async () => {
    const entries = Array.from({ length: 233 }, (_, index) =>
      makeEntry("docs", `tool_${index}`, `docs__tool_${index}`),
    );
    const harness = await makeHarness({ entries });
    try {
      const catalog = await harness.connectClient("/mcp");
      const lazy = await harness.connectClient("/mcp/lazy");

      expect((await catalog.client.listTools()).tools).toHaveLength(233);
      expect(
        (await lazy.client.listTools()).tools.map((tool) => tool.name),
      ).toEqual(["mcpx_search_tools", "mcpx_get_tool_schema", "mcpx_call_tool"]);
    } finally {
      await harness.close();
    }
  });

  it("discovers, forwards an authorized call, and preserves rich tool output", async () => {
    const toolResult = {
      content: [
        { type: "text", text: "Page 42" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        {
          type: "resource",
          resource: {
            uri: "file:///page.txt",
            mimeType: "text/plain",
            text: "body",
          },
        },
      ],
      structuredContent: { page: { id: "42", title: "Example" } },
      isError: true,
      _meta: { source: "upstream" },
    };
    const harness = await makeHarness({ toolResult });
    try {
      const { client } = await harness.connectClient(
        "/mcp/lazy",
        "Bearer caller-token",
      );
      const search = await client.callTool({
        name: "mcpx_search_tools",
        arguments: { query: ALLOWED_NAME },
      });
      expect(JSON.parse(resultText(search)).tools).toEqual([
        expect.objectContaining({ name: ALLOWED_NAME }),
      ]);

      const schema = await client.callTool({
        name: "mcpx_get_tool_schema",
        arguments: { name: ALLOWED_NAME },
      });
      expect(JSON.parse(resultText(schema))).toMatchObject({
        name: ALLOWED_NAME,
        inputSchema: expect.objectContaining({ required: ["id"] }),
      });

      const callMeta = { progressToken: "page-call-1", traceId: "trace-42" };
      const result = await client.callTool({
        name: "mcpx_call_tool",
        arguments: { name: ALLOWED_NAME, arguments: { id: "42" } },
        _meta: callMeta,
      });

      expect(result).toEqual(toolResult);
      expect(harness.upstreamCallTool).toHaveBeenCalledWith("docs", {
        name: "get_page",
        arguments: { id: "42" },
        _meta: { ...callMeta, authorization: "Bearer caller-token" },
      });
      expect(harness.systemStateTracker.recordToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          targetServerName: "docs",
          toolName: "get_page",
        }),
      );
      expect(harness.auditLog).toHaveBeenCalledWith({
        eventType: "tool_used",
        payload: expect.objectContaining({
          targetServerName: "docs",
          toolName: "get_page",
          args: { id: "42" },
          consumerTag: "test-consumer",
        }),
      });
    } finally {
      await harness.close();
    }
  });

  it("does not discover or execute denied, hidden, inactive, or unknown tools", async () => {
    const harness = await makeHarness();
    try {
      const { client } = await harness.connectClient("/mcp/lazy");
      for (const name of [
        DENIED_NAME,
        HIDDEN_NAME,
        INACTIVE_NAME,
        "missing__tool",
      ]) {
        const schema = await client.callTool({
          name: "mcpx_get_tool_schema",
          arguments: { name },
        });
        expect(schema.isError).toBe(true);
        expect(resultText(schema)).not.toContain(name);

        const call = await client.callTool({
          name: "mcpx_call_tool",
          arguments: { name, arguments: { id: "secret" } },
        });
        expect(call.isError).toBe(true);
        expect(resultText(call)).not.toContain(name);
      }

      expect(harness.upstreamCallTool).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("deduplicates concurrent calls and rechecks permissions before a cached replay", async () => {
    let releaseCall: ((value: unknown) => void) | undefined;
    let callStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      callStarted = resolve;
    });
    const pendingResult = new Promise<unknown>((resolve) => {
      releaseCall = resolve;
    });
    const harness = await makeHarness({
      cacheEnabled: true,
      onCallTool: async () => {
        callStarted?.();
        return pendingResult;
      },
    });
    try {
      const { client } = await harness.connectClient("/mcp/lazy");
      const params = {
        name: "mcpx_call_tool",
        arguments: { name: ALLOWED_NAME, arguments: { id: "42" } },
        _meta: { progressToken: "deduplicate-1" },
      };
      const first = client.callTool(params);
      await started;
      const second = client.callTool(params);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(harness.upstreamCallTool).toHaveBeenCalledTimes(1);

      const value = { content: [{ type: "text", text: "done" }] };
      releaseCall?.(value);
      await expect(Promise.all([first, second])).resolves.toEqual([
        value,
        value,
      ]);

      harness.revokeTool(ALLOWED_NAME);
      const replay = await client.callTool(params);
      expect(replay.isError).toBe(true);
      expect(harness.upstreamCallTool).toHaveBeenCalledTimes(1);
    } finally {
      releaseCall?.({ content: [] });
      await harness.close();
    }
  });

  it("rejects catalog sessions when addressed through the lazy endpoint", async () => {
    const harness = await makeHarness();
    try {
      const { transport } = await harness.connectClient("/mcp");
      const sessionId = transport.sessionId;
      if (!sessionId)
        throw new Error("Catalog client did not receive a session id");
      const headers = {
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId,
      };

      const post = await fetch(`${harness.baseUrl}/mcp/lazy`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      const get = await fetch(`${harness.baseUrl}/mcp/lazy`, {
        method: "GET",
        headers: { "Mcp-Session-Id": sessionId, Accept: "text/event-stream" },
      });
      const del = await fetch(`${harness.baseUrl}/mcp/lazy`, {
        method: "DELETE",
        headers: { "Mcp-Session-Id": sessionId },
      });

      expect([post.status, get.status, del.status]).toEqual([400, 400, 400]);
    } finally {
      await harness.close();
    }
  });

  it("restores only through the endpoint recorded on the persisted session", async () => {
    const metadata = { ...makeMetadata(), toolMode: "lazy" as const };
    const persistedSessions = new Map([["lazy-session", metadata]]);
    const harness = await makeHarness({ persistedSessions });
    try {
      const wrongMode = await fetch(`${harness.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Mcp-Session-Id": "lazy-session",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(wrongMode.status).toBe(400);

      const correctMode = await fetch(`${harness.baseUrl}/mcp/lazy`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Mcp-Session-Id": "lazy-session",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 2 }),
      });
      expect(correctMode.status).toBe(200);
      expect(harness.sessions.get("lazy-session")?.metadata.toolMode).toBe(
        "lazy",
      );
    } finally {
      await harness.close();
    }
  });
});
