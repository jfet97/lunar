import express, { Router } from "express";

export const MCP_REQUEST_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

export function buildJsonBodyRouter(): Router {
  const router = express.Router();
  // base64 media needs room beyond the default 100 KiB JSON limit
  router.use("/mcp", express.json({ limit: MCP_REQUEST_BODY_LIMIT_BYTES }));
  router.use(express.json());
  return router;
}
