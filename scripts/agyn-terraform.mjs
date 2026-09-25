// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Reviewed agent-definition changes using Agyn's provider and Terraform's lock.
 * @module
 * @remarks No reconciliation loop, task provisioning or secret distribution is
 * implemented here. Logs/plans/state can be sensitive; they stay in private
 * operator storage. Rendering a candidate does not roll out the A2A service.
 * @see scripts/agyn-terraform-policy.mjs
 * @see scripts/agyn-terraform-provider.mjs
 * @see infra/agyn/agents.tf
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { mergeTerraformProfiles, reviewAgentPlan, terraformProfiles } from "./agyn-terraform-policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const state = path.join(root, ".state/agyn-terraform");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const json = file => JSON.parse(readFileSync(file, "utf8"));
const options = parseArgs({ allowPositionals: true, options: {
  profile: { type: "string" }, "allow-create": { type: "boolean", default: false },
  plan: { type: "string" }, approve: { type: "string" },
  config: { type: "string" }, out: { type: "string" }, help: { type: "boolean" },
} });
const [command] = options.positionals;
const args = options.values;
const usage = `Usage: node scripts/agyn-terraform.mjs <command> [options]
  check                         Credential-free format, validation and mock tests
  plan [--profile NAME] [--allow-create]
                                Save a private plan and print its approval digest
  apply --plan FILE --approve SHA256 [--profile NAME] [--allow-create]
                                Apply only that reviewed plan, with unchanged inputs
  render --config FILE --out NEW_FILE
                                Generate a candidate A2A config from managed profiles
Requires agents:provider first. Live commands require KUBE_CONFIG_PATH or
KUBE_IN_CLUSTER_CONFIG=true; token via AGYN_API_TOKEN or an explicit --profile.
Custom Gateway CAs use SSL_CERT_FILE. No TLS verification bypass is supported.`;

if (args.help || !command) {
  console.log(usage);
} else {
  try { main(); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

function main() {
  if (options.positionals.length !== 1 || !["check", "plan", "apply", "render"].includes(command)) throw new Error(usage);
  const allowed = {
    check: [], plan: ["profile", "allow-create"],
    apply: ["profile", "plan", "approve", "allow-create"], render: ["config", "out"],
  }[command];
  for (const [key, value] of Object.entries(args)) {
    if (value && !allowed.includes(key)) throw new Error(`Unexpected --${key} for ${command}`);
  }
  process.umask(0o077);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const receipt = json(path.join(state, "provider.json"));
  if (receipt.sourceSha256 !== digest(readFileSync(path.join(root, "infra/agyn/provider-source.json"))) ||
      receipt.binarySha256 !== digest(readFileSync(receipt.binary))) throw new Error("Provider pin/binary changed; rerun agents:provider");
  const cliConfig = path.join(state, "terraform.tfrc");
  writeFileSync(cliConfig, `provider_installation {
  dev_overrides { "agynio/agyn" = ${JSON.stringify(path.dirname(receipt.binary))} }
  direct {}
}\n`, { mode: 0o600 });
  const env = { ...process.env };
  // Hidden CLI arguments/logging could change the reviewed action or expose data.
  for (const key of Object.keys(env)) if (key.startsWith("TF_") && key !== "TF_VAR_gateway_url") delete env[key];
  Object.assign(env, { TF_CLI_CONFIG_FILE: cliConfig, TF_INPUT: "0", TF_IN_AUTOMATION: "1", TF_WORKSPACE: "default" });
  const run = mkdtempSync(path.join(state, `${command}-`));
  const log = path.join(run, "terraform.log");
  const tf = (directory, argv, codes = [0]) => {
    const result = spawnSync("terraform", [`-chdir=${path.join(root, directory)}`, ...argv], {
      env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    });
    appendFileSync(log, `${result.stdout ?? ""}${result.stderr ?? ""}`, { mode: 0o600 });
    if (result.error || !codes.includes(result.status)) throw new Error(`Terraform failed; inspect private log ${log}`);
    return result.stdout;
  };
  const directory = "infra/agyn";
  if (command === "check") {
    delete env.AGYN_API_TOKEN;
    tf("infra", ["fmt", "-check", "-recursive"]);
    env.TF_DATA_DIR = path.join(run, "root-data");
    tf(directory, ["init", "-backend=false", "-input=false", "-no-color"]);
    tf(directory, ["validate", "-no-color"]);
    env.TF_DATA_DIR = path.join(run, "module-data");
    tf("infra/modules/a2a-agents", ["init", "-backend=false", "-input=false", "-no-color"]);
    tf("infra/modules/a2a-agents", ["test", "-no-color"]);
    console.log(`Terraform format, validation and mock tests passed. Log: ${log}`);
    return;
  }
  if (!env.KUBE_CONFIG_PATH && env.KUBE_IN_CLUSTER_CONFIG !== "true") throw new Error("Select an explicit Kubernetes backend with KUBE_CONFIG_PATH or KUBE_IN_CLUSTER_CONFIG=true");
  if (env.KUBE_CONFIG_PATH) env.KUBE_CONFIG_PATH = path.resolve(env.KUBE_CONFIG_PATH);
  env.TF_DATA_DIR = path.join(state, "live-data");
  if (command === "plan" || command === "apply") {
    if (args.profile) {
      try {
        env.AGYN_API_TOKEN = execFileSync("agyn", ["profile", "token", args.profile], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      } catch {
        throw new Error("Unable to obtain an Agyn profile token; check the selected login privately");
      }
    }
    if (!env.AGYN_API_TOKEN) throw new Error("Set AGYN_API_TOKEN or select an explicit Agyn --profile");
  }
  const inputs = sourceDigest(env, receipt);
  const savedPlan = command === "apply" ? path.resolve(args.plan ?? "") : path.join(run, "agents.tfplan");
  if (command === "apply") {
    if (!args.plan || !/^[a-f0-9]{64}$/.test(args.approve ?? "")) throw new Error("Apply requires --plan and its reviewed --approve SHA256");
    const approval = json(`${savedPlan}.approval.json`);
    if (args.approve !== digest(readFileSync(savedPlan)) || args.approve !== approval.sha256 ||
        inputs !== approval.inputs || args["allow-create"] !== approval.allowCreate) {
      throw new Error("Plan, source, provider, target or approval changed; create and review a new plan");
    }
  }
  tf(directory, ["init", "-input=false", "-no-color", "-reconfigure"]);
  if (command === "render") {
    if (!args.config || !args.out || path.resolve(args.config) === path.resolve(args.out)) throw new Error("Render requires --config and a different, new --out file");
    const profiles = terraformProfiles(JSON.parse(tf(directory, ["output", "-json"])));
    const candidate = mergeTerraformProfiles(json(args.config), profiles);
    writeFileSync(args.out, JSON.stringify(candidate, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    console.log(`Candidate written to ${path.resolve(args.out)}; no deployment was changed.`);
    return;
  }
  if (command === "plan") {
    tf(directory, ["plan", "-input=false", "-no-color", "-lock-timeout=60s", "-detailed-exitcode", `-out=${savedPlan}`], [0, 2]);
  }
  const plan = JSON.parse(tf(directory, ["show", "-json", savedPlan]));
  const review = reviewAgentPlan(plan, { allowCreate: args["allow-create"] });
  const sha256 = digest(readFileSync(savedPlan));
  if (command === "plan") {
    writeFileSync(`${savedPlan}.approval.json`, JSON.stringify({ sha256, inputs, allowCreate: args["allow-create"] }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ plan: savedPlan, sha256, review, log }, null, 2));
  } else {
    tf(directory, ["apply", "-input=false", "-no-color", "-lock-timeout=60s", savedPlan]);
    console.log(JSON.stringify({ applied: sha256, review, log }, null, 2));
  }
}

// Detect edits between review and apply, including ignored tfvars and external
// target selection. Saved plans contain their own values; this guard also binds
// them to the code/policy/provider that the operator reviewed.
function sourceDigest(env, receipt) {
  const entries = [];
  const collect = directory => {
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const relative = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(relative);
      else entries.push([relative, digest(readFileSync(path.join(root, relative)))]);
    }
  };
  collect("infra/agyn");
  collect("infra/modules/a2a-agents");
  for (const name of ["agyn-terraform.mjs", "agyn-terraform-policy.mjs"]) {
    entries.push([name, digest(readFileSync(path.join(root, "scripts", name)))]);
  }
  entries.push(["provider", receipt.binarySha256]);
  for (const key of Object.keys(env).filter(key => key.startsWith("KUBE_") || key === "TF_VAR_gateway_url" || key === "SSL_CERT_FILE").sort()) {
    entries.push([key, env[key]]);
  }
  if (env.KUBE_CONFIG_PATH) entries.push(["kubeconfig", digest(readFileSync(env.KUBE_CONFIG_PATH))]);
  return digest(JSON.stringify(entries));
}
