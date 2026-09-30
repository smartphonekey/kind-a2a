// SPDX-License-Identifier: AGPL-3.0-only
/** Bounded HTTP drain; no claim about remote execution or compute release. @module */
import type { Server } from "node:http";

/** Stop accepting connections; let accepted reports finish before forcing stuck HTTP connections closed. */
export async function closeHttpServer(server: Server, graceMs: number): Promise<void> {
  if (!Number.isSafeInteger(graceMs) || graceMs < 1) throw new Error("HTTP shutdown grace must be a positive integer");
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => server.closeAllConnections(), graceMs);
    server.close(error => {
      clearTimeout(deadline);
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
    server.closeIdleConnections();
  });
}
