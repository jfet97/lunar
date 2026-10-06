import express from "express";
import { createServer, type Server } from "node:http";
import { noOpLogger } from "@aigw/core/logging";
import { resetEnv } from "../env.js";
import { NotAllowedError, NotFoundError } from "../errors.js";
import type { Services } from "../services/services.js";
import { buildControlPlaneRouter } from "./control-plane.js";
import { noOpAuthGuard } from "./auth.js";

describe("server OAuth logout route", () => {
  let server: Server;
  let baseUrl: string;
  let originalEnvironment: NodeJS.ProcessEnv;
  const logout = jest.fn<Promise<void>, [string]>();
  let authVersion = 0;
  const reuse = jest.fn<Promise<void>, [string]>();
  const initiate = jest.fn();

  beforeEach(() => {
    originalEnvironment = { ...process.env };
    process.env["VERSION"] = "test";
    process.env["INSTANCE_ID"] = "test-instance";
    process.env["ENABLE_CONTROL_PLANE_REST"] = "true";
    resetEnv();
    logout.mockReset().mockResolvedValue(undefined);
    authVersion = 0;
    reuse.mockReset();
    initiate.mockReset();
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    process.env = originalEnvironment;
    resetEnv({
      ...process.env,
      VERSION: process.env["VERSION"] ?? "test",
      INSTANCE_ID: process.env["INSTANCE_ID"] ?? "test-instance",
    });
  });

  async function start(guard: express.RequestHandler = noOpAuthGuard) {
    const app = express();
    app.use(express.json());
    app.use(
      buildControlPlaneRouter(
        guard,
        {
          upstreamHandler: {
            logoutOAuthForServer: logout,
            getAuthVersion: () => authVersion,
            reuseOAuthByName: reuse,
            initiateOAuthForServer: initiate,
          },
        } as unknown as Services,
        noOpLogger,
      ),
    );
    server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No test server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  it("clears authentication for the selected server", async () => {
    await start();
    const response = await fetch(`${baseUrl}/auth/logout/docs%2Fteam`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(logout).toHaveBeenCalledWith("docs/team");
    expect(await response.json()).toMatchObject({
      message: expect.stringContaining("authentication cleared"),
    });
  });

  it.each([
    [new NotFoundError("Server not found"), 404],
    [new NotAllowedError("No OAuth authentication"), 400],
    [new Error("Unable to delete credentials"), 500],
  ])(
    "reports logout failures with the appropriate status",
    async (error, status) => {
      logout.mockRejectedValue(error);
      await start();
      const response = await fetch(`${baseUrl}/auth/logout/docs`, {
        method: "POST",
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ message: error.message });
    },
  );

  it("requires authentication before clearing credentials", async () => {
    await start((_req, res) => {
      res.status(401).end();
    });
    const response = await fetch(`${baseUrl}/auth/logout/docs`, {
      method: "POST",
    });
    expect(response.status).toBe(401);
    expect(logout).not.toHaveBeenCalled();
  });

  it("does not restart an old authentication request after logout cancels token reuse", async () => {
    let release!: () => void;
    let startReuse!: () => void;
    const started = new Promise<void>((resolve) => {
      startReuse = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    reuse.mockImplementation(async () => {
      startReuse();
      await gate;
      throw new Error("No saved tokens");
    });
    await start();
    const response = fetch(`${baseUrl}/auth/initiate/docs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    await started;
    authVersion++;
    release();
    const result = await response;
    expect(result.status).toBe(500);
    expect(await result.json()).toMatchObject({
      message: "Authentication was cleared. Start a new login.",
    });
    expect(initiate).not.toHaveBeenCalled();
  });
});
