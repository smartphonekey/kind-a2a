<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# A2A Web Workspace

The opt-in `/ui/` app uses React and assistant-ui's native
[`@assistant-ui/react-a2a`](https://www.assistant-ui.com/docs/runtimes/a2a/overview)
runtime. It connects to the same durable execution service as machine clients.
There is no additional agent controller, workflow engine, provider API client,
or chat database in the frontend.

## Run

Use Node 24.21.0 or another version accepted by the service's SQLite guard.
The frontend has a separate lockfile; service-only installations do not need it.

```sh
npm ci
npm --prefix web ci
npm run build
npm run build:web
A2A_SERVICE_CONFIG_FILE=/absolute/path/service.json npm run start:web
```

The launcher loads `AGYN_PROFILE` (default `local`) through the installed `agyn`
CLI. Both `node` and `agyn` must be on `PATH`. It uses the same environment
variables as [the service](SERVICE.md); it does not create environments, attach
provider credentials or change cluster policies. Agent profiles need the
reporting gate, durable native session directories and valid subscriptions.

Add this optional object to the normal service JSON:

```json
{
  "browser": {
    "origin": "http://127.0.0.1:8083",
    "assetsPath": "/absolute/checkout/web/dist"
  }
}
```

Open `http://127.0.0.1:8083/ui/` and sign in with an owner-scoped **A2A service
access token**, not an Agyn, OpenAI or Anthropic token. Its digest must be in the
private `credentialsFile`; see [SERVICE.md](SERVICE.md). Omitting `browser`
preserves the previous machine-only behavior.

The current workstation uses `.state/a2a-web/service.json` and the mode-0600
`.state/a2a-web/access-token`. Its user systemd unit is `aira-a2a-web.service`.
These operator files are ignored by Git. Restarting requires web sign-in again,
but preserves task history. Do not restart during an active execution merely to
rebuild CSS.

For frontend development, `npm --prefix web run dev` rebuilds the static assets
in watch mode. Reload the same service URL; no second origin or development
proxy bypasses the browser authentication boundary.

## Task Semantics

- Agent selection creates a new task. Follow-ups retain the existing task's
  immutable profile, task ID and context ID.
- Each task has its own Agyn instance, workspace and native session. Changing
  tasks or closing a tab only disconnects the browser stream; it does not cancel
  execution or keep compute running between turns.
- Progress and outcomes arrive over SSE. Artifacts download as inert text.
  Server history reloads after refresh or task selection.
- The native runtime has no initial task-ID option. `TaskClient` binds restored
  sends through its public client API and ends the browser stream on a paused
  state. Polling refreshes tasks that ran while their UI was detached.
- Completed, canceled, rejected and failed tasks are read-only. An ordinary
  conversational reply reports `turn_done`; `task_completed` closes it.
- Cancellation stays pending until the service confirms runtime removal.
  Disconnecting a stream is never considered a cancellation receipt.
- Uncertain executions are read-only and require the existing privileged
  reconciliation API. The UI does not grant that privilege or expose reporting
  credentials. Transport failures are never automatically resent.
- New tasks include a bounded first-message title in A2A metadata. Older tasks
  fall back to a task-ID label.

## Browser Boundary

`/web-api/login` exchanges the user's service token for a random, opaque,
HttpOnly, SameSite=Strict cookie. The bearer stays in server memory and is
revalidated on requests and throughout streams. Logout, expiry, revocation and
shutdown invalidate access. Sessions last at most eight hours and are not
persisted; tokens and messages are not stored in localStorage. Machine APIs
still reject browser origins and never accept the cookie.

Every browser route checks the configured Host and Origin. Mutations require
an exact Origin match. Cross-site requests and DNS rebinding hosts are rejected;
no permissive CORS is added. Login attempts, sessions, request bodies and
concurrent requests are bounded. SSE retains backpressure, heartbeats and
disconnect handling. Internal REST errors are sanitized. Markdown does not
enable raw HTML or remote images.

Only loopback origins may use HTTP. Remote access requires an HTTPS origin and
a reverse proxy preserving that Host and disabling streaming-response buffering.
Do not expose this trusted-local setup directly to the public internet: the
existing sandbox and production limitations still apply. This remains a
single-process SQLite service, not a distributed browser session or HA service.

Agyn Pods must reach `reportingUrl`, which can differ from the browser origin.
The workstation uses `http://192.168.5.2:8083/reporting` with explicit
`A2A_ALLOW_INSECURE_LOCAL_REPORTING=true`. The two web-agent IDs have separate
deny-ingress policies and an egress allowance only to that `/32` and TCP port.
The existing cluster policy is unchanged. This does not establish production
network isolation or TLS for reporting.

Claude's subscription uses the current local Max access token. That short-lived
credential must be renewed in Agyn when it expires; the web app does not read
or refresh provider credentials. Provider authentication remains an operator
responsibility, separate from web login.

## Tests

```sh
npm test
npm exec --prefix web -- playwright install chromium
npm run test:web
```

Browser tests start a separate model-free fixture on port 8094 with the real
HTTP service, SQLite store, worker, assistant-ui runtime and REST/SSE binding.
They never load Agyn/provider credentials. Desktop/mobile cases cover refresh,
same-task follow-ups, parallel profiles, task switching, artifacts, cancellation,
interrupted-task lockout and logout. Screenshots and traces are under ignored
`web/test-results/`.

The application and browser boundary are AGPL-3.0-only. The displayed avatar is
from [Agyn's GitHub organization](https://github.com/agynio); it remains Agyn's
branding and is not relicensed. Third-party packages retain their own licenses.
This is a local integration, not an official Agyn UI.

## Local Acceptance

On 2026-09-15, Codex and Claude each passed two real browser turns: write a
unique workspace file, report an artifact/outcome, release compute, reload the
page and read the original file through the same task. Each task retained one
instance/thread and used two different workloads. Their executions overlapped.
The final cluster observation found zero task Pods, all 105 prior PVCs preserved,
52 deployment specifications unchanged and three new retained task PVCs.

The full service suite passed 455 tests, and all eight desktop/mobile browser
tests passed. Read-only screenshots of both real tasks at 320, 390, 1440 and
1920 pixels verified responsive framing with no horizontal overflow.

Private receipts are `.state/a2a-web/live-ui-result-networked.json`,
`live-ui-result-claude-networked.json` and `final-proof.json` in that directory.
These prove UI integration with the retained trusted-local stack, not the
unreleased volume-retirement changes in the separate Agyn worktrees.

Two earlier setup attempts did not pass and were not replayed. The first used a
retained test profile whose subscription attachment had been removed; its
accepted request/paused instance and original `tasks.sqlite` remain quarantined
under `failed-initial-profile-config.json`. No workload was created for it, and
automatic release confirmation remains unresolved. The next attempt created a
Pod but did not acknowledge reporting setup; its task is marked for explicit
reconciliation in the active store. Subsequent tests used new task IDs after
dedicated profiles and the scoped reporting network allowances were configured.
