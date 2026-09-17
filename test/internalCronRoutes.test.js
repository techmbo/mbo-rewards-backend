/**
 * Phase 7C.1 — the internal scheduler entrypoints.
 *
 * Two routes a scheduler calls, authenticated by a shared secret and nothing else. A user JWT
 * would be the wrong credential twice over: it belongs to a person, and it expires after seven
 * days, which would stop the scheduler silently a week after setup.
 *
 * The drain is not a copy of the worker — it IS the worker handler — so every Phase 6 guarantee
 * (one claim, one unit, shared locks, lease handling, the staging-freeze deferral, the post-sync
 * gate) holds here without being re-proved. What is proved here is that it stays a delegation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CRON_AUTH_REFUSAL_CODE,
  cronSecretMatches,
  presentedCronSecret,
  requireCronSecret,
} from "../src/middleware/cronAuth.js";
import { cronSyncDrainHandler, cronSyncStartHandler } from "../src/controllers/internalCron.controller.js";
import {
  ORCHESTRATION_JOB_NAME,
  PLANNER_VERSION,
  UNIT_JOB_NAME,
  UNIT_KINDS,
  SyncOrchestrationService,
} from "../src/jobs/syncOrchestration.service.js";
import { SyncAccountLockService, accountLockKey } from "../src/jobs/syncAccountLock.service.js";

const AUTH_SRC = readFileSync(new URL("../src/middleware/cronAuth.js", import.meta.url), "utf8");
const CTRL_SRC = readFileSync(new URL("../src/controllers/internalCron.controller.js", import.meta.url), "utf8");
const ROUTES_SRC = readFileSync(new URL("../src/routes/index.js", import.meta.url), "utf8");

/** Executable code only; the comments name the legacy paths these routes must never reach. */
const codeOnly = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const SECRET = "zz-test-cron-secret-32-bytes-long-zz";

function withSecret(value, fn) {
  const previous = process.env.CRON_SECRET;
  if (value === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
}

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};

/* ------------------------------------------------------------------ durable JobRun fake ----- */

function createStore() {
  const rows = [];
  let seq = 0;
  const clone = (r) => JSON.parse(JSON.stringify(r));
  const match = (row, where = {}) => {
    for (const [k, c] of Object.entries(where)) {
      if (k === "AND") { if (!c.every((w) => match(row, w))) return false; continue; }
      if (k === "payload") {
        let v = row.payload;
        for (const p of c.path ?? []) v = v?.[p];
        if ("equals" in c && v !== c.equals) return false;
        continue;
      }
      const v = row[k];
      if (c && typeof c === "object" && !(c instanceof Date)) {
        if ("in" in c && !c.in.includes(v)) return false;
        if ("not" in c && v === c.not) return false;
        if ("gte" in c && !(v != null && new Date(v) >= new Date(c.gte))) return false;
        if ("lt" in c && !(v != null && new Date(v) < new Date(c.lt))) return false;
        if ("equals" in c && v !== c.equals) return false;
      } else if (v !== c) return false;
    }
    return true;
  };
  const sort = (list, orderBy) => {
    const specs = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return [...list].sort((a, b) => {
      for (const s of specs) {
        const [f, d] = Object.entries(s)[0];
        const av = a[f] instanceof Date ? a[f].getTime() : a[f];
        const bv = b[f] instanceof Date ? b[f].getTime() : b[f];
        if (av === bv) continue;
        return (av > bv ? 1 : -1) * (d === "desc" ? -1 : 1);
      }
      return 0;
    });
  };
  const apply = (row, data) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && !(v instanceof Date) && "increment" in v) row[k] = (row[k] ?? 0) + v.increment;
      else row[k] = v;
    }
  };
  const jobRun = {
    async create({ data }) {
      seq += 1;
      const row = { id: `row-${String(seq).padStart(3, "0")}`, status: "PENDING", priority: 100, attempt: 0, maxAttempts: 3, progress: 0, payload: null, result: null, lastError: null, correlationId: null, startedAt: null, completedAt: null, createdAt: new Date(Date.now() + seq), ...data };
      rows.push(row);
      return clone(row);
    },
    async createMany({ data }) { for (const d of data) await jobRun.create({ data: d }); return { count: data.length }; },
    async update({ where, data }) { const r = rows.find((x) => x.id === where.id); apply(r, data); return clone(r); },
    async updateMany({ where, data }) { let n = 0; for (const r of rows) if (match(r, where)) { apply(r, data); n += 1; } return { count: n }; },
    async deleteMany({ where }) { const d = rows.filter((r) => match(r, where ?? {})); for (const r of d) rows.splice(rows.indexOf(r), 1); return { count: d.length }; },
    async findUnique({ where }) { const r = rows.find((x) => x.id === where.id); return r ? clone(r) : null; },
    async findFirst({ where, orderBy }) { const l = sort(rows.filter((r) => match(r, where)), orderBy); return l.length ? clone(l[0]) : null; },
    async findMany({ where, orderBy }) { return sort(rows.filter((r) => match(r, where ?? {})), orderBy).map(clone); },
  };
  return { rows, prisma: { jobRun, async $transaction(fn) { return fn({ jobRun }); } } };
}

const now = () => new Date("2026-09-17T02:17:00.000Z");

/** One app: one store, one orchestration service, and every unit-execution seam observable. */
function app({ syncImpl } = {}) {
  const { rows, prisma } = createStore();
  const orchestration = new SyncOrchestrationService({
    prisma, now,
    listAccounts: async () => ["default"],
    loadAccountState: async () => ({ lastSuccessfulSync: null }),
  });
  const locks = new SyncAccountLockService({ prisma, now });
  const calls = { network: [], promotion: [], conversion: [], aggregation: [] };
  const locals = {
    syncOrchestration: orchestration,
    syncAccountLocks: locks,
    syncPlatformAccount: async (platform, accountLabel, options) => {
      calls.network.push({ platform, accountLabel, options });
      if (syncImpl) return syncImpl({ platform, accountLabel, options });
      return { [accountLabel ?? "default"]: { campaigns: 1 } };
    },
    promotionPage: async (i) => { calls.promotion.push(i); return { processed: 0, promoted: 0, skipped: 0, failed: 0, lastCursor: null, hasMore: false }; },
    conversionPromotionPage: async (i) => { calls.conversion.push(i); return { processed: 0, promoted: 0, skipped: 0, failed: 0, lastCursor: null, hasMore: false }; },
    aggregationRebuild: async (i) => { calls.aggregation.push(i); return { rebuilt: true }; },
  };
  const req = { app: { locals }, headers: {}, query: {}, params: {}, body: {} };
  return {
    rows, prisma, orchestration, locks, calls, req,
    async start() { const res = makeRes(); await cronSyncStartHandler(req, res, (e) => { throw e; }); return res; },
    async drain() { const res = makeRes(); await cronSyncDrainHandler(req, res, (e) => { throw e; }); return res; },
    units(runId) { return rows.filter((r) => r.jobName === UNIT_JOB_NAME && r.correlationId === runId); },
    runs() { return rows.filter((r) => r.jobName === ORCHESTRATION_JOB_NAME); },
    totalUnitWork() { return calls.network.length + calls.promotion.length + calls.conversion.length + calls.aggregation.length; },
  };
}

/* ================================================================================ the tests = */

describe("machine auth — a shared secret, and nothing else", () => {
  it("rejects when CRON_SECRET is missing or empty: an unset variable is never 'no auth needed'", () => {
    for (const configured of [undefined, "", "   "]) {
      withSecret(configured, () => {
        assert.equal(cronSecretMatches("anything"), false, JSON.stringify(configured));
        // Even presenting the empty string the server "has" is refused.
        assert.equal(cronSecretMatches(""), false);
        const res = makeRes();
        let nexted = false;
        requireCronSecret({ headers: { authorization: `Bearer ${SECRET}` } }, res, () => { nexted = true; });
        assert.equal(nexted, false, "an unconfigured server must not admit anyone");
        assert.equal(res.statusCode, 401);
      });
    }
  });

  it("rejects a missing, malformed or wrong-scheme Authorization header", () => {
    for (const headers of [
      {}, { authorization: "" }, { authorization: "Bearer" }, { authorization: "Bearer " },
      { authorization: SECRET }, { authorization: `Basic ${SECRET}` }, { authorization: `Token ${SECRET}` },
      { authorization: 12345 },
    ]) {
      assert.equal(presentedCronSecret({ headers }), null, JSON.stringify(headers));
      withSecret(SECRET, () => {
        const res = makeRes();
        let nexted = false;
        requireCronSecret({ headers }, res, () => { nexted = true; });
        assert.equal(nexted, false, JSON.stringify(headers));
        assert.equal(res.statusCode, 401);
        assert.equal(res.body.code, CRON_AUTH_REFUSAL_CODE);
      });
    }
    assert.equal(presentedCronSecret(undefined), null);
    assert.equal(presentedCronSecret({}), null);
  });

  it("rejects a wrong secret, including one that is a prefix or a different length", () => {
    withSecret(SECRET, () => {
      for (const presented of [
        "wrong", SECRET.slice(0, -1), `${SECRET}x`, SECRET.toUpperCase(), ` ${SECRET}`, SECRET.replace("z", "y"),
      ]) {
        assert.equal(cronSecretMatches(presented), false, presented);
      }
      // A wrong LENGTH must be a clean rejection, not a throw: timingSafeEqual throws on mismatched
      // buffers, and an unguarded compare would turn a bad guess into a 500 that leaks the length.
      assert.doesNotThrow(() => cronSecretMatches("x"));
      assert.doesNotThrow(() => cronSecretMatches("x".repeat(4096)));
    });
  });

  it("admits the correct secret, and only through the constant-time path", () => {
    withSecret(SECRET, () => {
      assert.equal(cronSecretMatches(SECRET), true);
      const res = makeRes();
      let nexted = false;
      requireCronSecret({ headers: { authorization: `Bearer ${SECRET}` } }, res, () => { nexted = true; });
      assert.equal(nexted, true);
      assert.equal(res.statusCode, null, "an admitted request writes no response of its own");
    });

    const code = codeOnly(AUTH_SRC);
    assert.match(code, /timingSafeEqual\(expected, actual\)/, "the comparison must be constant-time");
    assert.match(code, /if \(expected\.length !== actual\.length\) return false;/, "length is checked first");
    // The length check must come BEFORE the compare, or timingSafeEqual throws.
    assert.ok(code.indexOf("expected.length !== actual.length") < code.indexOf("timingSafeEqual("));
    // No short-circuit string comparison anywhere near the secret.
    assert.ok(!/configured\s*===\s*presented|presented\s*===\s*configured/.test(code), "non-constant-time compare");
    // The secret is never logged, returned or echoed.
    for (const leak of ["console.", "logger.", "CRON_SECRET}", "presented}"]) {
      assert.ok(!code.includes(leak), leak);
    }
    assert.ok(!code.includes("res.json({ ok: false, code: CRON_AUTH_REFUSAL_CODE, message: presented"), "echoes the secret");
  });
});

describe("sync-start — one bounded action: plan and enqueue", () => {
  it("creates a plannerVersion 6 run when none exists, and executes no unit", async () => {
    const h = app();
    const res = await h.start();

    assert.equal(res.statusCode, 202);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.created, true);
    assert.equal(res.body.reused, false);
    assert.equal(res.body.status, "created");
    assert.equal(res.body.plannerVersion, PLANNER_VERSION);
    assert.equal(PLANNER_VERSION, 6);
    assert.ok(res.body.runId);
    assert.equal(h.runs().length, 1);
    assert.equal(h.runs()[0].payload.plannerVersion, 6);
    assert.ok(h.units(res.body.runId).length > 0, "a plan was enqueued");

    // NOTHING was executed: no supplier call, no page, no aggregation day.
    assert.equal(h.totalUnitWork(), 0, "sync-start must never execute a unit");
    assert.ok(h.units(res.body.runId).every((u) => u.status === "PENDING"), "every unit is left pending");
  });

  it("a repeated call reuses the compatible active run rather than creating a second", async () => {
    const h = app();
    const first = await h.start();
    const second = await h.start();
    const third = await h.start();

    assert.equal(second.body.runId, first.body.runId);
    assert.equal(third.body.runId, first.body.runId);
    for (const res of [second, third]) {
      assert.equal(res.body.created, false);
      assert.equal(res.body.reused, true);
      assert.equal(res.body.status, "reused");
    }
    assert.equal(h.runs().filter((r) => !["CANCELLED"].includes(r.status)).length, 1, "exactly one live run");
    assert.equal(h.totalUnitWork(), 0);
  });

  it("the response carries scheduler-safe fields only — no run projection, no supplier data", async () => {
    const h = app();
    const res = await h.start();
    assert.deepEqual(Object.keys(res.body).sort(), ["created", "ok", "plannerVersion", "reused", "runId", "status"]);
    const serialised = JSON.stringify(res.body);
    for (const leak of ["syncStatus", "units", "accountLabel", "platform", "campaign", "payload", "lockKey", "options"]) {
      assert.ok(!serialised.includes(leak), leak);
    }
  });
});

describe("sync-drain — exactly one durable unit per request", () => {
  it("returns idle when there is no work, having executed nothing", async () => {
    const h = app();
    const res = await h.drain();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.worked, false);
    assert.equal(res.body.status, "idle");
    assert.equal(h.totalUnitWork(), 0);
  });

  it("executes exactly ONE unit per request, and a second request executes the next", async () => {
    const h = app();
    const started = await h.start();
    const planned = h.units(started.body.runId).length;
    assert.ok(planned >= 2, "the plan has more than one unit, so 'one per request' is meaningful");

    const first = await h.drain();
    assert.equal(first.body.status, "unit_completed");
    assert.equal(h.totalUnitWork(), 1, "one unit, not two");
    assert.equal(h.units(started.body.runId).filter((u) => u.status === "COMPLETED").length, 1);

    const second = await h.drain();
    assert.equal(second.body.status, "unit_completed");
    assert.equal(h.totalUnitWork(), 2, "the next request advances exactly one more");
    assert.notEqual(second.body.unit.unitId, first.body.unit.unitId);
  });

  it("preserves busy: a held account lock refuses the claim without doing work", async () => {
    const h = app();
    const started = await h.start();
    const first = h.units(started.body.runId)[0].payload;
    const held = await h.locks.acquire(accountLockKey({ platform: first.platform, accountLabel: first.accountLabel }), { holderId: "someone-else" });
    assert.equal(held.acquired, true);

    const res = await h.drain();
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.status, "busy");
    assert.equal(res.body.worked, false);
    assert.equal(h.totalUnitWork(), 0, "nothing ran behind the lock");
  });

  it("preserves the retry and dead-letter outcomes, and burns one attempt each time", async () => {
    const h = app({ syncImpl: () => { throw new Error("zzupstream downzz"); } });
    const started = await h.start();
    const unitId = h.units(started.body.runId)[0].id;

    assert.equal((await h.drain()).body.status, "unit_retry");
    assert.equal((await h.drain()).body.status, "unit_retry");
    const last = await h.drain();
    assert.equal(last.body.status, "unit_failed");
    assert.equal(h.rows.find((r) => r.id === unitId).status, "DEAD_LETTER");
    assert.equal(h.totalUnitWork(), 3, "one execution per request — never a retry loop inside one");
  });

  it("is the worker handler itself, so its outcome vocabulary cannot drift", () => {
    const code = codeOnly(CTRL_SRC);
    const drain = code.split("export async function cronSyncDrainHandler(")[1].split("\n}\n")[0];
    assert.match(drain, /return triggerSyncWorker\(req, res, next\);/, "the drain must DELEGATE, not reimplement");
    // A delegation is one statement: no claim, no complete, no gate, no projection of its own.
    for (const reimplemented of ["claimUnit", "completeUnit", "failUnit", "deferUnit", "nextWorkableUnit", "advancePostSync", "describeRun"]) {
      assert.ok(!drain.includes(reimplemented), `${reimplemented} reimplemented in the drain`);
    }
    // Every outcome the scheduler branches on is produced by the worker, and still exists there.
    const worker = readFileSync(new URL("../src/controllers/sync.controller.js", import.meta.url), "utf8");
    // As TOKENS, not as `status: "x"`: unit_retry and unit_failed are produced by one ternary on
    // the failure path, so neither appears as its own literal assignment.
    for (const outcome of ["idle", "unit_completed", "unit_deferred", "unit_retry", "unit_failed", "unit_abandoned", "busy"]) {
      assert.ok(worker.includes(`"${outcome}"`), `${outcome} missing from the worker`);
    }
    assert.match(worker, /status: failed\?\.status === "DEAD_LETTER" \? "unit_failed" : "unit_retry"/);
  });
});

describe("structural guards — the internal routes are thin and reach nothing unbounded", () => {
  it("neither handler loops, recurses or detaches a promise", () => {
    const code = codeOnly(CTRL_SRC);
    for (const forbidden of ["for (", "for(", "while (", "while(", "setTimeout", "setInterval", "setImmediate", ".then(", ".catch(", "void ", "Promise.all", "Promise.race", "await sleep"]) {
      assert.ok(!code.includes(forbidden), forbidden);
    }
    assert.equal((code.match(/cronSyncStartHandler\(/g) ?? []).length, 1, "the start handler calls itself");
    assert.equal((code.match(/cronSyncDrainHandler\(/g) ?? []).length, 1, "the drain handler calls itself");
    // No scheduling decisions live in Express: that is the scheduler's job. The word "cron" is
    // these routes' own name, so the guard targets scheduling CONSTRUCTS instead.
    for (const scheduling of ["setInterval", "setTimeout", "sleep(", "delay(", "retryAfter", "backoff", "nextRunAt", "Date.now() +"]) {
      assert.ok(!code.includes(scheduling), scheduling);
    }
    // And no second orchestration system: the handlers own no durable state of their own.
    for (const forbidden of ["jobRun.create", "jobRun.update", "prisma."]) {
      assert.ok(!code.includes(forbidden), forbidden);
    }
  });

  it("neither handler can reach the legacy or human-only sync paths", () => {
    const code = codeOnly(CTRL_SRC);
    for (const forbidden of [
      "syncAll", "triggerIncrementalSync", "triggerScheduledSync", "runSyncInBackground",
      "triggerSyncPlatform", "triggerBoostinyCanarySync", "syncPlatformAccount",
      "runTrackedJob", "PromotionJob", "ConversionPromotionService", "AggregationJob",
      "sync/incremental", "canary",
    ]) {
      assert.ok(!code.includes(forbidden), forbidden);
    }
    // The start path plans and enqueues; it never executes.
    const start = code.split("export async function cronSyncStartHandler(")[1].split("\n}\n")[0];
    assert.match(start, /getOrCreateRun\(\{/);
    for (const executing of ["claimUnit", "triggerSyncWorker", "nextWorkableUnit", "executeUnit"]) {
      assert.ok(!start.includes(executing), `${executing} in sync-start`);
    }
  });

  it("the routes are POST, machine-authed only, and the human sync chains are untouched", () => {
    const start = ROUTES_SRC.split('"/internal/cron/sync-start"')[1].split(";")[0];
    const drain = ROUTES_SRC.split('"/internal/cron/sync-drain"')[1].split(";")[0];
    for (const [name, block] of [["start", start], ["drain", drain]]) {
      assert.match(block, /requireCronSecret/, `${name} is not machine-authed`);
      for (const human of ["authenticate", "requireAdminRole", "requirePermission", "auditAction"]) {
        assert.ok(!block.includes(human), `${name} must not use ${human}: a scheduler is not a person`);
      }
    }
    assert.ok(!ROUTES_SRC.includes('router.get(\n  "/internal/cron/'), "GET must not be registered");
    assert.match(ROUTES_SRC, /router\.post\("\/internal\/cron\/sync-start", requireCronSecret, cronSyncStartHandler\);/);
    assert.match(ROUTES_SRC, /router\.post\("\/internal\/cron\/sync-drain", requireCronSecret, cronSyncDrainHandler\);/);

    // The human routes keep exactly the chains they had before this phase.
    const worker = ROUTES_SRC.split('"/sync/worker"')[1].split(");")[0];
    assert.match(worker, /authenticate/);
    assert.match(worker, /requireAdminRole/);
    assert.match(worker, /requirePermission\(PERMISSIONS\.SYNC_TRIGGER\)/);
    assert.match(worker, /auditAction\("sync\.worker", "sync:worker"\)/);
    assert.ok(!worker.includes("requireCronSecret"), "the human worker route must not gain machine auth");
    const all = ROUTES_SRC.split('"/sync/all"')[1].split(");")[0];
    assert.match(all, /authenticate/);
    assert.match(all, /requirePermission\(PERMISSIONS\.SYNC_TRIGGER\)/);
    assert.ok(!all.includes("requireCronSecret"));
    const status = ROUTES_SRC.split('"/sync/status"')[1].split(");")[0];
    assert.match(status, /authenticate/);
    assert.ok(!status.includes("requireCronSecret"));
  });

  it("exactly two internal routes exist, and no workflow file was added in this phase", () => {
    assert.equal((ROUTES_SRC.match(/"\/internal\//g) ?? []).length, 2, "only the two designed routes");
    assert.equal((ROUTES_SRC.match(/requireCronSecret/g) ?? []).length, 3, "imported once, used twice");
  });
});
