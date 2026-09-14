// SPDX-License-Identifier: AGPL-3.0-only
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const identifiers = ["call_id", "organization_id", "subscription_id", "agent_id", "agent_instance_id", "environment_id", "workload_id"] as const;
const errorTypes = new Set(["unknown", "authentication_error", "permission_error", "rate_limit_error", "invalid_request_error",
  "not_found_error", "api_error", "overloaded_error", "request_too_large", "server_error", "insufficient_quota"]);
const bodyStates = new Set(["complete", "incomplete", "oversized", "encoded", "invalid_json"]);
const authReasons = new Set(["unknown", "invalid_bearer_token", "invalid_api_key"]);

// This is a projection, not a redactor: unknown fields and all raw log text are
// discarded. Proxy logs are diagnostics, not authoritative agent outcomes.
export function nativeProxyRefusals(logs: string): Record<string, string | number | boolean>[] {
  return projectNativeDiagnostics(logs, false);
}

export function nativeProxyStreamErrors(logs: string): Record<string, string | number | boolean>[] {
  return projectNativeDiagnostics(logs, true);
}

export function nativeProxyRequests(logs: string): Record<string, string | number | boolean>[] {
  if (Buffer.byteLength(logs) > 64 * 1024) throw new Error("proxy log capture exceeded its bound");
  const records: Record<string, string | number | boolean>[] = [];
  const marker = "native: request metadata ";
  const labels: Record<string, string[]> = {
    phase: ["start", "response", "transport_error"], vendor: ["anthropic", "openai", "unknown"], method: ["GET", "POST", "HEAD", "other"],
    endpoint: ["anthropic_messages", "anthropic_count_tokens", "openai_responses", "other"],
    response_kind: ["sse", "json", "other", "absent"], response_encoding: ["identity", "encoded", "absent"]
  };
  for (const line of logs.split("\n")) {
    const start = line.indexOf(marker);
    if (start < 0 || line.length > 4096) continue;
    let value: Record<string, unknown>;
    try { value = JSON.parse(line.slice(start + marker.length)); } catch { continue; }
    if (!value || Array.isArray(value) || Object.entries(labels).some(([key, allowed]) => typeof value[key] !== "string" || !allowed.includes(value[key])) ||
      typeof value.request_stream !== "boolean" || typeof value.credential_present !== "boolean" || !Number.isInteger(value.status) ||
      typeof value.call_id !== "string" || identifiers.some(key => value[key] !== undefined &&
        (typeof value[key] !== "string" || !uuid.test(value[key]) || value[key] === "00000000-0000-0000-0000-000000000000"))) continue;
    if (value.phase === "response" ? Number(value.status) < 100 || Number(value.status) > 599 || value.response_kind === "absent" || value.response_encoding === "absent" :
      value.status !== 0 || value.response_kind !== "absent" || value.response_encoding !== "absent") continue;
    if (String(value.endpoint).startsWith("anthropic_") && value.vendor !== "anthropic" || value.endpoint === "openai_responses" && value.vendor !== "openai") continue;
    const record: Record<string, string | number | boolean> = { status: Number(value.status), request_stream: value.request_stream, credential_present: value.credential_present };
    for (const key of [...Object.keys(labels), ...identifiers]) if (typeof value[key] === "string") record[key] = value[key];
    records.push(record);
    if (records.length === 128) break;
  }
  return records;
}

function projectNativeDiagnostics(logs: string, stream: boolean): Record<string, string | number | boolean>[] {
  if (Buffer.byteLength(logs) > 64 * 1024) throw new Error("proxy log capture exceeded its bound");
  const records: Record<string, string | number | boolean>[] = [];
  for (const line of logs.split("\n")) {
    const marker = stream ? "native: upstream stream error " : "native: upstream refused ";
    const start = line.indexOf(marker);
    if (start < 0 || line.length > 4096) continue;
    let value: Record<string, unknown>;
    try { value = JSON.parse(line.slice(start + marker.length)); } catch { continue; }
    if (!value || Array.isArray(value) || !Number.isInteger(value.status) || Number(value.status) < 100 || Number(value.status) > 599 ||
      (stream ? Number(value.status) < 200 || Number(value.status) >= 300 : Number(value.status) >= 200 && Number(value.status) < 300) ||
      typeof value.vendor !== "string" || !["anthropic", "openai", "unknown"].includes(value.vendor) ||
      typeof value.body_state !== "string" || !bodyStates.has(value.body_state) || typeof value.error_type !== "string" || !errorTypes.has(value.error_type) ||
      typeof value.credential_present !== "boolean" || typeof value.anthropic_oauth_beta !== "boolean") continue;
    if (stream && (value.vendor !== "anthropic" || value.event_type !== "error")) continue;
    if (identifiers.some(key => value[key] !== undefined && (typeof value[key] !== "string" || !uuid.test(value[key]) || value[key] === "00000000-0000-0000-0000-000000000000"))) continue;
    if (value.auth_reason !== undefined && (typeof value.auth_reason !== "string" || !authReasons.has(value.auth_reason) ||
      (stream ? value.body_state !== "complete" || !["authentication_error", "permission_error"].includes(String(value.error_type)) : ![401, 403].includes(Number(value.status))))) continue;
    const record: Record<string, string | number | boolean> = {
      status: Number(value.status), vendor: String(value.vendor), body_state: String(value.body_state), error_type: String(value.error_type),
      credential_present: value.credential_present, anthropic_oauth_beta: value.anthropic_oauth_beta
    };
    for (const key of identifiers) if (typeof value[key] === "string") record[key] = value[key];
    if (typeof value.auth_reason === "string") record.auth_reason = value.auth_reason;
    if (stream) record.event_type = "error";
    records.push(record);
    if (records.length === 128) break;
  }
  return records;
}
