// SPDX-License-Identifier: AGPL-3.0-only
// Model-free browser acceptance only. Never loads Agyn or provider credentials.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createServiceApp } from "../../dist/service/http.js";
import { DurableTaskStore } from "../../dist/service/task-store.js";
import { ExecutionWorker } from "../../dist/service/worker.js";
import { serviceCard } from "../../dist/service/card.js";
import { cloudflareAccessAuthentication } from "../../dist/service/cloudflare-access.js";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

const accessMode = process.env.A2A_FIXTURE_ACCESS === 'true';
const port = accessMode ? 8095 : 8094;
const origin = `http://127.0.0.1:${port}`;
const accessConfig = { issuer: 'https://fixture.cloudflareaccess.com', audience: 'a'.repeat(64),
  tenant: 'browser-test', emailDomains: ['smartphonekey.com'] };
const keys = accessMode ? await generateKeyPair('RS256', { extractable: true }) : undefined;
const authentication = keys ? { ...cloudflareAccessAuthentication(accessConfig,
  createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'fixture' }] })), maxStreamMs: 250 } : undefined;

const scope = {
  tenant: "browser-test",
  subject: "browser-test",
  canReconcile: false,
};
const token = "browser_fixture_access_token_not_for_real_use";
const store = new DurableTaskStore(":memory:"),
  stopping = new AbortController(),
  calls = [];
const driver = {
  provision: async (execution) => ({
    instanceId: `instance-${execution.taskId}`,
    threadId: `thread-${execution.taskId}`,
    profileId: execution.profileId,
  }),
  prepare: async () => {},
  dispatch: async (execution) => {
    calls.push({
      taskId: execution.taskId,
      profile: execution.profileId,
      executionId: execution.id,
      messageId: execution.message.messageId,
      instanceId: execution.runtime.instanceId,
      time: Date.now(),
    });
    store.report(execution.runtime.instanceId, execution.id, {
      eventId: "progress",
      kind: "progress",
      message: "Inspecting the workspace",
    });
    return randomUUID();
  },
  observe: async (execution) => {
    const text = execution.message.parts
      .map((p) => p.content?.value ?? "")
      .join(" ");
    if (text.includes("uncertain")) return "interrupted";
    const call = calls.find((c) => c.executionId === execution.id);
    if (text.includes("hold") || Date.now() - call.time < 700) return "running";
    store.report(execution.runtime.instanceId, execution.id, {
      eventId: "artifact",
      kind: "artifact",
      artifactId: "result",
      name: "result.txt",
      text: `Result: ${text}`,
    });
    store.report(execution.runtime.instanceId, execution.id, {
      eventId: "outcome",
      kind: "outcome",
      outcome: text.includes("finish") ? "task_completed" : "turn_done",
      message: `Reply from ${execution.profileId}: ${text}`,
    });
    return "running";
  },
  release: async () => ({ stopped: true }),
};
const worker = new ExecutionWorker(store, driver, {
  concurrency: 2,
  leaseMs: 5000,
  pollMs: 25,
  turnTimeoutMs: 120_000,
});
const app = createServiceApp({
  store,
  card: serviceCard(origin),
  profileId: "codex",
  pollMs: 25,
  authorize: async (authorization) =>
    authorization === `Bearer ${token}` ? scope : undefined,
  signal: stopping.signal,
  browser: {
    origin,
    authentication,
    assetsPath: new URL("../dist/", import.meta.url).pathname,
    profiles: [
      { id: "codex", name: "Codex fixture" },
      { id: "claude", name: "Claude fixture" },
    ],
  },
});
const server = createServer(async (request, response) => {
  if (accessMode) {
    const url = new URL(request.url, origin);
    if (url.pathname === '/__fixture/login') {
      const user = url.searchParams.get('user') === 'bob' ? 'bob' : 'alice';
      const now = Math.floor(Date.now() / 1000);
      const jwt = await new SignJWT({ iss: accessConfig.issuer, aud: [accessConfig.audience], sub: user,
        email: `${user}@smartphonekey.com`, type: 'app', exp: now + 3600, iat: now, nbf: now })
        .setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).sign(keys.privateKey);
      response.setHeader('set-cookie', `fixture_access=${jwt}; HttpOnly; SameSite=Lax; Path=/`);
      response.end('signed in'); return;
    }
    if (url.pathname === '/cdn-cgi/access/logout') {
      response.setHeader('set-cookie', 'fixture_access=; Max-Age=0; HttpOnly; Path=/');
      response.end('Signed out'); return;
    }
    const jwt = request.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('fixture_access='))?.slice(15);
    delete request.headers['cf-access-jwt-assertion'];
    if (jwt) request.headers['cf-access-jwt-assertion'] = jwt;
  }
  if (request.url === "/__fixture/calls" && request.method === "GET") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(calls));
  } else app(request, response);
});
server.listen(port, "127.0.0.1", () => worker.start());
async function stop() {
  if (stopping.signal.aborted) return;
  stopping.abort();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await worker.stop();
  store.close();
}
process.once("SIGTERM", () => {
  void stop();
});
process.once("SIGINT", () => {
  void stop();
});
