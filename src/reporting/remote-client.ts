// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Relay reports through official Streamable HTTP MCP and read execution status.
 *
 * @module
 * @remarks The private binding is reloaded per operation for credential rotation.
 * Report delivery errors are ambiguous: callers may retry the same report, but
 * must not infer that the underlying work was unperformed.
 * @see src/reporting/config.ts
 * @see src/reporting/mcp.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { reportingConfig } from "./config.js";
import type { ReportingClient } from "./mcp.js";
import { reportSchema } from "../service/events.js";

/**
 * Construct a lazy client with no cached bearer or persistent MCP session.
 * Each report opens/closes a transport and validates its structured receipt;
 * status uses authenticated HTTP. Redirects fail, individual MCP fetches are
 * bounded to ten seconds and status to five; no application retry is added.
 * Errors are for trusted callers to sanitize before exposing them to an agent.
 */
export function remoteReportingClient(configFile: string): ReportingClient {
  return {
    async report(event) {
      const config = reportingConfig(configFile);
      const client = new Client({ name: "execution-reporting-relay", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(`${config.url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${config.token}` }, redirect: "error" },
        fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(10_000)]) })
      });
      try {
        await client.connect(transport);
        const { kind, ...args } = event;
        const result = await client.callTool({ name: `report_${kind}`, arguments: args });
        if (result.isError) throw new Error("report was not acknowledged");
        return z.object({ executionId: z.string().min(1), sequence: z.number().int().positive(), duplicate: z.boolean() }).parse(result.structuredContent);
      } finally { await client.close(); }
    },
    async status() {
      const config = reportingConfig(configFile);
      const response = await fetch(`${config.url}/status`, { headers: { authorization: `Bearer ${config.token}` },
        redirect: "error", signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("execution status unavailable");
      return z.object({ executionId: z.string().min(1), phase: z.string(), canceled: z.boolean(),
        outcome: reportSchema.options[1].nullable() }).parse(await response.json());
    }
  };
}
