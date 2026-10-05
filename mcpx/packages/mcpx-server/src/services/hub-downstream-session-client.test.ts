import { noOpLogger } from "@mcpx/toolkit-core/logging";
import { WEBAPP_BOUND_EVENTS } from "@mcpx/webapp-protocol/messages";
import { HubDownstreamSessionClient } from "./hub-downstream-session-client.js";
import { HubSocketAdapter } from "./saved-setups-client.js";

function entry(sessionId: string, version: string) {
  return {
    sessionId,
    data: {
      metadata: {
        clientId: "client-1",
        clientInfo: {
          name: "test",
          adapter: { name: "mcp-remote", version },
        },
        isProbe: false,
      },
    },
  };
}

function clientWithAck(ack: unknown): HubDownstreamSessionClient {
  const socket: HubSocketAdapter = {
    emitWithAck: async () => ack,
  };
  return new HubDownstreamSessionClient(() => socket, noOpLogger);
}

describe("HubDownstreamSessionClient.list", () => {
  // A bad version must not throw out of the inbound transform (which would
  // escape safeParse and reject the whole list, breaking recovery forever).
  it("recovers records with an unparseable adapter version, dropping the version", async () => {
    const client = clientWithAck({
      success: true,
      sessions: [entry("good", "1.2.3"), entry("bad", "not-a-semver")],
    });

    const entries = await client.list();

    expect(entries).toHaveLength(2);
    const good = entries.find((e) => e.sessionId === "good");
    const bad = entries.find((e) => e.sessionId === "bad");
    expect(good?.data.metadata.clientInfo.adapter?.version?.version).toBe(
      "1.2.3",
    );
    expect(bad?.data.metadata.clientInfo.adapter?.version).toBeUndefined();
  });

  it("retains the transport tool mode across persisted session round trips", async () => {
    const socketCalls: Array<{ event: string; payload: unknown }> = [];
    const metadata = {
      clientId: "client-1",
      clientInfo: { name: "test" },
      isProbe: false,
      toolMode: "lazy" as const,
    };
    const socket: HubSocketAdapter = {
      emitWithAck: async (event, envelope) => {
        socketCalls.push({ event, payload: envelope });
        if (event === WEBAPP_BOUND_EVENTS.LOAD_DOWNSTREAM_SESSION) {
          return {
            success: true,
            data: { metadata },
          };
        }
        return { success: true };
      },
    };
    const client = new HubDownstreamSessionClient(() => socket, noOpLogger);

    await client.store("lazy-session", { metadata });
    const restored = await client.load("lazy-session");

    expect(
      socketCalls.find(
        (call) => call.event === WEBAPP_BOUND_EVENTS.STORE_DOWNSTREAM_SESSION,
      )?.payload,
    ).toMatchObject({
      payload: {
        data: { metadata: { toolMode: "lazy" } },
      },
    });
    expect(restored?.metadata.toolMode).toBe("lazy");
  });
});
