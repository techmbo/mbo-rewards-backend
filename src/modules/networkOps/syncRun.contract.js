/**
 * Sync run identity — network + network_account_id + source_object + endpoint/report + sync_run_id.
 * Never put credentials in run DTOs, logs, or error payloads.
 */

import { randomUUID } from "node:crypto";
import { defaultEndpointFor, getSourceObject } from "./sourceObjects.catalog.js";
import { SYNC_OBS_STATUS, toSyncObservabilityDto } from "./syncObservability.contract.js";

export const SYNC_RUN_STATUS = Object.freeze({
  ...SYNC_OBS_STATUS,
  /** @deprecated use RUNNING */
  STARTED: "STARTED",
  /** @deprecated use SUCCESS */
  SUCCEEDED: "SUCCEEDED",
  SKIPPED: "SKIPPED",
  NOT_AVAILABLE: "NOT_AVAILABLE",
});

export function newSyncRunId() {
  return randomUUID();
}

export function buildSyncRunIdentity({
  network,
  networkAccountId,
  sourceObject,
  endpoint = null,
  syncRunId = null,
} = {}) {
  const net = String(network || "").trim();
  const objectKey = String(sourceObject || "").trim().toLowerCase();
  if (!net) throw new Error("sync run requires network");
  if (!objectKey) throw new Error("sync run requires source_object");
  const catalog = getSourceObject(net, objectKey);
  return {
    network: net,
    network_account_id: networkAccountId || null,
    source_object: objectKey,
    endpoint: endpoint || catalog?.endpoint || defaultEndpointFor(net, objectKey),
    sync_run_id: syncRunId || newSyncRunId(),
  };
}

export function syncRunIdentityKey(identity) {
  return [
    identity.network,
    identity.network_account_id || "",
    identity.source_object,
    identity.endpoint,
    identity.sync_run_id,
  ].join("|");
}

export function toSyncRunDto(row) {
  return toSyncObservabilityDto(row);
}
