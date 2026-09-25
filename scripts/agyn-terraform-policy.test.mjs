// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeTerraformProfiles, reviewAgentPlan, terraformProfiles } from "./agyn-terraform-policy.mjs";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const change = () => ({
  address: 'module.agents.agyn_agent.profile["codex"]', mode: "managed", type: "agyn_agent",
  provider_name: "registry.terraform.io/agynio/agyn",
  change: { actions: ["no-op"], importing: { id: first }, after: { id: first } },
});
const plan = () => ({ format_version: "1.2", complete: true, errored: false, checks: [{ status: "pass" }], resource_changes: [change()] });

test("adoption permits state imports without remote mutations", () => {
  assert.deepEqual(reviewAgentPlan(plan()), { imports: [change().address], creates: [], unchanged: [] });
});

test("new versioned agents require explicit create approval", () => {
  const p = plan();
  p.resource_changes[0].address = 'module.agents.agyn_agent.profile["reviewer-v2"]';
  p.resource_changes[0].change = { actions: ["create"], after: { environment_id: first } };
  assert.throws(() => reviewAgentPlan(p));
  assert.equal(reviewAgentPlan(p, { allowCreate: true }).creates.length, 1);
  p.resource_changes[0].address = change().address;
  assert.throws(() => reviewAgentPlan(p, { allowCreate: true }));
});

for (const actions of [["update"], ["delete"], ["delete", "create"], ["create", "delete"], ["forget"], ["read"], []]) {
  test(`deny resource actions ${JSON.stringify(actions)}`, () => {
    const p = plan();
    p.resource_changes[0].change.actions = actions;
    assert.throws(() => reviewAgentPlan(p, { allowCreate: true }));
  });
}

test("unknown resources, providers, repeated addresses and incomplete imports are rejected", () => {
  for (const modify of [
    p => p.resource_changes[0].type = "agyn_volume",
    p => p.resource_changes[0].mode = "data",
    p => p.resource_changes[0].provider_name = "untrusted/provider",
    p => p.resource_changes[0].address = "agyn_agent.outside",
    p => p.resource_changes.push(change()),
    p => p.resource_changes[0].change.after.id = second,
    p => delete p.resource_changes[0].change.importing.id,
    p => p.resource_changes[0].deposed = "old",
  ]) {
    const p = plan(); modify(p); assert.throws(() => reviewAgentPlan(p));
  }
});

test("incomplete, failed, drifted, deferred or unsupported plans fail closed", () => {
  for (const modify of [
    p => p.format_version = "2.0",
    p => p.complete = false,
    p => delete p.complete,
    p => p.errored = true,
    p => p.checks[0].status = "unknown",
    p => p.checks[0].status = "fail",
    p => p.deferred_changes = [{}],
    p => p.resource_changes = [],
    p => p.resource_drift = [{ change: { actions: ["update"] } }],
  ]) {
    const p = plan(); modify(p); assert.throws(() => reviewAgentPlan(p));
  }
});

test("outputs reject unknown fields, sensitive values and duplicate identities", () => {
  const output = value => ({ a2a_profiles: { sensitive: false, value } });
  const profiles = [{ id: "codex", agentId: first }];
  assert.deepEqual(terraformProfiles(output(profiles)), profiles);
  assert.throws(() => terraformProfiles({ a2a_profiles: { sensitive: true, value: profiles } }));
  assert.throws(() => terraformProfiles(output([{ ...profiles[0], token: "secret" }])));
  assert.throws(() => terraformProfiles(output([...profiles, ...profiles])));
  assert.throws(() => terraformProfiles(output([...profiles, { id: "alias", agentId: first }])));
  assert.throws(() => terraformProfiles({}));
});

test("rendering preserves other configuration and all old profile bindings", () => {
  const config = { profiles: [{ id: "codex", agentId: first }], defaultProfile: "codex", dbPath: "/keep/tasks.sqlite", concurrency: 2 };
  const profiles = [...config.profiles, { id: "reviewer-v2", agentId: second }];
  assert.deepEqual(mergeTerraformProfiles(config, profiles), { ...config, profiles });
  assert.throws(() => mergeTerraformProfiles(config, [profiles[1]]));
  assert.throws(() => mergeTerraformProfiles(config, [{ id: "codex", agentId: second }]));
  assert.throws(() => mergeTerraformProfiles({ ...config, defaultProfile: "missing" }, profiles));
  assert.equal(config.profiles.length, 1);
});
