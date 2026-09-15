/**
 * Manual per-network sync — explicit `promote=false` option.
 *
 * The post-sync promotion (all networks, unscoped) is not narrowed by sourceObject and pushed a
 * campaigns-only Boostiny sync past the serverless function limit. The route now accepts
 * `?promote=false` to pass promoteAfter:false to syncPlatformAccount. Only an explicit false
 * value ("false", "0", "no") switches it off; everything else keeps the current default (true).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolvePlatformSyncOptions } from "../src/controllers/sync.controller.js";

const CONTROLLER_SRC = readFileSync(new URL("../src/controllers/sync.controller.js", import.meta.url), "utf8");
const handlerOf = (name) => CONTROLLER_SRC.split(`export async function ${name}`)[1].split("\nexport ")[0];

describe("resolvePlatformSyncOptions — promote parsing is conservative", () => {
  it("no query parameter → promoteAfter: true (current default preserved)", () => {
    assert.deepEqual(resolvePlatformSyncOptions({}), { fastSync: false, promoteAfter: true, sourceObject: undefined });
    assert.deepEqual(resolvePlatformSyncOptions(undefined), { fastSync: false, promoteAfter: true, sourceObject: undefined });
  });

  it("?promote=false → promoteAfter: false (also 0 / no, any case, trimmed)", () => {
    for (const value of ["false", "FALSE", " false ", "0", "no", "No"]) {
      assert.equal(resolvePlatformSyncOptions({ promote: value }).promoteAfter, false, JSON.stringify(value));
    }
  });

  it("anything that is not an explicit false keeps promoteAfter: true — never a silent default change", () => {
    for (const value of ["true", "1", "yes", "", "off", "none", "skip", "nope", "f", "maybe", "null", "undefined", ["false"]]) {
      assert.equal(resolvePlatformSyncOptions({ promote: value }).promoteAfter, true, JSON.stringify(value));
    }
  });

  it("sourceObject=campaigns&promote=false preserves the sourceObject and fast flag handling", () => {
    assert.deepEqual(resolvePlatformSyncOptions({ sourceObject: "campaigns", promote: "false" }), {
      fastSync: false,
      promoteAfter: false,
      sourceObject: "campaigns",
    });
    assert.deepEqual(resolvePlatformSyncOptions({ source_object: "api_reports", promote: "false", fast: "true" }), {
      fastSync: true,
      promoteAfter: false,
      sourceObject: "api_reports",
    });
    assert.deepEqual(resolvePlatformSyncOptions({ sourceObject: "campaigns" }), { fastSync: false, promoteAfter: true, sourceObject: "campaigns" });
  });
});

describe("handler wiring — only the manual per-network route reads promote", () => {
  it("triggerSyncPlatform passes the resolved options straight through to syncPlatformAccount", () => {
    const handler = handlerOf("triggerSyncPlatform");
    assert.match(handler, /const \{ fastSync, promoteAfter, sourceObject \} = resolvePlatformSyncOptions\(req\.query\);/);
    assert.match(handler, /syncPlatformAccount\(platform, accountLabel \|\| undefined, \{\s*fastSync,\s*promoteAfter,\s*sourceObject: sourceObject \|\| undefined,\s*\}\)/);
    assert.ok(!handler.includes("promoteAfter: true"), "no hard-coded promotion any more");
    assert.match(handler, /return respondWithExclusiveSync\(\{/, "still awaited");
  });

  it("the awaited 200/409/500 helper is unchanged", () => {
    const helper = CONTROLLER_SRC.split("export async function respondWithExclusiveSync")[1].split("\n}")[0];
    assert.match(helper, /const run = await runExclusiveSync\(jobName, syncFn, \{ trigger \}\);/);
    assert.match(helper, /res\.status\(409\)/);
    assert.match(helper, /res\.status\(500\)/);
    assert.match(helper, /res\.status\(200\)\.json\(\{\s*ok: true,/);
  });

  it("canary, full sync and incremental do not read promote and keep their own promotion settings", () => {
    const canary = handlerOf("triggerBoostinyCanarySync");
    assert.ok(!canary.includes("promote") || canary.includes("promoteAfter: false"), "canary keeps promoteAfter: false only");
    assert.match(canary, /promoteAfter: false,/);
    assert.ok(!canary.includes("resolvePlatformSyncOptions"));
    const all = handlerOf("triggerSyncAll");
    // Full sync always requests promotion; it does not read the manual route's promote option.
    assert.match(all, /const options = \{ fastSync, promoteAfter: true \};/);
    assert.ok(!all.includes("resolvePlatformSyncOptions"));
    assert.ok(!/\bq\.promote\b|req\.query\?\.promote/.test(all));
    assert.match(all, /getOrCreateRun\(\{/);
    const incremental = handlerOf("triggerIncrementalSync");
    assert.match(incremental, /triggerScheduledSync\(\{ reason: "api" \}\)/);
    assert.ok(!incremental.includes("promote"));
  });
});
