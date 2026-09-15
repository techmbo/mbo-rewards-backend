/**
 * Manual per-network sync — awaited execution.
 *
 * POST /sync/:platform and /sync/:platform/:accountLabel used to launch the sync through the
 * fire-and-forget launcher and answer 202 at once; on serverless hosting the instance freezes
 * after the response and the sync never runs. The controller now awaits the run through
 * runExclusiveSync (the pattern proven by the Boostiny canary) and answers only when finished:
 * 200 on success/partial, 409 when the exclusive slot is held, 500 when the run throws.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { respondWithExclusiveSync, triggerSyncPlatform } from "../src/controllers/sync.controller.js";
import { getSyncStatus, isSyncRunning } from "../src/jobs/syncState.js";

const CONTROLLER_SRC = readFileSync(new URL("../src/controllers/sync.controller.js", import.meta.url), "utf8");

function fakeRes() {
  const res = { statusCode: null, body: null, sentAt: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; res.sentAt = Date.now(); return res; };
  return res;
}
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("respondWithExclusiveSync — the response waits for the supplied sync promise", () => {
  it("does not respond until the sync promise resolves, then returns 200 with the final status and result", async () => {
    const res = fakeRes();
    let release;
    let finished = false;
    const pending = respondWithExclusiveSync({
      jobName: "sync:zzplatformzz:zzaccountzz",
      syncFn: () => new Promise((resolve) => { release = resolve; }),
      res,
      trigger: "api",
    });
    await tick(20);
    assert.equal(res.statusCode, null, "nothing sent while the sync is still running");
    assert.equal(isSyncRunning(), true);
    release({ zzaccountzz: { conversions: 3 } });
    finished = true;
    await pending;
    assert.equal(finished, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.status, "success");
    assert.equal(res.body.syncStatus.status, "success");
    assert.equal(res.body.syncStatus.jobName, "sync:zzplatformzz:zzaccountzz");
    assert.ok(res.body.syncStatus.finishedAt, "status finalised before responding");
    assert.equal(res.body.syncStatus.percentComplete, 100);
    assert.deepEqual(res.body.syncStatus.result, { zzaccountzz: { conversions: 3 } });
    assert.equal(res.body.syncStatus.trigger, "api");
    assert.equal(isSyncRunning(), false);
    assert.equal(getSyncStatus().status, "success", "the polled status agrees with the response");
  });

  it("a partial result is still a 200 with status partial", async () => {
    const res = fakeRes();
    await respondWithExclusiveSync({ jobName: "sync:zzp", syncFn: async () => ({ a: { partialSuccess: true, warnings: ["zzwarnzz"] } }), res });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "partial");
    assert.equal(res.body.syncStatus.status, "partial");
  });

  it("a thrown sync returns 500 with the failure message and a failed, finalised status; the slot is released", async () => {
    const res = fakeRes();
    await respondWithExclusiveSync({ jobName: "sync:zzp", syncFn: async () => { throw new Error("zzupstream boomzz"); }, res });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.status, "failed");
    assert.equal(typeof res.body.message, "string");
    assert.ok(res.body.message.length > 0);
    assert.equal(res.body.syncStatus.status, "failed");
    assert.ok(res.body.syncStatus.error);
    assert.ok(res.body.syncStatus.finishedAt);
    assert.equal(isSyncRunning(), false);
  });

  it("a concurrent request while the slot is held returns 409 and does not queue a second run", async () => {
    const first = fakeRes();
    let release;
    let runs = 0;
    const pending = respondWithExclusiveSync({ jobName: "sync:zzfirst", syncFn: () => { runs += 1; return new Promise((resolve) => { release = resolve; }); }, res: first });
    await tick(5);
    const second = fakeRes();
    await respondWithExclusiveSync({ jobName: "sync:zzsecond", syncFn: async () => { runs += 1; return {}; }, res: second });
    assert.equal(second.statusCode, 409);
    assert.equal(second.body.ok, false);
    assert.equal(second.body.status, "running");
    assert.match(second.body.message, /already in progress/);
    assert.equal(second.body.syncStatus.jobName, "sync:zzfirst");
    release({});
    await pending;
    assert.equal(first.statusCode, 200);
    assert.equal(runs, 1, "the second request never executed a sync");
  });
});

describe("triggerSyncPlatform — handler wiring", () => {
  it("rejects an unsupported platform with 400 before touching the slot", async () => {
    const res = fakeRes();
    await triggerSyncPlatform({ params: { platform: "zznotanetworkzz" }, query: {} }, res, (e) => { throw e; });
    assert.equal(res.statusCode, 400);
    assert.equal(isSyncRunning(), false);
  });

  it("awaits the exclusive runner with the unchanged sync options and no background launcher", () => {
    const handler = CONTROLLER_SRC.split("export async function triggerSyncPlatform")[1].split("\nexport ")[0];
    assert.match(handler, /await locks\.withLock\(/, "held under the durable account lock");
    assert.match(handler, /respondWithExclusiveSync\(\{/, "still awaited inside the lock");
    // Options resolved once from the query (promoteAfter defaults to true; see syncPlatformPromoteOption tests).
    assert.match(handler, /const \{ fastSync, promoteAfter, sourceObject \} = resolvePlatformSyncOptions\(req\.query\);/);
    assert.match(handler, /accountSyncFor\(req\)\(platform, accountLabel \|\| undefined, \{\s*fastSync,\s*promoteAfter,\s*sourceObject: sourceObject \|\| undefined,\s*\}\)/);
    assert.ok(!handler.includes("startBackgroundSync("), "no background launcher on the manual per-network path");
    assert.ok(!handler.includes("runSyncInBackground("));
    assert.ok(!handler.includes("202"));
    const helper = CONTROLLER_SRC.split("export async function respondWithExclusiveSync")[1].split("\n}")[0];
    assert.match(helper, /const run = await runExclusiveSync\(jobName, syncFn, \{ trigger \}\);/);
    assert.match(helper, /if \(!run\.started\)[\s\S]*res\.status\(409\)/);
    assert.match(helper, /if \(run\.error\)[\s\S]*res\.status\(500\)/);
    assert.match(helper, /res\.status\(200\)\.json\(\{\s*ok: true,/);
  });

  it("the other routes keep their own shapes: /sync/all enqueues durably, /sync/incremental is unchanged, the canary keeps its awaited block", () => {
    const all = CONTROLLER_SRC.split("export async function triggerSyncAll")[1].split("\nexport ")[0];
    assert.match(all, /await [\w.]*\.getOrCreateRun\(\{/, "full sync enqueues a durable run");
    assert.match(all, /res\.status\(202\)/);
    assert.ok(!all.includes("respondWithExclusiveSync("), "the manual per-network helper is not used by full sync");
    const incremental = CONTROLLER_SRC.split("export async function triggerIncrementalSync")[1].split("\nexport ")[0];
    assert.match(incremental, /triggerScheduledSync\(\{ reason: "api" \}\)/);
    assert.match(incremental, /res\.status\(202\)/);
    const canary = CONTROLLER_SRC.split("export async function triggerBoostinyCanarySync")[1].split("\nexport ")[0];
    assert.match(canary, /const run = await runExclusiveSync\(/);
    assert.ok(!canary.includes("respondWithExclusiveSync("), "canary block not modified");
  });
});
