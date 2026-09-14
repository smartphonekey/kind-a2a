// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { AgynClient, AgynRpcError } from "./agyn-client.js";
import { ReportingDeliveryError } from "./service/agyn-terminal.js";
import { parseSetupFailure, setupFailure } from "./service/setup-diagnostics.js";

test("reporting setup diagnostics discard arbitrary provider errors", () => {
  assert.deepEqual(setupFailure("delivery", new Error("secret bearer credential")), { reportingSetupFailed: true, stage: "delivery" });
  const error = new AgynRpcError("private provider response", 403, "permission_denied");
  assert.deepEqual(setupFailure("ticket", error), { reportingSetupFailed: true, stage: "ticket", httpStatus: 403, rpcCode: "permission_denied" });
  assert.deepEqual(setupFailure("runtime", new AgynRpcError("secret", 500, "private-value")),
    { reportingSetupFailed: true, stage: "runtime", httpStatus: 500, rpcCode: "unknown" });
  assert.deepEqual(setupFailure("input", new AgynRpcError("secret", 999, "private-value")), { reportingSetupFailed: true, stage: "input" });
});

test("reporting setup output rejects raw text, oversized and unrecognized fields", () => {
  const valid = { reportingSetupFailed: true, stage: "delivery" };
  assert.deepEqual(parseSetupFailure(JSON.stringify(valid)), valid);
  for (const output of ["secret", "x".repeat(1025), "null", "[]", JSON.stringify({ ...valid, message: "secret" }),
    JSON.stringify({ ...valid, stage: "secret" }), JSON.stringify({ ...valid, rpcCode: "secret" }),
    JSON.stringify({ ...valid, httpStatus: 200 }), JSON.stringify({ ...valid, reportingSetupFailed: false })]) {
    assert.equal(parseSetupFailure(output), undefined);
  }
});

test("terminal delivery phase evidence is strict and credential-free", () => {
  const diagnostic = { deliveryReason: "protocol" as const, receiverReady: false, payloadAttempted: false, acknowledged: false };
  assert.deepEqual(setupFailure("delivery", new ReportingDeliveryError(diagnostic)), { reportingSetupFailed: true, stage: "delivery", ...diagnostic });
  for (const extra of [{ deliveryReason: "private" }, { receiverReady: "private" }, { payloadAttempted: "private" }, { exitCode: "private" }]) {
    assert.equal(parseSetupFailure(JSON.stringify({ reportingSetupFailed: true, stage: "delivery", ...extra })), undefined);
  }
});

test("Agyn HTTP failures provide typed diagnostics without parsing message text", async t => {
  const server = createServer((_req, res) => { res.writeHead(501, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "unimplemented", message: "private upstream detail" })); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert(address && typeof address !== "string");
  const client = new AgynClient(`http://127.0.0.1:${address.port}`, "fixture", "org", "owner");
  await assert.rejects(client.terminalSession("workload", ["fixture"]), error => {
    assert(error instanceof AgynRpcError);
    assert.deepEqual(setupFailure("ticket", error), { reportingSetupFailed: true, stage: "ticket", httpStatus: 501, rpcCode: "unimplemented" });
    return true;
  });
});
