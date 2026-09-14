// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { AgynClient } from "../agyn-client.js";
import { AgynRuntimeDriver } from "./agyn-driver.js";
import { DurableTaskStore } from "./task-store.js";
import { ExecutionWorker } from "./worker.js";
import { createServiceApp } from "./http.js";
import { fileAuthorizer } from "./auth.js";
import { serviceCard } from "./card.js";
import { requireSqliteWalFix } from "./sqlite-runtime.js";

const pathSchema = z.string().refine(isAbsolute, "absolute path required");
const schema = z.object({
  environmentProfile: z.literal("trusted-local"),
  dbPath: pathSchema, credentialsFile: pathSchema, reportingSetupExecutable: pathSchema,
  host: z.string().default("127.0.0.1"), port: z.number().int().min(1).max(65535).default(8083),
  publicUrl: z.string().url(), reportingUrl: z.string().url(),
  defaultProfile: z.string().min(1).max(128),
  profiles: z.array(z.object({ id: z.string().min(1).max(128), agentId: z.string().uuid() }).strict()).min(1).max(100),
  concurrency: z.number().int().min(1).max(32).default(2),
  turnTimeoutMs: z.number().int().min(1000).max(43_200_000).default(600_000)
}).strict();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

requireSqliteWalFix(process.versions.sqlite);
const config = schema.parse(JSON.parse(readFileSync(required("A2A_SERVICE_CONFIG_FILE"), "utf8")));
if (!config.profiles.some(profile => profile.id === config.defaultProfile)) throw new Error("default profile is missing");
if (!statSync(config.reportingSetupExecutable).isFile()) throw new Error("reporting setup executable is missing");
const store = new DurableTaskStore(config.dbPath);
const client = new AgynClient(required("AGYN_GATEWAY_URL"), required("AGYN_TOKEN"), required("AGYN_ORGANIZATION_ID"), required("AGYN_IDENTITY_ID"));
const driver = new AgynRuntimeDriver(client, config.profiles, async (execution, signal) => {
  const token = store.issueReportingCredential(execution.id, config.turnTimeoutMs + 3_600_000);
  const setupSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  return await new Promise<{ workloadId: string }>((resolve, reject) => {
    // The operator owns this executable. Never accept a command, path or credential from A2A messages.
    const child = spawn(config.reportingSetupExecutable, [], { stdio: ["pipe", "pipe", "ignore"], signal: setupSignal, killSignal: "SIGKILL" });
    let output = "";
    child.stdout.on("data", chunk => {
      output += chunk;
      if (Buffer.byteLength(output) > 16384) child.kill("SIGKILL");
    });
    child.on("error", () => reject(new Error("reporting setup failed")));
    child.stdin.on("error", () => {});
    child.once("close", code => {
      if (code !== 0) { reject(new Error("reporting setup failed")); return; }
      try {
        const ack = z.object({ executionId: z.literal(execution.id), instanceId: z.literal(execution.runtime!.instanceId),
          workloadId: z.string().uuid(), reportingConfigured: z.literal(true) }).strict().parse(JSON.parse(output));
        resolve({ workloadId: ack.workloadId });
      } catch { reject(new Error("reporting setup did not acknowledge the exact execution binding")); }
    });
    child.stdin.end(JSON.stringify({ executionId: execution.id, ...execution.runtime,
      requestId: execution.requestId, retiredRequestIds: store.retiredRequestIds(execution.id), reporting: {
      url: config.reportingUrl, token
    } }));
  });
});
const stopping = new AbortController();
const worker = new ExecutionWorker(store, driver, { concurrency: config.concurrency, leaseMs: 60_000, pollMs: 1000,
  turnTimeoutMs: config.turnTimeoutMs, onError: event => console.error(JSON.stringify({ kind: "worker.error", ...event })) });
const server = createServer(createServiceApp({ store, card: serviceCard(config.publicUrl), profileId: config.defaultProfile,
  authorize: fileAuthorizer(config.credentialsFile), signal: stopping.signal }));
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.maxHeadersCount = 100;
server.listen(config.port, config.host, () => {
  worker.start();
  console.log(`A2A development service listening at ${config.publicUrl}; environment profile: ${config.environmentProfile}`);
});
const shutdown = async () => {
  if (stopping.signal.aborted) return;
  stopping.abort();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await worker.stop();
  store.close();
};
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
server.once("error", async () => { await shutdown(); process.exitCode = 1; });
