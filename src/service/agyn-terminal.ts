// SPDX-License-Identifier: AGPL-3.0-only
import WebSocket from "ws";
import { z } from "zod";

type Binding = { executionId: string; instanceId: string; workloadId: string; runtimeSha256: string };

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
    let input = "", bytes = 0, ready = false, acknowledged = false, finished = false;
    const finish = (ok: boolean) => {
      if (finished) return;
      finished = true;
      bounded.removeEventListener("abort", abort);
      socket.terminate();
      if (ok) resolve(); else reject(new Error("Agyn reporting delivery failed"));
    };
    const abort = () => finish(false);
    bounded.addEventListener("abort", abort, { once: true });
    socket.on("error", abort);
    socket.on("close", abort);
    socket.on("open", () => socket.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 })));
    socket.on("message", (data, binary) => {
      try {
        const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
        bytes += buffer.length;
        if (bytes > 32768) throw new Error("terminal output limit");
        if (!binary) {
          const frame = JSON.parse(buffer.toString());
          if (frame.type === "exit") finish(acknowledged && (frame.code ?? 0) === 0 && frame.reason === "completed");
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
            for (let offset = 0; offset < content.length; offset += 16_384) socket.send(content.subarray(offset, offset + 16_384), { binary: true });
          } else {
            z.object({ executionId: z.literal(expected.executionId), instanceId: z.literal(expected.instanceId),
              reportingConfigured: z.literal(true) }).strict().parse(JSON.parse(line));
            acknowledged = true;
          }
        }
      } catch { finish(false); }
    });
  });
}
