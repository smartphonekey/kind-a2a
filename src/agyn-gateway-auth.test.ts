// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { AgynClient } from "./agyn-client.js";
import { AgynGatewayTokenError, agynClientFromEnvironment, gatewayTokenFile, maxGatewayTokenBytes } from "./service/agyn-gateway-auth.js";

const jwt = (subject: string) => ["eyJhbGciOiJSUzI1NiJ9", Buffer.from(JSON.stringify({ sub: subject })).toString("base64url"), "c2lnbmF0dXJl"].join(".");

function directory(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), "agyn-gateway-token-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

/** Record every gateway call and its bearer; GetMe answers with the given identity. */
async function gateway(t: TestContext, identity = "derived-identity") {
  const calls: { method: string; authorization?: string; body: Record<string, unknown> }[] = [];
  let getMeFailures = 0;
  const server = createServer((request, response) => {
    let body = ""; request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const method = request.url!.split("/").at(-1)!;
      const input = JSON.parse(body || "{}");
      calls.push({ method, authorization: request.headers.authorization, body: input });
      response.setHeader("content-type", "application/json");
      if (method === "GetMe") {
        if (getMeFailures > 0) { getMeFailures--; response.writeHead(503).end(JSON.stringify({ code: "unavailable" })); return; }
        response.end(JSON.stringify({ user: { meta: { id: identity }, oidcSubject: "system:serviceaccount:aira-a2a:aira-a2a" } }));
      } else if (method === "GetInstance") response.end(JSON.stringify({ instance: { meta: { id: input.id }, state: "AGENT_INSTANCE_STATE_ACTIVE" } }));
      else if (method === "GetThreads") response.end(JSON.stringify({ threads: [] }));
      else if (method === "CreateThread") response.end(JSON.stringify({ thread: { id: "thread", participants: input.participants.map((p: { participantId: string }) => ({ id: p.participantId })) } }));
      else if (method === "SendMessage") response.end(JSON.stringify({ message: { id: "message", threadId: input.threadId, senderId: input.senderId, body: input.body } }));
      else response.writeHead(404).end("{}");
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, calls, failGetMe: (count: number) => { getMeFailures = count; } };
}

test("gateway token file is re-read per request, follows an atomic kubelet-style swap and is trimmed", async t => {
  const root = directory(t);
  // Projected volumes publish through a ..data symlink that the kubelet swaps atomically.
  const publish = (generation: string, content: string) => {
    mkdirSync(join(root, generation)); writeFileSync(join(root, generation, "token"), content);
    symlinkSync(generation, join(root, "..data_tmp")); renameSync(join(root, "..data_tmp"), join(root, "..data"));
  };
  publish("..one", `${jwt("first")}\n`);
  symlinkSync("..data/token", join(root, "token"));
  const bearer = gatewayTokenFile(join(root, "token"));
  assert.equal(await bearer(), jwt("first"));
  publish("..two", `  ${jwt("second")}\r\n`);
  assert.equal(await bearer(), jwt("second"));
  writeFileSync(join(root, "..two", "token"), "agyn_static-token_value");
  assert.equal(await bearer(), "agyn_static-token_value");
  writeFileSync(join(root, "..two", "token"), "a".repeat(maxGatewayTokenBytes));
  assert.equal((await bearer()).length, maxGatewayTokenBytes);
});

test("gateway token file rejects missing, empty, oversized and non-bearer content without echoing it", async t => {
  const root = directory(t), path = join(root, "token");
  const bearer = gatewayTokenFile(path);
  const rejects = async (reason: string, secret?: string) => assert.rejects(bearer(), error => {
    assert(error instanceof AgynGatewayTokenError);
    assert.equal(error.reason, reason);
    if (secret) assert(!error.message.includes(secret) && !String(error.stack).includes(secret));
    return true;
  });
  await rejects("unreadable");
  for (const content of ["", " \n\t\r\n"]) { writeFileSync(path, content); await rejects("empty"); }
  writeFileSync(path, "a".repeat(maxGatewayTokenBytes + 1)); await rejects("oversized");
  writeFileSync(path, `${"a".repeat(maxGatewayTokenBytes)}\n`); await rejects("oversized");
  for (const content of ["secret-one\r\nx-injected: secret-two", "secret value", "secret\u0000value", "Bearer secret", "sécret"]) {
    writeFileSync(path, content); await rejects("malformed", "secret");
  }
  rmSync(path); mkdirSync(path); await rejects("unreadable");
  assert.throws(() => gatewayTokenFile("relative/token"), /absolute path/);
  assert.throws(() => gatewayTokenFile(""), /absolute path/);
});

test("client presents the current file token on every call and never sends an unauthenticated request", async t => {
  const root = directory(t), path = join(root, "token");
  const fake = await gateway(t);
  writeFileSync(path, jwt("first"));
  const client = new AgynClient(fake.url, gatewayTokenFile(path), "org", "configured-identity");
  await client.getInstance("instance");
  writeFileSync(path, `${jwt("rotated")}\n`);
  await client.getInstance("instance");
  assert.deepEqual(fake.calls.map(call => call.authorization), [`Bearer ${jwt("first")}`, `Bearer ${jwt("rotated")}`]);
  for (const content of ["", "x".repeat(maxGatewayTokenBytes + 1), "a b"]) {
    writeFileSync(path, content);
    await assert.rejects(client.getInstance("instance"), AgynGatewayTokenError);
  }
  rmSync(path);
  await assert.rejects(client.getInstance("instance"), AgynGatewayTokenError);
  assert.equal(fake.calls.length, 2, "a rejected token must fail before any gateway request");
  assert(!fake.calls.some(call => call.method === "GetMe"), "a configured identity needs no lookup");
});

test("client derives its participant identity once from GetMe and retries a failed lookup", async t => {
  const fake = await gateway(t, "identity-from-getme");
  const client = new AgynClient(fake.url, "static", "org");
  fake.failGetMe(1);
  await assert.rejects(client.createInstanceThread("instance"), /UsersGateway\.GetMe failed \(503/);
  assert(!fake.calls.some(call => call.method === "CreateThread"), "no thread without a resolved identity");
  const [thread] = await Promise.all([client.createInstanceThread("instance"), client.instanceThreads("instance"),
    client.sendMessage("thread", "body"), client.identity()]);
  assert.deepEqual(thread.participants.map(p => p.id), ["identity-from-getme", "instance"]);
  assert.equal(fake.calls.find(call => call.method === "GetThreads")?.body.participantId, "identity-from-getme");
  assert.equal(fake.calls.find(call => call.method === "SendMessage")?.body.senderId, "identity-from-getme");
  assert.equal(await client.identity(), "identity-from-getme");
  assert.equal(fake.calls.filter(call => call.method === "GetMe").length, 2, "one failed and one shared successful lookup");
  const empty = await gateway(t, "");
  await assert.rejects(new AgynClient(empty.url, "static", "org").identity(), /no caller identity/);
});

test("environment selects exactly one gateway credential source", async t => {
  const root = directory(t), path = join(root, "token");
  writeFileSync(path, jwt("service-account"));
  const fake = await gateway(t);
  const base = { AGYN_GATEWAY_URL: fake.url, AGYN_ORGANIZATION_ID: "org" };
  await assert.rejects(agynClientFromEnvironment({ ...base, AGYN_TOKEN: "static", AGYN_GATEWAY_TOKEN_FILE: path, AGYN_IDENTITY_ID: "id" }),
    /mutually exclusive/);
  await assert.rejects(agynClientFromEnvironment({ ...base, AGYN_TOKEN: "", AGYN_GATEWAY_TOKEN_FILE: path }), /mutually exclusive/);
  await assert.rejects(agynClientFromEnvironment({ ...base, AGYN_GATEWAY_TOKEN_FILE: "token" }), /absolute path/);
  await assert.rejects(agynClientFromEnvironment({ ...base, AGYN_GATEWAY_TOKEN_FILE: "" }), /absolute path/);
  await assert.rejects(agynClientFromEnvironment({ ...base, AGYN_GATEWAY_TOKEN_FILE: join(root, "missing") }), AgynGatewayTokenError);
  await assert.rejects(agynClientFromEnvironment({ AGYN_GATEWAY_URL: fake.url, AGYN_GATEWAY_TOKEN_FILE: path }), /AGYN_ORGANIZATION_ID is required/);
  // Static mode is unchanged: both the token and the identity are required.
  await assert.rejects(agynClientFromEnvironment({ ...base, AGYN_IDENTITY_ID: "id" }), /AGYN_TOKEN is required/);
  await assert.rejects(agynClientFromEnvironment({ ...base, AGYN_TOKEN: "static" }), /AGYN_IDENTITY_ID is required/);
  const staticClient = await agynClientFromEnvironment({ ...base, AGYN_TOKEN: " static ", AGYN_IDENTITY_ID: "id" });
  assert.equal(await staticClient.identity(), "id");
  await staticClient.getInstance("instance");
  assert.equal(fake.calls.at(-1)?.authorization, "Bearer static");
  const derived = await agynClientFromEnvironment({ ...base, AGYN_GATEWAY_TOKEN_FILE: path });
  assert.equal(derived.identityId, undefined);
  assert.equal(await derived.identity(), "derived-identity");
  assert.equal(fake.calls.at(-1)?.authorization, `Bearer ${jwt("service-account")}`);
  const pinned = await agynClientFromEnvironment({ ...base, AGYN_GATEWAY_TOKEN_FILE: path, AGYN_IDENTITY_ID: "pinned" });
  assert.equal(await pinned.identity(), "pinned");
});

async function run(t: TestContext, script: string, env: Record<string, string>, input?: string) {
  const child = spawn(process.execPath, [new URL(script, import.meta.url).pathname], {
    env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "pipe"], timeout: 8000, killSignal: "SIGKILL" });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { errors += chunk; });
  const finished = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await finished; });
  child.stdin.end(input ?? "");
  return { finished, child, output: () => output, errors: () => errors };
}

test("reporting installer authenticates with the token file and rejects an ambiguous credential source", async t => {
  const root = directory(t), path = join(root, "token");
  writeFileSync(path, `${jwt("installer")}\n`);
  const fake = await gateway(t);
  const setup = { executionId: randomUUID(), instanceId: randomUUID(), threadId: randomUUID(), requestId: randomUUID(),
    retiredRequestIds: [], profileId: "test", reporting: { url: "https://reporting.invalid", token: "A".repeat(43) }, setupTimeoutMs: 20_000 };
  const base = { AGYN_GATEWAY_URL: fake.url, AGYN_ORGANIZATION_ID: randomUUID() };
  // GetInstance succeeds; the fixture's 404 workload listing then ends setup after authenticated calls.
  const used = await run(t, "./service/agyn-reporting-installer.js", { ...base, AGYN_GATEWAY_TOKEN_FILE: path }, JSON.stringify(setup));
  assert.deepEqual((await used.finished)[0], 1);
  assert.deepEqual(JSON.parse(used.output()), { reportingSetupFailed: true, stage: "runtime", httpStatus: 404, rpcCode: "unknown" });
  assert(fake.calls.length >= 2 && fake.calls.every(call => call.authorization === `Bearer ${jwt("installer")}`));
  assert(!fake.calls.some(call => call.method === "GetMe"), "installer RPCs do not need the caller identity");
  const calls = fake.calls.length;
  for (const env of [{ ...base, AGYN_GATEWAY_TOKEN_FILE: path, AGYN_TOKEN: "static", AGYN_IDENTITY_ID: randomUUID() },
    { ...base, AGYN_GATEWAY_TOKEN_FILE: join(root, "missing") }]) {
    const rejected = await run(t, "./service/agyn-reporting-installer.js", env, JSON.stringify(setup));
    assert.deepEqual((await rejected.finished)[0], 1);
    assert.deepEqual(JSON.parse(rejected.output()), { reportingSetupFailed: true, stage: "environment" });
  }
  assert.equal(fake.calls.length, calls);
});

test("service entry point accepts a token file, refuses ambiguous or unreadable sources and never prints the token", async t => {
  const root = directory(t), path = join(root, "token");
  writeFileSync(path, jwt("never-printed"));
  const portFinder = createNetServer(); portFinder.listen(0, "127.0.0.1"); await once(portFinder, "listening");
  const address = portFinder.address(); assert(address && typeof address !== "string");
  await new Promise<void>(resolve => portFinder.close(() => resolve()));
  const publicUrl = `http://127.0.0.1:${address.port}`;
  writeFileSync(join(root, "credentials.json"), "[]", { mode: 0o600 });
  writeFileSync(join(root, "service.json"), JSON.stringify({ environmentProfile: "trusted-local", dbPath: join(root, "tasks.sqlite"),
    credentialsFile: join(root, "credentials.json"), reportingSetupExecutable: "/bin/false", publicUrl, reportingUrl: `${publicUrl}/reporting`,
    host: "127.0.0.1", port: address.port, defaultProfile: "agent", profiles: [{ id: "agent", agentId: "00000000-0000-0000-0000-000000000001" }] }));
  const base = { A2A_SERVICE_CONFIG_FILE: join(root, "service.json"), AGYN_GATEWAY_URL: "http://127.0.0.1:1", AGYN_ORGANIZATION_ID: "org" };
  for (const [env, expected] of [[{ ...base, AGYN_GATEWAY_TOKEN_FILE: path, AGYN_TOKEN: "static", AGYN_IDENTITY_ID: "id" }, /mutually exclusive/],
    [{ ...base, AGYN_GATEWAY_TOKEN_FILE: join(root, "missing") }, /token file is unreadable/]] as const) {
    const refused = await run(t, "./service/main.js", env);
    assert.notEqual((await refused.finished)[0], 0);
    assert.match(refused.errors(), expected);
    assert(!refused.output().includes("listening"));
  }
  const service = await run(t, "./service/main.js", { ...base, AGYN_GATEWAY_TOKEN_FILE: path });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { clearInterval(check); reject(new Error(`service startup timed out: ${service.errors()}`)); }, 5000);
    const check = setInterval(() => {
      if (service.output().includes("listening")) { clearTimeout(timeout); clearInterval(check); resolve(); }
      else if (service.child.exitCode !== null) { clearTimeout(timeout); clearInterval(check); reject(new Error(service.errors())); }
    }, 10);
  });
  assert.equal((await fetch(`${publicUrl}/healthz`)).status, 200);
  service.child.kill("SIGTERM");
  assert.equal((await service.finished)[0], 0);
  assert(!`${service.output()}${service.errors()}`.includes(jwt("never-printed")));
});
