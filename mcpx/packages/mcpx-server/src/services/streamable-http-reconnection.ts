import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
  type StreamableHTTPReconnectionOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// allow supported notification streams to survive a short outage without an unbounded retry loop
export const upstreamStreamReconnectionOptions: StreamableHTTPReconnectionOptions =
  {
    initialReconnectionDelay: 1_000,
    maxReconnectionDelay: 30_000,
    reconnectionDelayGrowFactor: 1.5,
    maxRetries: 15,
  };

export function createUpstreamHttpTransport(
  url: URL,
  options: StreamableHTTPClientTransportOptions,
): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(url, {
    ...options,
    reconnectionOptions: upstreamStreamReconnectionOptions,
  });
}
