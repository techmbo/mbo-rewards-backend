/**
 * Pointer 20 — Sync observability tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SYNC_OBS_STATUS,
  inferJobType,
  normalizeSyncObsStatus,
  rollupIngestCounters,
  rollupRawPayloadOutcomes,
  resolveTerminalStatus,
  toSyncObservabilityDto,
} from "../src/modules/networkOps/syncObservability.contract.js";
import { SourceObjectSyncService, resultRows } from "../src/modules/networkOps/sourceObjectSync.service.js";
import { SYNC_RUN_STATUS } from "../src/modules/networkOps/syncRun.contract.js";

function memoryPrisma() {
  const rows = [];
  return {
    rows,
    networkSyncRun: {
      create: async ({ data }) => {
        const row = { ...data };
        rows.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const idx = rows.findIndex((r) => r.id === where.id);
        if (idx < 0) throw new Error("run not found");
        rows[idx] = { ...rows[idx], ...data };
        return rows[idx];
      },
      findUnique: async ({ where }) => rows.find((r) => r.id === where.id) ?? null,
      findMany: async () => [...rows],
      count: async () => rows.length,
    },
  };
}

describe("Pointer 20 — syncObservability.contract", () => {
  it("normalizes legacy statuses to contract values", () => {
    assert.equal(normalizeSyncObsStatus("STARTED"), SYNC_OBS_STATUS.RUNNING);
    assert.equal(normalizeSyncObsStatus("SUCCEEDED"), SYNC_OBS_STATUS.SUCCESS);
    assert.equal(normalizeSyncObsStatus("SUCCESS"), SYNC_OBS_STATUS.SUCCESS);
  });

  it("infers job type from source object", () => {
    assert.equal(inferJobType("campaigns"), "CAMPAIGNS");
    assert.equal(inferJobType("conversions"), "CONVERSIONS");
    assert.equal(inferJobType("api_reports"), "REPORTING");
  });

  it("rolls up raw payload outcomes into counters", () => {
    const counters = rollupRawPayloadOutcomes([
      { created: true },
      { duplicate: true, record: { id: "1" } },
      { failed: true },
    ]);
    assert.equal(counters.recordsCreated, 1);
    assert.equal(counters.recordsUnchanged, 1);
    assert.equal(counters.recordsQuarantined, 1);
  });

  it("maps quarantined records to PARTIAL terminal status", () => {
    assert.equal(
      resolveTerminalStatus({ counters: { recordsQuarantined: 2 } }),
      SYNC_OBS_STATUS.PARTIAL,
    );
  });

  it("exposes full observability DTO", () => {
    const dto = toSyncObservabilityDto({
      id: "run-1",
      network: "boostiny",
      networkAccountId: "acc-1",
      sourceObject: "campaigns",
      endpoint: "GET /campaigns",
      status: "STARTED",
      jobType: "CAMPAIGNS",
      recordsFetched: 10,
      recordsCreated: 3,
      recordsUpdated: 2,
      recordsUnchanged: 5,
      retryCount: 2,
      startedAt: new Date("2026-09-01T00:00:00Z"),
      finishedAt: new Date("2026-09-01T00:00:05Z"),
    });
    assert.equal(dto.syncRunId, "run-1");
    assert.equal(dto.status, SYNC_OBS_STATUS.RUNNING);
    assert.equal(dto.recordsFetched, 10);
    assert.equal(dto.sourceEndpointOrReport, "GET /campaigns");
  });
});

describe("Pointer 20 — source object sync observability", () => {
  it("persists RUNNING then SUCCESS with recordsFetched on execute", async () => {
    const db = memoryPrisma();
    const svc = new SourceObjectSyncService({ prisma: db });
    const run = await svc.execute({
      network: "boostiny",
      networkAccountId: "acc-1",
      sourceObject: "campaigns",
      jobType: "CAMPAIGNS",
      checkpointBefore: { from: "2026-08-01", to: "2026-08-31" },
      execute: async () => [{ id: "c1" }, { id: "c2" }],
    });
    assert.equal(run.status, SYNC_OBS_STATUS.SUCCESS);
    assert.equal(resultRows(run).length, 2);
    const stored = db.rows.find((r) => r.id === run.syncRunId);
    assert.equal(stored.jobType, "CAMPAIGNS");
    assert.equal(stored.recordsFetched, 2);
    assert.equal(stored.checkpointBefore.from, "2026-08-01");
  });

  it("finalizeRun accumulates ingest counters", async () => {
    const db = memoryPrisma();
    const svc = new SourceObjectSyncService({ prisma: db });
    const started = await svc.startRun({
      network: "optimise",
      sourceObject: "conversions",
      endpoint: "GET /conversions",
      jobType: "CONVERSIONS",
    });
    const finalized = await svc.finalizeRun(started.identity.sync_run_id, {
      recordsFetched: 5,
      recordsCreated: 2,
      recordsUpdated: 1,
      recordsUnchanged: 2,
    });
    assert.equal(finalized.recordsCreated, 2);
    assert.equal(finalized.status, SYNC_OBS_STATUS.SUCCESS);
  });
});
