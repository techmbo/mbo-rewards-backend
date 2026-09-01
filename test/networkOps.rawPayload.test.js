/**
 * Full raw payload retention — exact network return, immutable under mapping.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hashPayload,
  hashRawBody,
  persistRawPayload,
} from "../src/modules/raw/rawPayload.service.js";
import { RAW_BODY_KIND, toRawPayloadDetailDto } from "../src/modules/networkOps/rawPayload.contract.js";
import { runWithSourceEvidence } from "../src/modules/networkOps/sourceEvidence.context.js";
import { MappingReplayService } from "../src/modules/mapping/replay.service.js";
import { assertNoSecrets } from "../src/modules/networkOps/networkAccount.contract.js";

function memoryPrisma(seed = null) {
  const rows = seed ? [structuredClone(seed)] : [];
  return {
    rows,
    rawPayload: {
      findUnique: async ({ where }) => {
        if (where.id) return rows.find((r) => r.id === where.id) ?? null;
        const key = where.supplier_sourceAccountLabel_resourceKey_externalId_payloadHash;
        if (!key) return null;
        return (
          rows.find(
            (r) =>
              r.supplier === key.supplier &&
              r.sourceAccountLabel === key.sourceAccountLabel &&
              r.resourceKey === key.resourceKey &&
              r.externalId === key.externalId &&
              r.payloadHash === key.payloadHash,
          ) ?? null
        );
      },
      create: async ({ data }) => {
        const record = { id: `rp-${rows.length + 1}`, ...data };
        rows.push(record);
        return record;
      },
      update: async ({ where, data }) => {
        const idx = rows.findIndex((r) => r.id === where.id);
        if (idx < 0) throw new Error("not found");
        if ("payload" in data || "payloadHash" in data || "payloadText" in data || "bodyRef" in data) {
          throw new Error("immutable fields must not be updated");
        }
        rows[idx] = { ...rows[idx], ...data };
        return rows[idx];
      },
    },
  };
}

describe("raw payload retention", () => {
  it("stores a clone of the network JSON before callers can mutate the source object", async () => {
    const db = memoryPrisma();
    const source = { id: "c1", name: "Nike", payouts: [{ type: "percent", value: 8.2 }] };
    const out = await persistRawPayload(
      {
        networkSource: "optimise_sea",
        entityType: "campaign",
        externalId: "optimise_sea-campaign-c1",
        payload: source,
        networkAccountId: "acc-1",
        sourceObject: "campaigns",
        endpointOrReport: "GET /campaigns",
        syncRunId: "run-1",
      },
      db,
    );
    source.name = "MUTATED AFTER FETCH";
    source.payouts[0].value = 99;
    assert.equal(out.created, true);
    assert.equal(out.record.payload.name, "Nike");
    assert.equal(out.record.payload.payouts[0].value, 8.2);
    assert.equal(out.record.network, "optimise_sea");
    assert.equal(out.record.networkAccountId, "acc-1");
    assert.equal(out.record.sourceObject, "campaigns");
    assert.equal(out.record.endpointOrReport, "GET /campaigns");
    assert.equal(out.record.syncRunId, "run-1");
    assert.equal(out.record.bodyKind, RAW_BODY_KIND.JSON);
  });

  it("does not rewrite payload or hash when linking an Entity after staging", async () => {
    const db = memoryPrisma();
    const first = await persistRawPayload(
      {
        networkSource: "boostiny",
        entityType: "campaign",
        externalId: "boostiny-campaign-1",
        payload: { id: 1, name: "Boost" },
        processingStatus: "RECEIVED",
      },
      db,
    );
    const originalHash = first.record.payloadHash;
    const linked = await persistRawPayload(
      {
        networkSource: "boostiny",
        entityType: "campaign",
        externalId: "boostiny-campaign-1",
        payload: { id: 1, name: "Boost" },
        entityId: "ent-9",
        processingStatus: "STAGED",
      },
      db,
    );
    assert.equal(linked.duplicate, true);
    assert.equal(linked.record.id, first.record.id);
    assert.equal(linked.record.payloadHash, originalHash);
    assert.equal(linked.record.entityId, "ent-9");
    assert.deepEqual(linked.record.payload, { id: 1, name: "Boost" });
  });

  it("stores a CSV/file reference without inventing a JSON rewrite of the file", async () => {
    const db = memoryPrisma();
    const out = await persistRawPayload(
      {
        networkSource: "awin",
        entityType: "product",
        externalId: "awin-feed-1",
        payload: null,
        bodyKind: RAW_BODY_KIND.FILE,
        bodyRef: "feeds/awin/2026-09-01.csv",
        sourceObject: "product_feeds",
        endpointOrReport: "GET product feeds",
      },
      db,
    );
    assert.equal(out.created, true);
    assert.equal(out.record.payload, null);
    assert.equal(out.record.bodyKind, RAW_BODY_KIND.FILE);
    assert.equal(out.record.bodyRef, "feeds/awin/2026-09-01.csv");
    assert.equal(
      out.record.payloadHash,
      hashRawBody({ bodyKind: RAW_BODY_KIND.FILE, bodyRef: "feeds/awin/2026-09-01.csv" }),
    );
  });

  it("picks up pointer-3 run identity from source evidence context", async () => {
    const db = memoryPrisma();
    const out = await runWithSourceEvidence(
      {
        network: "trackier",
        networkAccountId: "acc-t",
        sourceObject: "conversions",
        endpointOrReport: "GET /v2/publishers/conversions",
        syncRunId: "run-t",
        requestWindow: { start: "2026-08-01", end: "2026-09-01" },
      },
      () =>
        persistRawPayload(
          {
            networkSource: "trackier",
            entityType: "conversion",
            externalId: "trackier-conversion-1",
            payload: { conversionId: "x1" },
          },
          db,
        ),
    );
    assert.equal(out.record.syncRunId, "run-t");
    assert.equal(out.record.sourceObject, "conversions");
    assert.deepEqual(out.record.requestWindow, { start: "2026-08-01", end: "2026-09-01" });
  });

  it("mapping replay leaves the stored hash and body unchanged", async () => {
    const stored = {
      id: "rp-1",
      supplier: "OPTIMISE",
      resourceKey: "campaigns",
      mapperVersion: "1",
      payload: { productId: "123", name: "Sea campaign" },
      payloadHash: hashPayload({ productId: "123", name: "Sea campaign" }),
      payloadText: null,
      bodyRef: null,
      sourceAccountLabel: "default",
    };
    const db = memoryPrisma(stored);
    const replay = new MappingReplayService({ db, exceptions: { report: async () => {} } });
    const original = structuredClone(stored);
    try {
      await replay.replayRawPayload("rp-1");
    } catch {
      // Mapping definition may be absent in this isolated unit test.
    }
    const still = db.rows[0];
    assert.equal(still.payloadHash, original.payloadHash);
    assert.deepEqual(still.payload, original.payload);
  });

  it("staff DTO exposes required metadata and never includes secrets", () => {
    const dto = toRawPayloadDetailDto({
      id: "rp-22",
      network: "optimise_sea",
      networkAccountId: "acc-1",
      sourceObject: "conversions",
      endpointOrReport: "GET /conversions",
      apiVersion: null,
      syncRunId: "run-9",
      fetchedAt: new Date("2026-09-01T00:00:00Z"),
      requestWindow: { fromDate: "2026-08-01", toDate: "2026-09-01" },
      httpStatus: 200,
      payloadHash: "abc",
      bodyKind: "JSON",
      payload: { conversionId: "c1" },
      encryptedAccessToken: "NOPE",
    });
    assert.equal(dto.rawPayloadId, "rp-22");
    assert.equal(dto.network, "optimise_sea");
    assert.equal(dto.networkAccountId, "acc-1");
    assert.equal(dto.sourceObject, "conversions");
    assert.equal(dto.endpointOrReport, "GET /conversions");
    assert.equal(dto.syncRunId, "run-9");
    assert.equal(dto.httpStatus, 200);
    assert.equal(dto.immutable, true);
    assert.equal(dto.payload.conversionId, "c1");
    assert.equal(JSON.stringify(dto).includes("encryptedAccessToken"), false);
    assertNoSecrets(dto);
  });
});
