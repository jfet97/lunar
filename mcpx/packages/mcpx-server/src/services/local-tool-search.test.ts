import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createLogger, transports } from "winston";
import { LocalToolSearch } from "./local-tool-search.js";

const logger = createLogger({
  transports: [new transports.Console({ silent: true })],
});
const page: Tool = {
  name: "confluence__read_page",
  description: "Read documentation",
  inputSchema: { type: "object" },
};
const error: Tool = {
  name: "sentry__get_issue",
  description: "Read error details",
  inputSchema: { type: "object" },
};

function vector(index: number): number[] {
  const result = Array<number>(384).fill(0);
  result[index] = 1;
  return result;
}

describe("local hybrid tool search", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "mcpx-search-"));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(directory, { recursive: true });
  });

  it("finds semantically matching tools without shared query keywords", async () => {
    const embed = jest.fn(async (texts: string[]) =>
      texts.map((text) =>
        vector(
          text.includes("confluence") || text === "leggi la documentazione"
            ? 0
            : 1,
        ),
      ),
    );
    const search = new LocalToolSearch(
      logger,
      embed,
      join(directory, "vectors.json"),
    );
    expect(
      await search.search([page, error], "leggi la documentazione"),
    ).toEqual([page]);
  });

  it("persists tool embeddings and never ranks tools outside the current visible set", async () => {
    const embed = jest.fn(async (texts: string[]) =>
      texts.map(() => vector(0)),
    );
    const cache = join(directory, "vectors.json");
    const first = new LocalToolSearch(logger, embed, cache);
    await first.search([page, error], "documentation");
    expect(embed).toHaveBeenCalledTimes(2);
    embed.mockClear();
    const second = new LocalToolSearch(logger, embed, cache);
    expect(await second.search([page], "documentation")).toEqual([page]);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledWith(["documentation"]);
  });

  it("re-embeds changed descriptions and falls back to keyword search on model failure", async () => {
    const embed = jest.fn(async (texts: string[]) =>
      texts.map(() => vector(0)),
    );
    const search = new LocalToolSearch(
      logger,
      embed,
      join(directory, "vectors.json"),
    );
    await search.search([page], "documentation");
    embed.mockClear();
    await search.search(
      [{ ...page, description: "Changed documentation" }],
      "documentation",
    );
    expect(embed).toHaveBeenCalledTimes(2);
    const failing = new LocalToolSearch(
      logger,
      async () => {
        throw new Error("model unavailable");
      },
      join(directory, "missing.json"),
    );
    expect(await failing.search([page, error], "error")).toEqual([error]);
  });

  it("logs only the first embedding failure for an instance", async () => {
    const warning = jest.spyOn(logger, "warn");
    const failing = new LocalToolSearch(
      logger,
      async () => {
        throw new Error("model unavailable");
      },
      join(directory, "missing.json"),
    );
    await failing.search([page], "docs");
    await failing.search([page], "docs");
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it("serializes embedding work across concurrent searches", async () => {
    let active = 0;
    let peak = 0;
    const search = new LocalToolSearch(
      logger,
      async (texts) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return texts.map(() => vector(0));
      },
      join(directory, "vectors.json"),
    );
    await Promise.all([
      search.search([page], "docs"),
      search.search([error], "failure"),
    ]);
    expect(peak).toBe(1);
  });
});
