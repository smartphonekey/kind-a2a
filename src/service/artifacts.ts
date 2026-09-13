// SPDX-License-Identifier: AGPL-3.0-only
import type { Artifact } from "@a2a-js/sdk";
import type { ExecutionReport } from "./events.js";

export function taskArtifact(executionId: string, report: Extract<ExecutionReport, { kind: "artifact" }>): Artifact {
  return { artifactId: `${executionId}:${report.artifactId}`, name: report.name, description: "Agent artifact",
    parts: [{ content: { $case: "text", value: report.text }, filename: report.name, mediaType: "text/plain", metadata: {} }],
    metadata: {}, extensions: [] };
}
