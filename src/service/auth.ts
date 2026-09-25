// SPDX-License-Identifier: AGPL-3.0-only
/**
 * File-backed bearer authentication for owner-scoped service requests.
 * @module
 * @see src/service/http.ts
 * @see src/service/browser.ts
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import { z } from "zod";
import type { Scope } from "./task-store.js";

/** Reconciliation permission augments ownership; it never grants access to another owner's tasks. */
export type Principal = Scope & { canReconcile: boolean };
/** Return no principal for invalid credentials; reject when authentication cannot be evaluated. */
export type Authorize = (authorization: string | undefined) => Promise<Principal | undefined>;
const credentialsSchema = z.array(z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/), tenant: z.string().min(1).max(256),
  subject: z.string().min(1).max(256), canReconcile: z.boolean().default(false),
  expiresAt: z.string().datetime()
}).strict()).min(1).max(1000);

export function tokenDigest(token: string): string { return createHash("sha256").update(token).digest("hex"); }

/**
 * Reload credentials on each bearer check, including checks made by open subscriptions.
 * @remarks The file must be regular, not a symlink, with no group/other permissions.
 * A token must match exactly one credential, which must be unexpired. File/schema failures reject rather
 * than falling back to anonymous access; atomic replacement takes effect on the next check.
 */
export function fileAuthorizer(path: string): Authorize {
  return async authorization => {
    const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/)?.[1];
    if (!token) return undefined;
    const info = await lstat(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 1_048_576) throw new Error("invalid credentials file permissions or size");
    const credentials = credentialsSchema.parse(JSON.parse(await readFile(path, "utf8")));
    const digest = Buffer.from(tokenDigest(token), "hex");
    const matches = credentials.filter(entry => timingSafeEqual(digest, Buffer.from(entry.sha256, "hex")));
    if (matches.length !== 1 || Date.parse(matches[0].expiresAt) <= Date.now()) return undefined;
    const { tenant, subject, canReconcile } = matches[0];
    return { tenant, subject, canReconcile };
  };
}
