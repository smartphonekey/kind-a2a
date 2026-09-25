// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import express, { type Request, type Response } from "express";
import {
  AgentCard,
  SendMessageRequest,
  StreamResponse,
  SubscribeToTaskRequest,
  formatSSEEvent,
} from "@a2a-js/sdk";
import { ServerCallContext, validateVersion } from "@a2a-js/sdk/server";
import { restHandler } from "@a2a-js/sdk/server/express";
import { restStatusFor, toRestErrorBody } from "@a2a-js/sdk/errors";
import { z } from "zod";
import { CHECK_AUTH, DurableA2AHandler, PRINCIPAL, SIGNAL } from "./a2a.js";
import type { HttpOptions } from "./http.js";
import type { Principal } from "./auth.js";
import { SseWriter } from "./sse-writer.js";

export type BrowserOptions = {
  origin: string;
  assetsPath: string;
  profiles: readonly { id: string; name?: string }[];
  sessionTtlMs?: number;
};
type Session = { authorization: string; principal: Principal; expires: number };
const cookieName = "aira_session";
const loginSchema = z
  .object({ token: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/) })
  .strict();

/** An opt-in, same-origin boundary. The bearer never goes into a cookie or browser storage. */
export function browserRouter(options: HttpOptions, browser: BrowserOptions) {
  const origin = new URL(browser.origin);
  if (
    origin.origin !== browser.origin ||
    origin.username ||
    origin.password ||
    !["http:", "https:"].includes(origin.protocol)
  )
    throw new Error("browser.origin must be an HTTP(S) origin");
  if (
    origin.protocol === "http:" &&
    !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
  ) {
    throw new Error("non-loopback browser access requires HTTPS");
  }
  if (
    new Set(browser.profiles.map((p) => p.id)).size !==
      browser.profiles.length ||
    !browser.profiles.some((p) => p.id === options.profileId)
  )
    throw new Error("invalid browser profiles");
  const router = express.Router();
  const sessions = new Map<string, Session>();
  const active = new Map<string, number>();
  let loginWindow = 0,
    loginAttempts = 0;
  const ttl = browser.sessionTtlMs ?? 8 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 8 * 60 * 60 * 1000)
    throw new Error("invalid browser session TTL");
  options.signal.addEventListener("abort", () => sessions.clear(), {
    once: true,
  });
  const cookie = (response: Response, value: string, maxAge: number) =>
    response.cookie(cookieName, value, {
      httpOnly: true,
      sameSite: "strict",
      secure: origin.protocol === "https:",
      path: "/web-api",
      maxAge,
    });
  const sessionId = (request: Request) => {
    const matches = (request.headers.cookie ?? "")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.startsWith(`${cookieName}=`));
    return matches.length === 1 ? matches[0].slice(cookieName.length + 1) : "";
  };
  router.use((request, response, next) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    // Never trust forwarded Host/Origin headers; a reverse proxy must preserve the configured Host.
    if (
      request.headers.host !== origin.host ||
      (request.headers.origin && request.headers.origin !== origin.origin) ||
      request.headers["sec-fetch-site"] === "cross-site"
    ) {
      response.sendStatus(403);
      return;
    }
    if (
      !["GET", "HEAD"].includes(request.method) &&
      request.headers.origin !== origin.origin
    ) {
      response.sendStatus(403);
      return;
    }
    if (options.signal.aborted) {
      response.sendStatus(503);
      return;
    }
    next();
  });
  router.use(
    "/ui",
    express.static(browser.assetsPath, {
      index: "index.html",
      dotfiles: "deny",
      redirect: true,
    }),
  );
  router.use(
    express.json({
      limit: "160kb",
      strict: true,
      type: ["application/json", "application/a2a+json"],
    }),
  );
  router.post("/web-api/login", async (request, response) => {
    if (Date.now() - loginWindow >= 60_000) {
      loginWindow = Date.now();
      loginAttempts = 0;
    }
    if (++loginAttempts > 20) {
      response.setHeader("retry-after", "60");
      response.sendStatus(429);
      return;
    }
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      response.sendStatus(400);
      return;
    }
    const authorization = `Bearer ${parsed.data.token}`;
    let principal: Principal | undefined;
    try {
      principal = await options.authorize(authorization);
    } catch {
      response.sendStatus(503);
      return;
    }
    if (!principal) {
      response.sendStatus(401);
      return;
    }
    for (const [id, session] of sessions)
      if (session.expires <= Date.now()) sessions.delete(id);
    if (sessions.size >= 100) {
      response.sendStatus(429);
      return;
    }
    if (request.aborted || response.destroyed || options.signal.aborted) return;
    sessions.delete(sessionId(request));
    const id = randomBytes(32).toString("base64url");
    sessions.set(id, { authorization, principal, expires: Date.now() + ttl });
    cookie(response, id, ttl);
    response.json({ subject: principal.subject });
  });
  router.post("/web-api/logout", (request, response) => {
    sessions.delete(sessionId(request));
    cookie(response, "", 0);
    response.sendStatus(204);
  });
  router.use("/web-api", async (request, response, next) => {
    const id = sessionId(request),
      session = sessions.get(id);
    const check = async () => {
      if (
        !session ||
        sessions.get(id) !== session ||
        session.expires <= Date.now()
      )
        return undefined;
      const current = await options.authorize(session.authorization);
      if (
        !current ||
        current.tenant !== session.principal.tenant ||
        current.subject !== session.principal.subject
      ) {
        sessions.delete(id);
        return undefined;
      }
      return current;
    };
    let principal: Principal | undefined;
    try {
      principal = await check();
    } catch {
      response.sendStatus(503);
      return;
    }
    if (request.aborted || response.destroyed) return;
    if (!principal) {
      response.sendStatus(401);
      return;
    }
    const key = JSON.stringify([principal.tenant, principal.subject]);
    const count = active.get(key) ?? 0;
    if (count >= (options.maxRequestsPerOwner ?? 16)) {
      response.setHeader("retry-after", "1");
      response.sendStatus(429);
      return;
    }
    active.set(key, count + 1);
    response.once("close", () => {
      const n = (active.get(key) ?? 1) - 1;
      if (n) active.set(key, n);
      else active.delete(key);
    });
    response.locals.browserPrincipal = principal;
    response.locals.browserCheck = check;
    next();
  });
  router.get("/web-api/session", (_request, response) =>
    response.json({
      subject: response.locals.browserPrincipal.subject,
      profiles: browser.profiles,
      defaultProfile: options.profileId,
    }),
  );
  const mount = (path: string, profileId: string) => {
    const card: AgentCard = {
      ...options.card,
      supportedInterfaces: [
        {
          url: `${origin.origin}${path}`,
          protocolBinding: "HTTP+JSON",
          protocolVersion: "1.0",
          tenant: "",
        },
      ],
      securitySchemes: {
        session: {
          scheme: {
            $case: "apiKeySecurityScheme",
            value: {
              name: cookieName,
              location: "cookie",
              description: "Same-origin browser session",
            },
          },
        },
      },
      securityRequirements: [{ schemes: { session: { list: [] } } }],
    };
    const handler = new DurableA2AHandler(
      options.store,
      card,
      profileId,
      options.pollMs,
      "HTTP+JSON",
    );
    router.get(`${path}/.well-known/agent-card.json`, (_request, response) =>
      response.json(AgentCard.toJSON(card)),
    );
    router.use(path, (request, response, next) => {
      // Keep the browser surface small, including preventing the SDK's alternate
      // tenant-prefixed streaming routes from bypassing our bounded SSE writer.
      const supported =
        (request.method === "POST" &&
          /^\/message:(send|stream)$/.test(request.path)) ||
        (request.method === "GET" &&
          /^\/tasks(?:\/[A-Za-z0-9_-]{1,128})?$/.test(request.path)) ||
        (request.method === "POST" &&
          /^\/tasks\/[A-Za-z0-9_-]{1,128}:cancel$/.test(request.path)) ||
        (["GET", "POST"].includes(request.method) &&
          /^\/tasks\/[A-Za-z0-9_-]{1,128}:subscribe$/.test(request.path));
      if (!supported) {
        response.sendStatus(404);
        return;
      }
      const principal = response.locals.browserPrincipal as Principal;
      const disconnected = new AbortController();
      const abort = () => disconnected.abort();
      response.once("close", abort);
      request.once("aborted", abort);
      if (request.aborted || response.destroyed) abort();
      const signal = AbortSignal.any([options.signal, disconnected.signal]);
      const context = new ServerCallContext({
        user: { isAuthenticated: true, userName: principal.subject },
        tenant: principal.tenant,
        requestedVersion: request.header("A2A-Version") ?? "0.3",
        state: new Map<string, unknown>([
          [PRINCIPAL, principal],
          [SIGNAL, signal],
          [
            CHECK_AUTH,
            async () => {
              if (!(await response.locals.browserCheck()))
                throw new Error("authorization expired");
            },
          ],
        ]),
      });
      response.once("close", () => request.off("aborted", abort));
      const json = response.json.bind(response);
      response.json = (body) => {
        // The SDK includes Error.message in REST errors; keep internal diagnostics server-side.
        if (response.statusCode >= 500) {
          return json({ error: { code: response.statusCode, status: "INTERNAL", message: "Internal service error" } });
        }
        // SDK 1.1's generic REST errors retain the HTTP code but serialize the status as UNKNOWN.
        const status = response.statusCode === 409 ? "ABORTED"
          : response.statusCode === 429 ? "RESOURCE_EXHAUSTED" : undefined;
        if (status && body?.error?.status === "UNKNOWN") {
          return json({ ...body, error: { ...body.error, status } });
        }
        return json(body);
      };
      // Use the SDK REST binding for parsing/serialization; retain our bounded SSE writer.
      const streamRoute =
        request.method === "POST" && request.path === "/message:stream";
      const subscription = ["GET", "POST"].includes(request.method)
        ? /^\/tasks\/([^/]+):subscribe$/.exec(request.path)
        : null;
      if (streamRoute || subscription) {
        void (async () => {
          let writer: SseWriter | undefined;
          try {
            validateVersion(context.requestedVersion, card, "HTTP+JSON");
            const stream = streamRoute
              ? handler.sendMessageStream(
                  SendMessageRequest.fromJSON(request.body),
                  context,
                )
              : handler.resubscribe(
                  SubscribeToTaskRequest.fromJSON({
                    id: decodeURIComponent(subscription![1]),
                    tenant: request.query.tenant ?? "",
                  }),
                  context,
                );
            for await (const event of stream) {
              signal.throwIfAborted();
              if (!writer) {
                response.setHeader("content-type", "text/event-stream");
                response.setHeader("x-accel-buffering", "no");
                writer = new SseWriter(response, signal, abort, options.sse);
                response.flushHeaders();
              }
              await writer.write(formatSSEEvent(StreamResponse.toJSON(event)));
            }
            response.end();
          } catch (error) {
            if (!response.destroyed) {
              if (response.headersSent) {
                if (!signal.aborted)
                  await writer
                    ?.write(
                      'event: error\ndata: {"code":409,"status":"ABORTED","message":"Stream interrupted; reload the task before sending again"}\n\n',
                    )
                    .catch(() => response.destroy());
                response.end();
              } else {
                const status = restStatusFor(error);
                response
                  .status(status)
                  .json(
                    toRestErrorBody(
                      status >= 500
                        ? new Error("Internal service error")
                        : error,
                      status,
                    ),
                  );
              }
            }
          } finally {
            await writer?.close();
          }
        })();
      } else {
        restHandler({
          requestHandler: handler,
          userBuilder: async () => context.user!,
          contextBuilder: () => context,
        })(request, response, next);
      }
    });
  };
  mount("/web-api/a2a", options.profileId);
  for (const profile of browser.profiles) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(profile.id))
      throw new Error("browser profile IDs must be URL-safe");
    mount(`/web-api/agents/${profile.id}`, profile.id);
  }
  router.use((_request, response) => response.sendStatus(404));
  return router;
}
