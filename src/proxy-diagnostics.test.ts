// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { nativeProxyRefusals, nativeProxyStreamErrors, nativeProxyRequests } from "./live/proxy-diagnostics.js";

const valid = { status: 401, vendor: "anthropic", body_state: "complete", error_type: "authentication_error",
  auth_reason: "invalid_bearer_token", credential_present: true, anthropic_oauth_beta: true,
  call_id: "11111111-1111-4111-8111-111111111111", agent_id: "22222222-2222-4222-8222-222222222222" };
const line = (value: unknown) => `2026-09-14T00:00:00Z 2026/09/14 00:00:00 native: upstream refused ${JSON.stringify(value)}`;

test("proxy diagnostics retain only validated refusal metadata", () => {
  assert.deepEqual(nativeProxyRefusals(`private-token\n${line({ ...valid, message: "private-token", authorization: "private-token" })}\n`), [valid]);
});

test("proxy diagnostics discard malformed and untrusted fields", () => {
  for (const value of [null, [], "private-token", { ...valid, status: 200 }, { ...valid, status: "401" },
    { ...valid, status: 600 }, { ...valid, vendor: "private-token" }, { ...valid, vendor: ["anthropic"] },
    { ...valid, error_type: "private-token" }, { ...valid, body_state: "private-token" }, { ...valid, auth_reason: "private-token" },
    { ...valid, auth_reason: "invalid_api_key", status: 500 }, { ...valid, call_id: "private-token" },
    { ...valid, call_id: "00000000-0000-0000-0000-000000000000" }, { ...valid, credential_present: "private-token" }]) {
    assert.deepEqual(nativeProxyRefusals(line(value)), []);
  }
  assert.deepEqual(nativeProxyRefusals("native: upstream refused {private-token"), []);
});

test("proxy diagnostics are bounded", () => {
  assert.throws(() => nativeProxyRefusals("x".repeat(65537)), /bound/);
  assert.deepEqual(nativeProxyRefusals(line({ ...valid, message: "x".repeat(4096) })), []);
  const short = { ...valid, call_id: undefined, agent_id: undefined };
  assert.equal(nativeProxyRefusals(Array.from({ length: 160 }, () => line(short)).join("\n")).length, 128);
});

const streamValid = { ...valid, status: 200, event_type: "error" };
const streamLine = (value: unknown) => `native: upstream stream error ${JSON.stringify(value)}`;

test("native stream diagnostics keep transport status separate from the error category", () => {
  const logs = `${line(valid)}\n${streamLine({ ...streamValid, message: "private-token", authorization: "private-token" })}`;
  assert.deepEqual(nativeProxyRefusals(logs), [valid]);
  assert.deepEqual(nativeProxyStreamErrors(logs), [streamValid]);
});

test("native stream diagnostics reject untrusted and contradictory metadata", () => {
  for (const value of [null, [], "private-token", { ...streamValid, status: 401 }, { ...streamValid, status: "200" },
    { ...streamValid, status: 199 }, { ...streamValid, status: 300 }, { ...streamValid, event_type: "private-token" },
    { ...streamValid, vendor: "openai" }, { ...streamValid, auth_reason: "private-token" },
    { ...streamValid, auth_reason: "invalid_api_key", error_type: "overloaded_error" }, { ...streamValid, body_state: "incomplete" },
    { ...streamValid, body_state: "oversized" }, { ...streamValid, call_id: "private-token" },
    { ...streamValid, call_id: "00000000-0000-0000-0000-000000000000" }, { ...streamValid, credential_present: "true" }]) {
    assert.deepEqual(nativeProxyStreamErrors(streamLine(value)), []);
  }
  assert.deepEqual(nativeProxyStreamErrors("native: upstream stream error {private-token"), []);
});

test("native stream diagnostics retain unclassified incomplete frames without an authentication claim", () => {
  const incomplete = { ...streamValid, body_state: "incomplete", error_type: "unknown", auth_reason: undefined };
  const expected = { ...incomplete }; delete expected.auth_reason;
  assert.deepEqual(nativeProxyStreamErrors(streamLine(incomplete)), [expected]);
});

test("native stream diagnostics bound input, records and output fields", () => {
  assert.throws(() => nativeProxyStreamErrors("x".repeat(65537)), /bound/);
  assert.deepEqual(nativeProxyStreamErrors(streamLine({ ...streamValid, message: "x".repeat(4096) })), []);
  const short = { ...streamValid, call_id: undefined, agent_id: undefined };
  assert.equal(nativeProxyStreamErrors(Array.from({ length: 160 }, () => streamLine(short)).join("\n")).length, 128);
});

const requestValid = { phase: "response", call_id: valid.call_id, vendor: "anthropic", method: "POST", endpoint: "anthropic_messages",
  request_stream: true, credential_present: true, status: 200, response_kind: "sse", response_encoding: "identity" };
const requestLine = (value: unknown) => `native: request metadata ${JSON.stringify(value)}`;

test("native request diagnostics retain only fixed metadata and validated identities", () => {
  const expected = { ...requestValid, agent_instance_id: valid.agent_id };
  const logs = `${streamLine(streamValid)}\n${line(valid)}\n${requestLine({ ...expected, url: "private-token", authorization: "private-token", model: "private-token", body: "private-token" })}`;
  assert.deepEqual(nativeProxyRequests(logs), [expected]);
  const start = { ...requestValid, phase: "start", status: 0, response_kind: "absent", response_encoding: "absent" };
  assert.deepEqual(nativeProxyRequests(requestLine(start)), [start]);
  const failure = { ...start, phase: "transport_error" };
  assert.deepEqual(nativeProxyRequests(requestLine(failure)), [failure]);
});

test("native request diagnostics reject contradictory and untrusted metadata", () => {
  for (const value of [null, [], "private-token", { ...requestValid, status: "200" }, { ...requestValid, status: 0 },
    { ...requestValid, status: 600 }, { ...requestValid, phase: "start" }, { ...requestValid, phase: "transport_error" },
    { ...requestValid, call_id: undefined }, { ...requestValid, call_id: "private-token" }, { ...requestValid, agent_instance_id: "private-token" },
    { ...requestValid, call_id: "00000000-0000-0000-0000-000000000000" }, { ...requestValid, vendor: "openai" },
    { ...requestValid, endpoint: "openai_responses" }, { ...requestValid, response_encoding: "absent" }, { ...requestValid, response_kind: "absent" },
    { ...requestValid, request_stream: "true" }, { ...requestValid, credential_present: "true" }]) {
    assert.deepEqual(nativeProxyRequests(requestLine(value)), []);
  }
  for (const key of ["phase", "vendor", "method", "endpoint", "response_kind", "response_encoding"]) {
    assert.deepEqual(nativeProxyRequests(requestLine({ ...requestValid, [key]: "private-token" })), []);
  }
  assert.deepEqual(nativeProxyRequests("native: request metadata {private-token"), []);
});

test("native request diagnostics bound input, lines and record count", () => {
  assert.throws(() => nativeProxyRequests("x".repeat(65537)), /bound/);
  assert.deepEqual(nativeProxyRequests(requestLine({ ...requestValid, body: "x".repeat(4096) })), []);
  assert.equal(nativeProxyRequests(Array.from({ length: 160 }, () => requestLine(requestValid)).join("\n")).length, 128);
});
