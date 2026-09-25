<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# A2A Web Workspace

The opt-in `/ui/` app uses React and assistant-ui's native A2A runtime with the
same durable execution service as machine clients. The frontend does not own an
additional agent controller, provider API client or chat database.

For the installed app at `http://127.0.0.1:8084/ui/`, use
[Kubernetes access](KUBERNETES.md#access). The host instance below has separate
state and credentials; it is not a replica or failover target.

## Run

Use the Node runtime in `.nvmrc`. The frontend has a separate lockfile;
service-only installations do not need it.

```sh
nvm use
npm ci
npm --prefix web ci
npm run build
npm run build:web
```

Configure the service following [SERVICE.md](SERVICE.md#run-requirements).
Enable its optional browser configuration using the schema in
[main.ts](src/service/main.ts), with the exact browser origin and an absolute
path to the built `web/dist` directory. For a host installation, the usual origin
is `http://127.0.0.1:8083`.

The host launcher requires `node` and the installed `agyn` CLI on `PATH` and an
existing operator login selected by `AGYN_PROFILE` (default `local`). It does not
create environments, attach subscriptions or change cluster policy.

```sh
A2A_SERVICE_CONFIG_FILE=/absolute/private/service.json npm run start:web
```

Open `http://127.0.0.1:8083/ui/` and sign in with an owner-scoped **A2A service
access token**, not an Agyn, OpenAI or Anthropic token. The current workstation's
private host files are `.state/a2a-web/service.json` and the mode-0600
`.state/a2a-web/access-token`; its user unit is `aira-a2a-web.service`.
These operator files stay outside Git. Restarting requires sign-in again, but
must preserve task history. Do not restart active work merely to rebuild CSS.

For frontend development, `npm --prefix web run dev` watches and rebuilds static
assets. Reload the same authenticated service URL; this is not a separate Vite
server or an authentication-bypassing proxy.

## Task Semantics

Browse components before selecting the client and UI contracts:

```sh
npm run code:map -- scan --area web
npm run code:map -- inspect web/src/client web/src/main src/service/browser
```

Task restoration, profile selection, stream handling and UI state rules are
documented next to those implementations and linked tests. Use `--symbol NAME`
or `--source` only for the selected detail. Privileged interrupted-task recovery
remains an [operator procedure](SERVICE.md#recovery-and-operations), not a browser
permission granted by this guide.

## Browser Boundary

Keep browser and machine authentication separate. Do not persist service tokens
in frontend storage or expose provider/subscription credentials through the UI.
Maintain same-origin access; do not add a cross-origin proxy to bypass it.

Only loopback origins may use HTTP. Remote access requires an HTTPS origin and
a trusted reverse proxy preserving the configured Host and disabling streaming
response buffering. Do not expose this trusted-local setup directly to the
public internet. It is not a distributed-session or multi-node HA deployment.

Agyn workloads must independently reach `reportingUrl`. Any insecure local
reporting exception and network allowance is operator policy, not proof of
production TLS or isolation. Provider credential rotation remains separate from
web sign-in; a secret-manager update does not automatically propagate to Agyn.
Cookie, route, request-limit and rendering contracts live in `src/service/browser`
and the web source; security release criteria live in [PRODUCTION.md](PRODUCTION.md).

## Tests

```sh
npm test
npm exec --prefix web -- playwright install chromium
npm run test:web
```

Browser tests use a separate model-free fixture, not provider credentials or the
installed service database. Inspect `web/tests/ui.spec` and `web/tests/fixture`
for cases and setup; screenshots/traces stay in ignored `web/test-results/`.
Passing these tests is not real-provider acceptance.

## Verification Scope

[ACCEPTANCE.md](ACCEPTANCE.md) describes verification procedures and separates
model-free checks from live acceptance. Historical receipts remain behind the
[archive index](docs/archive/README.md), not in current operating instructions.

This is a local integration, not an official Agyn UI. The application/browser
boundary is AGPL-3.0-only; the Agyn avatar and third-party packages keep their own
terms. See [LICENSING.md](LICENSING.md).
