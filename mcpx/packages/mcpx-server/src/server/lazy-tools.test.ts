import { CallToolRequest, Tool } from "@modelcontextprotocol/sdk/types.js";
import { LAZY_TOOLS, resolveLazyToolRequest } from "./lazy-tools.js";

function request(name: string, args: Record<string, unknown>): CallToolRequest {
  return { method: "tools/call", params: { name, arguments: args } };
}

function tool(name: string, description = "Read a Confluence page"): Tool {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
  };
}

describe("lazy tool discovery", () => {
  it("advertises four tools and does not mark execution read-only", () => {
    expect(LAZY_TOOLS.map((tool) => tool.name)).toEqual([
      "mcpx_list_servers",
      "mcpx_search_tools",
      "mcpx_get_tool_schema",
      "mcpx_call_tool",
    ]);
    expect(
      LAZY_TOOLS.find((tool) => tool.name === "mcpx_call_tool")?.annotations
        ?.readOnlyHint,
    ).toBe(false);
  });

  it("lists server names with bounded existing descriptions and no extra metadata", async () => {
    const result = await resolveLazyToolRequest(
      request("mcpx_list_servers", {}),
      [],
      undefined,
      () => [
        { name: "docs", description: "d".repeat(10000), privateNote: "secret" },
        { name: "custom" },
      ],
    );
    expect(result).toEqual({
      kind: "result",
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              servers: [
                { name: "docs", description: "d".repeat(300) },
                { name: "custom" },
              ],
            }),
          },
        ],
      },
    });
  });

  it("rejects unexpected server-list arguments before retrieving metadata", async () => {
    const listServers = jest.fn(() => []);
    const result = await resolveLazyToolRequest(
      request("mcpx_list_servers", { includeSecrets: true }),
      [],
      undefined,
      listServers,
    );
    expect(result).toMatchObject({ kind: "result", result: { isError: true } });
    expect(listServers).not.toHaveBeenCalled();
  });

  it("bounds discovery output, truncates descriptions, and omits schemas", async () => {
    const catalog = Array.from({ length: 233 }, (_, index) =>
      tool(`confluence__page_${index}`, "x".repeat(10000)),
    );
    const firstTool = catalog[0];
    if (!firstTool) throw new Error("expected a tool in the catalog");
    firstTool.title = "t".repeat(10000);
    firstTool.annotations = {
      title: "a".repeat(10000),
      readOnlyHint: true,
      internalNote: "private".repeat(10000),
    } as NonNullable<Tool["annotations"]>;
    const result = await resolveLazyToolRequest(
      request("mcpx_search_tools", { query: "confluence", limit: 3 }),
      catalog,
    );
    expect(result.kind).toBe("result");
    if (result.kind !== "result") throw new Error("unexpected execution");
    const text = result.result.content[0];
    if (text?.type !== "text") throw new Error("expected discovery text");
    const output = JSON.parse(text.text);
    expect(output.tools).toHaveLength(3);
    expect(
      output.tools.every(
        (entry: { description: string }) => entry.description.length === 300,
      ),
    ).toBe(true);
    expect(text.text).not.toMatch(/inputSchema|outputSchema/);
    expect(output.nextOffset).toBe(3);
    expect(output.totalMatches).toBe(233);
    expect(output.tools[0]).toMatchObject({
      title: "t".repeat(300),
      annotations: { title: "a".repeat(300), readOnlyHint: true },
    });
    expect(text.text).not.toContain("internalNote");
    expect(text.text).not.toContain("private");
  });

  it("can find a tool beyond the first upstream catalog page", async () => {
    const catalog = Array.from({ length: 233 }, (_, index) =>
      tool(`svc__tool_${index}`),
    );
    const result = await resolveLazyToolRequest(
      request("mcpx_search_tools", { query: "svc__tool_200" }),
      catalog,
    );
    expect(result).toMatchObject({
      kind: "result",
      result: {
        content: [
          { type: "text", text: expect.stringContaining("svc__tool_200") },
        ],
      },
    });
    const schema = await resolveLazyToolRequest(
      request("mcpx_get_tool_schema", { name: "svc__tool_200" }),
      catalog,
    );
    expect(schema).toMatchObject({
      kind: "result",
      result: { content: [{ text: JSON.stringify(catalog[200]) }] },
    });
  });

  it.each(["mcpx_get_tool_schema", "mcpx_call_tool"])(
    "does not reveal or execute unavailable tools through %s",
    async (name) => {
      const result = await resolveLazyToolRequest(
        request(name, { name: "denied__secret" }),
        [tool("allowed__read")],
      );
      expect(result).toMatchObject({
        kind: "result",
        result: { isError: true },
      });
      expect(JSON.stringify(result)).not.toContain("denied__secret");
    },
  );

  it("rejects unbounded discovery and invalid execution arguments", async () => {
    for (const args of [
      { query: "page", limit: 999 },
      { query: "" },
      { query: "page", offset: -1 },
    ]) {
      expect(
        await resolveLazyToolRequest(request("mcpx_search_tools", args), []),
      ).toMatchObject({ kind: "result", result: { isError: true } });
    }
    expect(
      await resolveLazyToolRequest(
        request("mcpx_call_tool", { name: "svc__read", arguments: [] }),
        [tool("svc__read")],
      ),
    ).toMatchObject({ kind: "result", result: { isError: true } });
  });

  it("unwraps only visible calls and preserves progress and request metadata", async () => {
    const original = request("mcpx_call_tool", {
      name: "svc__read",
      arguments: { id: "42" },
    });
    original.params._meta = { progressToken: "progress", custom: "value" };
    expect(await resolveLazyToolRequest(original, [tool("svc__read")])).toEqual(
      {
        kind: "call",
        request: {
          method: "tools/call",
          params: {
            name: "svc__read",
            arguments: { id: "42" },
            _meta: original.params._meta,
          },
        },
      },
    );
    expect(
      await resolveLazyToolRequest(request("svc__read", {}), [
        tool("svc__read"),
      ]),
    ).toMatchObject({ kind: "result", result: { isError: true } });
  });
});
