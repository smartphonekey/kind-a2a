# Claude On The Prepared Agyn Stack

Status: four lifecycle scenarios have passing local evidence; parallel acceptance
and the intermittent native authentication failure remain open. This is not a
production-ready deployment or a passing five-scenario Claude sweep.

## Scope

The retained four-service stack and schema through `0022` are unchanged from
[the Codex rollout](AGYN-PREPARED-ROLLOUT.md#final-retained-verification).
Fixtures use native Claude `2.1.225`, `claude-sonnet-5`, the existing A2A
controller/workflows, prepared workload activation/removal, scoped runner RBAC,
bounded container resources and the existing network checks. No failed task is
redispatched by these operator runs; diagnostic attempts use new task identities.

Private operator evidence is `.state/agyn-prepared-claude-kTmUkz`. Provider
credentials and raw runtime/proxy logs are neither committed nor included in the
public report. Main source is `c3fabfe` for the first five runs, `8cb1862` for
the SSE-only diagnostic attempt and `2099cca` for request diagnostics/streaming.
Those two later commits change diagnostic capture, not execution policy.

## Live Results

All runs below occurred on 2026-09-14 UTC. Each exited and completed its fixture
cleanup; a cleanup success does not turn a failed acceptance into a pass.

| Scenario | Time | Result | Private evidence directory |
| --- | --- | --- | --- |
| Completed-turn continuation | 21:04-21:07 | Pass | `agyn-reporting-live-hRcoq9` |
| Interrupted recovery, first attempt | 21:08-21:09 | Native 401 before fault injection | `agyn-reporting-live-ySlcXN` |
| Interrupted recovery, fresh task | 21:15-21:19 | Pass | `agyn-reporting-live-M5PZFv` |
| Cancellation | 21:20-21:21 | Pass | `agyn-reporting-live-Q4bPp4` |
| Parallel/FIFO, HTTP diagnostics | 21:22-21:24 | Native 401 | `agyn-reporting-live-TbDMZ6` |
| Parallel/FIFO, SSE diagnostics | 21:46-21:48 | Native 401 | `agyn-reporting-live-K1JTR5` |
| Parallel/FIFO, request diagnostics | 22:09-22:10 | Native 401 | `agyn-reporting-live-rzGSft` |
| Blocking/streaming continuation | 22:12-22:15 | Pass | `agyn-reporting-live-lUeef0` |

Completed continuation retains native session
`6ed282a9-3d78-46e4-a1cc-c8991f5fbd4c` and PVC UID
`2dda3acd-4487-48f3-94aa-9550b1e72ad7` across two removed Pods. Both turns have
real reporting MCP artifacts/outcomes; the first has a native Stop reminder.

Interrupted recovery is a separate proof, not inferred from completed recovery.
Task `20c5ef46-2650-45b9-b81c-e8b7b4119ad7` survives controller SIGKILL and Pod
loss after an unconditional append. The append remains one line, the pending
inbox journal prevents automatic replay, and the gated replacement is inspected
before activation. Follow-up is rejected until explicit reconciliation retires
the old request by acknowledgement only. The same session/workspace then
continues; all three prepared workload removals have exact-identity confirmation.

Cancellation settles in 16.603 seconds after observed Pod deletion. A process
that survives SIGTERM stops advancing its retained heartbeat and produces no
late side-effect file. Follow-up to the canceled task is rejected. This checks
a healthy local cluster, not node-partition or forced-deletion fencing.

Streaming task `75600a7a-9443-46b5-8695-6a520de94ead` keeps native session
`bab1177c-02ac-47b9-a7b1-7fbef0e92e04` and PVC UID
`98bc4414-85bd-43c6-ab2d-9e8631fa55e7` across Pod UIDs
`303c1775-0bba-4627-82cc-0dd507fcf99c` and
`7f5f6560-4e2b-4797-833d-ab4d5c8827f1`. The duplicate blocking call waits
133.968 seconds. Two official-SDK streams each receive nine observations, stay
open through the two-second idle subscription window and replacement, and close
after terminal completion. Both turns release compute and have real MCP
artifacts/outcomes; exact prepared removal confirmations are retained.

## Authentication Evidence

The host login was refreshed before these runs; cleanup verifies that its file
did not change during the sweep. A valid host login is not Agyn acceptance.
Native failures retain typed `terminal_reason=api_error`, `api_status=401` and
daemon exit 1. The subtype can still be `success`, so it is not a success signal.

The first HTTP observer and the later SSE observer found no matching refusal.
Both agents in `K1JTR5` posted progress before one failed, ruling out a simple
claim that every failure occurs before any agent work. The additional request
observer yields a more specific result for `rzGSft`:

- Failed task `ef98d7a2-4345-4826-9221-b393cc86aad3`, instance
  `e8659fc6-2377-4cb6-a848-21fc61fa3dd8`, reports native 401 by its 22:10:27
  exit. It has two non-Messages proxy requests, but no recorded Messages request.
- Its peer instance `d61e3213-96d9-4342-805e-3b2275bbff4b` has four Messages
  requests through the proxy, each returning HTTP 200 and unencoded SSE.
- The subsequent passing streaming fixture has twelve proxied Messages
  requests, all HTTP 200/SSE, across both Pods of its instance.

`request-diagnostic-coverage.json` records 74 log lines / 40,362 bytes from the
same verified, non-restarted proxy Pod: 54 request records, four HTTP 404s, one
HTTP 304 and zero captured SSE errors. This is below every capture limit. It
does not include traffic bypassing the proxy, requests rejected before the
forwarder, TLS/identity failures or redirect intermediates. Routing or a
pre-forwarding failure is an investigation lead, not an established root cause.

Earlier TLS-only probes reached the Agyn Egress CA. Later read-only resolver
samples show both `127.0.0.1` and `10.43.0.10`; those samples did not identify a
native CLI socket. Neither observation proves the failed model request's route.
The next investigation must observe the actual CLI connection and exercise DNS
fallback/overlay startup without exposing provider credentials or replaying work.
Claude's documented proxy/CA configuration is described in the
[official network guide](https://code.claude.com/docs/en/network-config).

## Diagnostic Contributions

`spk-ai/llm-proxy` retains separate review branches:

- `feat/native-refusal-diagnostics`, `17c0f0f`: bounded native HTTP refusals and
  the first declared Anthropic SSE error, keeping actual HTTP status separate
  from the error category. Its 118 selected race entries pass with the known
  gzip test excluded; combined `c47f0e5` passes 121 full race entries.
- Dependent `feat/native-request-diagnostics`, `f4ddd0f`: explicit
  `NATIVE_REQUEST_DIAGNOSTICS=true`, default off. Fixed metadata records appear
  before forwarding and when headers or a transport failure arrive. No raw
  URLs, queries, headers, bodies, models or credentials are logged. Build/vet and
  136 selected race entries pass; combined `ab57552` passes 139 full race entries
  with the separate gzip test correction and no test exclusions.
- Main diagnostic projection/wrapper code passes all 444 service tests with
  zero failures/skips. The Go branches are pushed; no upstream PR is open.

Diagnostics do not change credentials, retries, forwarding or task outcomes.
Existing SSE event buffering and HTTP-200 error-stream metering are separate
hardening work, not fixed by these observers. Enabled request-log volume scales
with traffic and needs operator retention; this is not session analytics.

An initial SSE image was accidentally dynamically linked against host glibc and
could not execute in the Alpine base. The old stock replica stayed ready; the
fixture guard refused dispatch and that image was restored. The corrected image
and the later request image explicitly use `CGO_ENABLED=0`, pass ELF/build-info
checks and a credential-free, network-disabled execution smoke test. Their
running binary hashes were independently checked. Failed packaging receipts
remain retained; the failed rollout is not reported as a successful test.

## Final State

All eight fixture processes are terminal. The stock LLM proxy `0.14.0` is
restored with the same Deployment UID and observed readiness. All eight owned
subscription attachments, the temporary subscription and its managed secret are
removed with absence checks; 122 operator/fixture files pass the provider-byte
scan, and the host credential file is unchanged.

Read-only `after.json` verifies all four retained prepared services ready with
their original Deployment UIDs/digests, 57 permission probes, the empty old broad
RBAC binding and all 72 pre-existing PVC identities/specs/phases unchanged.
There are 83 retained task PVCs/owner pins, 161 registry workloads including 36
prepared records, zero unconfirmed removals and zero task Pods. No existing
workspace was deleted and no old service was restored onto the upgraded schema.

Parallel reliability, native route enforcement, late-operation/node/storage
fencing, credential reconciliation, hardened deployment, load/failover/backup
acceptance and the remaining [production gates](PRODUCTION.md) are still required.
