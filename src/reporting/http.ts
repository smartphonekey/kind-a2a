// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Expose durable execution reports, status and stop checks to scoped reporters.
 *
 * @module
 * @remarks Bearer authentication fixes the execution and instance on every
 * request. Browser origins are rejected; browser cookies and A2A owner tokens
 * do not substitute for a reporting credential.
 * @see SERVICE.md#reporting-setup-contract
 * @see src/service/task-store.ts
 */
import { Router } from "express";
import express from "express";
import { z } from "zod";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createReportingMcp } from "./mcp.js";
import { codexStopOutput } from "./stop-check.js";
import { DurableTaskStore } from "../service/task-store.js";

/**
 * Mount beneath /reporting. MCP is stateless, POST-only and closed per request;
 * a receipt is returned only after the store's report transaction completes.
 * Stop checks persist execution-local checkId decisions and a bounded budget;
 * current outcome/cancellation supersedes an old reminder. Exhaustion requests
 * release and reconciliation, not success or proof of runtime removal.
 */
export function reportingRouter(store: DurableTaskStore): Router {
  const router = Router();
  router.use((request, response, next) => {
    if (request.headers.origin) { response.sendStatus(403); return; }
    const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const identity = token ? store.authenticateReporter(token) : undefined;
    if (!identity) { response.setHeader("www-authenticate", "Bearer"); response.sendStatus(401); return; }
    response.locals.reporter = identity;
    next();
  });
  router.use(express.json({ limit: "160kb" }));
  router.get("/status", (_request, response) => {
    const { instanceId, executionId } = response.locals.reporter;
    response.json(store.reportingStatus(instanceId, executionId));
  });
  router.post("/stop-check", (request, response) => {
    const { instanceId, executionId } = response.locals.reporter;
    const { checkId } = z.object({ checkId: z.string().min(1).max(128) }).strict().parse(request.body);
    const decision = store.stopCheck(instanceId, executionId, checkId);
    response.json({ decision, codex: codexStopOutput(decision) });
  });
  router.post("/mcp", async (request, response) => {
    const { instanceId, executionId } = response.locals.reporter;
    const server = createReportingMcp({
      report: async event => ({ ...store.report(instanceId, executionId, event), executionId }),
      status: async () => store.reportingStatus(instanceId, executionId)
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try { await transport.handleRequest(request, response, request.body); }
    finally { await server.close(); }
  });
  router.all("/mcp", (_request, response) => { response.setHeader("allow", "POST"); response.sendStatus(405); });
  return router;
}
