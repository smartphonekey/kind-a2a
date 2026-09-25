> Archived documentation snapshot from `53eae79` (2026-09-25).
> Results and commands retain their original scope; this is not a current runbook.
> See [current documentation](../../../README.md) and [production gates](../../../PRODUCTION.md).

# Native Runner Control Transport

Status: independent source and subprocess acceptance passed on 2026-09-14.
This change is not installed and does not establish production authentication,
backend-incarnation binding or a deployed A2A lifecycle acceptance.

## Finding And Fix

The runner originally registered its full RunnerService on one gRPC server and
served that same server on both TCP and OpenZiti listeners. Enabling Ziti did
not restrict the plaintext TCP API, including while enrollment was pending.
A caller able to reach that port could bypass the overlay's service-access
policy. This is an application-level finding; existing network restrictions
may prevent particular workloads from reaching that port.

The independent [runner contribution](https://github.com/spk-ai/k8s-runner/tree/fix/ziti-control-listener)
is based on upstream `baadc75`, verified against upstream main before starting.
Production change `c5c467e` and fixture-guard follow-up `d0ef963`:

- Use separate TCP and control gRPC servers when `ZITI_ENABLED=true`.
- Allow only the exact unary `RunnerService.Ready` method on TCP; other
  registered unary methods and all streams return `Unauthenticated`. The
  allowlist does not trust request headers, method-name suffixes or agent input.
- Continue serving the full API on the OpenZiti listener. Existing
  [Dial and Bind policies](https://netfoundry.io/docs/openziti/learn/core-concepts/security/authorization/policies/overview/)
  determine which identities may access or provide that service.
- Apply the restriction before enrollment, and stop both servers on startup
  failure. TCP health probes remain possible. Their success is not proof of
  successful enrollment, an available terminator or the expected storage backend.
- Preserve existing standalone behavior when `ZITI_ENABLED=false`. That mode
  remains plaintext and is not made safe for untrusted agents by this patch.

There is no new RPC, secret format, bypass flag, A2A controller/workflow change
or model-specific behavior. Clients using direct TCP against a Ziti-enabled
runner must migrate before rollout. Disabling Ziti is not a secure workaround;
production must require the intended profile and audit all callers.

## Verification

Evidence is private in `.state/agyn-runner-transport-zYvx1k/`:

- `transport-before.jsonl` reproduces the bypass: plaintext requests reached
  the workload-start and exec probe handlers. Both anonymous and forged-metadata
  cases failed the new transport tests before the restriction was added.
- `startup-before.jsonl` reproduces volume inventory access through the actual
  startup path before enrollment completed. Its independent fake Kubernetes
  client recorded access, and the child-process assertion failed as expected.
- `runner-race-final.jsonl`: all **152 tests** including subtests pass on the
  independent branch under the race detector. The child helper skips direct
  invocation and is executed by its parent fixture. Build and vet also pass.
- `transport-repeat-final.jsonl`: ten repetitions of the transport/startup
  suite pass, yielding **400 passing test entries** with no failures or skips.
- `combined-runner-race-final.jsonl`: all **386 tests** including subtests pass
  on lab-only combination `28d77ea`, built from checked runner `3c461c5` and the
  transport patch, using API proposal `ec2bfed`. This includes plaintext
  rejection of `RemoveVolumeChecked` for anonymous and forged-metadata callers.
  Build and vet also pass. The four opt-in Kubernetes fixtures were not enabled;
  the child helper is launched only by its parent test.

The tests use real loopback gRPC connections, enumerate the generated service's
unary and streaming methods, and register a future service with a misleading
`Ready` method to check default denial. Positive controls verify the control
listener and standalone mode still forward unary and streaming calls.

The startup fixture launches a separate OS process through the production
startup path, replacing only the Kubernetes client constructor. Its loopback
Gateway stub holds enrollment while the TCP probes run, then refuses enrollment.
The test joins the process and observes connection refusal on the old TCP port.
The child receives no inherited environment and additionally requires the exact
fixture token/namespace/Ziti mode and explicit loopback endpoints. No real
cluster, provider credential, model, overlay enrollment or deployment is used.

The combined branch is an acceptance artifact, not an upstream PR that bundles
all earlier proposals. The independent contribution retains the repository's
existing license. Both branches are pushed; no upstream PR was opened for them.

## Remaining Work

- Audit actual runner Dial/Bind policies, authorized callers and old direct-TCP
  consumers. Verify real overlay operation, revocation/reconnection and failure
  behavior in a controlled deployment before the coordinated A2A sweep.
- Bind volume inventory, immutable bindings, deletion requests and absence
  responses to the correct runner and backend/namespace incarnation. An
  authenticated connection to the wrong or replaced backend is insufficient.
- Fence late starts/deletes and partitioned nodes. Listener restrictions do not
  stop an already-issued backend operation or establish physical workload absence.
- Complete explicit legacy reconciliation, all-writer draining and compatible
  migrations/clients, together with the other [production gates](PRODUCTION.md).

No installed service, policy, task volume, database or credential was changed
by this work. The earlier CNI and live lifecycle evidence retains its original
scope; it is not new acceptance of this transport change.
