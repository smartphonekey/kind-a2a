// SPDX-License-Identifier: AGPL-3.0-only
import { build } from "esbuild";
import { chmodSync, copyFileSync } from "node:fs";

await build({ entryPoints: ["src/reporting/runtime.ts"], bundle: true, platform: "node", target: "node22",
  format: "esm", outfile: "dist/reporting/runtime.mjs", minify: true,
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
chmodSync("dist/service/agyn-reporting-installer.js", 0o755);
copyFileSync("scripts/agyn-execution-receiver.cjs", "dist/reporting/receiver.cjs");
