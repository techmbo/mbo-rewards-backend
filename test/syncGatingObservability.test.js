import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SUPPLIER_GATE_EXCLUSION_REASON,
  buildSupplierSyncGate,
  loadSupplierSyncGate,
  supplierKeyForPlatform,
} from "../src/modules/supplier/supplierSyncGate.js";
import { SyncOrchestrationService, buildSyncPlan } from "../src/jobs/syncOrchestration.service.js";
import {
  CREDENTIAL_HEALTH,
  accountHealthStamp,
  healthFromSourceRuns,
  toNetworkConnectionDto,
} from "../src/modules/networkOps/networkAccount.contract.js";
import {
  RUN_ABANDONED_CODE,
  SourceObjectSyncService,
  safeSyncErrorCode,
} from "../src/modules/networkOps/sourceObjectSync.service.js";
import {
  currentCheckpointBefore,
  currentSyncTrigger,
  includeSourceObject,
  withConnectionScope,
} from "../src/jobs/sourceObjectRuns.js";
import { runWithSyncOptions } from "../src/jobs/syncContext.js";
import { runExclusiveSync } from "../src/jobs/syncState.js";

const NOW = new Date("2026-09-27T10:00:00.000Z");
const listAccounts = async (platform) => (platform === "optimise_sea" ? [{ accountLabel: "default" }] : []);
const loadAccountState = async () => ({ lastSuccessfulSync: null });

describe("PLANNED supplier gating (strict, registry-only)", () => {
  // The rollout's registry: the live networks ENABLED, Partnerize and Impact PLANNED, and no row
  // at all for Admitad, CJ, Rakuten (or Awin, unless an operator creates one).
  const registry = [
    { key: "BOOSTINY", status: "ENABLED" },
    { key: "OPTIMISE", status: "ENABLED" },
    { key: "TRACKIER", status: "ENABLED" },
    { key: "PARTNERIZE", status: "PLANNED" },
    { key: "IMPACT", status: "PLANNED" },
  ];
  const ALL = ["boostiny", "optimise_sea", "optimise_uk", "trackier", "awin", "partnerize", "impact", "admitad", "cj", "rakuten"];

  it("ENABLED joins; PLANNED and missing-from-registry are excluded", () => {
    const gate = buildSupplierSyncGate(registry);
    assert.deepEqual(Object.fromEntries(ALL.map((p) => [p, gate(p).status])), {
      boostiny: "ENABLED",
      optimise_sea: "ENABLED",
      optimise_uk: "ENABLED",
      trackier: "ENABLED",
      awin: "UNREGISTERED",
      partnerize: "PLANNED",
      impact: "PLANNED",
      admitad: "UNREGISTERED",
      cj: "UNREGISTERED",
      rakuten: "UNREGISTERED",
    });
    assert.deepEqual(ALL.filter((p) => gate(p).allowed), ["boostiny", "optimise_sea", "optimise_uk", "trackier"]);
    assert.equal(supplierKeyForPlatform("optimise_mena"), "OPTIMISE");
  });

  it("only an ENABLED row allows a platform; code seeds never do", () => {
    const gate = buildSupplierSyncGate([{ key: "AWIN", status: "ENABLED" }, { key: "BOOSTINY", status: "DEPRECATED" }]);
    assert.equal(gate("awin").allowed, true);
    assert.equal(gate("boostiny").allowed, false);
    assert.equal(gate("optimise_sea").allowed, false, "no OPTIMISE row: excluded, whatever the seeds say");
    assert.equal(buildSupplierSyncGate([])("trackier").allowed, false);
  });

  it("an unreadable registry excludes every supplier", async () => {
    for (const db of [{ supplier: { findMany: async () => { throw new Error("db down"); } } }, {}, null]) {
      const gate = await loadSupplierSyncGate({ db });
      for (const p of ALL) {
        assert.equal(gate(p).allowed, false, p);
        assert.equal(gate(p).status, "REGISTRY_UNAVAILABLE");
      }
    }
  });

  it("the planner excludes gated platforms with a stated reason and plans the rest", async () => {
    const plan = await buildSyncPlan({ kind: "full", listAccounts, loadAccountState, now: NOW, supplierGate: buildSupplierSyncGate(registry) });
    const plannedPlatforms = new Set(plan.units.map((u) => u.platform));
    for (const p of ["partnerize", "impact", "admitad", "cj", "rakuten", "awin"]) {
      assert.ok(!plannedPlatforms.has(p), `${p} planned`);
      assert.ok(plan.exclusions.some((e) => e.platform === p && e.reason === SUPPLIER_GATE_EXCLUSION_REASON), `${p} not excluded`);
    }
    assert.ok(plannedPlatforms.has("optimise_sea"));
  });

  it("the orchestration service always plans with the registry-backed gate", async () => {
    const prisma = { supplier: { findMany: async () => [{ key: "PARTNERIZE", status: "ENABLED" }, { key: "AWIN", status: "PLANNED" }] } };
    const service = new SyncOrchestrationService({ prisma, now: () => NOW, listAccounts, loadAccountState });
    const plan = await service.previewPlan({ kind: "full" });
    const platforms = new Set(plan.units.map((u) => u.platform));
    assert.ok(platforms.has("partnerize"));
    assert.ok(!platforms.has("awin"));
    assert.ok(plan.exclusions.some((e) => e.platform === "awin" && e.reason === SUPPLIER_GATE_EXCLUSION_REASON));
  });

  it("syncAll gates each network; the manual per-network route and explicit units are not gated", () => {
    const sync = readFileSync("src/jobs/sync.job.js", "utf8");
    for (const p of ["boostiny", "optimise", "trackier", "impact", "partnerize", "awin", "admitad", "rakuten", "cj"]) {
      assert.match(sync, new RegExp(`await gatedFullSync\\("${p}"`), p);
    }
    const planner = readFileSync("src/jobs/syncOrchestration.service.js", "utf8");
    assert.match(planner, /supplierGate: await this\.supplierGate\(\)/);
  });
});

describe("truthful connection health", () => {
  it("any failed source object keeps the checkpoint and names objects and codes only", () => {
    const health = healthFromSourceRuns([
      { sourceObject: "campaigns", status: "SUCCESS" },
      { sourceObject: "conversions", status: "FAILED", errorCode: "HTTP_500", errorMessage: "secret body" },
    ]);
    assert.equal(health.ok, false);
    assert.equal(health.anySucceeded, true);
    const stamp = accountHealthStamp(health, NOW);
    assert.equal(stamp.credentialHealth, CREDENTIAL_HEALTH.HEALTHY);
    assert.equal(stamp.lastFailureCode, "HTTP_500");
    assert.equal(stamp.lastFailureAt, NOW);
    assert.match(stamp.lastSyncError, /conversions \(HTTP_500\)/);
    assert.ok(!stamp.lastSyncError.includes("secret body"));
  });

  it("401/403 marks the credentials FAILED; an unexplained failure leaves the previous verdict", () => {
    assert.equal(accountHealthStamp(healthFromSourceRuns([{ status: "FAILED", errorCode: "HTTP_401" }])).credentialHealth, "FAILED");
    assert.equal(accountHealthStamp(healthFromSourceRuns([{ status: "FAILED", errorCode: "HTTP_403" }])).credentialHealth, "FAILED");
    assert.ok(!("credentialHealth" in accountHealthStamp(healthFromSourceRuns([{ status: "FAILED", errorCode: "TIMEOUT" }]))));
  });

  it("all-green clears the error and reports HEALTHY", () => {
    const stamp = accountHealthStamp(healthFromSourceRuns([{ status: "SUCCESS" }, { status: "PARTIAL" }]));
    assert.deepEqual(stamp, { credentialHealth: "HEALTHY", lastSyncError: null, lastFailureCode: null });
  });

  it("no source-object runs proves nothing: no health verdict and no checkpoint", () => {
    const health = healthFromSourceRuns([]);
    assert.equal(health.ran, 0);
    assert.deepEqual(accountHealthStamp(health), {});
    for (const file of ["src/jobs/sync.job.js", "src/jobs/waveESupplierSync.js"]) {
      assert.match(readFileSync(file, "utf8"), /health\.ok && health\.ran > 0\)+ data\.lastSuccessfulSync = now/, file);
    }
  });

  it("the sync jobs advance lastSuccessfulSync only on a clean health verdict", () => {
    const sync = readFileSync("src/jobs/sync.job.js", "utf8");
    assert.match(sync, /healthFromSourceRuns\(/);
    const wave = readFileSync("src/jobs/waveESupplierSync.js", "utf8");
    assert.match(wave, /healthFromSourceRuns\(/);
  });

  it("the connection DTO is value-free", () => {
    const dto = toNetworkConnectionDto({
      id: "a1",
      platform: "optimise_sea",
      accountLabel: "default",
      secretRef: "aws-sm:mbo/production/networks/optimise_sea/default",
      encryptedAccessToken: "enc",
      encryptedRefreshToken: "enc2",
      maskedApiKey: "abcd***wxyz",
      credentialSource: "PROVIDER_REF",
      pausedAt: NOW,
      pausedReason: "PENDING_ACTIVATION",
      campaignSyncEnabled: true,
      couponSyncEnabled: false,
    });
    const blob = JSON.stringify(dto);
    for (const leak of ["enc", "abcd", "mbo/production", "secretRef", "maskedApiKey"]) assert.ok(!blob.includes(leak), leak);
    assert.equal(dto.credentialProvider, "aws-sm");
    assert.equal(dto.paused, true);
    assert.equal(dto.switches.couponSyncEnabled, false);
  });
});

/** In-memory NetworkSyncRun + MarketplaceAccount store. */
function fakeDb({ runs = [], accounts = [] } = {}) {
  const calls = { runUpdateMany: [], accountUpdateMany: [] };
  const matches = (row, where) =>
    Object.entries(where).every(([k, cond]) => {
      if (cond && typeof cond === "object" && !(cond instanceof Date)) {
        if ("in" in cond) return cond.in.includes(row[k]);
        if ("lt" in cond) return row[k] < cond.lt;
      }
      return (row[k] ?? null) === cond;
    });
  return {
    calls,
    runs,
    accounts,
    networkSyncRun: {
      create: async ({ data }) => { runs.push({ ...data }); return data; },
      update: async ({ where, data }) => { const r = runs.find((x) => x.id === where.id); Object.assign(r, data); return r; },
      findUnique: async ({ where }) => runs.find((x) => x.id === where.id) ?? null,
      updateMany: async ({ where, data }) => {
        calls.runUpdateMany.push({ where, data });
        const hit = runs.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
    },
    marketplaceAccount: {
      findUnique: async ({ where }) => accounts.find((a) => a.id === where.id) ?? null,
      updateMany: async ({ where, data }) => {
        calls.accountUpdateMany.push({ where, data });
        const hit = accounts.filter((a) => a.id === where.id);
        hit.forEach((a) => Object.assign(a, data));
        return { count: hit.length };
      },
    },
  };
}

const silentExceptions = () => {
  const reports = [];
  return { reports, report: async (r) => { reports.push(r); return r; } };
};

describe("source-object run lifecycle", () => {
  it("a stale RUNNING row of the same connection + object is closed CANCELLED / RUN_ABANDONED, never deleted", async () => {
    const old = new Date(Date.now() - 45 * 60 * 1000);
    const fresh = new Date(Date.now() - 5 * 60 * 1000);
    const db = fakeDb({
      runs: [
        { id: "stale", network: "optimise", sourceObject: "campaigns", networkAccountId: "acc", status: "RUNNING", finishedAt: null, startedAt: old },
        { id: "young", network: "optimise", sourceObject: "campaigns", networkAccountId: "acc", status: "RUNNING", finishedAt: null, startedAt: fresh },
        { id: "other", network: "optimise", sourceObject: "conversions", networkAccountId: "acc", status: "RUNNING", finishedAt: null, startedAt: old },
      ],
    });
    const service = new SourceObjectSyncService({ prisma: db, exceptions: silentExceptions() });
    await service.execute({ network: "optimise", networkAccountId: "acc", sourceObject: "campaigns", execute: async () => ({ records: [] }) });
    const byId = Object.fromEntries(db.runs.map((r) => [r.id, r]));
    assert.equal(byId.stale.status, "CANCELLED");
    assert.equal(byId.stale.errorCode, RUN_ABANDONED_CODE);
    assert.ok(byId.stale.finishedAt instanceof Date);
    assert.equal(byId.young.status, "RUNNING");
    assert.equal(byId.other.status, "RUNNING");
    assert.equal(db.runs.length, 4, "nothing deleted; one new run");
  });

  it("recordsFetched is the fetch count; staging the same rows does not add them again", async () => {
    const db = fakeDb({ runs: [{ id: "r1", status: "SUCCESS", recordsFetched: 40, recordsCreated: 0, recordsUpdated: 0 }] });
    const service = new SourceObjectSyncService({ prisma: db });
    await service.finalizeRun("r1", { recordsFetched: 40, recordsCreated: 30, recordsUpdated: 10 });
    assert.equal(db.runs[0].recordsFetched, 40);
    assert.equal(db.runs[0].recordsCreated, 30);
  });

  it("a run that recorded no fetch count takes the staged count, and PARTIAL is never upgraded", async () => {
    const db = fakeDb({
      runs: [
        { id: "r0", status: "RUNNING", recordsFetched: 0 },
        { id: "rp", status: "PARTIAL", recordsFetched: 10 },
      ],
    });
    const service = new SourceObjectSyncService({ prisma: db });
    await service.finalizeRun("r0", { recordsFetched: 7, recordsCreated: 7 });
    await service.finalizeRun("rp", { recordsCreated: 10 });
    assert.equal(db.runs[0].recordsFetched, 7);
    assert.equal(db.runs[1].status, "PARTIAL");
  });

  it("safe error codes come from status and transport codes, never from messages", () => {
    assert.equal(safeSyncErrorCode({ response: { status: 429 }, message: "api_key=abc" }), "HTTP_429");
    assert.equal(safeSyncErrorCode({ code: "ECONNABORTED" }), "TIMEOUT");
    assert.equal(safeSyncErrorCode({ code: "ENOTFOUND" }), "NETWORK_ERROR");
    assert.equal(safeSyncErrorCode({ code: "ERR_BAD_RESPONSE" }), "SOURCE_OBJECT_SYNC_FAILED");
    assert.equal(safeSyncErrorCode({ code: "lower case code" }), "SOURCE_OBJECT_SYNC_FAILED");
    assert.equal(safeSyncErrorCode(new Error("Bearer abc.def")), "SOURCE_OBJECT_SYNC_FAILED");
  });

  it("a 401 pauses the connection (AUTH_FAILED) and reports an exception; data is untouched", async () => {
    const db = fakeDb({ accounts: [{ id: "acc", pausedAt: null, credentialHealth: "HEALTHY" }] });
    const exceptions = silentExceptions();
    const service = new SourceObjectSyncService({ prisma: db, exceptions });
    const error = Object.assign(new Error("Request failed with status code 401"), { response: { status: 401 } });
    const out = await service.execute({ network: "optimise", networkAccountId: "acc", sourceObject: "campaigns", execute: async () => { throw error; } });
    assert.equal(out.status, "FAILED");
    assert.deepEqual({ code: out.error.code, httpStatus: out.error.httpStatus, connectionPaused: out.error.connectionPaused }, {
      code: "HTTP_401",
      httpStatus: 401,
      connectionPaused: true,
    });
    assert.ok(db.accounts[0].pausedAt instanceof Date);
    assert.equal(db.accounts[0].pausedReason, "AUTH_FAILED");
    assert.equal(db.accounts[0].credentialHealth, "FAILED");
    assert.equal(db.accounts[0].lastFailureCode, "HTTP_401");
    assert.equal(exceptions.reports.length, 1);
  });

  it("a 403 that is not an authentication failure, or a 500, does not pause", async () => {
    for (const response of [{ status: 403, data: { message: "endpoint not enabled for this plan" } }, { status: 500 }]) {
      const db = fakeDb({ accounts: [{ id: "acc", pausedAt: null }] });
      const service = new SourceObjectSyncService({ prisma: db, exceptions: silentExceptions() });
      const error = Object.assign(new Error(`status ${response.status}`), { response });
      const out = await service.execute({ network: "optimise", networkAccountId: "acc", sourceObject: "campaigns", execute: async () => { throw error; } });
      assert.equal(out.error.connectionPaused, false);
      assert.equal(db.accounts[0].pausedAt, null);
    }
  });
});

describe("run trigger and checkpointBefore", () => {
  it("records the run's own origin", async () => {
    assert.equal(currentSyncTrigger(), "scheduler");
    await runWithSyncOptions({ trigger: "scheduler" }, async () => assert.equal(currentSyncTrigger(), "scheduler"));
    await runWithSyncOptions({ trigger: "manual" }, async () => assert.equal(currentSyncTrigger(), "manual"));
    await runWithSyncOptions({ trigger: "reprocess" }, async () => assert.equal(currentSyncTrigger(), "reprocess"));
    // A manual route or canary holds the in-process slot as "api".
    await runExclusiveSync("test:trigger", async () => assert.equal(currentSyncTrigger(), "manual"), { trigger: "api" });
    // The unit's recorded origin wins over the slot.
    await runExclusiveSync(
      "test:trigger2",
      () => runWithSyncOptions({ trigger: "scheduler" }, async () => assert.equal(currentSyncTrigger(), "scheduler")),
      { trigger: "api" },
    );
  });

  it("a worker unit carries its run's origin alongside, not inside, its forwarded options", () => {
    const controller = readFileSync("src/controllers/sync.controller.js", "utf8");
    const executeUnit = controller.split("async function executeUnit(")[1].split("\n}\n")[0];
    assert.match(executeUnit, /trigger: runTrigger === "scheduler" \? "scheduler" : "manual"/);
    const sync = readFileSync("src/jobs/sync.job.js", "utf8");
    assert.match(sync, /export async function syncPlatformAccount\(platform, accountLabel, options = \{\}, origin = \{\}\)/);
  });

  it("checkpointBefore is the connection's last success and the requested window, read before the fetch", async () => {
    const db = fakeDb({ accounts: [{ id: "acc", lastSuccessfulSync: new Date("2026-09-20T00:00:00Z") }] });
    const cp = await runWithSyncOptions({ windowStart: "2026-09-01", windowEnd: "2026-09-07" }, () => currentCheckpointBefore("acc", db));
    assert.equal(cp.lastSuccessfulSync, "2026-09-20T00:00:00.000Z");
    assert.deepEqual(cp.requestWindow, { start: "2026-09-01", end: "2026-09-07" });
    assert.deepEqual(await currentCheckpointBefore(null, db), { lastSuccessfulSync: null, requestWindow: null });
  });
});

describe("per-object connection switches", () => {
  it("a disabled object is excluded for fetch and persist alike; a paused connection runs nothing", async () => {
    const flags = { exists: true, paused: false, campaignSyncEnabled: true, couponSyncEnabled: false, productSyncEnabled: true, conversionSyncEnabled: false, financeSyncEnabled: false };
    await withConnectionScope("optimise_sea", "default", async () => {
      assert.equal(includeSourceObject(null, "campaigns"), true);
      assert.equal(includeSourceObject(null, "voucher_codes"), false);
      assert.equal(includeSourceObject(null, "conversions"), false);
      assert.equal(includeSourceObject(null, "payment_overview"), false);
      assert.equal(includeSourceObject("voucher_codes", "voucher_codes"), false, "an explicit request cannot override a switch");
    }, { getFlags: async () => flags });
    let ran = false;
    const paused = await withConnectionScope("optimise_sea", "default", async () => {
      ran = true;
    }, { getFlags: async () => ({ ...flags, paused: true, pausedReason: "AUTH_FAILED" }) });
    assert.equal(ran, false, "a paused connection does not run at all");
    assert.equal(paused.skipped, true);
    assert.equal(paused.connectionPaused, true);
    assert.match(paused.reason, /AUTH_FAILED/);
    await withConnectionScope("awin", "default", async () => {
      assert.equal(includeSourceObject(null, "voucher_codes"), true, "no connection row: legacy behaviour");
    }, { getFlags: async () => ({ exists: false }) });
  });
});
