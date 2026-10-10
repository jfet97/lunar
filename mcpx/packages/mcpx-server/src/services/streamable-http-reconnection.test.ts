import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  createUpstreamHttpTransport,
  upstreamStreamReconnectionOptions,
} from "./streamable-http-reconnection.js";

jest.setTimeout(15_000);

async function waitFor(check: () => boolean, timeout = 7_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for stream state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("upstream HTTP notification recovery", () => {
  let server: http.Server;
  let client: Client;
  let url: URL;
  let getRequests: number;
  let unsupported: boolean;
  let offlineUntil: number;
  let holdRequests: boolean;
  let notifications: number;
  let errors: Error[];
  let streams: Set<http.ServerResponse>;

  beforeEach(async () => {
    getRequests = 0;
    unsupported = false;
    offlineUntil = 0;
    holdRequests = false;
    notifications = 0;
    errors = [];
    streams = new Set();
    server = http.createServer((request, response) => {
      if (request.method === "GET") {
        getRequests++;
        if (holdRequests) return;
        if (unsupported || Date.now() < offlineUntil) {
          response.writeHead(unsupported ? 405 : 503).end();
          return;
        }
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        response.write(": ready\n\n");
        streams.add(response);
        response.on("close", () => streams.delete(response));
        return;
      }
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        const message = JSON.parse(body) as { id?: number; method: string };
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: "2025-03-26",
                capabilities: { tools: { listChanged: true } },
                serverInfo: { name: "stream-recovery-test", version: "1" },
              }
            : {};
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected TCP address");
    url = new URL(`http://127.0.0.1:${address.port}/mcp`);
    client = new Client({ name: "recovery-test", version: "1" });
    client.onerror = (error) => {
      errors.push(error);
    };
    client.setNotificationHandler(
      ToolListChangedNotificationSchema,
      async () => {
        notifications++;
      },
    );
  });

  afterEach(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function changed(): void {
    for (const stream of streams) {
      stream.write(
        'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n',
      );
    }
  }

  it("accepts unsupported optional GET without retrying a healthy server", async () => {
    unsupported = true;
    await client.connect(createUpstreamHttpTransport(url, {}));
    await waitFor(() => getRequests === 1);
    await client.ping();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(getRequests).toBe(1);
    expect(errors).toEqual([]);
  });

  it("restores notifications after an outage longer than the SDK default retry budget", async () => {
    await client.connect(createUpstreamHttpTransport(url, {}));
    await waitFor(() => streams.size === 1);
    offlineUntil = Date.now() + 4_000;
    for (const stream of streams) stream.destroy();
    streams.clear();
    await client.ping();
    await waitFor(() => streams.size === 1);
    changed();
    await waitFor(() => notifications === 1);
    expect(getRequests).toBeGreaterThan(3);
    expect(
      errors.some((error) =>
        error.message.startsWith("Maximum reconnection attempts"),
      ),
    ).toBe(false);
  });

  it("reopens a cleanly closed notification stream", async () => {
    await client.connect(createUpstreamHttpTransport(url, {}));
    await waitFor(() => streams.size === 1);
    for (const stream of streams) stream.end();
    streams.clear();
    await waitFor(() => streams.size === 1);
    changed();
    await waitFor(() => notifications === 1);
    expect(getRequests).toBe(2);
  });

  it("sends no further requests after closing during a reconnect", async () => {
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        reconnectionOptions: {
          ...upstreamStreamReconnectionOptions,
          initialReconnectionDelay: 5,
          maxReconnectionDelay: 5,
          reconnectionDelayGrowFactor: 1,
        },
      }),
    );
    await waitFor(() => streams.size === 1);
    holdRequests = true;
    for (const stream of streams) stream.destroy();
    streams.clear();
    await waitFor(() => getRequests === 2);
    await client.close();
    const count = getRequests;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(getRequests).toBe(count);
    expect(streams.size).toBe(0);
  });
});
