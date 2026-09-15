// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import { anchoredMigrations } from "../live/anchored-upgrade.js";
import { fixture } from "./prepared-upgrade-fixture.js";

export function anchoredFixture(upgraded = false, pending = false) {
  const base = fixture(true);
  if (upgraded) base.registry.migrations.push(...anchoredMigrations);
  const columns = [["workloads", "resource_anchors"], ["volumes", "resource_anchor"], ["volumes", "anchor_reservation"],
    ["volumes", "anchored_removal_observation"], ["runtime_volume_admission_guards", "resource_anchors_required"]]
    .map(([table, name]) => ({ table, name, type: name === "resource_anchors_required" ? "boolean" : "jsonb",
      nullable: name !== "resource_anchors_required", defaultHash: name === "resource_anchors_required" ? createHash("sha256").update("false").digest("hex") : null }));
  const constraints = [["workloads", "workloads_resource_anchors_shape"], ["volumes", "volumes_resource_anchor_shape"],
    ["volumes", "volumes_anchored_removal_state"], ["runtime_volume_admission_guards", "runtime_resource_anchor_pin"]]
    .map(([table, name]) => ({ table, name, fingerprint: "a".repeat(64) }));
  const triggers = [["workloads", "workloads_resource_anchors"], ["volumes", "volumes_resource_anchor"],
    ["runtime_volume_admission_guards", "runtime_resource_anchor_owner"]].map(([table, name]) => ({ table, name, fingerprint: "b".repeat(64) }));
  const functions = ["guard_resource_anchor_owner", "guard_workload_resource_anchors", "guard_volume_resource_anchor",
    "valid_registry_resource_anchor", "valid_registry_preparation_revocation", "valid_registry_revocation_observation"]
    .map(name => ({ name, arguments: "", fingerprint: "c".repeat(64) }));
  if (upgraded) {
    base.registry.constraints.push(...constraints.map(({ table, name }) => ({ table, name, validated: true })));
    base.registry.triggers.push(...triggers.map(({ table, name }) => ({ table, name, enabled: "O" })));
  }
  if (pending) {
    base.registry.volumes.checked = 1;
    base.registry.workloads.prepared = 2;
    base.registry.workloads.unconfirmed = 1;
    base.pins.prepared = 1;
  }
  return { ...base, recovery: { contract: "resource-anchors-through-0026",
    volumes: { anchored: pending ? 1 : 0, reserved: pending ? 1 : 0, retired: 0, fingerprint: "d".repeat(64) },
    workloads: { anchored: pending ? 2 : 0, revoked: pending ? 1 : 0, observed: 0, fingerprint: "e".repeat(64) },
    pins: { anchored: pending ? 1 : 0, fingerprint: "f".repeat(64) },
    columns: upgraded ? columns : [], constraints: upgraded ? constraints : [], triggers: upgraded ? triggers : [], functions: upgraded ? functions : [] } };
}
export type AnchoredFixture = ReturnType<typeof anchoredFixture>;
export const anchoredOutput = (f: AnchoredFixture) => [f.registry, f.pins, f.recovery].map(value => JSON.stringify(value)).join("\n") + "\n";
