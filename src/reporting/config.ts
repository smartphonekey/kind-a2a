// SPDX-License-Identifier: AGPL-3.0-only
import { lstatSync, readFileSync } from "node:fs";
import { z } from "zod";

const schema = z.object({ url: z.string().url(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  allowInsecureLocal: z.boolean().default(false) }).strict();

export function reportingConfig(path: string | undefined) {
  if (!path) throw new Error("REPORTING_CONFIG_FILE is required");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.mode & 0o077 || stat.size > 16384) throw new Error("reporting config must be a private regular file");
  const config = schema.parse(JSON.parse(readFileSync(path, "utf8")));
  const url = new URL(config.url);
  if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) throw new Error("invalid reporting URL");
  if (url.protocol !== "https:" && !config.allowInsecureLocal) throw new Error("reporting requires HTTPS");
  return { ...config, url: url.toString().replace(/\/$/, "") };
}
