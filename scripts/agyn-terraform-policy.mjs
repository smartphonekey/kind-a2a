// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Restrict reviewed Terraform plans to adopting or adding Agyn agent definitions.
 * @module
 * @remarks This is an operator guard, not a boundary against someone changing
 * the Git-managed policy itself. Terraform owns provider operations and locking.
 * @see infra/modules/a2a-agents/main.tf
 * @see scripts/agyn-terraform.mjs
 */
import { z } from "zod";

const uuid = z.string().uuid();
const profileId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const profilesSchema = z.array(z.object({ id: profileId, agentId: uuid }).strict()).min(1).max(100);
const addressPattern = /^module\.agents\.agyn_agent\.profile\["([A-Za-z0-9_-]{1,128})"\]$/;

/** Existing definitions are immutable here: edits require a new versioned profile. */
export function reviewAgentPlan(plan, { allowCreate = false } = {}) {
  if (plan.format_version !== "1.2" || plan.complete !== true || plan.errored !== false ||
      !Array.isArray(plan.resource_changes) || !plan.resource_changes.length ||
      (plan.deferred_changes?.length ?? 0) || (plan.checks ?? []).some(check => check.status !== "pass")) {
    throw new Error("A complete, successful Terraform plan with passing checks is required");
  }
  if ((plan.resource_drift ?? []).some(item => JSON.stringify(item.change?.actions) !== '["no-op"]')) {
    throw new Error("Remote drift requires explicit reconciliation before apply");
  }
  const summary = { imports: [], creates: [], unchanged: [] };
  const seen = new Set();
  for (const item of plan.resource_changes) {
    const match = addressPattern.exec(item.address);
    if (!match || item.type !== "agyn_agent" || item.mode !== "managed" || item.deposed ||
        item.provider_name !== "registry.terraform.io/agynio/agyn" || seen.has(item.address)) {
      throw new Error("Only unique agent definitions in module.agents are permitted");
    }
    seen.add(item.address);
    const action = JSON.stringify(item.change?.actions);
    if (action === '["no-op"]') {
      if (item.change.importing) {
        uuid.parse(item.change.importing.id);
        if (item.change.after?.id !== item.change.importing.id) throw new Error("Import identity mismatch");
        summary.imports.push(item.address);
      } else summary.unchanged.push(item.address);
    } else if (action === '["create"]' && allowCreate && !item.change.importing && /-v[1-9][0-9]*$/.test(match[1])) {
      uuid.parse(item.change.after?.environment_id);
      summary.creates.push(item.address);
    } else {
      throw new Error("Refusing updates, deletion, replacement or an unapproved/unversioned create");
    }
  }
  return summary;
}

/** Terraform outputs must contain only the public profile-to-agent bindings. */
export function terraformProfiles(outputs) {
  const output = outputs.a2a_profiles;
  if (!output || output.sensitive !== false) throw new Error("Nonsecret a2a_profiles output is required");
  return validateProfiles(output.value);
}

function validateProfiles(value) {
  const profiles = profilesSchema.parse(value);
  if (new Set(profiles.map(p => p.id)).size !== profiles.length ||
      new Set(profiles.map(p => p.agentId)).size !== profiles.length) throw new Error("Duplicate profile or agent identity");
  return profiles;
}

/** Render a candidate configuration without deleting or repointing existing profiles. */
export function mergeTerraformProfiles(config, profiles) {
  const before = validateProfiles(config.profiles);
  const after = validateProfiles(profiles);
  const byId = new Map(after.map(p => [p.id, p.agentId]));
  for (const old of before) {
    if (byId.get(old.id) !== old.agentId) throw new Error("Existing A2A profiles cannot be removed or repointed");
  }
  if (!byId.has(config.defaultProfile)) throw new Error("Default profile is unavailable");
  return { ...config, profiles: after };
}
