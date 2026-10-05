import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  SavedSetupItem,
  savedSetupItemSchema,
  SaveSetupResponse,
} from "@mcpx/shared-model";
import { CurrentSetup } from "./setup-manager.js";

export class LocalSavedSetups {
  constructor(private readonly directory: string) {}

  async save(
    description: string,
    setup: CurrentSetup,
  ): Promise<SaveSetupResponse> {
    const savedAt = new Date().toISOString();
    const item = savedSetupItemSchema.parse({
      id: randomUUID(),
      description,
      savedAt,
      ...structuredClone(setup),
    });
    await this.write(item);
    return {
      success: true,
      savedSetupId: item.id,
      description: item.description,
      savedAt: item.savedAt,
    };
  }

  async list(): Promise<{ setups: SavedSetupItem[] }> {
    await this.ensureDirectory();
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    const setups: SavedSetupItem[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith(".json") || entry.isSymbolicLink()) continue;
      const item = await this.read(entry.name.slice(0, -5));
      if (item) setups.push(redactSavedSetupForList(item));
    }
    setups.sort((left, right) => right.savedAt.localeCompare(left.savedAt));
    return { setups };
  }

  async get(savedSetupId: string): Promise<SavedSetupItem | undefined> {
    if (!isSavedSetupId(savedSetupId)) return undefined;
    return this.read(savedSetupId);
  }

  async overwrite(savedSetupId: string, setup: CurrentSetup): Promise<boolean> {
    if (!isSavedSetupId(savedSetupId)) return false;
    const current = await this.read(savedSetupId);
    if (!current) return false;
    await this.write(
      savedSetupItemSchema.parse({
        ...current,
        ...structuredClone(setup),
        savedAt: new Date().toISOString(),
      }),
    );
    return true;
  }

  async delete(savedSetupId: string): Promise<boolean> {
    if (!isSavedSetupId(savedSetupId)) return false;
    await this.ensureDirectory();
    try {
      await fs.unlink(this.itemPath(savedSetupId));
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  }

  private async read(
    savedSetupId: string,
  ): Promise<SavedSetupItem | undefined> {
    if (!isSavedSetupId(savedSetupId)) return undefined;
    await this.ensureDirectory();
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(
        this.itemPath(savedSetupId),
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const stat = await handle.stat();
      if (!stat.isFile()) return undefined;
      return savedSetupItemSchema.parse(
        JSON.parse(await handle.readFile({ encoding: "utf8" })),
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      if (isNodeError(error) && error.code === "ELOOP") return undefined;
      throw new Error(`Could not read local saved setup ${savedSetupId}`, {
        cause: error,
      });
    } finally {
      await handle?.close();
    }
  }

  private async write(item: SavedSetupItem): Promise<void> {
    await this.ensureDirectory();
    const destination = this.itemPath(item.id);
    const temporary = path.join(
      this.directory,
      `.${item.id}.${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(JSON.stringify(item, null, 2), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, destination);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw new Error("Could not write local saved setup", { cause: error });
    }
  }

  private async ensureDirectory(): Promise<void> {
    const parent = path.dirname(this.directory);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(parent);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(this.directory);
  }

  private itemPath(savedSetupId: string): string {
    return path.join(this.directory, `${savedSetupId}.json`);
  }
}

export function redactSavedSetupForList(item: SavedSetupItem): SavedSetupItem {
  const targetServers = Object.fromEntries(
    Object.entries(item.targetServers).map(([name, entry]) => {
      const { initiation } = entry;
      const safeInitiation =
        initiation.type === "stdio"
          ? {
              type: "stdio" as const,
              command: "node" as const,
              args: [],
              env: {},
            }
          : {
              type: initiation.type,
              url: "https://redacted.invalid",
            };
      return [
        name,
        {
          initiation: safeInitiation,
          ...(entry.catalogItemId
            ? { catalogItemId: entry.catalogItemId }
            : {}),
        },
      ];
    }),
  );
  const config: SavedSetupItem["config"] = {};
  if (item.config.toolGroups) config.toolGroups = item.config.toolGroups;
  if (item.config.skills) config.skills = item.config.skills;
  return { ...item, targetServers, config };
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Local saved setup path is not a directory: ${directory}`);
  }
  await fs.chmod(directory, 0o700);
}

function isSavedSetupId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
