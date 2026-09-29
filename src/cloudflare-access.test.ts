// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, get } from "node:http";
import test, { type TestContext } from "node:test";
import { ListTasksRequest } from "@a2a-js/sdk";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { cloudflareAccessAuthentication, cloudflareAccessSchema } from "./service/cloudflare-access.js";
import { createServiceApp } from "./service/http.js";
import { serviceCard } from "./service/card.js";
import { DurableTaskStore } from "./service/task-store.js";

const config = { issuer: "https://test.cloudflareaccess.com", audience: "a".repeat(64), tenant: "spkey", emailDomains: ["spkey.co"] };
const keys = await generateKeyPair("RS256", { extractable: true });
const key = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: "fixture" }] });
async function token(overrides: JWTPayload = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: config.issuer, aud: [config.audience], sub: "alice-id", email: "alice@spkey.co",
    exp: now + 3600, iat: now, nbf: now, type: "app", ...overrides })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" }).sign(keys.privateKey);
}
const headers = (jwt: string) => ({ "cf-access-jwt-assertion": jwt });

test("Access: signed identities are private owners, never operator or service identities", async () => {
  const auth = cloudflareAccessAuthentication(config, key), jwt = await token();
  const alice = await auth.authenticate(headers(jwt));
  assert(alice);
  assert.equal(alice.displayName, "alice@spkey.co");
  assert.equal(alice.principal.tenant, "spkey");
  assert.equal(alice.principal.canReconcile, false);
  assert.match(alice.principal.subject, /^cf:[a-f0-9]{64}$/);
  const renewed = await auth.authenticate(headers(await token({ email: "renamed@spkey.co" })));
  assert.equal(renewed?.principal.subject, alice.principal.subject);
  const recreated = await auth.authenticate(headers(await token({ sub: "new-user-id" })));
  assert.notEqual(recreated?.principal.subject, alice.principal.subject);
  auth.revoke(alice);
  assert.equal(await auth.authenticate(headers(jwt)), undefined);
});

test("Access: wrong audience/issuer, forged identity, expiry, service tokens and domain lookalikes fail closed", async () => {
  const auth = cloudflareAccessAuthentication(config, key), now = Math.floor(Date.now() / 1000);
  for (const claims of [
    { aud: ["b".repeat(64)] }, { iss: "https://other.cloudflareaccess.com" },
    { exp: now - 1 }, { nbf: now + 60 }, { iat: now + 60 }, { type: "org" },
    { sub: "" }, { email: "alice@spkey.co.attacker.com" }, { email: "alice@evilspkey.co" },
    { email: "alice@@spkey.co" }, { email: " alice@spkey.co" }, { email: undefined },
    { exp: undefined }, { iat: undefined }, { sub: undefined }, { type: undefined },
  ]) assert.equal(await auth.authenticate(headers(await token(claims))), undefined, JSON.stringify(claims));
  for (const value of [undefined, [await token()], "garbage", `${await token()}, ${await token()}`, "a".repeat(17000)]) {
    assert.equal(await auth.authenticate({ "cf-access-jwt-assertion": value, "cf-access-authenticated-user-email": "alice@spkey.co" }), undefined);
  }
  const jwt = await token(), parts = jwt.split(".");
  parts[1] = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[1], "base64url").toString()), sub: "admin" })).toString("base64url");
  assert.equal(await auth.authenticate(headers(parts.join("."))), undefined);
  const outage = cloudflareAccessAuthentication(config, async () => { throw new Error("private network detail"); });
  await assert.rejects(outage.authenticate(headers(jwt)), /^Error: Access verification unavailable$/);
  for (const issuer of ["http://test.cloudflareaccess.com", "https://test.cloudflareaccess.com.evil.test", "https://test.cloudflareaccess.com/", "https://test.cloudflareaccess.com:8443"])
    assert.equal(cloudflareAccessSchema.safeParse({ ...config, issuer }).success, false);
});

async function fixture(t: TestContext, maxStreamMs = 60_000) {
  const store = new DurableTaskStore(":memory:"), stopping = new AbortController();
  const authentication = { ...cloudflareAccessAuthentication(config, key), maxStreamMs };
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  server.on("request", createServiceApp({ store, signal: stopping.signal, card: serviceCard(base),
    profileId: "codex", pollMs: 5, authorize: async value => value === "Bearer operator" ?
      { tenant: "operator", subject: "operator", canReconcile: true } : undefined,
    browser: { origin: base, assetsPath: new URL("../web/dist", import.meta.url).pathname,
      profiles: [{ id: "codex" }], authentication } }));
  t.after(async () => {
    stopping.abort(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); store.close();
  });
  const request = (path: string, jwt?: string, init: RequestInit = {}) => fetch(`${base}${path}`, {
    ...init, redirect: "manual", signal: AbortSignal.timeout(5000),
    headers: { origin: base, "content-type": "application/json",
      "A2A-Version": "1.0", ...(jwt ? headers(jwt) : {}), ...init.headers },
  });
  return { request, base, store, authentication };
}

test("Access browser: no token fallback, exact origin, private task reads/writes/streams and no machine privileges", async t => {
  const f = await fixture(t), alice = await token(), bob = await token({ sub: "bob-id", email: "bob@spkey.co" });
  for (const path of ["/ui/", "/web-api/session", "/web-api/a2a/tasks"]) {
    assert.equal((await f.request(path)).status, 401);
    assert.equal((await f.request(path, undefined, { headers: { authorization: "Bearer operator", cookie: "aira_session=fake",
      "cf-access-authenticated-user-email": "alice@spkey.co" } })).status, 401);
  }
  assert.equal((await f.request("/web-api/session", alice, { headers: { origin: "https://evil.test" } })).status, 403);
  assert.equal((await f.request("/web-api/login", alice, { method: "POST", body: "{}" })).status, 404);
  const navigation = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
  // fetch synthesizes Sec-Fetch-Mode: cors; use HTTP for a document navigation.
  const navigationStatus = await new Promise<number | undefined>((resolve, reject) => {
    get(`${f.base}/`, { headers: { ...headers(alice), ...navigation } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(navigationStatus, 302);
  assert.equal((await f.request("/web-api/session", alice, { headers: navigation })).status, 403);
  const session = await f.request("/web-api/session", alice);
  assert.equal(session.status, 200);
  assert.equal(session.headers.get("set-cookie"), null);
  const identity = await session.json() as any;
  assert.equal(identity.authentication, "cloudflare-access");
  assert.equal(identity.displayName, "alice@spkey.co");
  assert.equal(identity.canReconcile, undefined);
  const card = await (await f.request("/web-api/a2a/.well-known/agent-card.json", alice)).json() as any;
  assert.equal(card.securitySchemes.session.apiKeySecurityScheme.name, "CF_Authorization");
  const input = { message: { messageId: "create", role: "ROLE_USER", parts: [{ text: "Private task" }] }, configuration: { returnImmediately: true } };
  const submitted = await f.request("/web-api/agents/codex/message:send", alice, { method: "POST", body: JSON.stringify(input) });
  assert.equal(submitted.status, 200);
  const task = (await submitted.json() as any).task;
  assert(task.id);
  for (const path of [`/web-api/a2a/tasks/${task.id}`, `/web-api/a2a/tasks/${task.id}:subscribe`])
    assert.equal((await f.request(path, bob)).status, 404);
  assert.equal((await f.request(`/web-api/a2a/tasks/${task.id}:cancel`, bob, { method: "POST", body: "{}" })).status, 404);
  const stolen = { ...input, message: { ...input.message, messageId: "steal", taskId: task.id } };
  assert.equal((await f.request("/web-api/a2a/message:send", bob, { method: "POST", body: JSON.stringify(stolen) })).status, 404);
  assert.equal(JSON.stringify(await (await f.request("/web-api/a2a/tasks", bob)).json()).includes(task.id), false);
  const followup = { ...stolen, message: { ...stolen.message, messageId: "followup" } };
  assert.equal((await f.request("/web-api/a2a/message:send", alice, { method: "POST", body: JSON.stringify(followup) })).status, 200);
  assert.equal((await fetch(`${f.base}/tasks`, { headers: headers(alice) })).status, 401);
  assert.equal((await f.request(`/web-api/a2a/tasks/${task.id}:cancel`, alice, { method: "POST", body: "{}", headers: { origin: "https://evil.test" } })).status, 403);
});

test("Access browser: stream windows end observation, not execution; logout revokes open and future reads", async t => {
  const f = await fixture(t, 120), jwt = await token();
  const identity = await f.authentication.authenticate(headers(jwt)); assert(identity);
  const body = { message: { messageId: "stream", role: "ROLE_USER", parts: [{ text: "Keep running" }] } };
  const response = await f.request("/web-api/a2a/message:stream", jwt, { method: "POST", body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /text\/event-stream/);
  const data = await response.text(); assert.match(data, /TASK_STATE_SUBMITTED/);
  const tasks = f.store.list(identity.principal, ListTasksRequest.fromJSON({ historyLength: 100 })).tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].metadata?.cancellationRequested, undefined);
  assert.equal(tasks[0].history.length, 1);
  const subscription = await f.request(`/web-api/a2a/tasks/${tasks[0].id}:subscribe`, jwt);
  assert.equal(subscription.status, 200);
  assert.equal((await f.request("/web-api/logout", jwt, { method: "POST", body: "{}" })).status, 204);
  assert.match(await subscription.text(), /Stream interrupted/);
  assert.equal((await f.request("/web-api/session", jwt)).status, 401);
  assert.equal(f.store.get(identity.principal, tasks[0].id).history.length, 1);
});

test("Access browser: token expiry closes an open stream without cancelling or retrying work", async t => {
  const f = await fixture(t), jwt = await token({ exp: Math.floor(Date.now() / 1000) + 2 });
  const identity = await f.authentication.authenticate(headers(jwt)); assert(identity);
  const body = { message: { messageId: "expiry", role: "ROLE_USER", parts: [{ text: "Do not retry" }] } };
  const response = await f.request("/web-api/a2a/message:stream", jwt, { method: "POST", body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  const content = await response.text();
  assert.match(content, /TASK_STATE_SUBMITTED/);
  assert.match(content, /Stream interrupted/);
  assert.equal((await f.request("/web-api/session", jwt)).status, 401);
  const tasks = f.store.list(identity.principal, ListTasksRequest.fromJSON({ historyLength: 100 })).tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].history.length, 1);
  assert.equal(tasks[0].metadata?.cancellationRequested, undefined);
});
