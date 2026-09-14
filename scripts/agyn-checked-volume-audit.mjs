// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { collectCheckedVolumeAudit } from "../dist/live/checked-volume-audit.js";

let stage = "configuration";
try {
  const root = process.env.AGYN_AUDIT_OUTPUT_DIR;
  if (process.env.AGYN_LIVE_ACCEPTANCE !== "trusted-local" || !isAbsolute(process.env.AGYN_KUBECONFIG ?? "") || !isAbsolute(root ?? "")) throw new Error("opt-in required");
  const info = lstatSync(root);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid()) throw new Error("private owned report directory required");
  stage = "capture";
  const report = collectCheckedVolumeAudit((args, input) => execFileSync("kubectl", ["--kubeconfig", process.env.AGYN_KUBECONFIG,
    "--request-timeout=20s", ...args], { input, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }), {
    postgresPod: process.env.AGYN_AUDIT_POSTGRES_POD ?? "", postgresPodUid: process.env.AGYN_AUDIT_POSTGRES_UID ?? "",
    postgresUser: process.env.AGYN_AUDIT_POSTGRES_USER ?? "", runnerId: process.env.AGYN_AUDIT_RUNNER_ID ?? "", namespaceUid: process.env.AGYN_AUDIT_NAMESPACE_UID ?? ""
  });
  stage = "report";
  const current = lstatSync(root);
  if (current.dev !== info.dev || current.ino !== info.ino || current.mode !== info.mode || current.uid !== info.uid) throw new Error("report directory changed");
  const directory = mkdtempSync(join(root, "capture-"));
  writeFileSync(join(directory, "audit.json"), JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ kind: report.kind, directory, observationalOnly: true, permitsRollout: false, summary: report.summary }));
  process.exitCode = report.findings.length ? 2 : 0;
} catch {
  // Raw subprocess exceptions may contain Pod specifications or database output.
  console.error(`Checked-volume audit failed during ${stage}; no rollout or data mutation was authorized.`);
  process.exitCode = 1;
}
