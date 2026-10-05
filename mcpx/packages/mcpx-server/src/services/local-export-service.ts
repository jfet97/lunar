import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { LocalExportResponse } from "@mcpx/shared-model";
import { TargetServer } from "../model/target-servers.js";

export interface LocalExportOptions {
  backupDirectory: string;
  appConfigPath: string;
  serversConfigPath: string;
  stateDirectory: string;
  composePath: string;
  composeSourceRoot: string;
  imagePath: string;
  imageSourceRoot: string;
  claudeConfigPath: string;
  claudeConfigSourceRoot: string;
  codexConfigPath: string;
  codexConfigSourceRoot: string;
  appConfigSourceRoot: string;
  serversConfigSourceRoot: string;
}

interface ExportManifest {
  backupId: string;
  createdAt: string;
  included: string[];
  omitted: LocalExportResponse["omitted"];
}

export class LocalExportService {
  constructor(private readonly options: LocalExportOptions) {}

  async create(input: {
    effectiveAppConfig: string;
    effectiveTargetServers: TargetServer[];
  }): Promise<LocalExportResponse> {
    const createdAt = new Date().toISOString();
    const backupId = `mcpx-${createdAt
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z")}-${randomUUID()}`;
    const root = path.resolve(this.options.backupDirectory);
    const destination = path.join(root, backupId);
    const staging = path.join(root, `.${backupId}.partial`);
    const included: string[] = [];
    const omitted: LocalExportResponse["omitted"] = [];

    try {
      await ensurePrivateDirectory(root);
      await fs.mkdir(staging, { mode: 0o700 });
      await fs.chmod(staging, 0o700);

      await writePrivateFile(
        staging,
        "config/app.yaml",
        input.effectiveAppConfig,
      );
      included.push("config/app.yaml (effective runtime configuration)");

      const copiedAppConfig = await copySingleFile(
        this.options.appConfigPath,
        staging,
        "sources/configured-app.yaml",
        omitted,
        "Configured APP_CONFIG_PATH source",
        this.options.appConfigSourceRoot,
      );
      if (copiedAppConfig) {
        included.push("sources/configured-app.yaml (configured app file)");
      } else if (
        !omitted.some(
          (entry) => entry.item === "Configured APP_CONFIG_PATH source",
        )
      ) {
        omitted.push({
          item: "Configured APP_CONFIG_PATH source",
          reason:
            "The source file is absent; config/app.yaml contains the effective runtime configuration.",
        });
      }

      const copiedServersConfig = await copySingleFile(
        this.options.serversConfigPath,
        staging,
        "config/mcp.json",
        omitted,
        "Configured SERVERS_CONFIG_PATH source",
        this.options.serversConfigSourceRoot,
      );
      if (copiedServersConfig) {
        included.push("config/mcp.json (configured server file)");
      } else {
        await writePrivateFile(
          staging,
          "config/mcp.json",
          serializeTargetServers(input.effectiveTargetServers),
        );
        included.push(
          "config/mcp.json (generated from effective runtime servers)",
        );
      }
      await writePrivateFile(
        staging,
        "runtime/mcp.json",
        serializeTargetServers(input.effectiveTargetServers),
      );
      included.push("runtime/mcp.json (effective runtime servers)");

      await copyStateTree(
        this.options.stateDirectory,
        root,
        staging,
        included,
        omitted,
      );

      const optionalFiles: Array<{
        source: string;
        destination: string;
        item: string;
        sourceRoot: string;
      }> = [
        {
          source: this.options.composePath,
          destination: "deployment/compose.yaml",
          item: "Deployment Compose file",
          sourceRoot: this.options.composeSourceRoot,
        },
        {
          source: this.options.imagePath,
          destination: "deployment/image.txt",
          item: "Deployment image provenance",
          sourceRoot: this.options.imageSourceRoot,
        },
        {
          source: this.options.claudeConfigPath,
          destination: "clients/claude-config.json",
          item: "Claude host client config",
          sourceRoot: this.options.claudeConfigSourceRoot,
        },
        {
          source: this.options.codexConfigPath,
          destination: "clients/codex-config.toml",
          item: "Codex host client config",
          sourceRoot: this.options.codexConfigSourceRoot,
        },
      ];
      for (const file of optionalFiles) {
        const copied = await copySingleFile(
          file.source,
          staging,
          file.destination,
          omitted,
          file.item,
          file.sourceRoot,
        );
        if (copied) included.push(`${file.destination} (${file.item})`);
      }

      omitted.push({
        item: "Hub-managed profile secrets and skill catalogs",
        reason:
          "These values are held by Hub or in process memory and are not persisted in the local gateway state.",
      });
      omitted.push({
        item: "Rebuildable embedding caches and live sessions",
        reason:
          "These are regenerated or transient and are intentionally excluded.",
      });

      const manifest: ExportManifest = {
        backupId,
        createdAt,
        included,
        omitted,
      };
      await writePrivateFile(
        staging,
        "manifest.json",
        JSON.stringify(manifest, null, 2),
      );
      await fs.rename(staging, destination);

      return { backupId, createdAt, destination, included, omitted };
    } catch (error) {
      await fs
        .rm(staging, { recursive: true, force: true })
        .catch(() => undefined);
      throw new Error(
        `Local backup export failed under ${root}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
}

function serializeTargetServers(servers: TargetServer[]): string {
  const mcpServers = Object.fromEntries(
    servers.map(({ name, catalogItemId: _catalogItemId, ...server }) => [
      name,
      server,
    ]),
  );
  return JSON.stringify({ mcpServers }, null, 2);
}

async function copyStateTree(
  sourceRoot: string,
  backupRoot: string,
  staging: string,
  included: string[],
  omitted: LocalExportResponse["omitted"],
): Promise<void> {
  let rootStat;
  try {
    rootStat = await fs.lstat(sourceRoot);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      omitted.push({
        item: ".mcpx durable state",
        reason: "The local state directory does not exist.",
      });
      return;
    }
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    omitted.push({
      item: ".mcpx durable state",
      reason: "The configured state root is not a regular directory.",
    });
    return;
  }
  if (path.resolve(sourceRoot) === path.resolve(backupRoot)) {
    throw new Error(
      "Backup destination cannot be the same as the local state directory",
    );
  }

  const destinationRoot = path.join(staging, ".mcpx");
  await makePrivateDirectory(destinationRoot);
  await copyDirectoryContents(
    sourceRoot,
    destinationRoot,
    ".mcpx",
    isWithinRoot(path.resolve(sourceRoot), path.resolve(backupRoot))
      ? path.resolve(backupRoot)
      : undefined,
    included,
    omitted,
  );
  if (!included.some((item) => item.startsWith(".mcpx/"))) {
    included.push(".mcpx/ (no durable files found)");
  }
}

async function copyDirectoryContents(
  sourceDirectory: string,
  destinationDirectory: string,
  outputRelativeDirectory: string,
  nestedBackupRoot: string | undefined,
  included: string[],
  omitted: LocalExportResponse["omitted"],
): Promise<void> {
  const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!isSafeEntryName(entry.name)) {
      omitted.push({
        item: `${outputRelativeDirectory}/${entry.name}`,
        reason: "Unsafe path name skipped.",
      });
      continue;
    }
    const source = path.join(sourceDirectory, entry.name);
    const outputRelative = `${outputRelativeDirectory}/${entry.name}`;
    const destination = path.join(destinationDirectory, entry.name);
    if (
      nestedBackupRoot &&
      isWithinRoot(nestedBackupRoot, path.resolve(source))
    ) {
      omitted.push({
        item: outputRelative,
        reason: "Backup directories are excluded to prevent recursive exports.",
      });
      continue;
    }
    const skippedReason = excludedStateReason(entry.name);
    if (skippedReason) {
      omitted.push({ item: outputRelative, reason: skippedReason });
      continue;
    }

    const stat = await fs.lstat(source);
    if (stat.isSymbolicLink()) {
      omitted.push({
        item: outputRelative,
        reason: "Symbolic links are not followed.",
      });
      continue;
    }
    if (stat.isDirectory()) {
      await makePrivateDirectory(destination);
      await copyDirectoryContents(
        source,
        destination,
        outputRelative,
        nestedBackupRoot,
        included,
        omitted,
      );
      continue;
    }
    if (!stat.isFile()) {
      omitted.push({
        item: outputRelative,
        reason: "Non-regular filesystem entry skipped.",
      });
      continue;
    }
    await copyRegularFile(source, destination);
    included.push(outputRelative);
  }
}

async function copySingleFile(
  source: string,
  staging: string,
  destinationRelative: string,
  omitted: LocalExportResponse["omitted"],
  item: string,
  sourceRoot: string,
): Promise<boolean> {
  const sourcePath = path.resolve(source);
  const rootPath = path.resolve(sourceRoot);
  if (!isWithinRoot(rootPath, sourcePath)) {
    omitted.push({
      item,
      reason: "The source path is outside its configured source root.",
    });
    return false;
  }
  const componentCheck = await checkPathComponents(rootPath, sourcePath);
  if (componentCheck === "missing") {
    omitted.push({
      item,
      reason: "The source file is unavailable to this process.",
    });
    return false;
  }
  if (componentCheck === "symlink") {
    omitted.push({
      item,
      reason: "A symbolic link in the source path was not followed.",
    });
    return false;
  }
  if (componentCheck === "not-file") {
    omitted.push({ item, reason: "The source path is not a regular file." });
    return false;
  }
  await copyRegularFile(sourcePath, path.join(staging, destinationRelative));
  return true;
}

async function checkPathComponents(
  sourceRoot: string,
  sourcePath: string,
): Promise<"ok" | "missing" | "symlink" | "not-file"> {
  let rootStat;
  try {
    rootStat = await fs.lstat(sourceRoot);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "missing";
    throw error;
  }
  if (rootStat.isSymbolicLink()) return "symlink";
  if (!rootStat.isDirectory()) return "not-file";
  const relative = path.relative(sourceRoot, sourcePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return "missing";
  const components = relative.split(path.sep).filter(Boolean);
  let current = sourceRoot;
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return "missing";
      throw error;
    }
    if (stat.isSymbolicLink()) return "symlink";
    if (index < components.length - 1 && !stat.isDirectory()) return "not-file";
    if (index === components.length - 1 && !stat.isFile()) return "not-file";
  }
  return components.length === 0 ? "not-file" : "ok";
}

async function copyRegularFile(
  source: string,
  destination: string,
): Promise<void> {
  let input: Awaited<ReturnType<typeof fs.open>> | undefined;
  let output: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    input = await fs.open(
      source,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const sourceStat = await input.stat();
    if (!sourceStat.isFile()) {
      throw new Error("Source changed to a non-regular file during export");
    }
    await makePrivateDirectory(path.dirname(destination));
    output = await fs.open(destination, "wx", 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      let offset = 0;
      while (offset < bytesRead) {
        const { bytesWritten } = await output.write(
          buffer,
          offset,
          bytesRead - offset,
          null,
        );
        if (bytesWritten === 0) {
          throw new Error("Backup destination stopped accepting data");
        }
        offset += bytesWritten;
      }
    }
    await output.sync();
    await output.chmod(0o600);
  } catch (error) {
    await output?.close().catch(() => undefined);
    await fs.rm(destination, { force: true }).catch(() => undefined);
    if (isNodeError(error) && error.code === "ELOOP") {
      throw new Error("Source became a symbolic link during export", {
        cause: error,
      });
    }
    throw error;
  } finally {
    await input?.close();
    await output?.close();
  }
}

async function writePrivateFile(
  staging: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const destination = path.join(staging, relativePath);
  await makePrivateDirectory(path.dirname(destination));
  const handle = await fs.open(destination, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

async function makePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await ensurePrivateDirectory(directory);
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(
      `Backup destination is not a regular directory: ${directory}`,
    );
  }
  await fs.chmod(directory, 0o700);
}

function excludedStateReason(name: string): string | undefined {
  const normalized = name.toLowerCase();
  if (
    normalized === "tool-embeddings.json" ||
    normalized.includes("embedding")
  ) {
    return "Rebuildable embedding cache excluded.";
  }
  if (
    ["sessions", "session", "live-sessions", "tmp", "temp"].includes(normalized)
  ) {
    return "Transient session or temporary state excluded.";
  }
  if (normalized === "backups" || normalized.endsWith("-backups")) {
    return "Backup directories are excluded to prevent recursive exports.";
  }
  return undefined;
}

function isSafeEntryName(name: string): boolean {
  return (
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0")
  );
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
