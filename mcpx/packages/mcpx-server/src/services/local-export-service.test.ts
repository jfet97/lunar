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

  it("exports only selected companion files and keeps credentials out of recovery metadata", async () => {
    const selected = path.join(root, "selected-companions");
    await fs.mkdir(selected);
    const companionsPath = path.join(selected, "files.json");
    await fs.writeFile(
      companionsPath,
      JSON.stringify({
        version: 1,
        services: [
          {
            name: "atlassian-media",
            files: [
              { source: "media.compose.yaml", destination: "compose.yaml" },
              { source: "media.env", destination: ".env" },
            ],
          },
        ],
      }),
    );
    await fs.writeFile(
      path.join(selected, "media.compose.yaml"),
      "services: {}\n",
    );
    await fs.writeFile(
      path.join(selected, "media.env"),
      "API_TOKEN=selected-secret\n",
    );
    await fs.writeFile(
      path.join(selected, "unselected.env"),
      "DO_NOT_COPY=other-secret\n",
    );
    const service = new LocalExportService({ ...options, companionsPath });
    const result = await service.create({
      effectiveAppConfig: "app: true\n",
      effectiveTargetServers: [
        {
          name: "atlassian-media",
          type: "streamable-http",
          url: "http://user:password@atlassian-media:9005/mcp?token=url-secret",
          headers: {
            Authorization: "literal-secret",
            "X-Token": { fromEnv: "MEDIA_TOKEN" },
            "X-Key": { fromSecret: "media-key" },
            "X-Template": "Bearer {{MEDIA_TOKEN}}:{{EXTRA_HEADER_TOKEN}}",
          },
        },
      ],
    });
    const file = path.join(
      result.destination,
      "companions/atlassian-media/.env",
    );
    expect(await fs.readFile(file, "utf8")).toBe("API_TOKEN=selected-secret\n");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await listFiles(result.destination)).not.toContain("unselected.env");
    expect(result.recovery?.servers).toEqual([
      expect.objectContaining({
        name: "atlassian-media",
        host: "atlassian-media",
        files: [
          "companions/atlassian-media/compose.yaml",
          "companions/atlassian-media/.env",
        ],
        requiredEnvironment: ["EXTRA_HEADER_TOKEN", "MEDIA_TOKEN"],
        requiredSecrets: ["media-key"],
      }),
    ]);
    const manifest = await fs.readFile(
      path.join(result.destination, "manifest.json"),
      "utf8",
    );
    const guide = await fs.readFile(
      path.join(result.destination, "RESTORE.md"),
      "utf8",
    );
    const metadata = JSON.stringify(result) + manifest + guide;
    for (const secret of [
      "selected-secret",
      "other-secret",
      "url-secret",
      "literal-secret",
      "password",
    ]) {
      expect(metadata).not.toContain(secret);
    }
    expect(guide).toContain("MEDIA_TOKEN");
    expect(guide).toContain("Use Import Gateway Backup");
    expect(JSON.parse(manifest)).toMatchObject({
      schemaVersion: 2,
      recovery: result.recovery,
    });
  });

  it("reports missing, directory, and symlink selections without sweeping adjacent files", async () => {
    const selected = path.join(root, "selected");
    await fs.mkdir(path.join(selected, "config"), { recursive: true });
    await fs.writeFile(
      path.join(selected, "config", "private.env"),
      "hidden-secret",
    );
    await fs.symlink(
      path.join(selected, "config"),
      path.join(selected, "linked"),
    );
    const companionsPath = path.join(selected, "files.json");
    await fs.writeFile(
      companionsPath,
      JSON.stringify({
        version: 1,
        services: [
          {
            name: "runtime-server",
            files: [
              { source: "missing.env", destination: ".env" },
              { source: "config", destination: "directory" },
              { source: "linked/private.env", destination: "secret.env" },
            ],
          },
        ],
      }),
    );
    const result = await new LocalExportService({
      ...options,
      companionsPath,
    }).create({
      effectiveAppConfig: "app: true\n",
      effectiveTargetServers: [runtimeServer()],
    });
    expect(result.recovery?.servers[0]?.files).toEqual([]);
    expect(result.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ item: "companions/runtime-server/.env" }),
        expect.objectContaining({
          item: "companions/runtime-server/directory",
        }),
        expect.objectContaining({
          item: "companions/runtime-server/secret.env",
          reason: "A symbolic link in the source path was not followed.",
        }),
      ]),
    );
    expect(
      (await listFiles(result.destination)).filter((file) =>
        file.startsWith("companions/"),
      ),
    ).toEqual(["companions/files.json"]);
  });

  it.each([
    [
      "source traversal",
      [
        {
          name: "service",
          files: [{ source: "../private.env", destination: ".env" }],
        },
      ],
    ],
    [
      "absolute source",
      [
        {
          name: "service",
          files: [{ source: "/private.env", destination: ".env" }],
        },
      ],
    ],
    [
      "destination traversal",
      [
        {
          name: "service",
          files: [{ source: "file", destination: "../../config/mcp.json" }],
        },
      ],
    ],
    ["unsafe service name", [{ name: "..", files: [] }]],
    [
      "duplicate service names",
      [
        { name: "service", files: [] },
        { name: "service", files: [] },
      ],
    ],
    [
      "case-only destination collision",
      [
        {
          name: "service",
          files: [
            { source: "a", destination: "file" },
            { source: "b", destination: "FILE" },
          ],
        },
      ],
    ],
    [
      "file-directory collision",
      [
        {
          name: "service",
          files: [
            { source: "a", destination: "config" },
            { source: "b", destination: "config/file" },
          ],
        },
      ],
    ],
  ])("rejects %s without leaving a backup", async (_description, services) => {
    const companionsPath = path.join(root, "files.json");
    await fs.writeFile(
      companionsPath,
      JSON.stringify({ version: 1, services }),
    );
    const service = new LocalExportService({ ...options, companionsPath });
    await expect(
      service.create({
        effectiveAppConfig: "app: true\n",
        effectiveTargetServers: [],
      }),
    ).rejects.toThrow("Invalid companion file selection");
    expect(await fs.readdir(options.backupDirectory)).toEqual([]);
  });

  it("fails an unavailable selection and reports malformed JSON without exposing its content", async () => {
    const companionsPath = path.join(root, "files.json");
    const service = new LocalExportService({ ...options, companionsPath });
    const input = {
      effectiveAppConfig: "app: true\n",
      effectiveTargetServers: [],
    };
    await expect(service.create(input)).rejects.toThrow(
      "selection is unavailable or unsafe",
    );
    await fs.writeFile(companionsPath, '{"token":"do-not-expose"');
    await expect(service.create(input)).rejects.toThrow(
      "must contain valid JSON",
    );
    expect(await fs.readdir(options.backupDirectory)).toEqual([]);
  });

  it("reports stdio installation and environment requirements without copying referenced files", async () => {
    const result = await service.create({
      effectiveAppConfig: "app: true\n",
      effectiveTargetServers: [
        {
          name: "local-server",
          type: "stdio",
          command: "node",
          args: ["/machine-specific/private-server.js", "argument-secret"],
          env: {
            TOKEN: { fromEnv: "UPSTREAM_TOKEN" },
            KEY: { fromSecret: "upstream-key" },
          },
        },
      ],
    });
    expect(result.recovery?.servers[0]).toMatchObject({
      transport: "stdio",
      files: [],
      requiredEnvironment: ["UPSTREAM_TOKEN"],
      requiredSecrets: ["upstream-key"],
    });
    expect(JSON.stringify(result)).not.toContain("private-server.js");
    expect(JSON.stringify(result)).not.toContain("argument-secret");
    expect(result.recovery?.servers[0]?.note).toContain(
      "Install the command and packages separately",
    );
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
    expect(await listFiles(result.destination)).not.toContain(".mcpx/exports");
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
