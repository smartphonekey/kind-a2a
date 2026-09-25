// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { createServiceApp } from "./service/http.js";
import { serviceCard } from "./service/card.js";
import { DurableTaskStore, type StoreOptions } from "./service/task-store.js";
import { Message, TaskState } from "@a2a-js/sdk";

async function fixture(t: TestContext, sessionTtlMs?: number, storeOptions?: StoreOptions) {
  const store = new DurableTaskStore(":memory:", storeOptions);
  const shutdown = new AbortController(),
    server = createServer();
  let available = true,
    valid = true;
  const tokens = {
    alice: randomBytes(32).toString("base64url"),
    bob: randomBytes(32).toString("base64url"),
  };
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  server.on(
    "request",
    createServiceApp({
      store,
      signal: shutdown.signal,
      card: serviceCard(base),
      profileId: "codex",
      pollMs: 5,
      browser: {
        origin: base,
        assetsPath: new URL("../web/dist/", import.meta.url).pathname,
        profiles: [{ id: "codex" }, { id: "claude" }],
        sessionTtlMs,
      },
      authorize: async (header) => {
        if (!available) throw new Error("secret auth backend detail");
        const who = Object.entries(tokens).find(
          ([, token]) => header === `Bearer ${token}`,
        )?.[0];
        return who && valid
          ? { tenant: "org", subject: who, canReconcile: false }
          : undefined;
      },
    }),
  );
  t.after(async () => {
    shutdown.abort();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        origin: base,
        "content-type": "application/json",
        "A2A-Version": "1.0",
        ...init.headers,
      },
      signal: AbortSignal.timeout(5000),
    });
  const login = async (who: "alice" | "bob" = "alice") => {
    const response = await request("/web-api/login", {
      method: "POST",
      body: JSON.stringify({ token: tokens[who] }),
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie")!;
  };
  return {
    base,
    tokens,
    request,
    login,
    store,
    setValid: (value: boolean) => {
      valid = value;
    },
    setAvailable: (value: boolean) => {
      available = value;
    },
  };
}
const input = (
  messageId: string,
  text = "Inspect the repository",
  taskId?: string,
) => ({
  message: {
    messageId,
    taskId,
    role: "ROLE_USER",
    parts: [{ text }],
  },
  configuration: { returnImmediately: true },
});

for (const scenario of ["recovery", "terminal", "identity", "task capacity", "owner capacity"] as const) {
  test(`A2A admission errors: ${scenario} preserves REST/JSON-RPC bindings without accepting work`, async (t) => {
    const capacity = scenario.endsWith("capacity");
    const f = await fixture(t, undefined, {
      maxQueuedPerTask: scenario === "task capacity" ? 1 : 32,
      maxPendingPerOwner: scenario === "owner capacity" ? 1 : 256,
    });
    const cookie = await f.login(), scope = { tenant: "org", subject: "alice" };
    const original = input("original");
    const submitted = f.store.submit(scope, Message.fromJSON(original.message), "claude");
    const taskId = submitted.task.id;
    if (scenario === "recovery") {
      const { lease } = f.store.claim("worker", 60_000, 1)!;
      f.store.bind(lease, { instanceId: "instance", threadId: "thread", profileId: "claude" });
      f.store.beginDispatch(lease);
      f.store.dispatched(lease, "original-provider-request");
      f.store.markUncertain(lease, "interrupted after a side effect");
      f.store.settle(lease, { stopped: true });
    } else if (scenario === "terminal") f.store.requestCancel(scope, taskId);
    const params = scenario === "identity" ? input("original", "Different content")
      : input("rejected", "Do not execute", scenario === "owner capacity" ? undefined : taskId);
    const before = f.store.snapshot(scope, taskId), execution = f.store.execution(submitted.execution.id);
    for (const method of ["SendMessage", "SendStreamingMessage"]) {
      const response = await fetch(`${f.base}/a2a`, {
        method: "POST",
        headers: { authorization: `Bearer ${f.tokens.alice}`, "content-type": "application/json", "A2A-Version": "1.0" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "rejected", method, params }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      const body = await response.json() as any;
      assert.equal(body.error.code, capacity ? -32029 : -32010);
      assert.equal(body.id, "rejected");
      assert.equal(body.result, undefined);
      assert.deepEqual(f.store.snapshot(scope, taskId), before);
    }
    for (const path of ["/web-api/a2a", "/web-api/agents/codex", "/web-api/agents/claude"]) {
      for (const operation of ["send", "stream"]) {
        const response = await f.request(`${path}/message:${operation}`, {
          method: "POST", headers: { cookie }, body: JSON.stringify(params),
        });
        assert.equal(response.status, capacity ? 429 : 409, `${path}/message:${operation}`);
        assert(!response.headers.get("content-type")?.includes("text/event-stream"));
        const body = await response.json() as any;
        assert.equal(body.error.code, response.status);
        assert.equal(body.error.status, capacity ? "RESOURCE_EXHAUSTED" : "ABORTED");
        assert.match(body.error.message, /recovery|terminal|identity|queue|admission/);
        assert.equal(body.task, undefined);
        assert.deepEqual(f.store.snapshot(scope, taskId), before);
        assert.deepEqual(f.store.execution(submitted.execution.id), execution);
      }
    }
    // Exact retries still resolve to the original execution, even after quarantine or cancellation.
    const retry = f.store.submit(scope, Message.fromJSON(original.message), "claude");
    assert.equal(retry.duplicate, true);
    assert.equal(retry.execution.id, submitted.execution.id);
  });
}

test("browser REST: semantic errors retain their SDK status names", async (t) => {
  const f = await fixture(t), cookie = await f.login(), scope = { tenant: "org", subject: "alice" };
  const { task } = f.store.submit(scope, Message.fromJSON(input("original").message), "codex");
  const { lease } = f.store.claim("worker", 60_000, 1)!;
  f.store.bind(lease, { instanceId: "instance", threadId: "thread", profileId: "codex" });
  f.store.beginDispatch(lease);
  f.store.dispatched(lease, "provider-request");
  f.store.report("instance", lease.executionId, { kind: "outcome", eventId: "done", outcome: "task_completed", message: "done" });
  f.store.releasing(lease);
  f.store.settle(lease, { stopped: true });
  const canceled = await f.request(`/web-api/a2a/tasks/${task.id}:cancel`, {
    method: "POST", headers: { cookie }, body: "{}",
  });
  assert.equal(canceled.status, 400);
  assert.equal(((await canceled.json()) as any).error.status, "FAILED_PRECONDITION");
  for (const operation of ["send", "stream"]) {
    const missing = await f.request(`/web-api/a2a/message:${operation}`, {
      method: "POST", headers: { cookie }, body: JSON.stringify(input("missing", "work", "missing")),
    });
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as any).error.status, "NOT_FOUND");
    const invalid = await f.request(`/web-api/a2a/message:${operation}`, {
      method: "POST", headers: { cookie }, body: JSON.stringify({ message: { role: "ROLE_USER", parts: [] } }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(((await invalid.json()) as any).error.status, "INVALID_ARGUMENT");
  }
});

test("A2A admission errors: unexpected failures stay redacted in REST and JSON-RPC", async (t) => {
  const f = await fixture(t), cookie = await f.login();
  f.store.submit = () => { throw new Error("private database path and authentication detail"); };
  for (const operation of ["send", "stream"]) {
    const response = await f.request(`/web-api/agents/claude/message:${operation}`, {
      method: "POST", headers: { cookie }, body: JSON.stringify(input("never-accepted")),
    });
    assert.equal(response.status, 500);
    const body = await response.json() as any;
    assert.equal(body.error.status, "INTERNAL");
    assert.equal(body.error.message, "Internal service error");
    assert(!JSON.stringify(body).includes("private"));
  }
  for (const method of ["SendMessage", "SendStreamingMessage"]) {
    const response = await fetch(`${f.base}/a2a`, {
      method: "POST",
      headers: { authorization: `Bearer ${f.tokens.alice}`, "content-type": "application/json", "A2A-Version": "1.0" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: input("never-accepted") }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as any).error, { code: -32603, message: "Internal service error" });
  }
});

test("browser: same-origin login, opaque HttpOnly session, no M2M credential bypass", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/web-api/session")).status, 401);
  for (const origin of ["https://evil.example", "null", ""]) {
    assert.equal(
      (
        await f.request("/web-api/login", {
          method: "POST",
          headers: { origin },
          body: JSON.stringify({ token: f.tokens.alice }),
        })
      ).status,
      403,
    );
  }
  const rebound = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(
      `${f.base}/web-api/session`,
      { headers: { host: "evil.example" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on("error", reject);
    request.end();
  });
  assert.equal(rebound, 403);
  assert.equal(
    (
      await f.request("/web-api/login", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ token: f.tokens.alice }),
      })
    ).status,
    400,
  );
  const cookie = await f.login();
  assert(
    cookie.includes("HttpOnly") &&
      cookie.includes("SameSite=Strict") &&
      cookie.includes("Path=/web-api"),
  );
  assert(!cookie.includes(f.tokens.alice));
  const me = await f.request("/web-api/session", { headers: { cookie } });
  assert.equal(me.headers.get("cache-control"), "no-store");
  assert(
    me.headers
      .get("content-security-policy")
      ?.includes("frame-ancestors 'none'"),
  );
  assert.deepEqual(((await me.json()) as any).profiles, [
    { id: "codex" },
    { id: "claude" },
  ]);
  assert.equal(
    (
      await f.request("/a2a", {
        method: "POST",
        headers: { cookie },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${f.base}/a2a`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.request("/web-api/agents/missing/message:send", {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify(input("missing")),
      })
    ).status,
    404,
  );
});

test("browser REST: profiles, owner isolation, durable history, same-task follow-up and cancellation", async (t) => {
  const f = await fixture(t),
    cookie = await f.login(),
    bob = await f.login("bob");
  const post = (path: string, body: unknown, auth = cookie) =>
    f.request(path, {
      method: "POST",
      headers: { cookie: auth },
      body: JSON.stringify(body),
    });
  const response = await post(
    "/web-api/agents/claude/message:send",
    input("first"),
  );
  assert.equal(response.status, 200);
  const task = ((await response.json()) as any).task;
  assert(task.id);
  assert.equal(task.metadata.profileId, "claude");
  assert.equal(task.metadata.title, "Inspect the repository");
  const card = (await f
    .request("/web-api/agents/claude/.well-known/agent-card.json", {
      headers: { cookie },
    })
    .then((r) => r.json())) as any;
  assert.equal(card.supportedInterfaces[0].protocolBinding, "HTTP+JSON");
  assert.equal(
    (
      await f.request(`/web-api/a2a/tasks/${task.id}`, {
        headers: { cookie: bob },
      })
    ).status,
    404,
  );
  assert.equal(
    (await post(`/web-api/a2a/tasks/${task.id}:cancel`, {}, bob)).status,
    404,
  );
  const listed = (await f
    .request("/web-api/a2a/tasks?pageSize=10&historyLength=1", {
      headers: { cookie },
    })
    .then((r) => r.json())) as any;
  assert.equal(listed.tasks[0].id, task.id);
  assert.equal(listed.tasks[0].history.length, 1);
  assert.equal(
    (
      (await f
        .request("/web-api/a2a/tasks", { headers: { cookie: bob } })
        .then((r) => r.json())) as any
    ).tasks?.length ?? 0,
    0,
  );
  const follow = (await post(
    "/web-api/agents/codex/message:send",
    input("second", "Follow up", task.id),
  ).then((r) => r.json())) as any;
  assert.equal(follow.task.id, task.id);
  assert.equal(follow.task.metadata.profileId, "claude");
  assert.equal(follow.task.metadata.title, "Inspect the repository");
  const history = (await f
    .request(`/web-api/a2a/tasks/${task.id}?historyLength=1000`, {
      headers: { cookie },
    })
    .then((r) => r.json())) as any;
  assert.deepEqual(
    history.history.map((m: any) => m.parts[0].text),
    ["Inspect the repository", "Follow up"],
  );
  const canceled = (await post(`/web-api/a2a/tasks/${task.id}:cancel`, {}).then(
    (r) => r.json(),
  )) as any;
  assert.equal(canceled.status.state, "TASK_STATE_CANCELED");
  assert.notEqual(
    (
      await post(
        "/web-api/agents/codex/message:send",
        input("third", "No replay", task.id),
      )
    ).status,
    200,
  );
});

test("browser: logout, expiry, credential revocation and auth failures fail closed", async (t) => {
  const f = await fixture(t),
    cookie = await f.login();
  f.setAvailable(false);
  assert.equal(
    (await f.request("/web-api/session", { headers: { cookie } })).status,
    503,
  );
  f.setAvailable(true);
  f.setValid(false);
  assert.equal(
    (await f.request("/web-api/session", { headers: { cookie } })).status,
    401,
  );
  f.setValid(true);
  assert.equal(
    (await f.request("/web-api/session", { headers: { cookie } })).status,
    401,
  );
  const second = await f.login();
  assert.equal(
    (
      await f.request("/web-api/logout", {
        method: "POST",
        headers: { cookie: second },
        body: "{}",
      })
    ).status,
    204,
  );
  assert.equal(
    (await f.request("/web-api/session", { headers: { cookie: second } }))
      .status,
    401,
  );
  const expiring = await fixture(t, 100),
    short = await expiring.login();
  await delay(150);
  assert.equal(
    (await expiring.request("/web-api/session", { headers: { cookie: short } }))
      .status,
    401,
  );
});

test("browser: stream disconnect does not cancel/replay execution; revoked stream ends without secret detail", async (t) => {
  const f = await fixture(t),
    cookie = await f.login();
  const response = await f.request("/web-api/agents/codex/message:stream", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify(input("stream")),
  });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body!.getReader();
  const chunk = new TextDecoder().decode((await reader.read()).value);
  const task = JSON.parse(chunk.split("data: ")[1]).task;
  assert(task.id);
  assert.equal(
    f.store.get({ tenant: "org", subject: "alice" }, task.id).status!.state,
    TaskState.TASK_STATE_SUBMITTED,
  );
  f.setAvailable(false);
  let rest = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    rest += new TextDecoder().decode(next.value);
  }
  assert(rest.includes("Stream interrupted"));
  assert(!rest.includes("secret auth backend detail"));
  assert.equal(
    f.store.get({ tenant: "org", subject: "alice" }, task.id).status!.state,
    TaskState.TASK_STATE_SUBMITTED,
  );
  f.setAvailable(true);
  const resubscribe = await f.request(
    `/web-api/a2a/tasks/${task.id}:subscribe`,
    { method: "POST", headers: { cookie }, body: "{}" },
  );
  const subscription = resubscribe.body!.getReader();
  assert(
    new TextDecoder()
      .decode((await subscription.read()).value)
      .includes(task.id),
  );
  await subscription.cancel();
  assert.equal(
    f.store.get({ tenant: "org", subject: "alice" }, task.id).history.length,
    1,
  );
});

test("browser: SDK REST errors never expose internal diagnostics", async (t) => {
  const f = await fixture(t),
    cookie = await f.login();
  f.store.get = () => {
    throw new Error("private database path and authentication detail");
  };
  const response = await f.request("/web-api/a2a/tasks/missing", {
    headers: { cookie },
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: { code: 500, status: "INTERNAL", message: "Internal service error" },
  });
});

test("browser: alternate SDK routes cannot bypass the bounded streaming boundary", async (t) => {
  const f = await fixture(t),
    cookie = await f.login();
  for (const path of [
    "/web-api/a2a/org/message:stream",
    "/web-api/a2a/org/tasks/missing:subscribe",
  ]) {
    const response = await f.request(path, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify(input("never-submitted")),
    });
    assert.equal(response.status, 404);
  }
  const missing = await f.request("/web-api/a2a/tasks/missing:subscribe", {
    method: "POST",
    headers: { cookie },
    body: "{}",
  });
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as any).error.status, "NOT_FOUND");
});
