// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/agyn-native-dns.mjs", import.meta.url));
const base = {
  AGYN_LIVE_ACCEPTANCE: "trusted-local",
  AGYN_KUBECONFIG: "/a2a-native-dns-missing-kubeconfig",
  AGYN_NATIVE_DNS_IMAGE: `fixture@sha256:${"a".repeat(64)}`,
  AGYN_NATIVE_DNS_RUNTIME_IMAGE: `runtime@sha256:${"b".repeat(64)}`,
};
const cases: { name: string; env: Record<string, string | undefined>; mode: string; error: RegExp }[] = [
  { name: "explicit local opt-in", env: { AGYN_LIVE_ACCEPTANCE: undefined }, mode: "mixed", error: /AssertionError/ },
  { name: "explicit kubeconfig", env: { AGYN_KUBECONFIG: undefined }, mode: "single", error: /explicit kubeconfig required/ },
  { name: "known mode", env: {}, mode: "unknown", error: /AssertionError/ },
  { name: "pinned test image", env: { AGYN_NATIVE_DNS_IMAGE: "fixture:latest" }, mode: "mixed", error: /digest-pinned images required/ },
  { name: "pinned native runtime", env: { AGYN_NATIVE_DNS_RUNTIME_IMAGE: "runtime:latest" }, mode: "unavailable", error: /digest-pinned images required/ },
];
for (const entry of cases) {
  test(`native DNS fixture requires ${entry.name} before opening Kubernetes configuration`, () => {
    const result = spawnSync(process.execPath, [script, entry.mode], {
      encoding: "utf8", timeout: 15000, env: { ...process.env, ...base, ...entry.env },
    });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, entry.error);
    assert.doesNotMatch(result.stderr, /ENOENT|a2a-native-dns-missing-kubeconfig/);
    assert.equal(result.stdout, "");
  });
}
