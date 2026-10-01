// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, get } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { closeHttpServer } from "./service/shutdown.js";

test("HTTP shutdown lets an accepted report finish before closing", async t => {
  let acknowledge!: () => void;
  const server = createServer((_request, response) => { acknowledge = () => response.end("durably accepted"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => server.closeAllConnections());
  const address = server.address(); assert(address && typeof address !== "string");
  const accepted = once(server, "request");
  const request = fetch(`http://127.0.0.1:${address.port}`);
  await accepted;
  let closed = false;
  const stopping = closeHttpServer(server, 1000).then(() => { closed = true; });
  await delay(20);
  assert.equal(closed, false);
  acknowledge();
  assert.equal(await (await request).text(), "durably accepted");
  await stopping;
  assert.equal(closed, true);
});

test("HTTP shutdown bounds stuck requests without pretending they completed", async t => {
  const server = createServer(() => {});
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => server.closeAllConnections());
  const address = server.address(); assert(address && typeof address !== "string");
  const accepted = once(server, "request");
  const failed = new Promise<Error>(resolve => {
    const request = get(`http://127.0.0.1:${address.port}`);
    request.once("error", resolve);
  });
  await accepted;
  await closeHttpServer(server, 20);
  assert.equal((await failed as NodeJS.ErrnoException).code, "ECONNRESET");
});

test("HTTP shutdown handles failed startup and rejects unbounded grace", async () => {
  await closeHttpServer(createServer(), 10);
  for (const value of [0, -1, Infinity, NaN, 0.5]) {
    await assert.rejects(closeHttpServer(createServer(), value), /positive integer/);
  }
});
