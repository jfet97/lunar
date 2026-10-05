import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Logger } from "winston";
import { rankToolsLexically } from "../server/lazy-tools.js";
import {
  embedToolTexts,
  EMBEDDING_MODEL_ID,
  EMBEDDING_MODEL_REVISION,
  EMBEDDING_VECTOR_SIZE,
} from "./tool-embeddings.js";

type Embedder = (texts: string[]) => Promise<number[][]>;
const MAX_CACHE_ENTRIES = 4096;

/** Hybrid retrieval with local embeddings shared across sessions, never permissions. */
export class LocalToolSearch {
  private vectors = new Map<string, number[]>();
  private readonly ready: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private warnedForEmbeddingFailure = false;

  constructor(
    private readonly logger: Logger,
    private readonly embed: Embedder = embedToolTexts,
    private readonly cachePath = process.env["MCPX_EMBEDDING_CACHE_PATH"] ??
      ".mcpx/tool-embeddings.json",
  ) {
    this.ready = this.loadCache();
  }

  async search(tools: Tool[], query: string): Promise<Tool[]> {
    const exact = tools.find(
      (tool) => tool.name.toLowerCase() === query.toLowerCase(),
    );
    if (exact) return [exact];
    if (tools.length === 0) return [];
    const task = this.queue.then(() => this.rank(tools, query));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async rank(tools: Tool[], query: string): Promise<Tool[]> {
    const lexical = rankToolsLexically(tools, query);
    try {
      await this.ready;
      const texts = tools.map((tool) =>
        `${tool.name.replace(/([a-z0-9])([A-Z])/g, "$1 $2")}\n${tool.title ?? ""}\n${tool.description ?? ""}`.slice(
          0,
          2000,
        ),
      );
      const keys = texts.map((text) => this.cacheKey(text));
      let changed = false;
      const missing = texts
        .map((text, index) => ({ key: keys[index], text }))
        .filter(
          (item): item is { key: string; text: string } =>
            item.key !== undefined && !this.vectors.has(item.key),
        );
      for (let offset = 0; offset < missing.length; offset += 32) {
        const batch = missing.slice(offset, offset + 32);
        const vectors = await this.embed(batch.map(({ text }) => text));
        if (vectors.length !== batch.length)
          throw new Error(
            "Embedding model returned the wrong number of vectors",
          );
        for (const [index, item] of batch.entries()) {
          const vector = vectors[index];
          if (!isVector(vector))
            throw new Error("Embedding model returned an invalid vector");
          this.vectors.set(item.key, vector);
          changed = true;
        }
      }
      if (changed) await this.saveCache();
      const [queryVector] = await this.embed([query.slice(0, 2000)]);
      if (!isVector(queryVector))
        throw new Error("Embedding model returned an invalid query vector");
      const semantic = tools
        .map((tool, index) => ({
          tool,
          score: cosine(queryVector, this.vectors.get(keys[index] ?? "") ?? []),
        }))
        .filter(({ score }) => score > 0.15)
        .sort(
          (a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name),
        )
        .map(({ tool }) => tool);
      const scores = new Map<string, number>();
      for (const ranking of [semantic, lexical]) {
        for (const [index, tool] of ranking.entries()) {
          scores.set(
            tool.name,
            (scores.get(tool.name) ?? 0) + 1 / (60 + index + 1),
          );
        }
      }
      return tools
        .filter((tool) => scores.has(tool.name))
        .sort(
          (a, b) =>
            (scores.get(b.name) ?? 0) - (scores.get(a.name) ?? 0) ||
            a.name.localeCompare(b.name),
        );
    } catch (error) {
      if (!this.warnedForEmbeddingFailure) {
        this.warnedForEmbeddingFailure = true;
        this.logger.warn(
          "Local tool embeddings unavailable; using keyword search",
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return lexical;
    }
  }

  private cacheKey(text: string): string {
    return createHash("sha256")
      .update(`${EMBEDDING_MODEL_ID}@${EMBEDDING_MODEL_REVISION}\n${text}`)
      .digest("hex");
  }

  private async loadCache(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(this.cachePath, "utf8"),
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return;
      for (const [key, vector] of Object.entries(parsed).slice(
        -MAX_CACHE_ENTRIES,
      )) {
        if (/^[a-f0-9]{64}$/.test(key) && isVector(vector))
          this.vectors.set(key, vector);
      }
    } catch {
      // a missing or invalid cache is rebuilt from the visible catalog
    }
  }

  private async saveCache(): Promise<void> {
    while (this.vectors.size > MAX_CACHE_ENTRIES) {
      const oldest = this.vectors.keys().next().value;
      if (oldest === undefined) break;
      this.vectors.delete(oldest);
    }
    try {
      await mkdir(dirname(this.cachePath), { recursive: true });
      const temporary = `${this.cachePath}.tmp`;
      await writeFile(
        temporary,
        JSON.stringify(Object.fromEntries(this.vectors)),
        { mode: 0o600 },
      );
      await rename(temporary, this.cachePath);
    } catch (error) {
      this.logger.warn("Could not persist tool embeddings", {
        error: String(error),
      });
    }
  }
}

function isVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === EMBEDDING_VECTOR_SIZE &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}
