// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Executable composition root for the durable store, Agyn worker and authenticated HTTP service.
 * @module
 * @remarks Importing this module starts the service. SQLite and shared admission checks
 * precede listening. The configured setup executable runs without a shell, receives
 * scoped credentials only on stdin, and must exit successfully within the profile's setup deadline with
 * an exact execution/instance acknowledgement and workload ID. Shutdown leaves remote
 * work and durable leases for recovery rather than claiming release.
 * @see src/service/agyn-reporting-installer.ts
 * @see src/service/agyn-gateway-auth.ts
 * @see src/service/worker.ts
 * @see src/service/http.ts
 */
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { TaskState } from "@a2a-js/sdk";
import { agynClientFromEnvironment } from "./agyn-gateway-auth.js";
import { AgynRuntimeDriver } from "./agyn-driver.js";
import { DurableTaskStore } from "./task-store.js";
import { ExecutionWorker } from "./worker.js";
import { createServiceApp } from "./http.js";
import { fileAuthorizer } from "./auth.js";
import { serviceCard } from "./card.js";
import { closeHttpServer } from "./shutdown.js";
import { requireSqliteWalFix } from "./sqlite-runtime.js";
import { parseSetupFailure } from "./setup-diagnostics.js";
import { cloudflareAccessAuthentication, cloudflareAccessSchema } from "./cloudflare-access.js";

const pathSchema = z.string().refine(isAbsolute, "absolute path required");
/** "trusted-local" acknowledges an operator trust boundary; it does not verify agent isolation. */
const schema = z.object({
  environmentProfile: z.literal("trusted-local"),
  dbPath: pathSchema, credentialsFile: pathSchema, reportingSetupExecutable: pathSchema,
  host: z.string().default("127.0.0.1"), port: z.number().int().min(1).max(65535).default(8083),
  publicUrl: z.string().url(), reportingUrl: z.string().url(),
  defaultProfile: z.string().min(1).max(128),
  // Profile limits override the service-wide turn deadline and the reporting setup deadline.
  // Setup covers workload start, including a cold image pull, until the gate acknowledges.
  // A profile's concurrency caps its running tasks within the shared concurrency ceiling.
  profiles: z.array(z.object({ id: z.string().min(1).max(128), agentId: z.string().uuid(),
    concurrency: z.number().int().min(1).max(32).optional(),
    turnTimeoutMs: z.number().int().min(1000).max(43_200_000).optional(),
    setupTimeoutMs: z.number().int().min(20_000).max(600_000).optional() }).strict()).min(1).max(100),
  concurrency: z.number().int().min(1).max(32).default(2),
  httpShutdownGraceMs: z.number().int().min(100).max(60_000).default(5000),
  turnTimeoutMs: z.number().int().min(1000).max(43_200_000).default(600_000),
  // Delete each terminal task's Agyn instance and workspace. The service identity must be
  // allowed to remove instance nicknames; see AgynRuntimeDriver.retire.
  retireTerminalTasks: z.boolean().default(false),
  browser: z.object({ origin: z.string().url(), assetsPath: pathSchema,
    cloudflareAccess: cloudflareAccessSchema.optional() }).strict().optional()
}).strict();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

requireSqliteWalFix(process.versions.sqlite);
const config = schema.parse(JSON.parse(readFileSync(required("A2A_SERVICE_CONFIG_FILE"), "utf8")));
if (!config.profiles.some(profile => profile.id === config.defaultProfile)) throw new Error("default profile is missing");
if (new Set(config.profiles.map(profile => profile.id)).size !== config.profiles.length) throw new Error("duplicate profile");
if (config.profiles.some(profile => (profile.concurrency ?? 0) > config.concurrency)) throw new Error("profile concurrency exceeds the shared concurrency");
const profileConcurrency = new Map(config.profiles.flatMap(profile => profile.concurrency === undefined ? [] : [[profile.id, profile.concurrency] as const]));
const profileLimits = new Map(config.profiles.map(profile => [profile.id, {
  turnTimeoutMs: profile.turnTimeoutMs ?? config.turnTimeoutMs, setupTimeoutMs: profile.setupTimeoutMs ?? 120_000 }]));
if (!statSync(config.reportingSetupExecutable).isFile()) throw new Error("reporting setup executable is missing");
const store = new DurableTaskStore(config.dbPath);
store.assertNotQuarantined();
const client = await agynClientFromEnvironment();
const driver = new AgynRuntimeDriver(client, config.profiles, async (execution, signal) => {
  const limits = profileLimits.get(execution.profileId);
  if (!limits) throw new Error("execution profile is not configured");
  const token = store.issueReportingCredential(execution.id, limits.turnTimeoutMs + 3_600_000);
  const setupSignal = AbortSignal.any([signal, AbortSignal.timeout(limits.setupTimeoutMs)]);
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
      if (code !== 0) {
        const failure = parseSetupFailure(output);
        if (failure) console.error(JSON.stringify({ kind: "reporting.setup_failed", executionId: execution.id, ...failure }));
        reject(new Error("reporting setup failed")); return;
      }
      try {
        const ack = z.object({ executionId: z.literal(execution.id), instanceId: z.literal(execution.runtime!.instanceId),
          workloadId: z.string().uuid(), reportingConfigured: z.literal(true) }).strict().parse(JSON.parse(output));
        resolve({ workloadId: ack.workloadId });
      } catch { reject(new Error("reporting setup did not acknowledge the exact execution binding")); }
    });
    child.stdin.end(JSON.stringify({ executionId: execution.id, ...execution.runtime,
      requestId: execution.requestId, retiredRequestIds: store.retiredRequestIds(execution.id),
      setupTimeoutMs: limits.setupTimeoutMs, reporting: { url: config.reportingUrl, token } }));
  });
});
const stopping = new AbortController();
const worker = new ExecutionWorker(store, driver, { concurrency: config.concurrency, profileConcurrency, leaseMs: 60_000, pollMs: 1000,
  turnTimeoutMs: config.turnTimeoutMs, retireTerminalRuntimes: config.retireTerminalTasks,
  profileTurnTimeoutMs: new Map([...profileLimits].map(([id, limits]) => [id, limits.turnTimeoutMs])),
  onError: event => console.error(JSON.stringify({ kind: "worker.error", ...event })),
  // Log every deletion of a terminal task's instance and workspace; the A2A task record stays.
  onRetired: event => console.log(JSON.stringify({ kind: "runtime.retired", ...event, state: TaskState[event.state] })) });
const server = createServer(createServiceApp({ store, card: serviceCard(config.publicUrl), profileId: config.defaultProfile,
  profiles: config.profiles.map(({ id }) => ({ id, card: serviceCard(config.publicUrl, id) })),
  authorize: fileAuthorizer(config.credentialsFile), signal: stopping.signal,
  ...(config.browser ? { browser: { origin: config.browser.origin, assetsPath: config.browser.assetsPath,
    ...(config.browser.cloudflareAccess ? { authentication: cloudflareAccessAuthentication(config.browser.cloudflareAccess) } : {}),
    profiles: config.profiles.map(({ id }) => ({ id })) } } : {}) }));
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
  // Stop local scheduling immediately, but allow accepted reporting requests to commit.
  // The durable leases remain owned until expiry; HTTP drain is not provider fencing.
  await Promise.all([closeHttpServer(server, config.httpShutdownGraceMs), worker.stop()]);
  store.close();
};
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
server.once("error", async () => { await shutdown(); process.exitCode = 1; });
