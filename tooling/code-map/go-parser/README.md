<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Go Parser Setup

Go navigation needs Go 1.21 or newer on `PATH`, with support for the syntax being
inspected. Install that toolchain before invoking the navigator.

From the A2A checkout root:

```sh
npm run test:code-map:go
npm run test:code-map
```

The race-enabled helper tests need a working C toolchain. To test without the
race detector, run `go test tooling/code-map/go-parser/main.go
tooling/code-map/go-parser/main_test.go` from the checkout root and report that
reduced scope explicitly.

See [main.go](main.go), [its tests](main_test.go) and
[go-adapter.mjs](../go-adapter.mjs) for the implementation contract.

Parser checks are not acceptance of any Agyn package or workload. Follow the
selected fork's local-test guidance before running its tests; native/provider
fixtures require separate authorization.
