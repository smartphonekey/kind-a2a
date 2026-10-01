#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/** Create a quarantined rehearsal copy without credentials, provider calls or live writes. @module */
import { parseArgs } from "node:util";
import { rehearseSnapshot } from "./snapshot.js";
try {
  const { values } = parseArgs({ options: { db: { type: "string" }, "output-root": { type: "string" } }, strict: true, allowPositionals: false });
  if (!values.db || !values["output-root"]) throw new Error("arguments required");
  const result = await rehearseSnapshot(values.db, values["output-root"]);
  console.log(JSON.stringify({ directory: result.directory, integrityVerified: true, executionQuarantined: true, wholeStackRecoveryVerified: false }));
} catch {
  console.error("Snapshot rehearsal failed. Use --db <trusted private database> --output-root <existing private directory>; preserve failed output for inspection.");
  process.exitCode = 1;
}
