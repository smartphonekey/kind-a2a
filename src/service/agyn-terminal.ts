// SPDX-License-Identifier: AGPL-3.0-only
import WebSocket from "ws";
import { z } from "zod";
import type { AgynWorkload } from "../agyn-client.js";

export function reportingTargetReady(workload: AgynWorkload): boolean {
  const containers = z.array(z.object({ name: z.string().min(1), role: z.string(), status: z.string().optional() })).parse(workload.containers ?? []);
  const main = containers.filter(container => container.role === "CONTAINER_ROLE_MAIN");
  if (main.length > 1 || new Set(containers.map(container => container.name)).size !== containers.length ||
    containers.some(container => container.name === "main" && container.role !== "CONTAINER_ROLE_MAIN")) {
    throw new Error("ambiguous terminal main container");
  }
  if (main[0]?.status === "CONTAINER_STATUS_TERMINATED") throw new Error("terminal main container terminated");
  // Pod readiness is reported independently of the registry's container list.
  // TerminalProxy requires that list to resolve the main-container alias.
  return main[0]?.status === "CONTAINER_STATUS_RUNNING";
}

type Binding = { executionId: string; instanceId: string; workloadId: string; runtimeSha256: string };
type DeliveryReason = "aborted" | "socket_error" | "closed" | "handshake" | "remote_exit" | "output_limit" | "protocol";
export class ReportingDeliveryError extends Error {
  constructor(readonly diagnostic: { deliveryReason: DeliveryReason; receiverReady: boolean; payloadAttempted: boolean;
    acknowledged: boolean; httpStatus?: number; exitCode?: number }) {
    super("Agyn reporting delivery failed");
    this.name = "ReportingDeliveryError";
  }
}

export async function deliverBinding(ticket: { websocketUrl: string; ticket: string }, expected: Binding,
  payload: string, signal: AbortSignal, allowInsecureLocal = false): Promise<void> {
  const url = new URL(ticket.websocketUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && allowInsecureLocal)) throw new Error("terminal requires TLS");
  if (url.username || url.password || url.hash) throw new Error("invalid terminal URL");
  url.searchParams.set("ticket", ticket.ticket);
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
  bounded.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, { maxPayload: 32768, followRedirects: false, handshakeTimeout: 10_000 });
    let input = "", bytes = 0, ready = false, acknowledged = false, finished = false, payloadAttempted = false;
    const finish = (ok: boolean, deliveryReason: DeliveryReason, metadata: { httpStatus?: number; exitCode?: number } = {}) => {
      if (finished) return;
      finished = true;
      bounded.removeEventListener("abort", abort);
      socket.terminate();
      if (ok) resolve(); else reject(new ReportingDeliveryError({ deliveryReason, receiverReady: ready, payloadAttempted, acknowledged, ...metadata }));
    };
    const abort = () => finish(false, "aborted");
    bounded.addEventListener("abort", abort, { once: true });
    socket.on("error", () => finish(false, "socket_error"));
    socket.on("close", () => finish(false, "closed"));
    socket.on("unexpected-response", (_request, response) => {
      const status = response.statusCode;
      finish(false, "handshake", Number.isInteger(status) && status! >= 400 && status! <= 599 ? { httpStatus: status } : {});
      response.destroy();
    });
    socket.on("open", () => socket.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 })));
    socket.on("message", (data, binary) => {
      try {
        const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
        bytes += buffer.length;
        if (bytes > 32768) { finish(false, "output_limit"); return; }
        if (!binary) {
          const frame = JSON.parse(buffer.toString());
          if (frame.type === "exit") finish(acknowledged && (frame.code ?? 0) === 0 && frame.reason === "completed", "remote_exit",
            Number.isInteger(frame.code) && frame.code >= 0 && frame.code <= 255 ? { exitCode: frame.code } : {});
          return;
        }
        input += buffer.toString();
        while (input.includes("\n")) {
          const end = input.indexOf("\n"), line = input.slice(0, end).trim(); input = input.slice(end + 1);
          if (!ready) {
            z.object({ ready: z.literal(true), instanceId: z.literal(expected.instanceId), workloadId: z.literal(expected.workloadId),
              runtimeSha256: z.literal(expected.runtimeSha256) }).strict().parse(JSON.parse(line));
            ready = true;
            // Raw mode is acknowledged before the first byte of the credential is sent.
            const content = Buffer.from(payload + "\n");
            payloadAttempted = true;
            for (let offset = 0; offset < content.length; offset += 16_384) socket.send(content.subarray(offset, offset + 16_384), { binary: true });
          } else {
            z.object({ executionId: z.literal(expected.executionId), instanceId: z.literal(expected.instanceId),
              reportingConfigured: z.literal(true) }).strict().parse(JSON.parse(line));
            acknowledged = true;
          }
        }
      } catch { finish(false, "protocol"); }
    });
  });
}
