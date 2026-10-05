import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TargetServer } from "../model/target-servers.js";
import {
  LocalExportOptions,
  LocalExportService,
} from "./local-export-service.js";

describe("LocalExportService", () => {
  let root: string;
  let options: LocalExportOptions;
  let service: LocalExportService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mcpx-export-"));
    options = makeOptions(root);
    service = new LocalExportService(options);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("exports effective defaults, external config, OAuth state, and mounted host files", async () => {
    await fs.mkdir(path.dirname(options.appConfigPath), { recursive: true });
    await fs.mkdir(path.dirname(options.serversConfigPath), {
      recursive: true,
    });
    await fs.mkdir(path.join(options.stateDirectory, "tokens"), {
      recursive: true,
    });
    await fs.mkdir(options.composeSourceRoot, { recursive: true });
    await fs.writeFile(options.appConfigPath, "configured-app: true\n");
    await fs.writeFile(
      options.serversConfigPath,
      JSON.stringify({ mcpServers: { configured: { type: "stdio" } } }),
    );
    await fs.writeFile(
      path.join(options.stateDirectory, "tokens", "server-tokens.json"),
      "oauth-token-content",
    );
    await fs.writeFile(
      path.join(options.stateDirectory, "tokens", "server-client.json"),
      "oauth-client-content",
    );
    await fs.writeFile(
      path.join(options.stateDirectory, "tokens", "server-verifier.txt"),
      "pkce-verifier-content",
    );
    await fs.writeFile(
      path.join(options.stateDirectory, "tool-embeddings.json"),
      "embedding-cache-content",
    );
    await fs.mkdir(path.join(options.stateDirectory, "sessions"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(options.stateDirectory, "sessions", "live.json"),
      "live-session-content",
    );
    await fs.mkdir(path.join(options.stateDirectory, "backups"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(options.stateDirectory, "backups", "old.json"),
      "old-backup-content",
    );
    const externalFile = path.join(root, "external.txt");
    await fs.writeFile(externalFile, "symlink-target-content");
    await fs.symlink(
      externalFile,
      path.join(options.stateDirectory, "external-link.txt"),
    );

    await fs.mkdir(options.composeSourceRoot, { recursive: true });
    await fs.writeFile(options.composePath, "services: {}\n");
    await fs.writeFile(options.imagePath, "mcpx@sha256:abc\n");
    await fs.writeFile(options.claudeConfigPath, "claude client config");
    await fs.writeFile(options.codexConfigPath, "codex client config");

    const result = await service.create({
      effectiveAppConfig: "effective-defaults: true\n",
      effectiveTargetServers: [runtimeServer()],
    });
    const output = result.destination;

    expect(
      await fs.readFile(path.join(output, "config/app.yaml"), "utf8"),
    ).toBe("effective-defaults: true\n");
    expect(
      await fs.readFile(
        path.join(output, "sources/configured-app.yaml"),
        "utf8",
      ),
    ).toBe("configured-app: true\n");
    expect(
      await fs.readFile(path.join(output, "config/mcp.json"), "utf8"),
    ).toContain("configured");
    expect(
      await fs.readFile(path.join(output, "runtime/mcp.json"), "utf8"),
    ).toContain("runtime-server");
    expect(
      await fs.readFile(
        path.join(output, ".mcpx/tokens/server-tokens.json"),
        "utf8",
      ),
    ).toBe("oauth-token-content");
    expect(
      await fs.readFile(
        path.join(output, ".mcpx/tokens/server-client.json"),
        "utf8",
      ),
    ).toBe("oauth-client-content");
    expect(
      await fs.readFile(
        path.join(output, ".mcpx/tokens/server-verifier.txt"),
        "utf8",
      ),
    ).toBe("pkce-verifier-content");
    expect(
      await fs.readFile(path.join(output, "deployment/image.txt"), "utf8"),
    ).toContain("sha256:abc");
    expect(
      await fs.readFile(path.join(output, "deployment/compose.yaml"), "utf8"),
    ).toBe("services: {}\n");
    expect(
      await fs.readFile(
        path.join(output, "clients/claude-config.json"),
        "utf8",
      ),
    ).toBe("claude client config");
    expect(
      await fs.readFile(path.join(output, "clients/codex-config.toml"), "utf8"),
    ).toBe("codex client config");

    const outputFiles = await listFiles(output);
    expect(outputFiles).not.toContain(".mcpx/tool-embeddings.json");
    expect(outputFiles).not.toContain(".mcpx/sessions/live.json");
    expect(outputFiles).not.toContain(".mcpx/backups/old.json");
    expect(outputFiles).not.toContain(".mcpx/external-link.txt");
    expect(result.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item: ".mcpx/external-link.txt",
          reason: "Symbolic links are not followed.",
        }),
        expect.objectContaining({ item: ".mcpx/tool-embeddings.json" }),
        expect.objectContaining({ item: ".mcpx/sessions" }),
        expect.objectContaining({ item: ".mcpx/backups" }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("oauth-token-content");
    const manifest = await fs.readFile(
      path.join(output, "manifest.json"),
      "utf8",
    );
    expect(manifest).not.toContain("oauth-token-content");
    expect((await fs.stat(output)).mode & 0o777).toBe(0o700);
    expect(
      (await fs.stat(path.join(output, ".mcpx/tokens"))).mode & 0o777,
    ).toBe(0o700);
    const tokenFileMode =
      (await fs.stat(path.join(output, ".mcpx/tokens/server-tokens.json")))
        .mode & 0o777;
    expect(tokenFileMode).toBe(0o600);
  });

  it("generates config files from runtime state and reports unavailable sources", async () => {
    const result = await service.create({
      effectiveAppConfig: "effective-app-defaults: true\n",
      effectiveTargetServers: [runtimeServer()],
    });

    expect(
      await fs.readFile(
        path.join(result.destination, "config/app.yaml"),
        "utf8",
      ),
    ).toBe("effective-app-defaults: true\n");
    expect(
      await fs.readFile(
        path.join(result.destination, "config/mcp.json"),
        "utf8",
      ),
    ).toContain("runtime-server");
    expect(result.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ item: "Configured APP_CONFIG_PATH source" }),
        expect.objectContaining({ item: "Deployment Compose file" }),
        expect.objectContaining({ item: "Claude host client config" }),
        expect.objectContaining({
          item: "Hub-managed profile secrets and skill catalogs",
        }),
      ]),
    );
  });

  it("does not leave a partial backup when the destination is invalid", async () => {
    const filePath = path.join(root, "backup-is-a-file");
    await fs.writeFile(filePath, "content");
    const brokenService = new LocalExportService({
      ...options,
      backupDirectory: filePath,
    });

    await expect(
      brokenService.create({
        effectiveAppConfig: "app: true\n",
        effectiveTargetServers: [],
      }),
    ).rejects.toThrow("Local backup export failed");
    expect(
      (await fs.readdir(root)).filter((entry) => entry.includes("partial")),
    ).toEqual([]);
  });

  it("excludes a custom backup directory nested in .mcpx state", async () => {
    const tokenPath = path.join(options.stateDirectory, "tokens", "token.json");
    await fs.mkdir(path.dirname(tokenPath), { recursive: true });
    await fs.writeFile(tokenPath, "durable-token");
    const nestedService = new LocalExportService({
      ...options,
      backupDirectory: path.join(options.stateDirectory, "exports"),
    });

    const result = await nestedService.create({
      effectiveAppConfig: "app: true\n",
      effectiveTargetServers: [],
    });

    expect(
      await fs.readFile(
        path.join(result.destination, ".mcpx/tokens/token.json"),
        "utf8",
      ),
    ).toBe("durable-token");
    expect(
      await listFiles(result.destination),
    ).not.toContain(".mcpx/exports");
    expect(result.omitted).toContainEqual({
      item: ".mcpx/exports",
      reason: "Backup directories are excluded to prevent recursive exports.",
    });
  });

  it("rejects a backup directory equal to the .mcpx state root without leaving staging data", async () => {
    await fs.mkdir(options.stateDirectory, { recursive: true });
    const sameDirectoryService = new LocalExportService({
      ...options,
      backupDirectory: options.stateDirectory,
    });

    await expect(
      sameDirectoryService.create({
        effectiveAppConfig: "app: true\n",
        effectiveTargetServers: [],
      }),
    ).rejects.toThrow("cannot be the same as the local state directory");
    expect(await fs.readdir(options.stateDirectory)).toEqual([]);
  });
});

function makeOptions(root: string): LocalExportOptions {
  const config = path.join(root, "external-config");
  const host = path.join(root, "host-mounts");
  return {
    backupDirectory: path.join(root, "backups"),
    appConfigPath: path.join(config, "app.yaml"),
    appConfigSourceRoot: config,
    serversConfigPath: path.join(config, "mcp.json"),
    serversConfigSourceRoot: config,
    stateDirectory: path.join(root, "runtime", ".mcpx"),
    composePath: path.join(host, "compose.yaml"),
    composeSourceRoot: host,
    imagePath: path.join(host, "image.txt"),
    imageSourceRoot: host,
    claudeConfigPath: path.join(host, "claude.json"),
    claudeConfigSourceRoot: host,
    codexConfigPath: path.join(host, "codex.toml"),
    codexConfigSourceRoot: host,
  };
}

function runtimeServer(): TargetServer {
  return {
    name: "runtime-server",
    type: "streamable-http",
    url: "https://runtime.example/mcp",
    headers: { Authorization: "runtime-secret" },
  };
}

async function listFiles(directory: string, relative = ""): Promise<string[]> {
  const entries = await fs.readdir(path.join(directory, relative), {
    withFileTypes: true,
  });
  const files: string[] = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(directory, child)));
    else files.push(child);
  }
  return files;
}
