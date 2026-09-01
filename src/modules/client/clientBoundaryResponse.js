/**
 * Pointer 23 — HTTP response helper for client / portal surfaces.
 */
import { ok } from "../../core/apiResponse.js";
import {
  assertClientBoundaryPayload,
  applyClientBoundaryContract,
} from "./clientBoundary.contract.js";

const CREDENTIAL_SURFACES = new Set(["credential_rotate", "credential_issue"]);

/**
 * Build a client-safe JSON body (assert + contract metadata).
 */
export function clientBoundaryOk(payload, { surface = "client", allowKeys = [] } = {}) {
  assertClientBoundaryPayload(payload, {
    surface,
    allowKeys: CREDENTIAL_SURFACES.has(surface) ? ["apiKey", ...allowKeys] : allowKeys,
  });
  return applyClientBoundaryContract(ok(payload), { surface });
}

export function sendClientBoundaryJson(res, payload, { surface = "client", status = 200, allowKeys = [] } = {}) {
  const body = clientBoundaryOk(payload, { surface, allowKeys });
  if (status !== 200) res.status(status);
  res.json(body);
}
