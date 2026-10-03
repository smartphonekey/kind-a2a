// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Agyn gateway connection settings shared by the service and its reporting installer.
 * @module
 * @remarks `AGYN_TOKEN` is a static bearer and requires `AGYN_IDENTITY_ID`.
 * `AGYN_GATEWAY_TOKEN_FILE` instead names a rotating bearer file, such as a
 * kubelet-projected ServiceAccount token that the gateway accepts as an OIDC
 * subject. Its Agyn user may only exist after first authentication, so the
 * identity is derived from GetMe unless `AGYN_IDENTITY_ID` is also set.
 * Setting both token variables is a configuration error, never a fallback.
 * @see src/service/main.ts
 * @see src/service/agyn-reporting-installer.ts
 * @see scripts/k8s-manifests.mjs
 */
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { AgynClient } from "../agyn-client.js";

/** A projected ServiceAccount JWT is a few KiB; a larger file is misconfigured, not a token. */
export const maxGatewayTokenBytes = 8192;
// RFC 6750 b64token syntax, which also excludes header-splitting characters.
const bearerSyntax = /^[A-Za-z0-9._~+/-]+=*$/;

/** A rejected token file; the message names the reason only, never the content. */
export class AgynGatewayTokenError extends Error {
  constructor(readonly reason: "unreadable" | "empty" | "oversized" | "malformed") {
    super(`Agyn gateway token file is ${reason}`);
    this.name = "AgynGatewayTokenError";
  }
}

/**
 * Return a bearer source that reads the file for every gateway request.
 * @remarks The kubelet replaces projected tokens atomically before they expire, so
 * a per-request read always presents the current token and has no cache to go stale.
 * Content is trimmed; a missing, empty, oversized or non-bearer file rejects the request.
 */
export function gatewayTokenFile(path: string): () => Promise<string> {
  if (!isAbsolute(path)) throw new Error("AGYN_GATEWAY_TOKEN_FILE must be an absolute path");
  return async () => {
    let content: Buffer;
    try {
      const handle = await open(path, "r");
      try {
        // Bounded read: the path may name a device or a growing file.
        const buffer = Buffer.alloc(maxGatewayTokenBytes + 1);
        let length = 0, read = 0;
        do {
          ({ bytesRead: read } = await handle.read(buffer, length, buffer.length - length, length));
          length += read;
        } while (read > 0 && length < buffer.length);
        content = buffer.subarray(0, length);
      } finally { await handle.close(); }
    } catch { throw new AgynGatewayTokenError("unreadable"); }
    if (content.length > maxGatewayTokenBytes) throw new AgynGatewayTokenError("oversized");
    const token = content.toString("utf8").trim();
    if (!token) throw new AgynGatewayTokenError("empty");
    if (!bearerSyntax.test(token)) throw new AgynGatewayTokenError("malformed");
    return token;
  };
}

/**
 * Build the gateway client from the environment. With a token file, read it once so a
 * misconfigured mount fails here rather than on the first execution.
 */
export async function agynClientFromEnvironment(env: Record<string, string | undefined> = process.env): Promise<AgynClient> {
  const optional = (name: string) => env[name]?.trim() || undefined;
  const required = (name: string) => {
    const value = optional(name);
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const tokenFile = env.AGYN_GATEWAY_TOKEN_FILE;
  if (tokenFile === undefined) {
    return new AgynClient(required("AGYN_GATEWAY_URL"), required("AGYN_TOKEN"), required("AGYN_ORGANIZATION_ID"), required("AGYN_IDENTITY_ID"));
  }
  if (env.AGYN_TOKEN !== undefined) throw new Error("AGYN_TOKEN and AGYN_GATEWAY_TOKEN_FILE are mutually exclusive");
  const bearer = gatewayTokenFile(tokenFile);
  const client = new AgynClient(required("AGYN_GATEWAY_URL"), bearer, required("AGYN_ORGANIZATION_ID"), optional("AGYN_IDENTITY_ID"));
  await bearer();
  return client;
}
