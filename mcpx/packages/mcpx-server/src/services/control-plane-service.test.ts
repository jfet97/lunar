import {
  ControlPlaneService,
  sanitizeTargetServerForTelemetry,
} from "./control-plane-service.js";
import { noOpLogger } from "@aigw/core/logging";
import { TargetServer } from "../model/target-servers.js";
import type { TargetServerRequest } from "@mcpx/shared-model";

describe("description-only server updates", () => {
  it.each([
    { type: "stdio", command: "node", args: [], env: {} },
    { type: "sse", url: "https://example.com/sse" },
    { type: "streamable-http", url: "https://example.com/mcp" },
  ] as const)(
    "saves and clears $type descriptions without reconnecting",
    async (config) => {
      const server = {
        ...config,
        name: "docs",
        description: "Original description",
      } as TargetServer;
      const upstream = {
        getTargetServer: jest.fn(() => server),
        updateClientDescription: jest.fn(),
        removeClient: jest.fn(),
        addClient: jest.fn(),
      };
      const service = new ControlPlaneService(
        {} as never,
        upstream as never,
        {} as never,
        { get: () => true } as never,
        {} as never,
        noOpLogger,
      );
      for (const description of ["Updated description", ""]) {
        const payload =
          server.type === "stdio"
            ? { ...server, description }
            : { ...server, description, headers: {} };
        await service.updateTargetServer(payload);
        expect(upstream.updateClientDescription).toHaveBeenLastCalledWith(
          "docs",
          description,
        );
      }
      expect(upstream.removeClient).not.toHaveBeenCalled();
      expect(upstream.addClient).not.toHaveBeenCalled();
    },
  );

  it("keeps the reconnect flow when the connection configuration changes", async () => {
    const server: TargetServer = {
      type: "streamable-http",
      name: "docs",
      url: "https://example.com/mcp",
    };
    const upstream = {
      getTargetServer: jest.fn(() => server),
      updateClientDescription: jest.fn(),
      removeClient: jest.fn(),
      addClient: jest.fn(),
    };
    const service = new ControlPlaneService(
      {} as never,
      upstream as never,
      {} as never,
      { get: () => true } as never,
      {} as never,
      noOpLogger,
    );
    await service.updateTargetServer({
      ...server,
      url: "https://example.com/new/mcp",
    });
    expect(upstream.updateClientDescription).not.toHaveBeenCalled();
    expect(upstream.removeClient).toHaveBeenCalledWith("docs");
    expect(upstream.addClient).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com/new/mcp" }),
    );
  });

  it("replaces remote credentials when the management update clears headers", async () => {
    const existing: TargetServer = {
      type: "streamable-http",
      name: "docs",
      url: "https://old.example/mcp",
      headers: { Authorization: "Bearer old-host-token" },
      catalogItemId: "docs-catalog-item",
    };
    const upstream = {
      getTargetServer: jest.fn(() => existing),
      updateClientDescription: jest.fn(),
      removeClient: jest.fn(),
      addClient: jest.fn(),
    };
    const service = new ControlPlaneService(
      {} as never,
      upstream as never,
      {} as never,
      { get: () => true } as never,
      {} as never,
      noOpLogger,
    );

    await service.updateTargetServer(
      {
        type: "streamable-http",
        name: "docs",
        url: "https://new.example/mcp",
        headers: {},
      },
      { replaceConfiguration: true },
    );

    expect(upstream.addClient).toHaveBeenCalledWith({
      type: "streamable-http",
      name: "docs",
      url: "https://new.example/mcp",
      headers: {},
      catalogItemId: "docs-catalog-item",
    });
    expect(upstream.addClient.mock.calls[0]?.[0]).not.toHaveProperty(
      "headers.Authorization",
    );
  });
});

describe("sanitizeTargetServerForTelemetry", () => {
  it("omits env", () => {
    const server: TargetServerRequest = {
      name: "my-server",
      type: "stdio",
      command: "npx",
      args: ["--flag"],
      env: { SECRET: "value", NORMAL: "ok" },
    };

    const result = sanitizeTargetServerForTelemetry(server);

    expect(result).toEqual({
      name: "my-server",
      type: "stdio",
      command: "npx",
      args: ["--flag"],
    });
  });
});
