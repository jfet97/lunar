import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  AnySchema,
  SchemaOutput,
  safeParse,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  ClientRequest,
  ListToolsResultSchema,
  Request,
} from "@modelcontextprotocol/sdk/types.js";

const MAX_TOOL_LIST_PAGES = 1000;

/** Collects upstream tool pages before the SDK caches tool metadata. */
export class PaginatedClient extends Client {
  override async request<T extends AnySchema>(
    request: ClientRequest | Request,
    resultSchema: T,
    options?: RequestOptions,
  ): Promise<SchemaOutput<T>> {
    if (request.method !== "tools/list") {
      return super.request(request, resultSchema, options);
    }

    const firstPage = await super.request(
      request,
      ListToolsResultSchema,
      options,
    );
    const { nextCursor: initialCursor, ...result } = firstPage;
    result.tools = [...firstPage.tools];
    let cursor = initialCursor;
    let pageCount = 1;

    while (cursor !== undefined && cursor !== null) {
      if (pageCount >= MAX_TOOL_LIST_PAGES) {
        throw new Error("Upstream tools/list exceeded 1000 pages");
      }
      const page = await super.request(
        { ...request, params: { ...request.params, cursor } },
        ListToolsResultSchema,
        options,
      );
      result.tools.push(...page.tools);
      cursor = page.nextCursor;
      pageCount += 1;
    }

    const parsed = safeParse(resultSchema, result);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  }
}
