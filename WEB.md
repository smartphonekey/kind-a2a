<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# A2A Web Workspace

For the public hostname `https://agents.spkey.co/ui/` and its pending production
origin, use [Kubernetes access](KUBERNETES.md#access). The host instance below has separate
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

The [host launcher](scripts/start-web.sh) requires `node` and the installed `agyn`
CLI on `PATH` and an existing operator login; select its profile with `AGYN_PROFILE`.
Provision the compatible environment and subscription bindings before launching.

```sh
A2A_SERVICE_CONFIG_FILE=/absolute/private/service.json npm run start:web
```

Open `http://127.0.0.1:8083/ui/` and sign in with an owner-scoped **A2A service
access token**, not an Agyn, OpenAI or Anthropic token. The current workstation's
private host files are `.state/a2a-web/service.json` and the mode-0600
`.state/a2a-web/access-token`; its user unit is `aira-a2a-web.service`.
These operator files stay outside Git. Restarting requires sign-in again, but
must preserve task history. Do not restart active work merely to rebuild CSS.

For frontend development, run `npm --prefix web run dev`, then reload the same
authenticated service URL. Do not bypass service authentication with a dev proxy.

## Task Semantics

Client and restoration contracts are in [client.ts](web/src/client.ts),
[main.tsx](web/src/main.tsx) and the [browser router](src/service/browser.ts).
Privileged interrupted-task recovery remains an
[operator procedure](SERVICE.md#recovery-and-operations), not a browser permission
granted by this guide.

## Browser Boundary

Keep browser and machine authentication separate. Do not persist service tokens
in frontend storage or expose provider/subscription credentials through the UI.
Maintain same-origin access; do not add a cross-origin proxy to bypass it.

For the remote workspace, use Cloudflare Access with the existing Google IdP
and only `@smartphonekey.com` accounts. The hostname is `agents.spkey.co`;
see [deployment prerequisites](KUBERNETES.md#cloudflare-access). Do not distribute
the local operator credential to browser users. The [identity adapter](src/service/cloudflare-access.ts)
and [Tunnel definition](infra/cloudflare/main.tf) own the verification contract.

Tasks are private per Access identity. Existing operator-owned tasks are not
automatically reassigned, and recreating an Access user does not transfer their
old tasks. Any ownership transfer needs a separate audited migration. Google
sign-in grants no reconciliation authority or provider credentials.

Access-side revocation is checked at the edge on each request, not by offline
JWT verification. Streams reconnect through the edge at most once per minute;
revocation also depends on Cloudflare's propagation delay. Logout invalidates
the current token locally and uses Cloudflare's logout route, which signs the
user out of other Access applications too. It does not cancel running tasks.

Remote HTTPS does not remove the trusted-local boundary: the connector-to-app
and workload-reporting hops use cluster HTTP. Their NetworkPolicies are not TLS
or hostile-code isolation. This remains a single-node installation, not HA.

Workload reporting access and provider credential rotation remain separate from
web sign-in; follow [service setup](SERVICE.md#run-requirements) and
[deployment credential operations](KUBERNETES.md#credentials-and-recovery).
Security release criteria remain in [PRODUCTION.md](PRODUCTION.md).

## Tests

```sh
npm test
npm exec --prefix web -- playwright install chromium
npm run test:web
```

Keep these checks model-free: do not inject provider credentials or point them
at the installed service database. The [Playwright configuration](web/playwright.config.ts)
selects the [fixture](web/tests/fixture.mjs) and [cases](web/tests/ui.spec.ts).
Passing these tests is not real-provider acceptance; keep screenshots/traces in
ignored `web/test-results/`.

## Verification Scope

[ACCEPTANCE.md](ACCEPTANCE.md) describes verification procedures and separates
model-free checks from live acceptance. Historical receipts remain behind the
[archive index](docs/archive/README.md), not in current operating instructions.

This is a local integration, not an official Agyn UI. The application/browser
boundary is AGPL-3.0-only; the Agyn avatar and third-party packages keep their own
terms. See [LICENSING.md](LICENSING.md).
