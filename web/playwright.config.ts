// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  workers: 1,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:8094",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    {
      name: "mobile",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: "node tests/fixture.mjs",
    url: "http://127.0.0.1:8094/healthz",
    reuseExistingServer: false,
  },
});
