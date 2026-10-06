import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { noOpLogger } from "@aigw/core/logging";
import { ManualClock } from "@aigw/core/time";
import { ConfigService, DEFAULT_CONFIG } from "../config.js";
import { resetEnv } from "../env.js";
import type { RemoteTargetServer } from "../model/target-servers.js";
import { OAuthSessionManager } from "../server/oauth-session-manager.js";
import { CapabilityRegistry } from "./capability-registry.js";
import { CapabilityResolver } from "./capability-resolver.js";
import { DiskTokenStore } from "./disk-token-store.js";
import { OAuthConnectionHandler } from "./oauth-connection-handler.js";
import { SystemStateTracker } from "./system-state.js";
import { ToolTokenEstimator } from "./tool-token-estimator.js";
import { UpstreamHandler } from "./upstream-handler.js";
import type { ExtendedClientI } from "./client-extension.js";
import { ControlPlaneService } from "./control-plane-service.js";
import {
  InternalCapabilitiesService,
  wireInternalCapabilityProvider,
} from "./internal-capabilities-service.js";
import { ManagementToolsService } from "./management-tools.js";

describe("upstream OAuth logout", () => {
  let directory: string;
  let originalEnvironment: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnvironment = { ...process.env };
    process.env["VERSION"] = "test";
    process.env["INSTANCE_ID"] = "test-instance";
    process.env["ENABLE_PROMPT_CAPABILITY"] = "true";
    resetEnv();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "mcpx-logout-"));
  });

  afterEach(async () => {
    process.env = originalEnvironment;
    resetEnv({
      ...process.env,
      VERSION: process.env["VERSION"] ?? "test",
      INSTANCE_ID: process.env["INSTANCE_ID"] ?? "test-instance",
    });
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function makeHarness(serverName = "docs") {
    const targetServer: RemoteTargetServer = {
      name: serverName,
      type: "streamable-http",
      url: "https://example.com/mcp",
      description: "Documentation",
    };
    const config = new ConfigService(
      DEFAULT_CONFIG,
      { load: () => ({ success: true, data: DEFAULT_CONFIG }), save: () => {} },
      noOpLogger,
    );
    await config.initialize();
    const catalog = {
      subscribe: () => () => {},
      getCatalog: () => [],
      getDisplayNameByName: () => undefined,
      getDisplayNameById: () => undefined,
      isServerApproved: () => true,
      isToolApproved: () => true,
      isPromptApproved: () => true,
      getPerCatalogItemOAuth: () => undefined,
    };
    const registry = new CapabilityRegistry(noOpLogger);
    const resolver = new CapabilityResolver(
      registry,
      catalog as never,
      { hasPermission: () => true },
      noOpLogger,
    );
    const state = new SystemStateTracker(new ManualClock(), noOpLogger);
    const store = new DiskTokenStore(directory, noOpLogger);
    const sessions = new OAuthSessionManager(
      noOpLogger,
      store,
      { resolveOauthCredential: () => undefined },
      catalog as never,
    );
    const provider = sessions.getOrCreateOAuthProvider({
      serverName,
      serverUrl: targetServer.url,
    });
    await provider.saveTokens({
      access_token: "old-token",
      refresh_token: "old-refresh",
      token_type: "bearer",
    });
    await provider.saveCodeVerifier("old-verifier");
    await provider.saveClientInformation?.({
      client_id: "old-client",
      redirect_uris: [],
    });
    const extended = {
      close: jest.fn(async () => {}),
      onToolsListChanged: () => () => {},
      onPromptsListChanged: () => () => {},
      listTools: jest.fn(async () => ({
        tools: [
          { name: "read", inputSchema: { type: "object", properties: {} } },
        ],
        toolParentNames: {},
      })),
      listPrompts: async () => ({ prompts: [] }),
      callTool: jest.fn(async () => ({ content: [] })),
      getPrompt: jest.fn(async () => ({ messages: [] })),
    };
    const oauth = new OAuthConnectionHandler(
      sessions,
      { build: async () => extended } as never,
      noOpLogger,
      {
        discoverOAuthProtectedResourceMetadata: async () => {
          throw new Error("No metadata");
        },
        discoverAuthorizationServerMetadata: async () => undefined,
        auth: async (freshProvider) => {
          await freshProvider.redirectToAuthorization(
            new URL("https://example.com/login"),
          );
          return "REDIRECT";
        },
      },
    );
    const writeConfig = jest.fn();
    const upstream = new UpstreamHandler(
      state,
      { writeTargetServers: writeConfig } as never,
      { createConnection: async () => extended } as never,
      oauth,
      catalog as never,
      new ToolTokenEstimator(),
      registry,
      resolver,
      config,
      noOpLogger,
      {
        pingIntervalMs: 0,
        pingTimeoutMs: 100,
        pingFailureThreshold: 3,
        reconnectBaseDelayMs: 10,
      },
    );
    await upstream.addClient(targetServer);
    return {
      targetServer,
      upstream,
      extended,
      writeConfig,
      store,
      sessions,
      provider,
      registry,
      resolver,
      state,
      config,
      oauth,
    };
  }

  async function callManagementRemove(
    harness: Awaited<ReturnType<typeof makeHarness>>,
  ) {
    const controlPlane = new ControlPlaneService(
      harness.state,
      harness.upstream,
      harness.config,
      { get: () => true } as never,
      { log: jest.fn() } as never,
      noOpLogger,
    );
    const internal = new InternalCapabilitiesService(noOpLogger);
    const provider = new ManagementToolsService(
      {
        controlPlane,
        upstreamHandler: harness.upstream,
        setupManager: {} as never,
        localSavedSetups: {} as never,
        localExportService: {} as never,
        hubService: {} as never,
      } as never,
      { hasPermission: () => true },
      () => false,
      "http://localhost:9523/auth/callback",
      noOpLogger,
    );
    wireInternalCapabilityProvider(provider, internal, harness.registry);
    const entry = {
      serverName: "mcpx",
      capabilityName: "management_remove_server",
      origin: "internal" as const,
      definition: {
        ...harness.registry.servers
          .get("mcpx")!
          .tools!.find(
            ({ definition }) => definition.name === "management_remove_server",
          )!.definition,
        name: "mcpx__management_remove_server",
      },
    };
    return internal.dispatchTool(entry, { name: "docs" }, {});
  }

  function getToolResponseJson(response: {
    content: Array<{ type: string; text?: string }>;
  }): Record<string, unknown> {
    const text = response.content.find((item) => item.type === "text")?.text;
    if (!text) throw new Error("Expected a text tool result");
    return JSON.parse(text) as Record<string, unknown>;
  }

  it.each(["docs", "Docs"])(
    "clears credentials and callbacks for %s, retains config and allows fresh login",
    async (serverName) => {
      const harness = await makeHarness(serverName);
      try {
        harness.sessions.startOAuthFlow(
          serverName,
          harness.targetServer.url,
          "old-state",
        );
        expect(harness.resolver.resolveToolCall("docs__read", {}).ok).toBe(
          true,
        );
        expect(harness.state.export().targetServers[0]).toMatchObject({
          oauth: true,
        });
        const writes = harness.writeConfig.mock.calls.length;
        await harness.upstream.logoutOAuthForServer("  Docs ");
        expect(harness.extended.close).toHaveBeenCalled();
        expect(await fs.readdir(directory)).toEqual([]);
        expect(harness.sessions.getOAuthFlow("old-state")).toBeUndefined();
        expect(harness.resolver.resolveToolCall("docs__read", {}).ok).toBe(
          false,
        );
        expect(
          harness.registry.servers
            .get("docs")
            ?.tools?.every((tool) => tool.origin === "internal"),
        ).toBe(true);
        expect(harness.state.export().targetServers[0]?.state).toEqual({
          type: "pending-auth",
        });
        expect(harness.upstream.servers).toEqual([harness.targetServer]);
        expect(harness.writeConfig).toHaveBeenCalledTimes(writes);
        await expect(
          harness.upstream.callTool("docs", { name: "read" }),
        ).rejects.toThrow();
        await expect(
          harness.provider.saveTokens({
            access_token: "late-token",
            token_type: "bearer",
          }),
        ).rejects.toThrow("authentication was cleared");
        const login = await harness.upstream.initiateOAuthForServer("docs");
        expect(new URL(login.authorizationUrl).pathname).toBe("/login");
        expect(harness.sessions.getOAuthFlow(login.state)).toBeDefined();
      } finally {
        await harness.upstream.shutdown();
        harness.resolver.shutdown();
        harness.state.stopRetentionSweep();
      }
    },
  );

  it("rejects an old device-flow completion after a description edit and logout", async () => {
    const harness = await makeHarness();
    let onComplete!: (client: ExtendedClientI) => void | Promise<void>;
    jest
      .spyOn(harness.oauth, "initiateOAuth")
      .mockImplementation(async (_target, options) => {
        if (!options?.onComplete)
          throw new Error("Missing completion callback");
        onComplete = options.onComplete;
        return {
          authorizationUrl: "https://example.com/login",
          state: "old-state",
        };
      });
    try {
      await harness.upstream.initiateOAuthForServer("docs");
      harness.upstream.updateClientDescription("docs", "Updated description");
      await harness.upstream.logoutOAuthForServer("docs");
      await expect(
        onComplete(harness.extended as unknown as ExtendedClientI),
      ).rejects.toThrow("was logged out");
      expect(harness.resolver.resolveToolCall("docs__read", {}).ok).toBe(false);
      expect(harness.state.export().targetServers[0]?.state).toEqual({
        type: "pending-auth",
      });
    } finally {
      await harness.upstream.shutdown();
      harness.resolver.shutdown();
      harness.state.stopRetentionSweep();
    }
  });

  it("reports deletion failures and permits retry without reconnecting", async () => {
    const harness = await makeHarness();
    const deletion = jest
      .spyOn(harness.store, "deleteAll")
      .mockRejectedValue(new Error("Unable to delete credentials"));
    try {
      await expect(
        harness.upstream.logoutOAuthForServer("docs"),
      ).rejects.toThrow("Unable to delete credentials");
      expect(harness.resolver.resolveToolCall("docs__read", {}).ok).toBe(false);
      deletion.mockRestore();
      await harness.upstream.logoutOAuthForServer("docs");
      expect(await fs.readdir(directory)).toEqual([]);
    } finally {
      await harness.upstream.shutdown();
      harness.resolver.shutdown();
      harness.state.stopRetentionSweep();
    }
  });

  it.each(["close", "persistence", "token deletion"] as const)(
    "returns a management tool error when strict removal fails during %s",
    async (failure) => {
      const harness = await makeHarness();
      try {
        if (failure === "close") {
          harness.extended.close.mockRejectedValue(
            new Error("Unable to close connection"),
          );
        } else if (failure === "persistence") {
          harness.writeConfig.mockImplementation(() => {
            throw new Error("Unable to persist server configuration");
          });
        } else {
          jest
            .spyOn(harness.store, "deleteAll")
            .mockRejectedValue(new Error("Unable to delete credentials"));
        }

        const response = await callManagementRemove(harness);
        expect(response.isError).toBe(true);
        expect(getToolResponseJson(response as never)).not.toHaveProperty(
          "removed",
          true,
        );
        expect(harness.upstream.servers).toHaveLength(1);
        expect(harness.upstream.servers).toHaveLength(1);
      } finally {
        await harness.upstream.shutdown();
        harness.resolver.shutdown();
        harness.state.stopRetentionSweep();
      }
    },
  );

  it.each(["docs", "Docs"] as const)(
    "confirms management removal and clears credentials for configured name %s",
    async (serverName) => {
      const harness = await makeHarness(serverName);
      const deleteTokens = jest.spyOn(
        harness.oauth,
        "deleteOAuthTokensForServer",
      );
      try {
        const response = await callManagementRemove(harness);
        expect(response.isError).toBeUndefined();
        expect(getToolResponseJson(response as never)).toEqual({
          name: "docs",
          removed: true,
        });
        expect(deleteTokens).toHaveBeenCalledWith(serverName);
        expect(harness.upstream.servers).toEqual([]);
        expect(await fs.readdir(directory)).toEqual([]);
      } finally {
        await harness.upstream.shutdown();
        harness.resolver.shutdown();
        harness.state.stopRetentionSweep();
      }
    },
  );

  it("keeps legacy best-effort removal when OAuth token deletion fails", async () => {
    const harness = await makeHarness();
    jest
      .spyOn(harness.store, "deleteAll")
      .mockRejectedValue(new Error("Unable to delete credentials"));
    try {
      await expect(harness.upstream.removeClient("docs")).resolves.toBeUndefined();
      expect(harness.upstream.servers).toEqual([]);
      expect(harness.writeConfig).toHaveBeenLastCalledWith([]);
    } finally {
      await harness.upstream.shutdown();
      harness.resolver.shutdown();
      harness.state.stopRetentionSweep();
    }
  });

  it("can log out after an unrelated configuration update rebuilds provider caches", async () => {
    const harness = await makeHarness();
    try {
      await harness.sessions.prepareConfig(DEFAULT_CONFIG);
      await harness.sessions.commitConfig();
      expect(harness.sessions.getExistingOAuthProvider("docs")).toBeUndefined();
      expect(harness.upstream.isOAuthServer("docs")).toBe(true);
      await harness.upstream.logoutOAuthForServer("docs");
      expect(await fs.readdir(directory)).toEqual([]);
    } finally {
      await harness.upstream.shutdown();
      harness.resolver.shutdown();
      harness.state.stopRetentionSweep();
    }
  });

  it("blocks dispatch if the server is disabled while token inspection is pending", async () => {
    const harness = await makeHarness();
    let release!: () => void;
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.spyOn(harness.provider, "tokens").mockImplementation(async () => {
      start();
      await gate;
      return { access_token: "old-token", token_type: "bearer" };
    });
    try {
      const call = harness.upstream.callTool("docs", { name: "read" });
      await started;
      await harness.config.withLock(() =>
        harness.config.updateConfig({
          ...DEFAULT_CONFIG,
          targetServerAttributes: { docs: { inactive: true } },
        }),
      );
      const rejected = expect(call).rejects.toThrow("inactive");
      release();
      await rejected;
      expect(harness.extended.callTool).not.toHaveBeenCalled();
    } finally {
      release();
      await harness.upstream.shutdown();
      harness.resolver.shutdown();
      harness.state.stopRetentionSweep();
    }
  });
});
