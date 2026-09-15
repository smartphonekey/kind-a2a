// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from "vite";

export default defineConfig({
  base: "/ui/",
  server: { strictPort: true },
  build: { sourcemap: false },
});
