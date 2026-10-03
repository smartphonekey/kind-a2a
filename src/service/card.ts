// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Public discovery metadata for the machine-facing A2A JSON-RPC binding.
 * @module
 * @see src/service/http.ts
 * @see src/service/browser.ts
 */
import { type AgentCard } from "@a2a-js/sdk";

/**
 * Advertise bearer-authenticated text tasks and streaming; browser mounts replace the transport and security scheme.
 * With a profile, the card names that profile's machine endpoint instead of the default-profile /a2a route.
 */
export function serviceCard(publicUrl: string, profileId?: string): AgentCard {
  const endpoint = profileId === undefined ? "/a2a" : `/agents/${profileId}/a2a`;
  return {
    name: "Agyn A2A Execution Service", description: "Isolated, durable Agyn task execution", version: "0.5.0-dev",
    provider: { organization: "AIRA", url: "https://github.com/smartphonekey/kind-a2a" },
    supportedInterfaces: [{ url: `${publicUrl.replace(/\/$/, "")}${endpoint}`, protocolBinding: "JSONRPC", protocolVersion: "1.0", tenant: "" }],
    capabilities: { streaming: true, pushNotifications: false, extensions: [] },
    securitySchemes: { bearer: { scheme: { $case: "httpAuthSecurityScheme", value: {
      scheme: "Bearer", bearerFormat: "opaque", description: "Owner-scoped service credential"
    } } } }, securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"], signatures: [],
    skills: [{ id: "isolated-task", name: "Isolated task execution", description: "Task-specific Agyn instance with durable state and compute release between turns",
      tags: ["agyn", "execution"], examples: [], inputModes: ["text/plain"], outputModes: ["text/plain"], securityRequirements: [] }]
  };
}
