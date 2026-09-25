<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Go Parser Setup

Go navigation needs Go 1.21 or newer on `PATH`. The Node adapter builds this
trusted standard-library helper offline into the workspace's private `.cache/`.
It never builds a scanned repository, downloads its modules, runs its generators
or executes its tests. The installed Go toolchain must already support the source
syntax being inspected.

From the A2A checkout root:

```sh
npm run test:code-map:go
npm run test:code-map
npm run code:map -- repos
npm run code:map -- scan --repo daemon
```

The race-enabled helper tests need a working C toolchain. To test without the
race detector, run `go test tooling/code-map/go-parser/main.go
tooling/code-map/go-parser/main_test.go` from the checkout root and report that
reduced scope explicitly.

IPC types, parsing limits, metadata semantics and failure behavior live beside
their owners in [main.go](main.go), with executable cases in
[main_test.go](main_test.go). Invocation/cache policy belongs to
[go-adapter.mjs](../go-adapter.mjs). Inspect those components instead of maintaining
a second protocol or symbol inventory here.

Parser checks are not acceptance of any Agyn package or workload. Follow the
selected fork's local-test guidance before running its tests; native/provider
fixtures require separate authorization.
