/**
 * Source-evidence context stamped onto RawPayload persist.
 * Lives for one source-object fetch/upsert so mapping never has to guess the 5-tuple.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage();

export function runWithSourceEvidence(evidence, fn) {
  const parent = store.getStore() || {};
  return store.run({ ...parent, ...(evidence || {}) }, fn);
}

export function getSourceEvidence() {
  return store.getStore() || {};
}

export function evidenceFromRunSummary(summary, extras = {}) {
  if (!summary && !Object.keys(extras).length) return extras;
  return {
    network: extras.network ?? summary?.network ?? null,
    networkAccountId: extras.networkAccountId ?? summary?.networkAccountId ?? null,
    sourceObject: extras.sourceObject ?? summary?.sourceObject ?? null,
    endpointOrReport: extras.endpointOrReport ?? summary?.endpoint ?? summary?.endpointOrReport ?? null,
    syncRunId: extras.syncRunId ?? summary?.syncRunId ?? null,
    fetchedAt: extras.fetchedAt ?? new Date(),
    requestWindow: extras.requestWindow ?? null,
    checkpoint: extras.checkpoint ?? null,
    httpStatus: extras.httpStatus ?? null,
    apiVersion: extras.apiVersion ?? null,
  };
}
