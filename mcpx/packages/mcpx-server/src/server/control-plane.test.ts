import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import express from "express";
import { createServer, Server } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ListSavedSetupsResponse,
  SaveSetupResponse,
} from "@mcpx/shared-model";
import { savedSetupItemSchema } from "@mcpx/shared-model";
import { noOpLogger } from "@aigw/core/logging";
import { resetEnv } from "../env.js";
import { LocalExportService } from "../services/local-export-service.js";
import { LocalSavedSetups } from "../services/local-saved-setups.js";
import { Services } from "../services/services.js";
import { CurrentSetup } from "../services/setup-manager.js";
import { buildControlPlaneRouter } from "./control-plane.js";
import { noOpAuthGuard } from "./auth.js";

describe("control plane local saved setups and exports", () => {
  let tempDirectory: string;
  let server: Server | undefined;
  let baseUrl: string;
  let originalEnvironment: NodeJS.ProcessEnv;
  let currentSetup: CurrentSetup;
  let appliedSetup: unknown;
  let localSavedSetups: LocalSavedSetups;
  let hubSavedSetups: {
    saveSetup: jest.Mock<() => Promise<SaveSetupResponse>>;
    listSavedSetups: jest.Mock<() => Promise<ListSavedSetupsResponse>>;
    deleteSavedSetup: jest.Mock<
      () => Promise<{ success: boolean; error?: string; errorCode?: string }>
    >;
    updateSavedSetup: jest.Mock<
      () => Promise<{ success: boolean; error?: string; errorCode?: string }>
    >;
  };

  beforeEach(async () => {
    originalEnvironment = { ...process.env };
    delete process.env["INSTANCE_KEY"];
    process.env["VERSION"] = "test";
    process.env["INSTANCE_ID"] = "test-instance";
    process.env["ENABLE_CONTROL_PLANE_REST"] = "true";
    resetEnv();
    tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "mcpx-control-plane-"),
    );
    currentSetup = makeSetup();
    appliedSetup = undefined;
    hubSavedSetups = {
      saveSetup: jest.fn<() => Promise<SaveSetupResponse>>(),
      listSavedSetups: jest
        .fn<() => Promise<ListSavedSetupsResponse>>()
        .mockResolvedValue({ setups: [] }),
      deleteSavedSetup: jest.fn<
        () => Promise<{
          success: boolean;
          error?: string;
          errorCode?: string;
        }>
      >(),
      updateSavedSetup: jest.fn<
        () => Promise<{
          success: boolean;
          error?: string;
          errorCode?: string;
        }>
      >(),
    };

    localSavedSetups = new LocalSavedSetups(
      path.join(tempDirectory, ".mcpx", "saved-setups"),
    );
    const services = {
      hubService: {
        status: { status: "unauthenticated" },
        savedSetups: hubSavedSetups,
      },
      localSavedSetups,
      localExportService: makeExportService(tempDirectory),
      setupManager: {
        captureCurrentSetup: () => currentSetup,
        applySetup: async (setup: unknown) => {
          appliedSetup = setup;
        },
      },
      controlPlane: {
        getAppConfig: () => ({ yaml: "toolGroups: []\n" }),
      },
      upstreamHandler: { servers: [runtimeServer()] },
    } as unknown as Services;
    const app = express();
    app.use(express.json());
    app.use(buildControlPlaneRouter(noOpAuthGuard, services, noOpLogger));
    server = createServer(app);
    await new Promise<void>((resolve) => {
      server?.listen(0, "127.0.0.1", resolve);
    });
    const address = server?.address();
    if (!address || typeof address === "string")
      throw new Error("No test server port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    try {
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server?.close((error) => (error ? reject(error) : resolve()));
        });
      }
      await fs.rm(tempDirectory, { recursive: true, force: true });
    } finally {
      process.env = originalEnvironment;
      resetEnv({
        ...originalEnvironment,
        VERSION: originalEnvironment["VERSION"] ?? "test",
        INSTANCE_ID: originalEnvironment["INSTANCE_ID"] ?? "test-instance",
      });
    }
  });

  it("supports the full standalone saved-setup lifecycle without Hub and keeps list responses secret-free", async () => {
    const saveResponse = await fetch(`${baseUrl}/saved-setups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Local setup" }),
    });
    expect(saveResponse.status).toBe(201);
    const saved = await saveResponse.json();

    const listResponse = await fetch(`${baseUrl}/saved-setups`);
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.text();
    expect(listBody).toContain("Local setup");
    expect(listBody).not.toContain("header-secret");
    expect(listBody).not.toContain("environment-secret");
    expect(listBody).not.toContain("query-secret");

    const restoreResponse = await fetch(
      `${baseUrl}/saved-setups/${saved.savedSetupId}/restore`,
      { method: "POST" },
    );
    expect(restoreResponse.status).toBe(200);
    expect(appliedSetup).toMatchObject({
      targetServers: {
        private: {
          initiation: { headers: { Authorization: "header-secret" } },
        },
      },
    });

    currentSetup = makeSetup();
    currentSetup.targetServers = {};
    const overwriteResponse = await fetch(
      `${baseUrl}/saved-setups/${saved.savedSetupId}`,
      { method: "PUT" },
    );
    expect(overwriteResponse.status).toBe(200);

    const deleteResponse = await fetch(
      `${baseUrl}/saved-setups/${saved.savedSetupId}`,
      { method: "DELETE" },
    );
    expect(deleteResponse.status).toBe(200);
    expect(hubSavedSetups.saveSetup).not.toHaveBeenCalled();
    expect(hubSavedSetups.listSavedSetups).not.toHaveBeenCalled();
    expect(hubSavedSetups.deleteSavedSetup).not.toHaveBeenCalled();
    expect(hubSavedSetups.updateSavedSetup).not.toHaveBeenCalled();
  });

  it("returns local save failures in the API error response shape", async () => {
    jest
      .spyOn(localSavedSetups, "save")
      .mockRejectedValue(new Error("Could not write local saved setup"));

    const response = await fetch(`${baseUrl}/saved-setups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Local setup" }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      message: "Could not write local saved setup",
    });
  });

  it("continues using authenticated Hub saved setups", async () => {
    delete process.env["INSTANCE_KEY"];
    resetEnv();
    const services = {
      hubService: {
        status: { status: "authenticated" },
        savedSetups: hubSavedSetups,
      },
      localSavedSetups: new LocalSavedSetups(
        path.join(tempDirectory, "unused-local-setups"),
      ),
      localExportService: makeExportService(tempDirectory),
      setupManager: { captureCurrentSetup: () => currentSetup },
      controlPlane: { getAppConfig: () => ({ yaml: "toolGroups: []\n" }) },
      upstreamHandler: { servers: [] },
    } as unknown as Services;
    const app = express();
    app.use(buildControlPlaneRouter(noOpAuthGuard, services, noOpLogger));
    const hubServer = createServer(app);
    await new Promise<void>((resolve) => {
      hubServer.listen(0, "127.0.0.1", resolve);
    });
    const address = hubServer.address();
    if (!address || typeof address === "string")
      throw new Error("No test server port");
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/saved-setups`,
      );
      expect(response.status).toBe(200);
      expect(hubSavedSetups.listSavedSetups).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        hubServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps enterprise saved setups on Hub while Hub is disconnected", async () => {
    process.env["INSTANCE_KEY"] = "enterprise-instance-key";
    resetEnv();

    const savedSetupId = "0190a000-0000-7000-8000-000000000020";
    const savedAt = "2026-10-05T20:00:00.000Z";
    hubSavedSetups.saveSetup.mockResolvedValue({
      success: true,
      savedSetupId,
      description: "Hub setup",
      savedAt,
    });
    hubSavedSetups.listSavedSetups.mockResolvedValue({
      setups: [
        savedSetupItemSchema.parse({
          id: savedSetupId,
          description: "Hub setup",
          savedAt,
          ...makeSetup(),
        }),
      ],
    });
    hubSavedSetups.deleteSavedSetup.mockResolvedValue({ success: true });
    hubSavedSetups.updateSavedSetup.mockResolvedValue({ success: true });

    const localSave = jest.spyOn(localSavedSetups, "save");
    const localList = jest.spyOn(localSavedSetups, "list");
    const localGet = jest.spyOn(localSavedSetups, "get");
    const localOverwrite = jest.spyOn(localSavedSetups, "overwrite");
    const localDelete = jest.spyOn(localSavedSetups, "delete");

    const saveResponse = await fetch(`${baseUrl}/saved-setups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Hub setup" }),
    });
    expect(saveResponse.status).toBe(201);

    const listResponse = await fetch(`${baseUrl}/saved-setups`);
    expect(listResponse.status).toBe(200);

    const restoreResponse = await fetch(
      `${baseUrl}/saved-setups/${savedSetupId}/restore`,
      { method: "POST" },
    );
    expect(restoreResponse.status).toBe(200);

    const overwriteResponse = await fetch(
      `${baseUrl}/saved-setups/${savedSetupId}`,
      { method: "PUT" },
    );
    expect(overwriteResponse.status).toBe(200);

    const deleteResponse = await fetch(
      `${baseUrl}/saved-setups/${savedSetupId}`,
      { method: "DELETE" },
    );
    expect(deleteResponse.status).toBe(200);

    hubSavedSetups.saveSetup.mockRejectedValue(
      new Error("Hub connection is unavailable"),
    );
    const disconnectedSaveResponse = await fetch(`${baseUrl}/saved-setups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Hub setup while disconnected" }),
    });
    expect(disconnectedSaveResponse.status).toBe(500);
    await expect(disconnectedSaveResponse.json()).resolves.toEqual({
      message: "Hub connection is unavailable",
    });

    expect(hubSavedSetups.saveSetup).toHaveBeenCalledTimes(2);
    expect(hubSavedSetups.listSavedSetups).toHaveBeenCalledTimes(2);
    expect(hubSavedSetups.updateSavedSetup).toHaveBeenCalledTimes(1);
    expect(hubSavedSetups.deleteSavedSetup).toHaveBeenCalledTimes(1);
    expect(localSave).not.toHaveBeenCalled();
    expect(localList).not.toHaveBeenCalled();
    expect(localGet).not.toHaveBeenCalled();
    expect(localOverwrite).not.toHaveBeenCalled();
    expect(localDelete).not.toHaveBeenCalled();
  });

  it("writes a full export locally and reports the configured destination", async () => {
    const response = await fetch(`${baseUrl}/backup/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destination: "/etc" }),
    });
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result.destination).toContain(path.join(tempDirectory, "backups"));
    expect(result.included).toContain(
      "config/app.yaml (effective runtime configuration)",
    );
    expect(
      await fs.readFile(
        path.join(result.destination, "config/app.yaml"),
        "utf8",
      ),
    ).toBe("toolGroups: []\n");
  });
});

function makeSetup(): CurrentSetup {
  return {
    targetServers: {
      private: {
        initiation: {
          type: "streamable-http",
          url: "https://example.com/mcp?token=query-secret",
          headers: { Authorization: "header-secret" },
        },
      },
      local: {
        initiation: {
          type: "stdio",
          command: "node",
          args: ["--token", "argument-secret"],
          env: { TOKEN: "environment-secret" },
        },
      },
    },
    config: {
      permissions: {
        default: { _type: "default-allow", block: [] },
        consumers: {},
        clientNames: {},
      },
      toolGroups: [],
      auth: { enabled: false },
      toolExtensions: { services: {} },
      targetServerAttributes: {},
      skills: { enabled: [] },
    },
  };
}

function runtimeServer() {
  return {
    name: "runtime-server",
    type: "streamable-http" as const,
    url: "https://runtime.example/mcp",
  };
}

function makeExportService(root: string): LocalExportService {
  const home = path.join(root, "home");
  const config = path.join(root, "config");
  return new LocalExportService({
    backupDirectory: path.join(root, "backups"),
    appConfigPath: path.join(config, "app.yaml"),
    appConfigSourceRoot: config,
    serversConfigPath: path.join(config, "mcp.json"),
    serversConfigSourceRoot: config,
    stateDirectory: path.join(root, ".mcpx"),
    composePath: path.join(home, ".config", "mcpx", "compose.yaml"),
    composeSourceRoot: home,
    imagePath: path.join(home, ".config", "mcpx", "image.txt"),
    imageSourceRoot: home,
    claudeConfigPath: path.join(home, ".claude.json"),
    claudeConfigSourceRoot: home,
    codexConfigPath: path.join(home, ".codex", "config.toml"),
    codexConfigSourceRoot: home,
  });
}
