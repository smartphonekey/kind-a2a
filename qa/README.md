<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# A2A QA Agent

This opt-in profile uses the existing Agyn agent Terraform module and durable
execution-reporting contract. It does not create a second A2A server, deploy an
agent, provision hardware, or certify an application. The source owners are
[profile generation](agent-profile.mjs), [agent instructions](agent-instructions.txt),
[runner](../scripts/qa-runner.mjs) and [Android adapter](../scripts/qa-android.mjs).

## Operator prerequisites

- A reviewed Agyn environment with the existing required reporting setup and
  execution/removal gates. Install this repository's scripts at `/opt/a2a/scripts`
  and Node in its image. Use a separate environment per capability; the profile
  never upgrades a generic Linux worker into a privileged emulator host.
- Isolated ephemeral compute for each trust boundary, CPU/memory/disk quotas,
  bounded network access and no host mounts, container socket, cluster credentials,
  release credentials or ambient production secrets. Recipes and repository build
  hooks execute arbitrary code. Process groups, private output and environment
  filtering are reliability measures, not a security sandbox. A hostile process
  can escape a process group; the environment's removal gate must reap all compute.
- Approved read-only repository access supplied outside prompts and source, plus
  an exact commit, app variant and staging/test tenant. Clone and resolve the
  approved ref before running; never put credentials in clone URLs. The runner
  neither clones repositories nor grants ongoing GitLab access. Review lockfiles,
  package scripts and Gradle wrapper provenance before execution. No cloud build,
  EAS credit use, OTA publish or store submission is part of these recipes.
- Pinned toolchain and browser/SDK images prepared by the operator, with license
  acceptance handled in that preparation. Do not download an arbitrary tool from
  test output. Do not provision or alter host acceleration at task runtime.

For Linux Android workers, confirm [KVM acceleration](https://developer.android.com/studio/run/emulator-acceleration)
and `emulator -accel-check` on the actual host; an ordinary VM or Kubernetes Pod
is not evidence that accelerated emulation works. Select a dedicated supported
host and explicit device access, with operator approval. Android AVDs must be
private/disposable: the adapter wipes the selected AVD. Provision a writable
per-workspace AVD directory and set ANDROID_AVD_HOME in the reviewed recipe;
the runner gives commands a fresh HOME. Share neither AVD storage
nor the adb server with another run. The adapter reserves its host-local emulator
port with an exclusive lock. A hard-killed run can leave that lock: fail closed
until an operator verifies removal of the previous compute/emulator and clears
the reservation. Never infer safe reuse from elapsed time alone. Review [command-line emulator options](https://developer.android.com/studio/run/emulator-commandline).
iOS requires a separate macOS host with [Xcode and Simulator](https://developer.apple.com/xcode/system-requirements/).
There is no iOS execution profile here yet; Linux returns blocked for iOS recipes.
An iOS device/ad-hoc IPA is not a simulator build.

## Prepare a profile and recipe

Generate private Terraform input with actual reviewed UUIDs:

```sh
node qa/agent-profile.mjs web "$ORGANIZATION_ID" "$QA_WEB_ENVIRONMENT_ID" > /private/qa-web.tfvars.json
node qa/agent-profile.mjs android "$ORGANIZATION_ID" "$QA_ANDROID_ENVIRONMENT_ID" > /private/qa-android.tfvars.json
```

These are independent input examples. Merge the generated agent map into the
installation's existing private input; do not replace existing agents or remove
import provenance. Continue through the existing [GitOps plan policy](../scripts/agyn-terraform-policy.mjs)
and [deployment ownership rules](../KUBERNETES.md). Add the resulting profile IDs
and agent IDs to the service through its existing reviewed profile binding.
Public examples contain no installation IDs. Nothing here changes infra or Flux.

Copy and review the [web](recipes/web.example.json) or
[Android](recipes/android.example.json) recipe outside the untrusted checkout.
Examples are templates, not an assertion about a particular application's build.
The web example requires npm and an existing Playwright suite/configuration that
starts its own local server. Adapt it to a pinned pnpm/Yarn project when needed;
review any install scripts before allowing them. Browser binaries must already
be installed. The Android example requires a Gradle instrumentation suite and
must be adapted for the actual variant, APK paths, package/runner and AVD. The
adapter builds debug APKs locally, verifies boot, installs on its own emulator,
and rejects instrumentation failures or zero tests. React Native/Expo projects
may need a different reviewed prebuild, Detox or Maestro recipe; Jest alone does
not establish native UI coverage. Do not substitute production-config builds
for staging just because store submission is disabled.

```sh
node scripts/qa-runner.mjs /private/reviewed-recipe.json /workspace/app
node --test scripts/qa-runner.test.mjs
```

## Evidence and acceptance

The runner returns a private fresh output directory outside the input checkout,
in a sibling `.a2a-qa-runs` directory. Keep the checkout and its sibling state on
the task durable volume, or retain evidence in an approved artifact store.
Apply an operator retention policy. Run state is rejected inside the Git worktree,
including when a command runs from a nested subdirectory. Logs are bounded and may contain app secrets: never
publish them automatically. Explicit repository evidence paths are hashed, not
uploaded or certified as fresh; recipes must remove old test outputs first.
Screenshots, traces, videos, JUnit/XML and APKs remain private. The existing
reporting MCP transports bounded text, not binary files. Share only a sanitized
summary and authorized artifact references before the final acknowledged outcome.

A passed runner means commands exited successfully and requested evidence was
available, not that user journeys or real devices passed. Record exact source and
image revisions, tests/assertions, platform/device/API/browser, target environment,
initial failures and retries, skipped stages and remaining blockers. Cover
interrupted/repeated navigation, cancellation and failure recovery in app suites.
Calling, push, camera/audio, biometrics and manufacturer-specific behavior require
appropriate physical-device acceptance beyond emulator tests.

Unit/process fixtures validate orchestration. Real browser, Android build/boot,
GitLab access, app-specific journeys and hardware acceptance remain separate live
gates under [ACCEPTANCE.md](../ACCEPTANCE.md). No such gate is implicitly run by
adding this profile.
