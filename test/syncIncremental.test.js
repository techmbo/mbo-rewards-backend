import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runWithSyncOptions } from "../src/jobs/syncContext.js";
import { incrementalFromDate } from "../src/jobs/sync.job.js";
import {
  shouldRefreshCampaigns,
  shouldRefreshCoupons,
} from "../src/jobs/syncTimestamps.js";
import {
  getSyncStatus,
  isSyncRunning,
  runSyncInBackground,
} from "../src/jobs/syncState.js";

describe("incrementalFromDate", () => {
  it("subtracts overlap days from lastSuccessfulSync", () => {
    assert.equal(incrementalFromDate("2026-08-03T06:00:00.000Z", 2), "2026-08-01");
    assert.equal(incrementalFromDate("2026-08-03T06:00:00.000Z", 0), "2026-08-03");
  });
});

describe("shouldRefreshCampaigns / Coupons", () => {
  it("always refreshes when no prior timestamp", () => {
    assert.equal(shouldRefreshCampaigns(null, { fastSync: true }), true);
    assert.equal(shouldRefreshCoupons(undefined, { fastSync: true }), true);
  });

  it("full sync always refreshes even if cache is fresh", () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
    assert.equal(shouldRefreshCampaigns(recent, { fastSync: false }), true);
    assert.equal(shouldRefreshCoupons(recent, { fastSync: false }), true);
  });

  it("fast sync skips when cache is within TTL", () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
    assert.equal(shouldRefreshCampaigns(recent, { fastSync: true }), false);
    assert.equal(shouldRefreshCoupons(recent, { fastSync: true }), false);
  });

  it("fast sync refreshes when cache is stale", () => {
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago
    assert.equal(shouldRefreshCampaigns(stale, { fastSync: true }), true);
    assert.equal(shouldRefreshCoupons(stale, { fastSync: true }), true);
  });

  it("respects per-run sync context override", async () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000);
    await runWithSyncOptions({ fastSync: true }, async () => {
      assert.equal(shouldRefreshCampaigns(recent), false);
    });
    await runWithSyncOptions({ fastSync: false }, async () => {
      assert.equal(shouldRefreshCampaigns(recent), true);
    });
  });
});

describe("syncState exclusive lock", () => {
  it("rejects overlapping background syncs", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    const first = runSyncInBackground("test-sync-1", async () => {
      await gate;
      return { ok: true };
    });
    assert.equal(first.started, true);
    assert.equal(isSyncRunning(), true);

    const second = runSyncInBackground("test-sync-2", async () => ({ ok: true }));
    assert.equal(second.started, false);
    assert.match(second.reason, /already in progress/i);

    release();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(getSyncStatus().status, "success");
  });
});
