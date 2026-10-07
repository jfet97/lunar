import express from "express";
import { createServer, type Server } from "node:http";
import { buildJsonBodyRouter, MCP_REQUEST_BODY_LIMIT_BYTES } from "./json-body.js";

describe("MCP JSON request limits", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    const app = express();
    app.use(buildJsonBodyRouter());
    app.post(/.*/, (req, res) => res.json({ characters: req.body.data.length }));
    app.use(((error, _req, res, _next) => {
      res.sendStatus(error.status ?? 500);
    }) as express.ErrorRequestHandler);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  });

  async function post(path: string, characters: number): Promise<Response> {
    return fetch(baseUrl + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: "x".repeat(characters) }),
    });
  }

  it.each(["/mcp", "/mcp/lazy"])("accepts a base64-sized media request on %s", async (path) => {
    const characters = 12 * 1024 * 1024;
    const response = await post(path, characters);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ characters });
  });

  it("rejects requests above the bounded MCP limit", async () => {
    const response = await post("/mcp", MCP_REQUEST_BODY_LIMIT_BYTES);
    expect(response.status).toBe(413);
  });

  it.each(["/config", "/admin", "/mcpx"])("retains the ordinary JSON limit on %s", async (path) => {
    const response = await post(path, 150 * 1024);
    expect(response.status).toBe(413);
  });
});
