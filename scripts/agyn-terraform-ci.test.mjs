// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertAutoApplyContext, autoApplyEnvironment } from "./agyn-terraform-ci.mjs";

const sha = "a".repeat(40);
const context = () => ({
  env: {
    GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main",
    GITHUB_REF_PROTECTED: "true", GITHUB_REPOSITORY: "smartphonekey/kind-a2a", GITHUB_SHA: sha,
    GITHUB_WORKFLOW_REF: "smartphonekey/kind-a2a/.github/workflows/agyn-agents.yml@refs/heads/main",
    GITHUB_RUN_ID: "42", AGYN_AUTO_APPLY_ENABLED: "true",
  },
  event: { ref: "refs/heads/main", after: sha, repository: { full_name: "smartphonekey/kind-a2a" }, deleted: false, forced: false },
  checkout: { head: sha, remoteHead: sha, dirty: false },
});

test("auto-apply accepts the current protected main push, recording provenance", () => {
  const c = context();
  assert.deepEqual(assertAutoApplyContext(c.env, c.event, c.checkout), {
    revision: sha, run: "https://github.com/smartphonekey/kind-a2a/actions/runs/42",
  });
});

for (const [name, change] of [
  ["local invocation", c => delete c.env.GITHUB_ACTIONS],
  ["pull request", c => c.env.GITHUB_EVENT_NAME = "pull_request"],
  ["pull request target", c => c.env.GITHUB_EVENT_NAME = "pull_request_target"],
  ["workflow dispatch", c => c.env.GITHUB_EVENT_NAME = "workflow_dispatch"],
  ["different branch", c => c.env.GITHUB_REF = "refs/heads/topic"],
  ["fork", c => c.env.GITHUB_REPOSITORY = "untrusted/kind-a2a"],
  ["different workflow", c => c.env.GITHUB_WORKFLOW_REF = "untrusted"],
  ["unprotected main", c => c.env.GITHUB_REF_PROTECTED = "false"],
  ["disabled deployment", c => c.env.AGYN_AUTO_APPLY_ENABLED = "false"],
  ["invalid revision", c => c.env.GITHUB_SHA = "main"],
  ["missing run", c => delete c.env.GITHUB_RUN_ID],
  ["different event repository", c => c.event.repository.full_name = "untrusted/kind-a2a"],
  ["different event branch", c => c.event.ref = "refs/pull/7/merge"],
  ["different event revision", c => c.event.after = "b".repeat(40)],
  ["branch deletion", c => c.event.deleted = true],
  ["force push", c => c.event.forced = true],
  ["different checkout", c => c.checkout.head = "b".repeat(40)],
  ["dirty checkout", c => c.checkout.dirty = true],
  ["outdated job", c => c.checkout.remoteHead = "b".repeat(40)],
]) {
  test(`auto-apply rejects ${name}`, () => {
    const c = context(); change(c);
    assert.throws(() => assertAutoApplyContext(c.env, c.event, c.checkout));
  });
}

const credentials = () => ({
  KUBE_HOST: "https://cluster.example.test", KUBE_TOKEN: "scoped-test-token", AGYN_API_TOKEN: "agyn-test-token",
  KUBE_CLUSTER_CA_CERT_DATA: "-----BEGIN CERTIFICATE-----\ntest", AGYN_GATEWAY_CA_PEM: "-----BEGIN CERTIFICATE-----\ntest",
  TF_VAR_gateway_url: "https://gateway.example.test",
});

test("auto-apply clears ambient Kubernetes credentials and TLS bypasses", () => {
  const env = credentials();
  const result = autoApplyEnvironment({ ...env, KUBE_CONFIG_PATH: "/admin.conf", KUBE_CONFIG_PATHS: "/other.conf", KUBE_INSECURE: "true", KUBE_CLIENT_KEY_DATA: "admin-key", KUBE_IN_CLUSTER_CONFIG: "true" });
  assert.deepEqual(result, { ...env, KUBE_INSECURE: "false", KUBE_IN_CLUSTER_CONFIG: "false" });
});

test("auto-apply requires complete credentials and HTTPS targets", () => {
  for (const key of Object.keys(credentials())) {
    const env = credentials(); delete env[key];
    assert.throws(() => autoApplyEnvironment(env));
  }
  for (const target of ["http://cluster.test", "https://user:password@cluster.test", "https://cluster.test/path", "https://cluster.test?token=secret", "https://cluster.test#fragment"]) {
    assert.throws(() => autoApplyEnvironment({ ...credentials(), KUBE_HOST: target }));
    assert.throws(() => autoApplyEnvironment({ ...credentials(), TF_VAR_gateway_url: target }));
  }
});
