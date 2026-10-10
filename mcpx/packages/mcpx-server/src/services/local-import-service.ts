import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { parse } from "yaml";
import z from "zod/v4";
import {
  appConfigSchema,
  LocalBackupImportRequest,
  LocalBackupImportResponse,
  LocalBackupPreview,
  localBackupImportRequestSchema,
  localBackupSelectionSchema,
  savedSetupItemSchema,
} from "@mcpx/shared-model";
import { OAuthClientInformationFullSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { targetServerConfigSchema } from "../model/target-servers.js";
import { storedTokensSchema } from "./oauth-token-store.js";
import { env } from "../env.js";

export interface LocalImportOptions {
  backupDirectory: string;
  appConfigPath: string;
  serversConfigPath: string;
  stateDirectory: string;
}

const manifestSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  backupId: localBackupSelectionSchema.shape.backupId,
  createdAt: z.string().datetime(),
  included: z.array(z.string()),
  omitted: z.array(z.object({ item: z.string(), reason: z.string() })),
});
const pendingSchema = localBackupImportRequestSchema.extend({
  id: z.string().uuid(),
});
const journalSchema = pendingSchema.extend({
  committed: z.boolean(),
  originals: z.array(z.boolean()).length(4),
  destinationsHash: z.string().regex(/^[a-f0-9]{64}$/),
});
type Journal = z.infer<typeof journalSchema>;
type ImportFile = { relative: string; content: Buffer };

export class BackupImportError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export function getLocalImportOptions(): LocalImportOptions {
  return {
    backupDirectory: path.resolve(
      env.MCPX_BACKUP_DIR ?? path.join(homedir(), ".config", "mcpx", "backups"),
    ),
    appConfigPath: path.resolve(env.APP_CONFIG_PATH),
    serversConfigPath: path.resolve(env.SERVERS_CONFIG_PATH),
    stateDirectory: path.join(process.cwd(), ".mcpx"),
  };
}

export class LocalImportService {
  private busy = false;
  private readonly controlDirectory: string;

  constructor(private readonly options: LocalImportOptions) {
    this.controlDirectory = path.join(
      path.resolve(options.backupDirectory),
      ".restore",
    );
  }

  async preview(backupId: string): Promise<LocalBackupPreview> {
    const selection = localBackupSelectionSchema.safeParse({ backupId });
    if (!selection.success)
      throw new BackupImportError("Use a backup folder name, without a path.");
    await assertDirectory(path.resolve(this.options.backupDirectory));
    return (
      await this.readBackup(
        path.join(this.options.backupDirectory, backupId),
        backupId,
      )
    ).preview;
  }

  async pending(): Promise<LocalBackupImportResponse | null> {
    const request = await this.readPending();
    return request
      ? {
          backupId: request.backupId,
          restartRequired: true,
          message:
            "Import queued. Restart MCPX to restore configuration, locally saved setups, and OAuth state.",
        }
      : null;
  }

  async stage(
    input: LocalBackupImportRequest,
  ): Promise<LocalBackupImportResponse> {
    if (this.busy)
      throw new BackupImportError(
        "Another import operation is in progress.",
        409,
      );
    this.busy = true;
    let staging: string | undefined;
    try {
      const request = localBackupImportRequestSchema.safeParse(input);
      if (!request.success)
        throw new BackupImportError("Invalid backup import request.");
      await privateDirectory(path.resolve(this.options.backupDirectory));
      await privateDirectory(this.controlDirectory);
      if (await optionalStat(this.journalPath()))
        throw new BackupImportError(
          "An import transaction needs recovery before another import can be queued.",
          409,
        );
      if (await this.readPending())
        throw new BackupImportError(
          "An import is already queued. Cancel it before choosing another backup.",
          409,
        );
      const backup = await this.readBackup(
        path.join(this.options.backupDirectory, request.data.backupId),
        request.data.backupId,
      );
      if (backup.preview.fingerprint !== request.data.fingerprint) {
        throw new BackupImportError(
          "The backup changed since preview. Review it again before importing.",
          409,
        );
      }
      const id = randomUUID();
      staging = path.join(this.controlDirectory, `staged-${id}`);
      await privateDirectory(staging);
      for (const file of backup.files) {
        const destination = path.join(staging, file.relative);
        await privateDirectory(path.dirname(destination));
        await privateFile(destination, file.content);
      }
      await privateDirectory(path.join(staging, ".mcpx"));
      const temporary = path.join(this.controlDirectory, `request-${id}.json`);
      await privateFile(temporary, JSON.stringify({ ...request.data, id }));
      try {
        await fs.link(temporary, this.pendingPath());
        staging = undefined;
      } catch (error) {
        if (isMissing(error, "EEXIST"))
          throw new BackupImportError("An import is already queued.", 409);
        throw error;
      } finally {
        await fs.rm(temporary, { force: true });
      }
      const result = await this.pending();
      if (!result)
        throw new BackupImportError(
          "Failed to publish the pending import.",
          500,
        );
      return result;
    } finally {
      if (staging) await fs.rm(staging, { recursive: true, force: true });
      this.busy = false;
    }
  }

  async cancel(): Promise<void> {
    if (this.busy)
      throw new BackupImportError(
        "Another import operation is in progress.",
        409,
      );
    this.busy = true;
    try {
      if (await optionalStat(this.journalPath()))
        throw new BackupImportError(
          "An import transaction is in progress; preserve its queue and recovery files.",
          409,
        );
      const request = await this.readPending();
      if (!request) return;
      await fs.unlink(this.pendingPath());
      await fs.rm(path.join(this.controlDirectory, `staged-${request.id}`), {
        recursive: true,
        force: true,
      });
    } finally {
      this.busy = false;
    }
  }

  async applyPending(supported = true): Promise<boolean> {
    if (await optionalStat(this.controlDirectory)) {
      await assertDirectory(path.resolve(this.options.backupDirectory));
      await assertDirectory(this.controlDirectory);
    }
    const previous = await optionalJson(this.journalPath());
    if (previous !== undefined) {
      const journal = journalSchema.safeParse(previous);
      if (!journal.success)
        throw new BackupImportError(
          "Invalid import recovery journal; manual recovery is required.",
        );
      if (
        journal.data.destinationsHash !== this.destinationsHash(journal.data.id)
      )
        throw new BackupImportError(
          "Import destinations changed during recovery; restore the original paths before restarting.",
        );
      await this.recover(journal.data);
      if (journal.data.committed) return true;
    }
    const request = await this.readPending();
    if (!request) return false;
    if (!supported)
      throw new BackupImportError(
        "Queued imports require a standalone gateway with file-backed server configuration.",
      );
    const staging = path.join(this.controlDirectory, `staged-${request.id}`);
    const backup = await this.readBackup(staging, request.backupId);
    if (backup.preview.fingerprint !== request.fingerprint)
      throw new BackupImportError(
        "The staged import changed. Cancel it and review the original backup again.",
      );
    const targets = this.targets(request.id);
    if (new Set(targets.map((entry) => entry.target)).size !== targets.length)
      throw new BackupImportError("Import destinations overlap.");
    for (const entry of targets.filter((entry) => entry.directory)) {
      if (
        targets.some(
          (other) => other !== entry && isInside(entry.target, other.target),
        ) ||
        isInside(entry.target, this.controlDirectory)
      ) {
        throw new BackupImportError(
          "Import configuration and backup paths must be outside the restored state subdirectories.",
        );
      }
    }
    const originals: boolean[] = [];
    const prepared: typeof targets = [];
    try {
      for (const entry of targets) {
        await privateDirectory(path.dirname(entry.target));
        const original = await optionalStat(entry.target);
        if (
          original &&
          (original.isSymbolicLink() ||
            (entry.directory ? !original.isDirectory() : !original.isFile()))
        ) {
          throw new BackupImportError(
            "Import destinations must be regular files or directories, without symlinks.",
          );
        }
        originals.push(original !== undefined);
        if (await optionalStat(entry.old))
          throw new BackupImportError(
            "Import rollback files already exist; manual recovery is required.",
          );
        prepared.push(entry);
        await fs.rm(entry.fresh, { recursive: entry.directory, force: true });
        if (entry.directory) {
          await privateDirectory(entry.fresh);
          const prefix = `${entry.relative}/`;
          for (const file of backup.files.filter((file) =>
            file.relative.startsWith(prefix),
          )) {
            await privateFile(
              path.join(entry.fresh, file.relative.slice(prefix.length)),
              file.content,
            );
          }
        } else {
          const file = backup.files.find(
            (file) => file.relative === entry.relative,
          );
          if (!file)
            throw new BackupImportError(
              "The import is missing a required gateway configuration file.",
            );
          await privateFile(entry.fresh, file.content);
        }
      }
    } catch (error) {
      for (const entry of prepared)
        await fs.rm(entry.fresh, { recursive: entry.directory, force: true });
      throw error;
    }
    const journal: Journal = {
      ...request,
      committed: false,
      originals,
      destinationsHash: this.destinationsHash(request.id),
    };
    try {
      await this.writeJournal(journal);
    } catch (error) {
      for (const entry of targets)
        await fs.rm(entry.fresh, { recursive: entry.directory, force: true });
      throw error;
    }
    try {
      for (const [index, entry] of targets.entries()) {
        if (originals[index]) {
          await fs.rename(entry.target, entry.old);
          await fs.chmod(entry.old, entry.directory ? 0o700 : 0o600);
        }
        await fs.rename(entry.fresh, entry.target);
      }
      await this.writeJournal({ ...journal, committed: true });
      journal.committed = true;
    } catch (error) {
      await this.recover(journal);
      throw new BackupImportError(
        `Import failed and the previous files were restored (${isMissing(error, "EACCES") ? "permission denied" : "filesystem error"}).`,
        500,
      );
    }
    await this.recover(journal);
    return true;
  }

  private targets(id: string): Array<{
    target: string;
    relative: string;
    directory: boolean;
    old: string;
    fresh: string;
  }> {
    return [
      {
        target: path.resolve(this.options.appConfigPath),
        relative: "config/app.yaml",
        directory: false,
      },
      {
        target: path.resolve(this.options.serversConfigPath),
        relative: "config/mcp.json",
        directory: false,
      },
      {
        target: path.join(this.options.stateDirectory, "tokens"),
        relative: ".mcpx/tokens",
        directory: true,
      },
      {
        target: path.join(this.options.stateDirectory, "saved-setups"),
        relative: ".mcpx/saved-setups",
        directory: true,
      },
    ].map((entry) => ({
      ...entry,
      old: path.join(
        path.dirname(entry.target),
        `.mcpx-import-${id}-${path.basename(entry.target)}.old`,
      ),
      fresh: path.join(
        path.dirname(entry.target),
        `.mcpx-import-${id}-${path.basename(entry.target)}.new`,
      ),
    }));
  }

  private async recover(journal: Journal): Promise<void> {
    const targets = this.targets(journal.id);
    if (!journal.committed) {
      for (const [index, entry] of [...targets.entries()].reverse()) {
        await assertDirectory(path.dirname(entry.target));
        const original = await optionalStat(entry.old);
        if (
          original &&
          (original.isSymbolicLink() ||
            (entry.directory ? !original.isDirectory() : !original.isFile()))
        )
          throw new BackupImportError(
            "Rollback originals must be regular files or directories; manual recovery is required.",
          );
        if (original) {
          await fs.rm(entry.target, {
            recursive: entry.directory,
            force: true,
          });
          await fs.rename(entry.old, entry.target);
        } else if (!journal.originals[index]) {
          await fs.rm(entry.target, {
            recursive: entry.directory,
            force: true,
          });
        }
        await fs.rm(entry.fresh, { recursive: entry.directory, force: true });
      }
    } else {
      const receipt = path.join(this.controlDirectory, "last-import.json");
      await replacePrivateFile(
        receipt,
        JSON.stringify({
          backupId: journal.backupId,
          appliedAt: new Date().toISOString(),
          previousFiles: targets
            .filter((_entry, index) => journal.originals[index])
            .map((entry) => entry.old),
        }),
      );
      await fs.rm(this.pendingPath(), { force: true });
      await fs.rm(path.join(this.controlDirectory, `staged-${journal.id}`), {
        recursive: true,
        force: true,
      });
    }
    await fs.unlink(this.journalPath());
  }

  private async readBackup(
    directory: string,
    expectedId: string,
  ): Promise<{ preview: LocalBackupPreview; files: ImportFile[] }> {
    await assertDirectory(directory);
    const manifestFile = await readRegular(
      path.join(directory, "manifest.json"),
    );
    let manifest: z.infer<typeof manifestSchema>;
    try {
      manifest = manifestSchema.parse(
        JSON.parse(manifestFile.toString("utf8")),
      );
    } catch {
      throw new BackupImportError(
        "The backup manifest is invalid or uses an unsupported format.",
      );
    }
    if (manifest.backupId !== expectedId)
      throw new BackupImportError(
        "The backup folder name does not match its manifest.",
      );
    const files: ImportFile[] = [
      { relative: "manifest.json", content: manifestFile },
    ];
    let total = manifestFile.length;
    for (const relative of ["config/app.yaml", "config/mcp.json"]) {
      await assertDirectory(path.join(directory, "config"));
      if (
        !manifest.included.some(
          (item) => item === relative || item.startsWith(`${relative} (`),
        )
      )
        throw new BackupImportError(
          "The manifest does not include required gateway configuration.",
        );
      const content = await readRegular(path.join(directory, relative));
      files.push({ relative, content });
      total += content.length;
    }
    let serverNames: string[];
    try {
      appConfigSchema.parse(parse(files[1]!.content.toString("utf8")));
      serverNames = Object.keys(
        targetServerConfigSchema.parse(
          JSON.parse(files[2]!.content.toString("utf8")),
        ).mcpServers,
      ).sort();
    } catch {
      throw new BackupImportError(
        "The backup contains invalid gateway or MCP server configuration.",
      );
    }
    await assertDirectory(path.join(directory, ".mcpx"));
    if (!manifest.included.some((item) => item.startsWith(".mcpx/")))
      throw new BackupImportError(
        "This backup has no declared durable gateway state; restore its configuration manually.",
      );
    let savedSetupCount = 0;
    let oauthFileCount = 0;
    for (const kind of ["tokens", "saved-setups"] as const) {
      const folder = path.join(directory, ".mcpx", kind);
      if (!(await optionalStat(folder))) continue;
      await assertDirectory(folder);
      for (const name of (await fs.readdir(folder)).sort()) {
        if (!/^[a-zA-Z0-9._-]+$/.test(name))
          throw new BackupImportError(
            "The backup contains an unsafe state file name.",
          );
        const relative = `.mcpx/${kind}/${name}`;
        if (!manifest.included.includes(relative))
          throw new BackupImportError(
            "A gateway state file is missing from the manifest.",
          );
        const content = await readRegular(path.join(folder, name));
        try {
          if (kind === "saved-setups") {
            const item = savedSetupItemSchema.parse(
              JSON.parse(content.toString("utf8")),
            );
            if (name !== `${item.id}.json`)
              throw new Error("Mismatched saved setup id");
            savedSetupCount++;
          } else {
            if (name.endsWith("-tokens.json"))
              storedTokensSchema.parse(JSON.parse(content.toString("utf8")));
            else if (name.endsWith("-client.json"))
              OAuthClientInformationFullSchema.parse(
                JSON.parse(content.toString("utf8")),
              );
            else if (!name.endsWith("-verifier.txt"))
              throw new Error("Unknown token file");
            oauthFileCount++;
          }
        } catch {
          throw new BackupImportError(
            "The backup contains invalid saved setup or OAuth state files.",
          );
        }
        total += content.length;
        if (total > 64 * 1024 * 1024 || files.length >= 10000)
          throw new BackupImportError(
            "The gateway import exceeds the 64 MiB or 10,000-file limit.",
          );
        files.push({ relative, content });
      }
    }
    const restored = files
      .filter((file) => file.relative !== "manifest.json")
      .map((file) => file.relative);
    for (const item of manifest.included) {
      if (
        (item.startsWith(".mcpx/tokens/") ||
          item.startsWith(".mcpx/saved-setups/")) &&
        !restored.includes(item)
      )
        throw new BackupImportError(
          "A gateway state file declared in the manifest is missing.",
        );
    }
    const hash = createHash("sha256");
    for (const file of files)
      hash
        .update(`${file.relative}\0${file.content.length}\0`)
        .update(file.content);
    return {
      files,
      preview: {
        backupId: manifest.backupId,
        createdAt: manifest.createdAt,
        fingerprint: hash.digest("hex"),
        serverNames,
        savedSetupCount,
        oauthFileCount,
        restored,
        manual: manifest.included.filter(
          (item) =>
            !restored.some(
              (file) => item === file || item.startsWith(`${file} (`),
            ) && !item.startsWith(".mcpx/ ("),
        ),
        restartRequired: true,
      },
    };
  }

  private async readPending(): Promise<
    z.infer<typeof pendingSchema> | undefined
  > {
    if (!(await optionalStat(this.controlDirectory))) return undefined;
    await assertDirectory(path.resolve(this.options.backupDirectory));
    await assertDirectory(this.controlDirectory);
    const data = await optionalJson(this.pendingPath());
    if (data === undefined) return undefined;
    const result = pendingSchema.safeParse(data);
    if (!result.success)
      throw new BackupImportError(
        "Invalid pending import metadata; manual recovery is required.",
      );
    return result.data;
  }

  private pendingPath(): string {
    return path.join(this.controlDirectory, "pending.json");
  }
  private journalPath(): string {
    return path.join(this.controlDirectory, "transaction.json");
  }
  private async writeJournal(journal: Journal): Promise<void> {
    await replacePrivateFile(this.journalPath(), JSON.stringify(journal));
  }
  private destinationsHash(id: string): string {
    return createHash("sha256")
      .update(JSON.stringify(this.targets(id).map((entry) => entry.target)))
      .digest("hex");
  }
}

async function assertDirectory(directory: string): Promise<void> {
  const stat = await optionalStat(directory);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink())
    throw new BackupImportError(
      "A required backup directory is missing or is not a regular directory.",
    );
}

async function privateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await assertDirectory(directory);
  await fs.chmod(directory, 0o700);
}

async function optionalStat(
  file: string,
): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function readRegular(file: string): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const source = await fs.lstat(file);
    if (source.isSymbolicLink() || !source.isFile())
      throw new BackupImportError(
        "Import files must be regular files, without symlinks.",
      );
    handle = await fs.open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
      throw new BackupImportError(
        "Import files must be regular files of at most 16 MiB, without symlinks.",
      );
    const content = Buffer.allocUnsafe(stat.size + 1);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(
        content,
        offset,
        content.length - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > stat.size)
      throw new BackupImportError(
        "An import file changed while being read. Preview the backup again.",
      );
    return content.subarray(0, offset);
  } catch (error) {
    if (error instanceof BackupImportError) throw error;
    throw new BackupImportError(
      "A required import file is missing, unreadable, or a symlink.",
    );
  } finally {
    await handle?.close();
  }
}

async function privateFile(
  file: string,
  content: string | Buffer,
): Promise<void> {
  const handle = await fs.open(file, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replacePrivateFile(
  file: string,
  content: string,
): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await privateFile(temporary, content);
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function optionalJson(file: string): Promise<unknown> {
  if (!(await optionalStat(file))) return undefined;
  try {
    return JSON.parse((await readRegular(file)).toString("utf8"));
  } catch {
    throw new BackupImportError(
      "Invalid import metadata; manual recovery is required.",
    );
  }
}

function isMissing(error: unknown, code = "ENOENT"): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}
