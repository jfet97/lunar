import { noOpLogger } from "@aigw/core/logging";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CapabilityRegistry, tagTools } from "./capability-registry.js";
import { ActiveTool } from "./capability-resolver.js";
import {
  HiddenInternalCapabilityError,
  InternalCapabilitiesService,
  wireInternalCapabilityProvider,
} from "./internal-capabilities-service.js";
import { ManagementToolsService } from "./management-tools.js";
import type { Services } from "./services.js";

function fixture() {
  const saveResult = {
    success: true,
    savedSetupId: "setup-id",
    description: "small",
    savedAt: "2026-10-06T00:00:00.000Z",
  };
  const server = {
    name: "docs",
    type: "streamable-http",
    url: "https://example.com/mcp?token=private",
    headers: { Authorization: "private-header" },
  };
  const setup = {
    targetServers: { docs: server },
    config: { private: "secret" },
  };
  const services = {
    controlPlane: {
      addTargetServer: jest.fn().mockResolvedValue(server),
      updateTargetServer: jest.fn().mockResolvedValue(server),
      removeTargetServer: jest.fn().mockResolvedValue(undefined),
      getSystemState: () => ({
        targetServers: [
          {
            ...server,
            _type: server.type,
            state: { type: "pending-auth" },
            oauth: true,
          },
        ],
      }),
      getAppConfig: () => ({ yaml: "private: secret" }),
      config: {
        getTargetServerAttributes: () => ({ docs: { inactive: true } }),
        activateTargetServer: jest.fn().mockResolvedValue(undefined),
        deactivateTargetServer: jest.fn().mockResolvedValue(undefined),
      },
    },
    upstreamHandler: {
      servers: [server],
      getTargetServer: jest.fn((name) =>
        name === "docs" ? server : undefined,
      ),
      initiateOAuthForServer: jest.fn().mockResolvedValue({
        authorizationUrl: "https://example.com/authorize?state=state",
        userCode: "ABCD",
      }),
      logoutOAuthForServer: jest.fn().mockResolvedValue(undefined),
      reconnectServer: jest.fn().mockResolvedValue(true),
    },
    setupManager: { captureCurrentSetup: jest.fn(() => setup) },
    localSavedSetups: { save: jest.fn().mockResolvedValue(saveResult) },
    hubService: {
      savedSetups: { saveSetup: jest.fn().mockResolvedValue(saveResult) },
    },
    localExportService: {
      create: jest.fn().mockResolvedValue({
        backupId: "large",
        destination: "/backups/large",
        included: ["tokens"],
        omitted: [{ item: "compose", reason: "unavailable" }],
      }),
    },
  };
  const allowed = jest.fn(() => true);
  const hub = jest.fn(() => false);
  const internal = new InternalCapabilitiesService(noOpLogger);
  const registry = new CapabilityRegistry(noOpLogger);
  const provider = new ManagementToolsService(
    services as unknown as Services,
    { hasPermission: allowed },
    hub,
    "http://localhost:9523/auth/callback",
    noOpLogger,
  );
  wireInternalCapabilityProvider(provider, internal, registry);
  const tools = registry.servers.get("mcpx")!.tools!;
  const entry = (name: string): ActiveTool => {
    const tool = tools.find(({ definition }) => definition.name === name)!;
    return {
      serverName: "mcpx",
      capabilityName: name,
      origin: "internal",
      definition: { ...tool.definition, name: `mcpx__${name}` },
    };
  };
  const call = (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<CallToolResult> =>
    internal.dispatchTool(entry(name), args, {
      clientName: "client",
      consumerTag: "owner",
    }) as Promise<CallToolResult>;
  return {
    services,
    allowed,
    hub,
    internal,
    registry,
    provider,
    tools,
    entry,
    call,
    server,
    setup,
  };
}

function json(response: CallToolResult) {
  const first = response.content[0];
  if (first?.type !== "text") throw new Error("Expected text");
  return JSON.parse(first.text);
}

describe("built-in management tools", () => {
  it("advertises ten schemas and destructive annotations", () => {
    const { tools } = fixture();
    expect(tools).toHaveLength(10);
    for (const { definition } of tools)
      expect(definition.inputSchema.type).toBe("object");
    expect(
      tools.find((t) => t.definition.name === "management_remove_server")
        ?.definition.annotations?.destructiveHint,
    ).toBe(true);
    expect(
      tools.find((t) => t.definition.name === "management_list_servers")
        ?.definition.annotations?.readOnlyHint,
    ).toBe(true);
  });

  it("lists disabled and pending-auth servers without credential-bearing configuration", async () => {
    const { call } = fixture();
    const response = await call("management_list_servers");
    expect(json(response)).toEqual({
      servers: [
        {
          name: "docs",
          transport: "streamable-http",
          enabled: false,
          state: "pending-auth",
          oauth: true,
        },
      ],
    });
    expect(JSON.stringify(response)).not.toMatch(
      /private|Authorization|example\.com/,
    );
  });

  it.each(["add", "update"])(
    "%s passes validated configuration to the control plane without echoing it",
    async (action) => {
      const { call, services } = fixture();
      const config = {
        type: "stdio",
        command: "npx",
        args: ["my-server"],
        env: { TOKEN: "private" },
      };
      const response = await call(`management_${action}_server`, {
        name: " Docs ",
        config,
      });
      const method =
        action === "add"
          ? services.controlPlane.addTargetServer
          : services.controlPlane.updateTargetServer;
      if (action === "add") {
        expect(method).toHaveBeenCalledWith({ ...config, name: "docs" });
      } else {
        expect(method).toHaveBeenCalledWith(
          { ...config, name: "docs" },
          { replaceConfiguration: true },
        );
      }
      expect(JSON.stringify(response)).not.toContain("private");
      expect(response.isError).toBeUndefined();
    },
  );

  it("clears omitted remote headers when replacing an MCP server", async () => {
    const { call, services } = fixture();
    const response = await call("management_update_server", {
      name: "docs",
      config: { type: "streamable-http", url: "https://new.example/mcp" },
    });
    expect(response.isError).toBeUndefined();
    expect(services.controlPlane.updateTargetServer).toHaveBeenCalledWith(
      {
        name: "docs",
        type: "streamable-http",
        url: "https://new.example/mcp",
        headers: {},
      },
      { replaceConfiguration: true },
    );
  });

  it.each(["enable", "disable"])(
    "%s preserves the server and credentials",
    async (action) => {
      const { call, services } = fixture();
      const response = await call(`management_${action}_server`, {
        name: "DOCS",
      });
      expect(json(response)).toEqual({
        name: "docs",
        enabled: action === "enable",
      });
      expect(
        action === "enable"
          ? services.controlPlane.config.activateTargetServer
          : services.controlPlane.config.deactivateTargetServer,
      ).toHaveBeenCalledWith("docs");
      expect(services.controlPlane.removeTargetServer).not.toHaveBeenCalled();
      expect(
        services.upstreamHandler.logoutOAuthForServer,
      ).not.toHaveBeenCalled();
    },
  );

  it("does not create inactive configuration entries for nonexistent servers", async () => {
    const { call, services } = fixture();
    expect(
      (await call("management_disable_server", { name: "missing" })).isError,
    ).toBe(true);
    expect(
      services.controlPlane.config.deactivateTargetServer,
    ).not.toHaveBeenCalled();
  });

  it("reconnects a failed server without replacing configuration or logging out", async () => {
    const { call, services } = fixture();
    expect(
      json(await call("management_reconnect_server", { name: "DOCS" })),
    ).toEqual({ name: "docs", retried: true });
    expect(services.upstreamHandler.reconnectServer).toHaveBeenCalledWith(
      "docs",
    );
    expect(services.controlPlane.updateTargetServer).not.toHaveBeenCalled();
    expect(services.controlPlane.removeTargetServer).not.toHaveBeenCalled();
    expect(
      services.upstreamHandler.logoutOAuthForServer,
    ).not.toHaveBeenCalled();
  });

  it.each(["local", "hub"])(
    "routes small backups to the %s owner",
    async (owner) => {
      const { call, services, hub, setup } = fixture();
      hub.mockReturnValue(owner === "hub");
      const response = await call("management_create_backup", {
        mode: "setup",
        description: "small",
      });
      expect(response.isError).toBeUndefined();
      if (owner === "local") {
        expect(services.localSavedSetups.save).toHaveBeenCalledWith(
          "small",
          setup,
        );
        expect(
          services.hubService.savedSetups.saveSetup,
        ).not.toHaveBeenCalled();
      } else {
        expect(services.hubService.savedSetups.saveSetup).toHaveBeenCalledWith({
          ...setup,
          description: "small",
        });
        expect(services.localSavedSetups.save).not.toHaveBeenCalled();
      }
      expect(JSON.stringify(response)).not.toContain("secret");
      expect(services.localExportService.create).not.toHaveBeenCalled();
    },
  );

  it("creates a full export and reports omissions", async () => {
    const { call, services, server } = fixture();
    const response = await call("management_create_backup", { mode: "full" });
    expect(services.localExportService.create).toHaveBeenCalledWith({
      effectiveAppConfig: "private: secret",
      effectiveTargetServers: [server],
    });
    expect(json(response).omitted).toEqual([
      { item: "compose", reason: "unavailable" },
    ]);
    expect(services.localSavedSetups.save).not.toHaveBeenCalled();
  });

  it("returns a browser login URL and device code, then logs out without deletion", async () => {
    const { call, services } = fixture();
    expect(
      json(await call("management_login_server", { name: "docs" })),
    ).toMatchObject({
      authorizationUrl: expect.stringContaining("authorize"),
      userCode: "ABCD",
    });
    expect(
      services.upstreamHandler.initiateOAuthForServer,
    ).toHaveBeenCalledWith("docs", "http://localhost:9523/auth/callback");
    expect(
      json(await call("management_logout_server", { name: "docs" })),
    ).toEqual({ name: "docs", loggedOut: true });
    expect(services.upstreamHandler.logoutOAuthForServer).toHaveBeenCalledWith(
      "docs",
    );
    expect(services.controlPlane.removeTargetServer).not.toHaveBeenCalled();
  });

  it("deletes through the existing control plane", async () => {
    const { call, services } = fixture();
    expect(
      json(await call("management_remove_server", { name: "docs" })),
    ).toEqual({ name: "docs", removed: true });
    expect(services.controlPlane.removeTargetServer).toHaveBeenCalledWith(
      "docs",
      { strict: true },
    );
  });

  it("enforces consumer permissions for both listing and execution", async () => {
    const { call, allowed, internal, entry, services } = fixture();
    allowed.mockReturnValue(false);
    expect(
      internal.visibleToolForListing(entry("management_logout_server"), {
        consumerTag: "blocked",
      }),
    ).toBeUndefined();
    await expect(
      call("management_logout_server", { name: "docs" }),
    ).rejects.toBeInstanceOf(HiddenInternalCapabilityError);
    expect(
      services.upstreamHandler.logoutOAuthForServer,
    ).not.toHaveBeenCalled();
    expect(allowed).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceName: "mcpx",
        capabilityName: "management_logout_server",
        consumerTag: "owner",
        clientName: "client",
      }),
    );
  });

  it.each([
    "add",
    "enable",
    "disable",
    "reconnect",
    "remove",
    "login",
    "logout",
  ])("rejects %s targeting the reserved mcpx server", async (action) => {
    const { call } = fixture();
    const response = await call(`management_${action}_server`, {
      name: " MCPX ",
      ...(action === "add"
        ? { config: { type: "sse", url: "https://example.com" } }
        : {}),
    });
    expect(response.isError).toBe(true);
    expect(json(response).message).toContain("Invalid");
  });

  it("does not echo secrets in failures or allow arbitrary backup destinations", async () => {
    const { call, services } = fixture();
    services.controlPlane.addTargetServer.mockRejectedValue(
      new Error("private secret Authorization"),
    );
    const failed = await call("management_add_server", {
      name: "docs",
      config: { type: "sse", url: "https://example.com" },
    });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toMatch(/private|secret|Authorization/);
    expect(
      (
        await call("management_create_backup", {
          mode: "full",
          destination: "/etc",
        })
      ).isError,
    ).toBe(true);
    expect(services.localExportService.create).not.toHaveBeenCalled();
  });

  it("retains existing built-in dynamic tools when management is registered", () => {
    const { provider } = fixture();
    const registry = new CapabilityRegistry(noOpLogger);
    registry.registerServer("mcpx", {
      tools: tagTools(
        [{ name: "get_new_capabilities", inputSchema: { type: "object" } }],
        "internal",
      ),
    });
    wireInternalCapabilityProvider(
      provider,
      new InternalCapabilitiesService(noOpLogger),
      registry,
    );
    expect(registry.servers.get("mcpx")?.tools).toHaveLength(11);
    expect(registry.servers.get("mcpx")?.tools?.[0]?.definition.name).toBe(
      "get_new_capabilities",
    );
  });
});
