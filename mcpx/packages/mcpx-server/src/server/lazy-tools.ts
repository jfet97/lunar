import {
  CallToolRequest,
  CallToolResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import z from "zod/v4";

const MAX_RESULTS = 20;
const MAX_DESCRIPTION_LENGTH = 300;
const searchSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(MAX_RESULTS).default(5),
    offset: z.number().int().min(0).default(0),
  })
  .strict();
const nameSchema = z.object({ name: z.string().min(1).max(500) }).strict();
const callSchema = nameSchema
  .extend({
    arguments: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const LAZY_TOOLS: Tool[] = [
  {
    name: "mcpx_search_tools",
    description:
      "Find tools by keywords or exact name. Returns a small shortlist without schemas. Search for a service and task, then use mcpx_get_tool_schema for the selected name. Use offset to browse more matches.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500 },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_RESULTS,
          default: 5,
        },
        offset: { type: "integer", minimum: 0, default: 0 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "mcpx_get_tool_schema",
    description:
      "Get the complete definition and argument schema of one tool returned by mcpx_search_tools. Inspect it before calling the tool.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", minLength: 1, maxLength: 500 } },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "mcpx_call_tool",
    description:
      "Execute a discovered tool by its exact name with arguments matching mcpx_get_tool_schema. The target may read, write, or delete data; check its description and annotations first. Gateway permissions apply to the target tool.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 500 },
        arguments: { type: "object", additionalProperties: true },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
  },
];

export const LAZY_INSTRUCTIONS =
  "Tools are loaded on demand. Use mcpx_search_tools with service/task keywords, mcpx_get_tool_schema for one chosen tool, then mcpx_call_tool with its exact name and arguments. Search results omit schemas and are bounded; use offset for additional matches. Do not list the entire catalog before starting a task.";

type LazyRequestResolution =
  | { kind: "result"; result: CallToolResult }
  | { kind: "call"; request: CallToolRequest };

/** Resolve discovery locally and unwrap execution into the ordinary gateway path. */
export async function resolveLazyToolRequest(
  request: CallToolRequest,
  visibleTools: Tool[],
  search: (tools: Tool[], query: string) => Promise<Tool[]> = async (
    tools,
    query,
  ) => rankToolsLexically(tools, query),
): Promise<LazyRequestResolution> {
  const args = request.params.arguments ?? {};
  if (request.params.name === "mcpx_search_tools") {
    const parsed = searchSchema.safeParse(args);
    if (!parsed.success) return invalidArguments(parsed.error.message);
    const { query, limit, offset } = parsed.data;
    const matches = await search(visibleTools, query);
    const tools = matches.slice(offset, offset + limit).map((tool) => {
      const annotations = projectAnnotations(tool.annotations);
      return {
        name: tool.name,
        ...(tool.title
          ? { title: tool.title.slice(0, MAX_DESCRIPTION_LENGTH) }
          : {}),
        description: (tool.description ?? "").slice(0, MAX_DESCRIPTION_LENGTH),
        ...(annotations ? { annotations } : {}),
      };
    });
    return jsonResult({
      tools,
      totalMatches: matches.length,
      ...(offset + limit < matches.length
        ? { nextOffset: offset + limit }
        : {}),
    });
  }

  if (request.params.name === "mcpx_get_tool_schema") {
    const parsed = nameSchema.safeParse(args);
    if (!parsed.success) return invalidArguments(parsed.error.message);
    const tool = visibleTools.find((tool) => tool.name === parsed.data.name);
    return tool ? jsonResult(tool) : unavailableTool();
  }

  if (request.params.name === "mcpx_call_tool") {
    const parsed = callSchema.safeParse(args);
    if (!parsed.success) return invalidArguments(parsed.error.message);
    if (!visibleTools.some((tool) => tool.name === parsed.data.name)) {
      return unavailableTool();
    }
    return {
      kind: "call",
      request: {
        ...request,
        params: {
          ...request.params,
          name: parsed.data.name,
          arguments: parsed.data.arguments,
        },
      },
    };
  }

  return errorResult(
    "Use mcpx_search_tools, mcpx_get_tool_schema, or mcpx_call_tool on this endpoint.",
  );
}

function projectAnnotations(
  annotations: Tool["annotations"],
): Tool["annotations"] | undefined {
  if (!annotations) return undefined;
  const projected = {
    ...(typeof annotations.title === "string"
      ? { title: annotations.title.slice(0, MAX_DESCRIPTION_LENGTH) }
      : {}),
    ...(typeof annotations.readOnlyHint === "boolean"
      ? { readOnlyHint: annotations.readOnlyHint }
      : {}),
    ...(typeof annotations.destructiveHint === "boolean"
      ? { destructiveHint: annotations.destructiveHint }
      : {}),
    ...(typeof annotations.idempotentHint === "boolean"
      ? { idempotentHint: annotations.idempotentHint }
      : {}),
    ...(typeof annotations.openWorldHint === "boolean"
      ? { openWorldHint: annotations.openWorldHint }
      : {}),
  };
  return Object.keys(projected).length === 0 ? undefined : projected;
}

export function rankToolsLexically(tools: Tool[], query: string): Tool[] {
  const terms = tokenize(query);
  return tools
    .map((tool) => ({ tool, score: scoreTool(tool, query, terms) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .map(({ tool }) => tool);
}

function tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .match(/[a-z0-9]+/g) ?? [],
    ),
  ];
}

function scoreTool(tool: Tool, query: string, terms: string[]): number {
  const name = tool.name.toLowerCase();
  if (name === query.toLowerCase()) return 10000;
  if (terms.length === 0) return 0;
  const nameTerms = tokenize(`${tool.name} ${tool.title ?? ""}`);
  const descriptionTerms = tokenize(tool.description ?? "");
  let matched = 0;
  let score = 0;
  for (const term of terms) {
    const nameMatch = nameTerms.some((word) => matchesTerm(word, term));
    const descriptionMatch = descriptionTerms.some((word) =>
      matchesTerm(word, term),
    );
    if (nameMatch || descriptionMatch) {
      matched += 1;
      score += nameMatch ? 10 : 1;
    }
  }
  return matched === 0 ? 0 : score + (matched / terms.length) * 100;
}

function matchesTerm(word: string, term: string): boolean {
  return (
    word === term ||
    (Math.min(word.length, term.length) >= 3 &&
      (word.startsWith(term) || term.startsWith(word)))
  );
}

function jsonResult(value: unknown): LazyRequestResolution {
  return {
    kind: "result",
    result: {
      content: [{ type: "text", text: JSON.stringify(value) }],
    },
  };
}

function invalidArguments(detail: string): LazyRequestResolution {
  return errorResult(`Invalid discovery arguments: ${detail}`);
}

function unavailableTool(): LazyRequestResolution {
  return errorResult("Tool unavailable. Search for an available tool first.");
}

function errorResult(message: string): LazyRequestResolution {
  return {
    kind: "result",
    result: {
      content: [{ type: "text", text: message }],
      isError: true,
    },
  };
}
