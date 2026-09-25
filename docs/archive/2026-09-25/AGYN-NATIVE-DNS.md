> Archived documentation snapshot from `53eae79` (2026-09-25).
> Results and commands retain their original scope; this is not a current runbook.
> See [current documentation](../../../README.md) and [production gates](../../../PRODUCTION.md).

# Native Agent DNS Interception

Status: the resolver bypass is reproduced with the actual native Claude CLI.
The focused fix and prepared-compatible integration are pushed. The local
orchestrator has been upgraded and all five lifecycle scenarios pass for both
Claude and Codex with the stock proxy, plus a separate Claude diagnostic
parallel run. All fixtures are stopped and cleanup is verified.
This does not establish production readiness or explain every historical 401.

## Reproduction

Ziti-enabled Pods previously listed both `127.0.0.1` and `10.43.0.10` as DNS
servers. An ordinary nameserver is not a safe fallback for intercepted names:
[musl queries configured resolvers in parallel](https://wiki.musl-libc.org/functional-differences-from-glibc.html#Name-Resolver/DNS).
The installed Claude runtime bundles musl. A test of that exact CLI, rather than
an inference from a Node or TLS probe, confirms it can select the ordinary answer.

The opt-in `TestNativeDNSInterception` is in `spk-ai/agynd-cli`, branch
`lab/native-dns-interception`, commit `a874280`. It uses native Claude `2.1.225`
from runtime digest `c431db3091a76154ff6be7620f54204fffe30555f1f14adf182b9140c325deb4`.
Two loopback DNS servers return different loopback addresses. Fake HTTP API
servers distinguish intercepted requests (HTTP 400) from bypass requests
(HTTP 401). The test supplies a synthetic key, no provider credential, and
disables tools and external traffic. No model executes.

| Configuration | Primary queries | Secondary queries | Intercepted model requests | Bypass model requests | Native result |
| --- | --- | --- | --- | --- | --- |
| Both resolvers; primary delayed 300 ms | 2 | 2 | 0 | 1 | HTTP 401 |
| Only the delayed primary | 2 | 0 | 2 | 0 | HTTP 400 |
| Only an unavailable primary | 10 | 0 | 0 | 0 | Turn returns an error |

All three assertions and cleanup checks pass. The mixed case is a successful
reproduction of the bug, not a passing routing configuration. The unavailable
control proves no model request reaches either endpoint when DNS cannot answer.
The test intentionally skips outside its explicit native fixture gate.

Private evidence directories are `agyn-native-dns-live-MGGRH7`,
`agyn-native-dns-live-s7VFmn` and `agyn-native-dns-live-eZQRKn` under `.state/`.
Each retained all 83 pre-existing PVC identities/specs/phases and five platform
Deployment specs. All fixture Pods and policies were removed.

## Focused Fix

`spk-ai/agents-orchestrator`, `fix/workload-dns-interception`, commit `204b5e9`,
is based on upstream `ae7d0bf` (`v0.23.0`). It changes only Ziti-enabled agent and
sandbox DNS plus the readiness wait to use the local resolver alone. The
tunneler keeps its explicit upstream for ordinary names and control-plane
bootstrap; enrollment DNS and Ziti-disabled behavior are preserved. Existing
Pods are not rewritten.

Agent, sandbox and wait regressions fail before the fix and pass afterward.
The clean focused tree passes 261 ordinary test entries and build; all 61
assembler race entries pass. The broader selected race run passes 260 entries
with exactly `TestGroupMembershipConsumerLoopRetriesWithoutBlocking` excluded.
Unfiltered vet still reports the existing self-assignment in `start_decision.go`.
Generated API churn is excluded from the contribution.

The separate integration branch `lab/prepared-native-dns`, `c932293`, applies
the same fix on prepared-workload source `754e935`, preserving its lifecycle
contracts. It passes 601 ordinary entries and 600 selected race entries. Five
opt-in native/process fixture entries skip when their gates are not supplied;
the same known race test is excluded. `go vet -assign=false ./...` passes, not
unfiltered vet. These counts do not claim a fresh combined crash-fixture sweep.
Both branches are pushed; neither has an upstream PR.

## Retained Local Rollout

Private operator evidence is `.state/agyn-native-dns-fix-urLgza`. Only the
orchestrator image changes, to:

```text
docker.io/library/a2a-agyn-orchestrator@sha256:7042faa8a77fecf7ca6642d5996796e16e3dfd88cc66b4da67687563b0e7df4b
```

The static binary records clean source `c932293` and has SHA-256
`5dbe44bd4350fe0652ff0a19d21e44cf58620a27b776942b89d09a384ccf8579`.
Its credential-free, network-disabled image smoke test reaches the expected
missing-configuration error. The running Kubernetes binary matches that hash.
Deployment UID/spec checks allow only the image replacement; the old Pod is
confirmed absent before dispatch. All other prepared services and schema through
`0022` remain intact, with all 83 existing task claims unchanged. Preflight
verifies 57 RBAC probes and zero task Pods/unconfirmed removals.

The focused old-baseline image must not replace the prepared-compatible stack.
The earlier [Claude report](AGYN-PREPARED-CLAUDE.md) remains the record of the
failing parallel attempts. The fresh matrices below verify the new image;
no failed user task is automatically replayed.

## First Real-Agent Result

Claude parallel/FIFO passed at 22:58 UTC on 2026-09-14, using fresh tasks and
the request-diagnostic proxy. Evidence is `agyn-reporting-live-7A2qFF`.
It verifies distinct instances/workspaces/native sessions, authenticated
execution-scoped reporters, cross-task reporter rejection, network isolation,
continued progress in the second task while the first resumes in a new Pod,
FIFO admission after confirmed release, and final compute removal.

There are 20 proxied Messages responses, all HTTP 200/SSE: 13 for instance
`5647af4b-4817-48ad-bca0-2912b5151bf1` across its two Pods and seven for
`ff71ff5a-5efd-475c-97bb-7892040d9ba5`. The 58 request-metadata records contain
no model authentication refusal or SSE error. Non-model 404/304 responses are
not represented as successful model calls. Fifty-nine separate read-only route
samples across all three Pods verify exactly one resolver in both the Pod spec
and the runtime file, successful ordinary cluster DNS forwarding, and a trusted
Agyn egress certificate. Those probes send no application bytes and are
corroboration, not substitutes for native model-request evidence.

The diagnostic proxy was restored before the additional lifecycle matrix. No
provider credential was changed between the diagnostic and stock-proxy runs.

## Claude Stock-Proxy Matrix

All five scenarios pass on the DNS-fixed prepared stack with stock LLM proxy
`0.14.0`, native Claude `2.1.225` and model `claude-sonnet-5`. The A2A controller
and workflows are unchanged. Times below are UTC on 2026-09-14; each process
exited zero and completed cleanup before the next scenario started.

| Scenario | Time | Prepared workloads removed | Private evidence directory |
| --- | --- | --- | --- |
| Parallel/FIFO repeat | 23:00-23:04 | 3 | `agyn-reporting-live-kOICEo` |
| Completed-turn continuation | 23:04-23:06 | 2 | `agyn-reporting-live-bBm1H3` |
| Interrupted-turn recovery | 23:06-23:11 | 3 | `agyn-reporting-live-Cd41DG` |
| Cancellation | 23:11-23:13 | 1 | `agyn-reporting-live-CbWMDt` |
| Blocking/streaming continuation | 23:13-23:16 | 2 | `agyn-reporting-live-i4SMvw` |

Completed continuation retains native session
`de2525d1-d6e7-4ee5-9c9a-a4b4c2af9a27`; interrupted continuation retains
`0ae3c2f7-0f2b-4632-9f7f-3a87d8dc71d9`. Both keep their exact workspace
identity across Pod replacement. The interrupted append remains one line and
the old inbox record is explicitly retired as `ack_only`; it is not a safe-retry
inference from restored thread metadata. Cancellation settles in 11.569 seconds
after the request, with deletion observed, stopped heartbeat and no late write.
Streaming's duplicate blocking request waits 157.169 seconds; both official-SDK
streams record nine observations and survive the two-second idle subscription
window and Pod replacement. Completed and streaming cases each record a real
native Stop reminder followed by the MCP outcome.

`claude-evidence-summary.json` revalidates all 14 exact Pod/PVC removal bindings
across the six runs, including the diagnostic parallel run. Cleanup removes all
six owned attachments, the temporary Claude subscription and its managed secret,
with absence checks. All 81 operator/fixture files pass the provider-byte scan,
and the host credential file is unchanged. No existing workspace is deleted.
These passes address the reproduced resolver path and local lifecycle behavior;
they do not retrospectively classify every historical error or prove sustained
production reliability.

## Codex Regressions

All five scenarios also pass with the same stock proxy and prepared stack,
Codex runtime `0.147.0`, model `gpt-5.5`, and the existing subscription reference.
No provider credential is copied into these fixtures. Times are UTC on
2026-09-14; all processes exit zero with cleanup observed.

| Scenario | Time | Prepared workloads removed | Private evidence directory |
| --- | --- | --- | --- |
| Parallel/FIFO | 23:17-23:22 | 3 | `agyn-reporting-live-iDd4JP` |
| Completed-turn continuation | 23:22-23:24 | 2 | `agyn-reporting-live-6Z8iYb` |
| Interrupted-turn recovery | 23:24-23:28 | 3 | `agyn-reporting-live-JtHjg3` |
| Cancellation | 23:28-23:29 | 1 | `agyn-reporting-live-6a2uBB` |
| Blocking/streaming continuation | 23:29-23:32 | 2 | `agyn-reporting-live-ax3vvf` |

Completed recovery preserves native session
`01a0a23b-a906-7a73-97ef-cfb95898a71a`; interrupted recovery preserves
`01a0a23d-7fc4-7c32-8702-21132b971ec0`. The interrupted side effect remains one
line with explicit inbox retirement. Cancellation settles in 6.545 seconds.
Streaming preserves session `01a0a242-13e5-7882-a07b-59b2317dd1ce`; its blocking
request waits 87.544 seconds and both streams receive nine observations across
the 2.001-second idle subscription window and Pod replacement. Completed and
streaming cases each have a native Stop reminder and acknowledged MCP outcome.

`codex-evidence-summary.json` revalidates all 11 exact prepared removal bindings.
Cleanup removes the five test-environment subscription attachments only; the
shared subscription, secret reference and template attachment are unchanged.
The operator never resolves that shared provider credential.

## Final State

Both matrices and the diagnostic parallel process are terminal: 11 successful
runs, 25 exact prepared workload removals. Read-only `after.json` verifies all
four retained services ready, the stock proxy restored, and unchanged Deployment
UIDs/specs except the reviewed orchestrator image. All 57 permission probes pass;
the old broad RBAC binding remains empty. All 83 prior PVC identities/specs/phases
are preserved, with 97 total retained task PVCs/owner pins, 186 registry workloads
including 61 prepared records, zero unconfirmed removals and zero task Pods.
No temporary network policies, Services or quotas remain. The existing egress
policy remains installed. All 41 platform Deployments are ready.

The service build and 449 tests pass, with no failures/skips. The original
baseline remains intact. The focused orchestrator patch, prepared integration
and native reproduction branches are pushed; no upstream PR is submitted.
This is a verified local correction, not completion of the production gates.

## Operator Fixture

The native fixture's lab branch pins the proposed Claude SDK fork at `54490e0`;
this dependency is not part of the focused orchestrator patch. Generate the
daemon's Gateway APIs as in its development setup, build its Go test binary from
`a874280` with `CGO_ENABLED=0`, and package it with
`ops/Dockerfile.claude-diagnostics`. Load a digest-pinned test image and the
reviewed native runtime into the explicit target cluster, then run:

```sh
AGYN_LIVE_ACCEPTANCE=trusted-local \
AGYN_KUBECONFIG=/absolute/path/to/kubeconfig \
AGYN_NATIVE_DNS_IMAGE='local-test-image@sha256:REPLACE_WITH_DIGEST' \
AGYN_NATIVE_DNS_RUNTIME_IMAGE='reviewed-claude-runtime@sha256:REPLACE_WITH_DIGEST' \
node scripts/agyn-native-dns.mjs mixed
```

Repeat with `single` and `unavailable`. This operator-only script refuses a
non-idle workload namespace and uses only owned emptyDir fixtures, no PVCs or
service-account token. Network policy denies external ingress/egress. The main
container is nonroot, read-only, RuntimeDefault, and drops all capabilities
except `NET_BIND_SERVICE` for loopback DNS port 53. Cleanup confirms exact-UID
Pod removal before removing its policy and verifies unchanged existing storage
and Deployment specs. Evidence contains synthetic test results, not credentials.

## Remaining Boundary

This prevents the reproduced resolver race; it is not enforcement against
custom resolvers, direct IPs, privileged workloads or a hostile repository.
Interception startup, sustained provider reliability, hardened network/sandbox
policy, node/storage/late-operation fencing and the remaining
[production gates](PRODUCTION.md) still require evidence.
