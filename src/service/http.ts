// SPDX-License-Identifier: AGPL-3.0-only
import { once } from "node:events";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { AgentCard, formatSSEEvent } from "@a2a-js/sdk";
import { JsonRpcTransportHandler, ServerCallContext, validateVersion } from "@a2a-js/sdk/server";
import { DurableA2AHandler, PRINCIPAL, SIGNAL, CHECK_AUTH } from "./a2a.js";
import { type Authorize, type Principal } from "./auth.js";
import { DurableTaskStore, TaskStoreError } from "./task-store.js";
import { reportingRouter } from "../reporting/http.js";

export type HttpOptions = {
  store: DurableTaskStore; card: AgentCard; profileId: string; authorize: Authorize;
  signal: AbortSignal; pollMs?: number; waitMs?: number; maxRequestsPerOwner?: number;
  ready?: () => boolean;
};
const reconciliation = z.object({ resolution: z.enum(["continue", "fail"]), reason: z.string().trim().min(1).max(4096) }).strict();

export function createServiceApp(options: HttpOptions) {
  const app = express();
  app.disable("x-powered-by");
  const active = new Map<string, number>();
  const handler = new DurableA2AHandler(options.store, options.card, options.profileId, options.pollMs, options.waitMs);
  const transport = new JsonRpcTransportHandler(handler);
  app.use((_request, response, next) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    next();
  });
  app.get("/healthz", (_request, response) => response.json({ ok: true }));
  app.get("/readyz", (_request, response) => {
    const ready = !options.signal.aborted && (options.ready?.() ?? true);
    response.status(ready ? 200 : 503).json({ ready });
  });
  app.get("/.well-known/agent-card.json", (_request, response) => response.json(AgentCard.toJSON(options.card)));
  app.use("/reporting", reportingRouter(options.store));
  app.use(async (request, response, next) => {
    if (options.signal.aborted) { response.sendStatus(503); return; }
    // This service is machine-to-machine; browser origins require a separately authenticated gateway.
    if (request.headers.origin) { response.sendStatus(403); return; }
    let principal: Principal | undefined;
    try { principal = await options.authorize(request.headers.authorization); }
    catch { response.status(503).json({ error: "authentication service unavailable" }); return; }
    if (!principal) { response.setHeader("www-authenticate", "Bearer"); response.sendStatus(401); return; }
    const key = JSON.stringify([principal.tenant, principal.subject]);
    const count = active.get(key) ?? 0;
    if (count >= (options.maxRequestsPerOwner ?? 16)) { response.setHeader("retry-after", "1"); response.sendStatus(429); return; }
    active.set(key, count + 1);
    response.once("close", () => {
      const remaining = (active.get(key) ?? 1) - 1;
      if (remaining) active.set(key, remaining); else active.delete(key);
    });
    response.locals.principal = principal;
    next();
  });
  app.use(express.json({ limit: "160kb", strict: true }));
  app.post("/a2a", async (request, response) => {
    const principal = response.locals.principal as Principal;
    const disconnected = new AbortController();
    const abort = () => disconnected.abort();
    response.once("close", abort);
    request.once("aborted", abort);
    const signal = AbortSignal.any([disconnected.signal, options.signal]);
    const context = new ServerCallContext({
      user: { isAuthenticated: true, userName: principal.subject }, tenant: principal.tenant,
      requestedVersion: request.header("A2A-Version") ?? "0.3",
      state: new Map<string, unknown>([[PRINCIPAL, principal], [SIGNAL, signal], [CHECK_AUTH, async () => {
        const current = await options.authorize(request.headers.authorization);
        if (!current || current.tenant !== principal.tenant || current.subject !== principal.subject) {
          disconnected.abort();
          throw new Error("authorization expired");
        }
      }]])
    });
    try {
      validateVersion(context.requestedVersion, options.card, "JSONRPC");
      const result = await transport.handle(request.body, context);
      if (!(Symbol.asyncIterator in result)) { response.json(result); return; }
      // Keep the SDK's parser/serializer; own only HTTP streaming lifetime and backpressure.
      for await (const event of result) {
        if (signal.aborted) break;
        if (!response.headersSent) {
          response.setHeader("content-type", "text/event-stream");
          response.setHeader("x-accel-buffering", "no");
          response.flushHeaders();
        }
        if (!response.write(formatSSEEvent(event))) {
          await once(response, "drain", { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
        }
      }
      response.end();
    } catch (error) {
      if (signal.aborted || response.headersSent) { response.end(); return; }
      const mapped = JsonRpcTransportHandler.mapToJSONRPCError(error);
      if (mapped.code === -32603) mapped.message = "Internal service error";
      response.json({ jsonrpc: "2.0", id: rpcId(request), error: mapped });
    } finally {
      response.off("close", abort);
      request.off("aborted", abort);
    }
  });
  app.get("/tasks/:taskId/events", (request, response) => {
    const cursor = z.coerce.number().int().safe().nonnegative().parse(request.query.after ?? 0);
    const limit = z.coerce.number().int().min(1).max(1000).parse(request.query.limit ?? 100);
    const events = options.store.events(response.locals.principal, request.params.taskId, cursor, limit);
    response.json({ events, nextCursor: events.at(-1)?.sequence ?? cursor });
  });
  app.post("/tasks/:taskId/executions/:executionId/reconcile", (request, response) => {
    const principal = response.locals.principal as Principal;
    options.store.get(principal, request.params.taskId);
    if (!principal.canReconcile) { response.sendStatus(403); return; }
    const execution = options.store.execution(request.params.executionId);
    if (execution?.taskId !== request.params.taskId) { response.sendStatus(404); return; }
    const { resolution, reason } = reconciliation.parse(request.body);
    response.json(options.store.resolveUncertain(principal, execution.id, resolution, reason));
  });
  app.post("/tasks/:taskId/executions/:executionId/reporting-credential", (request, response) => {
    const principal = response.locals.principal as Principal;
    options.store.get(principal, request.params.taskId);
    if (!principal.canReconcile) { response.sendStatus(403); return; }
    const execution = options.store.execution(request.params.executionId);
    if (execution?.taskId !== request.params.taskId) { response.sendStatus(404); return; }
    response.json({ token: options.store.issueReportingCredential(execution.id, 3_600_000) });
  });
  app.use((error: unknown, _request: Request, response: Response, _next: express.NextFunction) => {
    if (error instanceof TaskStoreError) {
      response.status(error.code === "not_found" ? 404 : error.code === "capacity" ? 429 : error.code === "invalid" ? 400 : 409)
        .json({ error: error.code, message: error.message });
    } else if (error instanceof z.ZodError || error instanceof SyntaxError) response.status(400).json({ error: "invalid request" });
    else if ((error as { type?: string })?.type === "entity.too.large") response.sendStatus(413);
    else response.status(500).json({ error: "internal service error" });
  });
  return app;
}

function rpcId(request: Request): string | number | null {
  const id = request.body?.id as unknown;
  return typeof id === "number" || typeof id === "string" ? id : null;
}
