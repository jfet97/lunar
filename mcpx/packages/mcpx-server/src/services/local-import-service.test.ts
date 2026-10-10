import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { stringify } from "yaml";
import { DEFAULT_CONFIG } from "../config.js";
import {
  LocalExportOptions,
  LocalExportService,
} from "./local-export-service.js";
import {
  LocalImportOptions,
  LocalImportService,
} from "./local-import-service.js";

describe("LocalImportService", () => {
  let root: string;
  let exportOptions: LocalExportOptions;
  let importOptions: LocalImportOptions;
  let importer: LocalImportService;
  let backupId: string;
  let source: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mcpx-import-"));
    const config = path.join(root, "source", "config");
    const state = path.join(root, "source", ".mcpx");
    await fs.mkdir(config, { recursive: true });
    await fs.mkdir(path.join(state, "tokens"), { recursive: true });
    await fs.mkdir(path.join(state, "saved-setups"), { recursive: true });
    await fs.writeFile(
      path.join(config, "app.yaml"),
      stringify(DEFAULT_CONFIG),
    );
    await fs.writeFile(
      path.join(config, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          restored: {
            type: "streamable-http",
            url: "https://example.com/mcp?token=url-secret",
            headers: { Authorization: "header-secret" },
          },
        },
      }),
    );
    await fs.writeFile(
      path.join(state, "tokens", "restored-tokens.json"),
      JSON.stringify({
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        token_type: "Bearer",
      }),
    );
    await fs.writeFile(
      path.join(state, "tokens", "restored-client.json"),
      JSON.stringify({
        client_id: "registered-client",
        client_secret: "client-secret",
        redirect_uris: ["http://localhost:9000/oauth/callback"],
      }),
    );
    await fs.writeFile(
      path.join(state, "tokens", "restored-verifier.txt"),
      "private-verifier",
    );
    const id = randomUUID();
    await fs.writeFile(
      path.join(state, "saved-setups", `${id}.json`),
      JSON.stringify({
        id,
        description: "Saved configuration",
        savedAt: new Date().toISOString(),
        targetServers: {},
        config: {},
      }),
    );
    exportOptions = {
      backupDirectory: path.join(root, "backups"),
      appConfigPath: path.join(config, "app.yaml"),
      appConfigSourceRoot: config,
      serversConfigPath: path.join(config, "mcp.json"),
      serversConfigSourceRoot: config,
      stateDirectory: state,
      composePath: path.join(root, "compose.yaml"),
      composeSourceRoot: root,
      imagePath: path.join(root, "image.txt"),
      imageSourceRoot: root,
      claudeConfigPath: path.join(root, "claude.json"),
      claudeConfigSourceRoot: root,
      codexConfigPath: path.join(root, "codex.toml"),
      codexConfigSourceRoot: root,
    };
    const backup = await new LocalExportService(exportOptions).create({
      effectiveAppConfig: stringify(DEFAULT_CONFIG),
      effectiveTargetServers: [],
    });
    backupId = backup.backupId;
    source = backup.destination;
    importOptions = {
      backupDirectory: exportOptions.backupDirectory,
      appConfigPath: path.join(root, "destination", "config", "app.yaml"),
      serversConfigPath: path.join(root, "destination", "config", "mcp.json"),
      stateDirectory: path.join(root, "destination", ".mcpx"),
    };
    importer = new LocalImportService(importOptions);
    await fs.mkdir(path.dirname(importOptions.appConfigPath), {
      recursive: true,
    });
    await fs.mkdir(path.join(importOptions.stateDirectory, "tokens"), {
      recursive: true,
    });
    await fs.mkdir(path.join(importOptions.stateDirectory, "saved-setups"), {
      recursive: true,
    });
    await fs.writeFile(importOptions.appConfigPath, "previous-app");
    await fs.writeFile(importOptions.serversConfigPath, "previous-servers");
    await fs.writeFile(
      path.join(importOptions.stateDirectory, "tokens", "old-tokens.json"),
      "previous-tokens",
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([0o755, 0o750])(
    "preserves existing destination parent permissions %o",
    async (mode) => {
      const config = path.dirname(importOptions.appConfigPath);
      await fs.chmod(config, mode);
      await fs.chmod(importOptions.stateDirectory, mode);
      const preview = await importer.preview(backupId);
      await importer.stage({ backupId, fingerprint: preview.fingerprint });
      await importer.applyPending();
      expect((await fs.stat(config)).mode & 0o777).toBe(mode);
      expect((await fs.stat(importOptions.stateDirectory)).mode & 0o777).toBe(
        mode,
      );
    },
  );

  it.each(["My Service", "Café"])(
    "restores OAuth state for server %s",
    async (serverName) => {
      const tokenDirectory = path.join(exportOptions.stateDirectory, "tokens");
      for (const suffix of ["tokens.json", "client.json", "verifier.txt"]) {
        await fs.rename(
          path.join(tokenDirectory, `restored-${suffix}`),
          path.join(tokenDirectory, `${serverName}-${suffix}`),
        );
      }
      await fs.writeFile(
        exportOptions.serversConfigPath,
        JSON.stringify({
          mcpServers: {
            [serverName]: {
              type: "streamable-http",
              url: "https://example.com/mcp",
            },
          },
        }),
      );
      const backup = await new LocalExportService(exportOptions).create({
        effectiveAppConfig: stringify(DEFAULT_CONFIG),
        effectiveTargetServers: [],
      });
      const preview = await importer.preview(backup.backupId);
      expect(preview.serverNames).toEqual([serverName]);
      expect(preview.oauthFileCount).toBe(3);
      await importer.stage({
        backupId: backup.backupId,
        fingerprint: preview.fingerprint,
      });
      await importer.applyPending();
      expect(
        await fs.readFile(
          path.join(
            importOptions.stateDirectory,
            "tokens",
            `${serverName}-tokens.json`,
          ),
          "utf8",
        ),
      ).toContain("access-secret");
    },
  );

  it("previews without exposing credentials, queues without live changes, and restores on startup", async () => {
    const preview = await importer.preview(backupId);
    expect(preview).toMatchObject({
      serverNames: ["restored"],
      oauthFileCount: 3,
      savedSetupCount: 1,
      restartRequired: true,
    });
    expect(preview.manual).toContain("RESTORE.md");
    for (const secret of [
      "access-secret",
      "refresh-secret",
      "client-secret",
      "header-secret",
      "url-secret",
      "private-verifier",
    ])
      expect(JSON.stringify(preview)).not.toContain(secret);
    await importer.stage({ backupId, fingerprint: preview.fingerprint });
    expect(await fs.readFile(importOptions.appConfigPath, "utf8")).toBe(
      "previous-app",
    );
    expect(await importer.pending()).toMatchObject({
      backupId,
      restartRequired: true,
    });
    await fs.writeFile(
      path.join(source, "config", "app.yaml"),
      "invalid-original-after-staging",
    );
    expect(await new LocalImportService(importOptions).applyPending()).toBe(
      true,
    );
    expect(await fs.readFile(importOptions.appConfigPath, "utf8")).toBe(
      stringify(DEFAULT_CONFIG),
    );
    expect(
      await fs.readFile(
        path.join(
          importOptions.stateDirectory,
          "tokens",
          "restored-tokens.json",
        ),
        "utf8",
      ),
    ).toContain("access-secret");
    expect(
      await fs.readdir(path.join(importOptions.stateDirectory, "tokens")),
    ).not.toContain("old-tokens.json");
    expect(
      (
        await fs.stat(
          path.join(
            importOptions.stateDirectory,
            "tokens",
            "restored-tokens.json",
          ),
        )
      ).mode & 0o777,
    ).toBe(0o600);
    expect(await importer.pending()).toBeNull();
    expect(await importer.applyPending()).toBe(false);
    const receipt = JSON.parse(
      await fs.readFile(
        path.join(
          importOptions.backupDirectory,
          ".restore",
          "last-import.json",
        ),
        "utf8",
      ),
    );
    expect(await fs.readFile(receipt.previousFiles[0], "utf8")).toBe(
      "previous-app",
    );
    expect(
      await fs.readFile(
        path.join(receipt.previousFiles[2], "old-tokens.json"),
        "utf8",
      ),
    ).toBe("previous-tokens");
  });

  it("cancels a queued import and rejects a second queued import", async () => {
    const preview = await importer.preview(backupId);
    await importer.stage({ backupId, fingerprint: preview.fingerprint });
    await expect(
      importer.stage({ backupId, fingerprint: preview.fingerprint }),
    ).rejects.toThrow("already queued");
    await importer.cancel();
    expect(await importer.pending()).toBeNull();
    expect(await importer.applyPending()).toBe(false);
    expect(await fs.readFile(importOptions.appConfigPath, "utf8")).toBe(
      "previous-app",
    );
    expect(
      (
        await fs.readdir(path.join(importOptions.backupDirectory, ".restore"))
      ).filter((name) => name.startsWith("staged-")),
    ).toEqual([]);
  });

  it("rejects a backup changed after preview and leaves current files untouched", async () => {
    const preview = await importer.preview(backupId);
    await fs.writeFile(
      path.join(source, ".mcpx", "tokens", "restored-verifier.txt"),
      "changed-verifier",
    );
    await expect(
      importer.stage({ backupId, fingerprint: preview.fingerprint }),
    ).rejects.toThrow("changed since preview");
    expect(await importer.pending()).toBeNull();
  });

  it("replaces current state with empty state when the exported backup contains none", async () => {
    for (const kind of ["tokens", "saved-setups"])
      await fs.rm(path.join(exportOptions.stateDirectory, kind), {
        recursive: true,
      });
    const backup = await new LocalExportService(exportOptions).create({
      effectiveAppConfig: stringify(DEFAULT_CONFIG),
      effectiveTargetServers: [],
    });
    const preview = await importer.preview(backup.backupId);
    expect(preview.oauthFileCount).toBe(0);
    await importer.stage({
      backupId: preview.backupId,
      fingerprint: preview.fingerprint,
    });
    await importer.applyPending();
    expect(
      await fs.readdir(path.join(importOptions.stateDirectory, "tokens")),
    ).toEqual([]);
    expect(
      await fs.readdir(path.join(importOptions.stateDirectory, "saved-setups")),
    ).toEqual([]);
  });

  it("supports the original unversioned export manifest", async () => {
    const manifestPath = path.join(source, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    delete manifest.schemaVersion;
    delete manifest.recovery;
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    expect((await importer.preview(backupId)).savedSetupCount).toBe(1);
  });

  it.each(["../outside", "/etc", "sub/folder", "..", "bad\\path"])(
    "rejects unsafe backup selection %s",
    async (name) => {
      await expect(importer.preview(name)).rejects.toThrow("without a path");
    },
  );

  it("rejects symlinked backup files and undeclared state files", async () => {
    const token = path.join(source, ".mcpx", "tokens", "restored-tokens.json");
    await fs.rm(token);
    await fs.symlink(
      path.join(exportOptions.stateDirectory, "tokens", "restored-tokens.json"),
      token,
    );
    await expect(importer.preview(backupId)).rejects.toThrow("symlink");
    await fs.rm(token);
    await fs.copyFile(
      path.join(exportOptions.stateDirectory, "tokens", "restored-tokens.json"),
      token,
    );
    await fs.writeFile(
      path.join(source, ".mcpx", "tokens", "extra-tokens.json"),
      "{}",
    );
    await expect(importer.preview(backupId)).rejects.toThrow(
      "missing from the manifest",
    );
  });

  it("rejects missing declared state and invalid configurations without returning their content", async () => {
    const token = path.join(source, ".mcpx", "tokens", "restored-tokens.json");
    await fs.rm(token);
    await expect(importer.preview(backupId)).rejects.toThrow(
      "declared in the manifest is missing",
    );
    await fs.copyFile(
      path.join(exportOptions.stateDirectory, "tokens", "restored-tokens.json"),
      token,
    );
    await fs.writeFile(
      path.join(source, "config", "app.yaml"),
      "secret: [do-not-expose",
    );
    await expect(importer.preview(backupId)).rejects.toThrow("invalid gateway");
  });

  it("rolls back all previously replaced files if a filesystem replacement fails", async () => {
    const preview = await importer.preview(backupId);
    await importer.stage({ backupId, fingerprint: preview.fingerprint });
    const rename = fs.rename.bind(fs);
    let failed = false;
    jest.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
      if (!failed && String(oldPath).endsWith("-tokens.new")) {
        failed = true;
        throw new Error("simulated rename failure");
      }
      return rename(oldPath, newPath);
    });
    await expect(importer.applyPending()).rejects.toThrow(
      "previous files were restored",
    );
    expect(await fs.readFile(importOptions.appConfigPath, "utf8")).toBe(
      "previous-app",
    );
    expect(await fs.readFile(importOptions.serversConfigPath, "utf8")).toBe(
      "previous-servers",
    );
    expect(
      await fs.readFile(
        path.join(importOptions.stateDirectory, "tokens", "old-tokens.json"),
        "utf8",
      ),
    ).toBe("previous-tokens");
    jest.restoreAllMocks();
    expect(await importer.applyPending()).toBe(true);
  });

  it("recovers a journal left after commit without applying the import twice", async () => {
    const preview = await importer.preview(backupId);
    await importer.stage({ backupId, fingerprint: preview.fingerprint });
    const rename = fs.rename.bind(fs);
    jest.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
      if (String(newPath).endsWith("last-import.json"))
        throw new Error("receipt write failed");
      return rename(oldPath, newPath);
    });
    await expect(importer.applyPending()).rejects.toThrow(
      "receipt write failed",
    );
    jest.restoreAllMocks();
    await expect(
      new LocalImportService({
        ...importOptions,
        appConfigPath: path.join(root, "different-app.yaml"),
      }).applyPending(),
    ).rejects.toThrow("destinations changed during recovery");
    expect(await new LocalImportService(importOptions).applyPending()).toBe(
      true,
    );
    expect(await importer.pending()).toBeNull();
    expect(await fs.readFile(importOptions.appConfigPath, "utf8")).toBe(
      stringify(DEFAULT_CONFIG),
    );
  });

  it("recovers an interrupted rollback before another startup can load partial state", async () => {
    const preview = await importer.preview(backupId);
    await importer.stage({ backupId, fingerprint: preview.fingerprint });
    const rename = fs.rename.bind(fs);
    jest.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
      if (String(oldPath).endsWith("-tokens.new"))
        throw new Error("replacement interrupted");
      if (
        String(oldPath).endsWith(".old") &&
        String(newPath) === importOptions.appConfigPath
      )
        throw new Error("rollback interrupted");
      return rename(oldPath, newPath);
    });
    await expect(importer.applyPending()).rejects.toThrow(
      "rollback interrupted",
    );
    jest.restoreAllMocks();
    await expect(
      new LocalImportService(importOptions).applyPending(false),
    ).rejects.toThrow("standalone gateway");
    expect(await fs.readFile(importOptions.appConfigPath, "utf8")).toBe(
      "previous-app",
    );
    expect(await fs.readFile(importOptions.serversConfigPath, "utf8")).toBe(
      "previous-servers",
    );
    expect(
      await fs.readFile(
        path.join(importOptions.stateDirectory, "tokens", "old-tokens.json"),
        "utf8",
      ),
    ).toBe("previous-tokens");
    await importer.cancel();
  });

  it("rejects symlinked destinations before replacing files and removes preparation files", async () => {
    const preview = await importer.preview(backupId);
    await importer.stage({ backupId, fingerprint: preview.fingerprint });
    await fs.rm(importOptions.serversConfigPath);
    await fs.symlink(
      exportOptions.serversConfigPath,
      importOptions.serversConfigPath,
    );
    await expect(importer.applyPending()).rejects.toThrow("without symlinks");
    expect(await fs.readFile(importOptions.appConfigPath, "utf8")).toBe(
      "previous-app",
    );
    expect(
      (await fs.readdir(path.dirname(importOptions.appConfigPath))).filter(
        (name) => name.endsWith(".new"),
      ),
    ).toEqual([]);
  });

  it("keeps retained rollback state out of later exports", async () => {
    const preview = await importer.preview(backupId);
    await importer.stage({ backupId, fingerprint: preview.fingerprint });
    await importer.applyPending();
    const exported = await new LocalExportService({
      ...exportOptions,
      stateDirectory: importOptions.stateDirectory,
    }).create({
      effectiveAppConfig: stringify(DEFAULT_CONFIG),
      effectiveTargetServers: [],
    });
    expect(
      exported.included.some((file) => file.includes(".mcpx-import-")),
    ).toBe(false);
    expect(
      exported.omitted.some((file) => file.item.includes(".mcpx-import-")),
    ).toBe(true);
  });

  it("refuses startup application when persistence is managed by Hub", async () => {
    const preview = await importer.preview(backupId);
    await importer.stage({ backupId, fingerprint: preview.fingerprint });
    await expect(importer.applyPending(false)).rejects.toThrow(
      "standalone gateway",
    );
    expect(await fs.readFile(importOptions.appConfigPath, "utf8")).toBe(
      "previous-app",
    );
  });
});
