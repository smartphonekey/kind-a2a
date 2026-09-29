// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Cloudflare Access identity adapter; it never grants machine or reconciliation access.
 * @module
 * @see src/service/browser.ts
 */
import { createHash } from "node:crypto";
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import type { BrowserAuthentication } from "./auth.js";

export const cloudflareAccessSchema = z.object({
  issuer: z.string().regex(/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/),
  audience: z.string().regex(/^[a-f0-9]{64}$/),
  tenant: z.string().min(1).max(128),
  emailDomains: z.array(z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/)).min(1).max(20),
}).strict();
export type CloudflareAccessConfig = z.infer<typeof cloudflareAccessSchema>;

/**
 * Trust only signed application JWTs from the configured team and audience. A
 * service-token JWT is not a human identity. Email is a display/domain claim,
 * never the owner key: re-created Access users must not inherit old tasks.
 *
 * Offline verification cannot detect Access-side revocation. Browser streams
 * are bounded to one minute so their next subscription passes the edge policy
 * again. Local logout also invalidates this token immediately in this process.
 */
export function cloudflareAccessAuthentication(
  input: CloudflareAccessConfig,
  key?: JWTVerifyGetKey,
): BrowserAuthentication {
  const config = cloudflareAccessSchema.parse(input);
  const jwks = key ?? createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`), {
    timeoutDuration: 5000, cooldownDuration: 5000, cacheMaxAge: 300_000,
  });
  const revoked = new Map<string, number>();
  const digest = (token: string) => createHash("sha256").update(token).digest("hex");
  const authenticate: BrowserAuthentication["authenticate"] = async headers => {
    const token = headers["cf-access-jwt-assertion"];
    if (typeof token !== "string" || token.length > 16_384 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return;
    const now = Date.now();
    for (const [id, expiry] of revoked) if (expiry <= now) revoked.delete(id);
    const id = digest(token);
    if (revoked.has(id)) return;
    let payload;
    try {
      ({ payload } = await jwtVerify(token, jwks, {
        algorithms: ["RS256"], issuer: config.issuer, audience: config.audience,
        requiredClaims: ["sub", "email", "exp", "iat", "type"],
      }));
    } catch (error) {
      if (error instanceof errors.JOSEError && !(error instanceof errors.JWKSTimeout)) return;
      throw new Error("Access verification unavailable");
    }
    if (payload.type !== "app" || typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 256 ||
        typeof payload.email !== "string" || payload.email.length > 254 ||
        !/^[^\s@]+@[^\s@]+$/.test(payload.email) ||
        !config.emailDomains.includes(payload.email.split("@")[1].toLowerCase()) ||
        !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat) || payload.iat! > Math.floor(now / 1000)) return;
    const subject = `cf:${createHash("sha256").update(JSON.stringify([config.issuer, payload.sub])).digest("hex")}`;
    return { principal: { tenant: config.tenant, subject, canReconcile: false },
      displayName: payload.email, expiresAt: payload.exp! * 1000, credentialId: id };
  };
  return {
    mode: "cloudflare-access", maxStreamMs: 60_000, logoutUrl: "/cdn-cgi/access/logout", authenticate,
    revoke: identity => {
      if (revoked.size >= 1000) throw new Error("Logout capacity exceeded");
      revoked.set(identity.credentialId, identity.expiresAt);
    },
  };
}
