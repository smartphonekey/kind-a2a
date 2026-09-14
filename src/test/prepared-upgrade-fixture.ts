// SPDX-License-Identifier: AGPL-3.0-only
export const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
export const scope = { postgresPod: "platform-postgres-0", postgresPodUid: id(1), postgresUser: "agyn", runnerId: id(2), namespaceUid: id(3) };
export const migrations = ["0017_workload_removal_confirmation.sql", "0018_checked_volume_lifecycle.sql", "0019_volume_workload_admission.sql",
  "0020_legacy_volume_adoption.sql", "0021_volume_backend_identity.sql", "0022_prepared_workloads.sql"];
export function fixture(upgraded = false) {
  return { registry: { database: "runners", readOnly: "on", isolation: "repeatable read", migrations: upgraded ? [...migrations] : migrations.slice(0, 1),
    volumes: { total: 1, checked: 0, fingerprint: "a".repeat(32) }, workloads: { total: 2, unconfirmed: 0, prepared: 0, fingerprint: "b".repeat(32) },
    runner: { id: scope.runnerId, status: "enrolled" },
    constraints: upgraded ? [["volumes", "volumes_checked_state"], ["volumes", "volumes_checked_backend"], ["workloads", "workloads_preparation_shape"],
      ["runtime_volume_admission_guards", "runtime_prepared_pin"]].map(([table, name]) => ({ table, name, validated: true })) : [],
    triggers: upgraded ? [["volumes", "volumes_checked_lifecycle"], ["volumes", "volumes_workload_admission"], ["volumes", "volumes_legacy_adoption"],
      ["volumes", "volumes_prepared_owner"], ["workloads", "workloads_volume_admission"], ["workloads", "workloads_preparation"],
      ["runtime_volume_admission_guards", "runtime_prepared_pin"]].map(([table, name]) => ({ table, name, enabled: "O" })) : [] },
    pins: { tablePresent: upgraded, total: upgraded ? 1 : 0, prepared: 0, fingerprint: "c".repeat(32) } };
}
export type Fixture = ReturnType<typeof fixture>;
export const output = (f: Fixture) => JSON.stringify(f.registry) + "\n" + JSON.stringify(f.pins) + "\n";
