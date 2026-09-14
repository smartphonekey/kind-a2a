// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import { AgynRpcError } from "../agyn-client.js";
import { ReportingDeliveryError } from "./agyn-terminal.js";

const stages = z.enum(["input", "environment", "runtime", "ticket", "delivery"]);
const rpcCodes = z.enum(["canceled", "unknown", "invalid_argument", "deadline_exceeded", "not_found", "already_exists", "permission_denied",
  "resource_exhausted", "failed_precondition", "aborted", "out_of_range", "unimplemented", "internal", "unavailable", "data_loss", "unauthenticated"]);
const schema = z.object({ reportingSetupFailed: z.literal(true), stage: stages,
  httpStatus: z.number().int().min(400).max(599).optional(), rpcCode: rpcCodes.optional(),
  deliveryReason: z.enum(["aborted", "socket_error", "closed", "handshake", "remote_exit", "output_limit", "protocol"]).optional(),
  receiverReady: z.boolean().optional(), payloadAttempted: z.boolean().optional(), acknowledged: z.boolean().optional(),
  exitCode: z.number().int().min(0).max(255).optional() }).strict();
export type SetupStage = z.infer<typeof stages>;

export function setupFailure(stage: SetupStage, error: unknown): z.infer<typeof schema> {
  if (error instanceof ReportingDeliveryError) return schema.parse({ reportingSetupFailed: true, stage, ...error.diagnostic });
  return schema.parse({ reportingSetupFailed: true, stage, ...(error instanceof AgynRpcError &&
    Number.isInteger(error.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599 ? {
      httpStatus: error.httpStatus, rpcCode: rpcCodes.safeParse(error.rpcCode).data ?? "unknown"
    } : {}) });
}

// Installer output is untrusted; never copy error messages or arbitrary fields.
export function parseSetupFailure(output: string): z.infer<typeof schema> | undefined {
  if (Buffer.byteLength(output) > 1024) return;
  try { return schema.safeParse(JSON.parse(output)).data; } catch { return; }
}
