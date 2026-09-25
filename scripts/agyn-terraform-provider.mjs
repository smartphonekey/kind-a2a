// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Build the unpublished native-model fix from an immutable fork revision.
 * @module
 * @remarks This project-local development override is not a signed provider
 * release. Retire it when an upstream release includes model_name support.
 * @see infra/agyn/provider-source.json
 * @see scripts/agyn-terraform.mjs
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const state = path.join(root, ".state/agyn-terraform");
const source = readFileSync(path.join(root, "infra/agyn/provider-source.json"));
const pin = JSON.parse(source);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
process.umask(0o077);
mkdirSync(state, { recursive: true, mode: 0o700 });
const build = mkdtempSync(path.join(state, "provider-"));
const checkout = path.join(build, "source");
const bin = path.join(build, "bin");
mkdirSync(bin);
if (!/^[a-f0-9]{40}$/.test(pin.revision)) throw new Error("An immutable provider revision is required");

const env = { ...process.env, GOTOOLCHAIN: "local", GOWORK: "off", GOFLAGS: "-mod=readonly" };
for (const key of Object.keys(env)) {
  if (key.startsWith("TF_") || key.startsWith("AGYN_") || key.startsWith("KUBE_")) delete env[key];
}
function run(command, args, cwd = build) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`${command} failed; build retained at ${build}`);
}

run("git", ["init", "--quiet", checkout]);
run("git", ["remote", "add", "origin", pin.repository], checkout);
run("git", ["fetch", "--depth=1", "origin", pin.revision], checkout);
run("git", ["checkout", "--quiet", "--detach", pin.revision], checkout);
// Generate only the Gateway surface and its imports, never floating BSR HEAD.
run("buf", ["generate", pin.api, "--include-imports", "--path", "agynio/api/gateway/v1", "--template", JSON.stringify({
  version: "v2",
  managed: { enabled: true, override: [{ file_option: "go_package_prefix", value: "github.com/agynio/terraform-provider-agyn/gen" }] },
  plugins: [
    { remote: pin.protobufPlugin, out: "gen", opt: ["paths=source_relative"] },
    { remote: pin.connectPlugin, out: "gen", opt: ["paths=source_relative", "simple"] },
  ],
})], checkout);
run("go", ["test", "-race", "./internal/resources", "./internal/agentapi", "./internal/provider", "-count=1", "-timeout=5m"], checkout);
const binary = path.join(bin, "terraform-provider-agyn");
run("go", ["build", "-trimpath", "-buildvcs=false", "-o", binary, "."], checkout);
writeFileSync(path.join(state, "provider.json"), JSON.stringify({
  sourceSha256: digest(source), binary, binarySha256: digest(readFileSync(binary)),
}, null, 2) + "\n", { mode: 0o600 });
console.log(`Built and tested provider ${pin.revision}; receipt: ${path.join(state, "provider.json")}`);
