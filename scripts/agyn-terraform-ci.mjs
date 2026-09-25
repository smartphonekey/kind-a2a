// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Fail-closed context checks for automatic application of merged definitions.
 * @module
 * @remarks Environment variables are not authentication. GitHub's protected
 * environment and workflow-restricted, single-job runner enforce that boundary.
 * @see scripts/agyn-terraform.mjs
 * @see .github/workflows/agyn-agents.yml
 */
const repository = "smartphonekey/kind-a2a";
const ref = "refs/heads/main";
const workflow = `${repository}/.github/workflows/agyn-agents.yml@${ref}`;

/** Merge approval replaces the separate plan approval, never the plan policy. */
export function assertAutoApplyContext(env, event, { head, remoteHead, dirty }) {
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "push" ||
      env.GITHUB_REPOSITORY !== repository || env.GITHUB_REF !== ref ||
      env.GITHUB_REF_PROTECTED !== "true" || env.GITHUB_WORKFLOW_REF !== workflow ||
      env.AGYN_AUTO_APPLY_ENABLED !== "true" || !/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? "") ||
      !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? "")) {
    throw new Error("Auto-apply requires the enabled main-push deployment workflow on protected main");
  }
  if (event?.repository?.full_name !== repository || event.ref !== ref ||
      event.after !== env.GITHUB_SHA || event.deleted !== false || event.forced !== false) {
    throw new Error("Refusing an inconsistent, deleted or force-pushed deployment event");
  }
  if (dirty || head !== env.GITHUB_SHA || remoteHead !== env.GITHUB_SHA) {
    throw new Error("Checkout changed or main advanced; this deployment must not apply");
  }
  return { revision: head, run: `https://github.com/${repository}/actions/runs/${env.GITHUB_RUN_ID}` };
}

/** CI uses step-scoped credentials, never the runner's ambient kubeconfig. */
export function autoApplyEnvironment(env) {
  for (const key of ["KUBE_HOST", "TF_VAR_gateway_url"]) {
    const url = new URL(env[key]);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error(`Auto-apply requires a verified HTTPS origin in ${key}`);
    }
  }
  if (!env.KUBE_TOKEN?.trim() || !env.AGYN_API_TOKEN?.trim() ||
      !env.KUBE_CLUSTER_CA_CERT_DATA?.includes("-----BEGIN CERTIFICATE-----") ||
      !env.AGYN_GATEWAY_CA_PEM?.includes("-----BEGIN CERTIFICATE-----")) {
    throw new Error("Auto-apply requires dedicated Kubernetes/Agyn tokens and explicit CA certificates");
  }
  const result = { ...env };
  for (const key of Object.keys(result)) {
    if (key.startsWith("KUBE_") && !["KUBE_HOST", "KUBE_TOKEN", "KUBE_CLUSTER_CA_CERT_DATA"].includes(key)) delete result[key];
  }
  result.KUBE_INSECURE = "false";
  result.KUBE_IN_CLUSTER_CONFIG = "false";
  return result;
}
