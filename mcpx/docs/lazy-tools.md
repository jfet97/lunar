# On-demand tool discovery

Connect an MCP client to `http://localhost:9000/mcp/lazy` to expose three tools
instead of the complete upstream catalog. This endpoint is built into MCPX and
uses the same authentication, upstream connections, permissions, and sessions.
The existing `/mcp` and `/sse` endpoints remain available for clients that need
the complete catalog and for administration.

## Discovery and execution

1. Call `search_tools` with service/task keywords. It returns five matches by
   default, including names, short descriptions, and tool annotations.
2. Call `get_tool_schema` with one returned name to obtain its full definition.
3. Call `call_tool` with that name and an `arguments` object matching its schema.

Search results omit argument and output schemas. `limit` is capped at 20;
`offset` and `nextOffset` allow bounded browsing. An exact tool name selects that
tool directly. Tool names returned by discovery are the same qualified names
advertised by the full endpoint.

Search, schema lookup, and execution check the caller's current permitted tool
set. Cached embeddings do not grant access. Execution goes through the ordinary
gateway path, including authorization forwarding, audit records, metrics, and
correlated-call deduplication. Original tool results are returned unchanged.
Sessions cannot be reused between the full and lazy endpoints.

## Local semantic retrieval

The Docker image includes a pinned, quantized
`Xenova/paraphrase-multilingual-MiniLM-L12-v2` model. Semantic retrieval runs
locally on CPU through ONNX WebAssembly and combines its ranking with keyword
matches. It needs no inference API, account, or additional service. Model files
are downloaded and checked during the image build; inference uses local files.

Tool embeddings are computed when needed and persisted in
`.mcpx/tool-embeddings.json`, in the existing state volume. Changed definitions
are re-embedded. Query embeddings stay in memory. Searches use keyword ranking
if the embedding runtime is unavailable and emit a gateway warning.

## Client configuration

For Codex:

```toml
[mcp_servers.mcpx]
url = "http://localhost:9000/mcp/lazy"
startup_timeout_sec = 60
```

For Claude Code:

```json
{
  "mcpServers": {
    "mcpx": {
      "type": "http",
      "url": "http://localhost:9000/mcp/lazy"
    }
  }
}
```

Reconnect the client after changing its endpoint. A running conversation may
retain earlier tool definitions. Update workflow guides that assume upstream
tools are directly advertised: their names now belong in `call_tool` arguments.
Client permission rules see the generic execution tool; MCPX permissions still
apply to the underlying target. The execution wrapper is conservatively marked
as potentially destructive and is not marked read-only.
