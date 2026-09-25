// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const identity = "11111111-1111-4111-8111-111111111111";
const fixturePlan = {
  format_version: "1.2", complete: true, errored: false,
  resource_changes: [{
    address: 'module.agents.agyn_agent.profile["codex"]', mode: "managed", type: "agyn_agent",
    provider_name: "registry.terraform.io/agynio/agyn",
    change: { actions: ["no-op"], importing: { id: identity }, after: { id: identity } },
  }],
};

function fixture(t, { ci = false, actions = ["no-op"], advanceMain = false, failApply = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "a2a-terraform-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ["scripts", "bin", "infra/agyn", "infra/modules/a2a-agents", ".state/agyn-terraform"]) mkdirSync(path.join(dir, name), { recursive: true });
  for (const name of ["agyn-terraform.mjs", "agyn-terraform-policy.mjs", "agyn-terraform-ci.mjs"]) copyFileSync(path.join(root, "scripts", name), path.join(dir, "scripts", name));
  symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "dir");
  const binary = path.join(dir, "provider");
  writeFileSync(binary, "test binary");
  writeFileSync(path.join(dir, "infra/agyn/provider-source.json"), "{}");
  writeFileSync(path.join(dir, "infra/agyn/agents.tf"), "# test definitions\n");
  writeFileSync(path.join(dir, "kubeconfig"), "explicit test target");
  writeFileSync(path.join(dir, ".state/agyn-terraform/provider.json"), JSON.stringify({ sourceSha256: hash("{}"), binary, binarySha256: hash("test binary") }));
  const planValue = structuredClone(fixturePlan);
  planValue.resource_changes[0].change.actions = actions;
  if (actions[0] === "create") {
    planValue.resource_changes[0].address = 'module.agents.agyn_agent.profile["reviewer-v2"]';
    delete planValue.resource_changes[0].change.importing;
    planValue.resource_changes[0].change.after.environment_id = identity;
  }
  writeFileSync(path.join(dir, "event.json"), JSON.stringify({ ref: "refs/heads/main", after: "a".repeat(40), repository: { full_name: "smartphonekey/kind-a2a" }, deleted: false, forced: false }));
  writeFileSync(path.join(dir, "bin/git"), `#!${process.execPath}
const fs = require('node:fs');
const command = process.argv[2];
if (command === 'rev-parse') console.log('a'.repeat(40));
if (command === 'ls-remote') console.log((fs.existsSync(process.env.FIXTURE_DIR + '/advanced') ? 'b' : 'a').repeat(40) + '\\trefs/heads/main');
`, { mode: 0o700 });
  // The fake CLI records only invocations; it never starts a provider or cluster.
  writeFileSync(path.join(dir, "bin/terraform"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_DIR + '/calls', JSON.stringify(args) + '\\n');
const command = args[1];
if (command === 'plan') {
  fs.writeFileSync(args.find(x => x.startsWith('-out=')).slice(5), ${JSON.stringify(JSON.stringify(planValue))});
  if (${advanceMain}) fs.writeFileSync(process.env.FIXTURE_DIR + '/advanced', 'yes');
}
if (command === 'show') process.stdout.write(fs.readFileSync(args.at(-1)));
if (command === 'output') process.stdout.write(JSON.stringify({a2a_profiles:{sensitive:false,value:[{id:'codex',agentId:${JSON.stringify(identity)}}]}}));
if (command === 'apply') {
  fs.writeFileSync(process.env.FIXTURE_DIR + '/applied', 'yes');
  if (${failApply}) process.exit(1);
}
`, { mode: 0o700 });
  const run = (...args) => spawnSync(process.execPath, [path.join(dir, "scripts/agyn-terraform.mjs"), ...args], {
    cwd: dir, encoding: "utf8", env: {
      ...process.env, PATH: `${path.join(dir, "bin")}:${process.env.PATH}`, FIXTURE_DIR: dir,
      KUBE_CONFIG_PATH: path.join(dir, "kubeconfig"), AGYN_API_TOKEN: "fixture-secret-do-not-log",
      ...(ci ? {
        GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_REF_PROTECTED: "true",
        GITHUB_REPOSITORY: "smartphonekey/kind-a2a", GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "42",
        GITHUB_WORKFLOW_REF: "smartphonekey/kind-a2a/.github/workflows/agyn-agents.yml@refs/heads/main",
        GITHUB_EVENT_PATH: path.join(dir, "event.json"), AGYN_AUTO_APPLY_ENABLED: "true",
        KUBE_HOST: "https://cluster.example.test", KUBE_TOKEN: "fixture-kube-token",
        KUBE_CLUSTER_CA_CERT_DATA: "-----BEGIN CERTIFICATE-----\ntest", AGYN_GATEWAY_CA_PEM: "-----BEGIN CERTIFICATE-----\ntest",
        TF_VAR_gateway_url: "https://gateway.example.test",
      } : { GITHUB_ACTIONS: "false" }),
    },
  });
  const plan = () => {
    const result = run("plan");
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-secret-do-not-log/);
    return JSON.parse(result.stdout);
  };
  return { dir, run, plan };
}

test("CI deploy plans and applies a versioned create without separate human approval", t => {
  const f = fixture(t, { ci: true, actions: ["create"] });
  const result = f.run("deploy");
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.review.creates.length, 1);
  assert.equal(receipt.deployment.revision, "a".repeat(40));
  const calls = readFileSync(path.join(f.dir, "calls"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.map(args => args[1]), ["init", "plan", "show", "apply"]);
  assert.equal(calls[1].find(arg => arg.startsWith("-out=")).slice(5), calls[3].at(-1));
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-secret|fixture-kube-token/);
});

for (const actions of [["update"], ["delete"], ["delete", "create"]]) {
  test(`CI deploy retains the refusal of ${actions.join("/")}`, t => {
    const f = fixture(t, { ci: true, actions });
    assert.equal(f.run("deploy").status, 1);
    assert.equal(existsSync(path.join(f.dir, "applied")), false);
  });
}

test("CI deploy rechecks main after planning and does not apply an outdated plan", t => {
  const f = fixture(t, { ci: true, advanceMain: true });
  assert.equal(f.run("deploy").status, 1);
  assert.equal(existsSync(path.join(f.dir, "applied")), false);
});

test("CI deploy fails on apply error without retrying", t => {
  const f = fixture(t, { ci: true, failApply: true });
  assert.equal(f.run("deploy").status, 1);
  const calls = readFileSync(path.join(f.dir, "calls"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.filter(args => args[1] === "apply").length, 1);
});

test("local invocation cannot use the CI automatic approval path", t => {
  const f = fixture(t);
  assert.equal(f.run("deploy").status, 1);
  assert.equal(existsSync(path.join(f.dir, "calls")), false);
});

test("apply requires the exact reviewed plan and writes private evidence", t => {
  const f = fixture(t);
  const p = f.plan();
  assert.equal(statSync(p.plan).mode & 0o777, 0o600);
  assert.equal(statSync(p.log).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(p.plan)).mode & 0o777, 0o700);
  assert.equal(f.run("apply", "--plan", p.plan).status, 1);
  assert.equal(existsSync(path.join(f.dir, "applied")), false);
  assert.equal(f.run("apply", "--plan", p.plan, "--approve", p.sha256).status, 0);
  assert.equal(existsSync(path.join(f.dir, "applied")), true);
});

for (const [name, mutate] of [
  ["plan", (f, p) => appendFileSync(p.plan, " ")],
  ["source", f => appendFileSync(path.join(f.dir, "infra/agyn/agents.tf"), "# changed\n")],
  ["backend", f => appendFileSync(path.join(f.dir, "kubeconfig"), " changed")],
  ["provider", f => appendFileSync(path.join(f.dir, "provider"), " changed")],
]) {
  test(`changed ${name} prevents apply`, t => {
    const f = fixture(t);
    const p = f.plan();
    mutate(f, p);
    assert.equal(f.run("apply", "--plan", p.plan, "--approve", p.sha256).status, 1);
    assert.equal(existsSync(path.join(f.dir, "applied")), false);
  });
}

test("create consent cannot be added after plan review", t => {
  const f = fixture(t);
  const p = f.plan();
  assert.equal(f.run("apply", "--plan", p.plan, "--approve", p.sha256, "--allow-create").status, 1);
  assert.equal(existsSync(path.join(f.dir, "applied")), false);
});

test("render keeps secrets private and refuses either input or output overwrite", t => {
  const f = fixture(t);
  const before = { profiles: [{ id: "codex", agentId: identity }], defaultProfile: "codex", token: "retained-test-token" };
  const config = path.join(f.dir, "config.json");
  const out = path.join(f.dir, "candidate.json");
  writeFileSync(config, JSON.stringify(before));
  const result = f.run("render", "--config", config, "--out", out);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /retained-test-token/);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), before);
  assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.equal(f.run("render", "--config", config, "--out", config).status, 1);
  assert.equal(f.run("render", "--config", config, "--out", out).status, 1);
  assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), before);
});
