/**
 * Source-object sync — identity, isolation, declared-not-live, no secret leakage.
 * Networks provide source facts. MBO owns the canonical standard. Never skip raw payload.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  listSourceObjectCatalog,
  getSourceObject,
  networkFamily,
} from "../src/modules/networkOps/sourceObjects.catalog.js";
import {
  SYNC_RUN_STATUS,
  buildSyncRunIdentity,
  syncRunIdentityKey,
  toSyncRunDto,
} from "../src/modules/networkOps/syncRun.contract.js";
import { SYNC_OBS_STATUS } from "../src/modules/networkOps/syncObservability.contract.js";
import { SourceObjectSyncService, resultRows } from "../src/modules/networkOps/sourceObjectSync.service.js";
import { toNetworkDetailDto } from "../src/modules/ops/networkOps.dto.js";
import { assertNoSecrets } from "../src/modules/networkOps/networkAccount.contract.js";

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
      findMany: async ({ where, orderBy, take }) => {
        let out = [...rows];
        if (where?.network?.in) out = out.filter((r) => where.network.in.includes(r.network));
        else if (where?.network) out = out.filter((r) => r.network === where.network);
        if (where?.networkAccountId) {
          out = out.filter((r) => r.networkAccountId === where.networkAccountId);
        }
        if (orderBy?.startedAt === "desc") {
          out.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
        }
        if (take) out = out.slice(0, take);
        return out;
      },
    },
  };
}

describe("source object catalog", () => {
  it("declares contract objects for every listed network, including ones with no adapter", () => {
    for (const network of [
      "optimise",
      "impact",
      "partnerize",
      "awin",
      "admitad",
      "cj",
      "rakuten",
      "trackier",
      "boostiny",
    ]) {
      const items = listSourceObjectCatalog(network);
      assert.ok(items.length > 0, `${network} catalog is empty`);
    }
    assert.equal(networkFamily("optimise_sea"), "optimise");
    assert.equal(getSourceObject("admitad", "programs")?.live, false);
    assert.equal(getSourceObject("cj", "advertisers")?.live, false);
    assert.equal(getSourceObject("rakuten", "events")?.live, false);
    assert.equal(getSourceObject("optimise", "campaigns")?.live, true);
    assert.equal(getSourceObject("boostiny", "settlement")?.live, false);
  });
});

describe("sync run identity", () => {
  it("is the five-part key: network + network_account_id + source_object + endpoint + sync_run_id", () => {
    const conversions = buildSyncRunIdentity({
      network: "optimise_sea",
      networkAccountId: "acc-1",
      sourceObject: "conversions",
      endpoint: "GET /conversions",
      syncRunId: "run-a",
    });
    const byPayment = buildSyncRunIdentity({
      network: "optimise_sea",
      networkAccountId: "acc-1",
      sourceObject: "conversions",
      endpoint: "GET /conversions (conversionsByPayment)",
      syncRunId: "run-b",
    });
    assert.equal(conversions.network, "optimise_sea");
    assert.equal(conversions.network_account_id, "acc-1");
    assert.equal(conversions.source_object, "conversions");
    assert.notEqual(syncRunIdentityKey(conversions), syncRunIdentityKey(byPayment));
  });

  it("never copies secrets onto the run DTO", () => {
    const dto = toSyncRunDto({
      id: "run-1",
      network: "boostiny",
      networkAccountId: "acc-1",
      sourceObject: "campaigns",
      endpoint: "GET campaigns",
      status: "FAILED",
      errorMessage: "401 apiKey=supersecretvalue123 Bearer abc.def.ghi.jkl",
      startedAt: new Date("2026-09-01T00:00:00Z"),
      finishedAt: new Date("2026-09-01T00:00:01Z"),
      encryptedAccessToken: "SHOULD_NOT_APPEAR",
    });
    assertNoSecrets(dto);
    assert.equal(JSON.stringify(dto).includes("supersecretvalue123"), false);
    assert.equal(JSON.stringify(dto).includes("encryptedAccessToken"), false);
    assert.match(dto.errorMessage, /redacted/i);
  });
});

describe("isolated source object runs", () => {
  it("does not throw when a sibling object fails; campaigns stay succeeded", async () => {
    const db = memoryPrisma();
    const svc = new SourceObjectSyncService({ prisma: db });
    const outcomes = await svc.executeMany([
      {
        network: "optimise_sea",
        networkAccountId: "acc-1",
        sourceObject: "campaigns",
        endpoint: "GET /campaigns",
        execute: async () => [{ id: "c1", name: "raw campaign" }],
      },
      {
        network: "optimise_sea",
        networkAccountId: "acc-1",
        sourceObject: "conversions",
        endpoint: "GET /conversions",
        execute: async () => {
          throw new Error("Optimise conversions 500 apiKey=leakmeplease123456789012345678901234567890");
        },
      },
    ]);
    assert.equal(outcomes[0].status, SYNC_OBS_STATUS.SUCCESS);
    assert.equal(outcomes[1].status, SYNC_RUN_STATUS.FAILED);
    assert.equal(resultRows(outcomes[0]).length, 1);
    assert.equal(resultRows(outcomes[1]).length, 0);
    assert.equal(JSON.stringify(outcomes[1].error).includes("leakmeplease"), false);
    assert.equal(outcomes[0].identity.sync_run_id !== outcomes[1].identity.sync_run_id, true);
  });

  it("returns NOT_AVAILABLE for declared objects and unknown adapters — never invents a fetch", async () => {
    const db = memoryPrisma();
    const svc = new SourceObjectSyncService({ prisma: db });
    const admitad = await svc.execute({
      network: "admitad",
      networkAccountId: "acc-1",
      sourceObject: "programs",
      execute: async () => {
        throw new Error("should not run");
      },
    });
    const unknown = await svc.execute({
      network: "optimise_sea",
      sourceObject: "not_a_real_object",
    });
    assert.equal(admitad.status, SYNC_RUN_STATUS.NOT_AVAILABLE);
    assert.equal(admitad.result, null);
    assert.equal(unknown.status, SYNC_RUN_STATUS.NOT_AVAILABLE);
    assert.equal(unknown.error.code, "UNKNOWN_SOURCE_OBJECT");
  });

  it("keeps the handler result as the raw network payload, not a client API DTO", async () => {
    const db = memoryPrisma();
    const svc = new SourceObjectSyncService({ prisma: db });
    const run = await svc.execute({
      network: "boostiny",
      networkAccountId: "acc-9",
      sourceObject: "campaigns",
      execute: async () => [{ campaign_id: "raw-99", payouts: [{ type: "percent", value: 8.2 }] }],
    });
    assert.equal(run.status, SYNC_OBS_STATUS.SUCCESS);
    assert.deepEqual(run.result[0].payouts, [{ type: "percent", value: 8.2 }]);
    assert.equal("clientCampaignId" in run.result[0], false);
  });
});

describe("network detail source objects", () => {
  it("exposes catalog + last run on the staff DTO without secrets", () => {
    const dto = toNetworkDetailDto({
      key: "OPTIMISE",
      name: "Optimise",
      credentialsConfigured: true,
      capabilities: {},
      metrics: {},
      mapping: { status: "NEEDS_REVIEW", issues: [] },
      syncHealth: {},
      accounts: [],
      pipeline: [],
      coverage: {},
      sourceObjects: [
        {
          sourceObject: "campaigns",
          label: "Campaigns",
          endpoint: "GET /campaigns",
          live: true,
          availability: "LIVE",
          lastRun: {
            syncRunId: "run-1",
            network: "optimise_sea",
            networkAccountId: "acc-1",
            sourceObject: "campaigns",
            endpoint: "GET /campaigns",
            status: "SUCCEEDED",
            recordCount: 12,
            errorMessage: "apiKey=shouldnotleak123456789012345678901234567890aaaa",
            startedAt: new Date("2026-09-01T00:00:00Z"),
            finishedAt: new Date("2026-09-01T00:00:02Z"),
          },
        },
      ],
    });
    assert.equal(dto.sourceObjects[0].sourceObject, "campaigns");
    assert.equal(dto.sourceObjects[0].lastRun.status, SYNC_OBS_STATUS.SUCCESS);
    assert.equal(JSON.stringify(dto).includes("shouldnotleak"), false);
    assertNoSecrets(dto);
  });
});
