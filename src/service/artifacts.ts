// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared artifact projection for stored task snapshots and A2A stream updates.
 * @module
 * @see src/service/task-store.ts
 * @see src/service/a2a.ts
 */
import type { Artifact } from "@a2a-js/sdk";
import type { ExecutionReport } from "./events.js";

/** Namespace the report's artifact ID by execution so later turns cannot collide with earlier artifacts. */
export function taskArtifact(executionId: string, report: Extract<ExecutionReport, { kind: "artifact" }>): Artifact {
  return { artifactId: `${executionId}:${report.artifactId}`, name: report.name, description: "Agent artifact",
    parts: [{ content: { $case: "text", value: report.text }, filename: report.name, mediaType: "text/plain", metadata: {} }],
    metadata: {}, extensions: [] };
}
