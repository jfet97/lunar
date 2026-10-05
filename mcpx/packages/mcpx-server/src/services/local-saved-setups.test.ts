import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CurrentSetup } from "./setup-manager.js";
import { LocalSavedSetups } from "./local-saved-setups.js";

describe("LocalSavedSetups", () => {
  let tempDirectory: string;
  let store: LocalSavedSetups;

  beforeEach(async () => {
    tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "mcpx-setups-"));
    store = new LocalSavedSetups(
      path.join(tempDirectory, ".mcpx", "saved-setups"),
    );
  });

  afterEach(async () => {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  it("saves, lists, overwrites, restores, and deletes local setups", async () => {
    const saved = await store.save("Local setup", currentSetup());
    expect(saved.success).toBe(true);
    if (!saved.success) throw new Error(saved.error);

    const listed = await store.list();
    expect(listed.setups).toHaveLength(1);
    expect(listed.setups[0]).toMatchObject({
      id: saved.savedSetupId,
      description: "Local setup",
    });

    const raw = await store.get(saved.savedSetupId);
    expect(raw?.targetServers["private"]?.initiation).toMatchObject({
      headers: { Authorization: "header-secret" },
    });
    expect(raw?.targetServers["local"]?.initiation).toMatchObject({
      args: ["--token", "argument-secret"],
    });

    const visible = JSON.stringify(listed);
    expect(visible).not.toContain("header-secret");
    expect(visible).not.toContain("environment-secret");
    expect(visible).not.toContain("argument-secret");
    expect(visible).not.toContain("query-secret");
    expect(visible).not.toContain("auth-secret");
    expect(listed.setups[0]?.targetServers["private"]?.initiation).toEqual({
      type: "streamable-http",
      url: "https://redacted.invalid",
    });
    expect(listed.setups[0]?.targetServers["local"]?.initiation).toMatchObject({
      command: "node",
    });

    const replacement = currentSetup();
    replacement.targetServers = {};
    replacement.config.toolGroups = [
      { name: "Updated group", services: { local: ["ping"] } },
    ];
    expect(await store.overwrite(saved.savedSetupId, replacement)).toBe(true);
    expect(await store.get(saved.savedSetupId)).toMatchObject({
      targetServers: {},
      config: {
        toolGroups: [{ name: "Updated group" }],
      },
    });

    expect(await store.delete(saved.savedSetupId)).toBe(true);
    expect(await store.get(saved.savedSetupId)).toBeUndefined();
    expect((await store.list()).setups).toEqual([]);
  });

  it("stores setups privately and removes atomic-write temporary files", async () => {
    const saved = await store.save("Private setup", currentSetup());
    if (!saved.success) throw new Error(saved.error);

    const directory = path.join(tempDirectory, ".mcpx", "saved-setups");
    const directoryMode = (await fs.stat(directory)).mode & 0o777;
    const setupFile = path.join(directory, `${saved.savedSetupId}.json`);
    const fileMode = (await fs.stat(setupFile)).mode & 0o777;
    const entries = await fs.readdir(directory);

    expect(directoryMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
    expect(entries).toEqual([`${saved.savedSetupId}.json`]);
  });

  it("does not follow symlinked saved setup entries", async () => {
    const directory = path.join(tempDirectory, ".mcpx", "saved-setups");
    await fs.mkdir(directory, { recursive: true });
    const external = path.join(tempDirectory, "outside.json");
    await fs.writeFile(external, JSON.stringify({ description: "outside" }));
    const symlinkId = randomUUID();
    await fs.symlink(external, path.join(directory, `${symlinkId}.json`));

    expect((await store.list()).setups).toEqual([]);
    expect(await store.get(symlinkId)).toBeUndefined();
  });
});

function currentSetup(): CurrentSetup {
  return {
    targetServers: {
      private: {
        initiation: {
          type: "streamable-http",
          url: "https://example.com/path?token=query-secret",
          headers: { Authorization: "header-secret" },
        },
      },
      local: {
        initiation: {
          type: "stdio",
          command: "node",
          args: ["--token", "argument-secret"],
          env: { SECRET: "environment-secret" },
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
      auth: { enabled: false, header: "auth-secret" },
      toolExtensions: { services: {} },
      targetServerAttributes: {},
      skills: { enabled: [] },
    },
  };
}
