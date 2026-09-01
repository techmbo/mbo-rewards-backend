/**
 * Immutable raw payload — exact network return, before mapping.
 * Mapping corrections replay from this row. They never rewrite payload, hash, or body ref.
 */

import { iso } from "../ops/v15FieldContract.js";
import { assertNoSecrets, sanitizeSecretError } from "./networkAccount.contract.js";

export const RAW_BODY_KIND = Object.freeze({
  JSON: "JSON",
  CSV: "CSV",
  FILE: "FILE",
  TEXT: "TEXT",
});

export function cloneRawJson(value) {
  if (value == null) return value;
  if (typeof value !== "object") return value;
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function requestWindowDto(row) {
  const window = row.requestWindow && typeof row.requestWindow === "object" ? row.requestWindow : null;
  const checkpoint = window?.checkpoint ?? row.checkpoint ?? null;
  if (!window && checkpoint == null) return { requestWindow: null, checkpoint: null };
  return {
    requestWindow: window,
    checkpoint,
  };
}

export function toRawPayloadListDto(row) {
  if (!row) return null;
  const { requestWindow, checkpoint } = requestWindowDto(row);
  const dto = {
    rawPayloadId: row.id ?? row.rawPayloadId ?? null,
    id: row.id ?? row.rawPayloadId ?? null,
    network: row.network ?? row.networkSource ?? null,
    networkAccountId: row.networkAccountId ?? null,
    sourceObject: row.sourceObject ?? null,
    endpointOrReport: row.endpointOrReport ?? row.resourceKey ?? null,
    apiVersion: row.apiVersion ?? null,
    syncRunId: row.syncRunId ?? null,
    fetchedAt: iso(row.fetchedAt),
    receivedAt: iso(row.receivedAt),
    requestWindow,
    checkpoint,
    httpStatus: row.httpStatus ?? null,
    payloadHash: row.payloadHash ?? null,
    bodyKind: row.bodyKind || RAW_BODY_KIND.JSON,
    bodyRef: row.bodyRef ?? null,
    hasPayloadText: Boolean(row.payloadText),
    supplier: row.supplier ?? null,
    sourceAccountLabel: row.sourceAccountLabel ?? null,
    resourceKey: row.resourceKey ?? null,
    entityType: row.entityType ?? null,
    externalId: row.externalId ?? null,
    mapperVersion: row.mapperVersion ?? null,
    processingStatus: row.processingStatus ?? null,
    networkSource: row.networkSource ?? null,
    entityId: row.entityId ?? null,
    immutable: true,
  };
  return assertNoSecrets(dto);
}

export function toRawPayloadDetailDto(row) {
  const list = toRawPayloadListDto(row);
  if (!list) return null;
  const errorMessage = sanitizeSecretError(row.errorMessage);
  const dto = {
    ...list,
    payload: row.bodyKind && row.bodyKind !== RAW_BODY_KIND.JSON ? null : cloneRawJson(row.payload),
    payloadText: row.payloadText ?? null,
    metadata: row.metadata ?? null,
    errorMessage,
  };
  return assertNoSecrets(dto);
}
