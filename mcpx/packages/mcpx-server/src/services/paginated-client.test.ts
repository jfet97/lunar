import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListToolsResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { PaginatedClient } from "./paginated-client.js";

function tool(name: string): Tool {
  return {
    name,
    inputSchema: { type: "object" },
    outputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
  };
}

async function fixture(list: (cursor: string | undefined) => ListToolsResult) {
  const server = new Server(
    { name: "paginated-upstream", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  const cursors: (string | undefined)[] = [];
  server.setRequestHandler(ListToolsRequestSchema, (request) => {
    cursors.push(request.params?.cursor);
    return list(request.params?.cursor);
  });
  server.setRequestHandler(CallToolRequestSchema, (request) => ({
    content: [{ type: "text", text: "ok" }],
    structuredContent: { value: request.params.name === "tool-0" ? 42 : "ok" },
  }));
  const client = new PaginatedClient({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    cursors,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

describe("PaginatedClient", () => {
  it("collects later-page tools and caches validators from every page", async () => {
    const tools = Array.from({ length: 101 }, (_, i) => tool(`tool-${i}`));
    const upstream = await fixture((cursor) => {
      const start = cursor === undefined ? 0 : Number(cursor);
      return {
        tools: tools.slice(start, start + 50),
        ...(start + 50 < tools.length
          ? { nextCursor: String(start + 50) }
          : {}),
      };
    });
    try {
      const result = await upstream.client.listTools();
      expect(result.tools).toEqual(tools);
      expect(result.nextCursor).toBeUndefined();
      expect(upstream.cursors).toEqual([undefined, "50", "100"]);
      await expect(
        upstream.client.callTool({ name: "tool-0" }),
      ).rejects.toThrow(/does not match the tool's output schema/i);
      const response = await upstream.client.callTool({ name: "tool-100" });
      expect(response.structuredContent).toEqual({ value: "ok" });
    } finally {
      await upstream.close();
    }
  });

  it("preserves a single-page response and its metadata", async () => {
    const page = { tools: [tool("single")], _meta: { source: "fixture" } };
    const upstream = await fixture(() => page);
    try {
      expect(await upstream.client.listTools()).toEqual(page);
      expect(upstream.cursors).toEqual([undefined]);
    } finally {
      await upstream.close();
    }
  });

  it("follows empty and repeated opaque cursors", async () => {
    let page = 0;
    const upstream = await fixture(() => ({
      tools: [tool(`page-${page}`)],
      ...(page++ < 2 ? { nextCursor: "" } : {}),
    }));
    try {
      expect((await upstream.client.listTools()).tools).toHaveLength(3);
      expect(upstream.cursors).toEqual([undefined, "", ""]);
    } finally {
      await upstream.close();
    }
  });

  it("fails explicitly when an upstream never finishes pagination", async () => {
    const upstream = await fixture(() => ({ tools: [], nextCursor: "more" }));
    try {
      await expect(upstream.client.listTools()).rejects.toThrow(
        "Upstream tools/list exceeded 1000 pages",
      );
      expect(upstream.cursors).toHaveLength(1000);
    } finally {
      await upstream.close();
    }
  });
});
