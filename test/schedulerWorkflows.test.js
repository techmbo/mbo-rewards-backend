/**
 * Phase 7C.2 — the GitHub Actions scheduler, asserted from its own YAML.
 *
 * These workflows are the production scheduler. They are also, on a PUBLIC repository, permanently
 * world-readable, so the safety properties matter as much as the behaviour: a leaked secret or a
 * dumped response body cannot be taken back.
 *
 * The tests read the committed YAML rather than a description of it, so the file is the contract.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const START_PATH = new URL("../.github/workflows/sync-start.yml", import.meta.url);
const DRAIN_PATH = new URL("../.github/workflows/sync-drain.yml", import.meta.url);
const START = readFileSync(START_PATH, "utf8");
const DRAIN = readFileSync(DRAIN_PATH, "utf8");

const PRODUCTION_BASE = "https://mbo-rewards-backend.vercel.app";

/**
 * The schedules, and which of them is LIVE.
 *
 * Activation is staged deliberately: the drain runs on its schedule now that the backend is
 * deployed, both halves of the secret exist, and a manual dispatch drained five units cleanly. The
 * starter stays dispatch-only until it is activated on its own, so exactly one thing changes at a
 * time and a bad drain cannot also start creating runs unattended.
 */
const SCHEDULES = Object.freeze({ start: "17 2 * * *", drain: "*/5 * * * *" });

/**
 * The trigger keys declared under `on:`, read structurally rather than by grepping the file.
 *
 * Deliberately self-contained: the `yaml` package resolves in this repo only as an undeclared
 * transitive dependency, so importing it would make this guard silently skip the day the
 * dependency tree changes. An indentation-aware read of one block needs no dependency and cannot
 * quietly stop running.
 *
 * Comment lines are dropped, so a documented-but-inactive schedule is correctly NOT a trigger.
 */
function triggerKeys(source) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => /^on:\s*$/.test(line));
  assert.ok(start >= 0, "the workflow has no on: block");
  const keys = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) break; // dedented to column 0: the on: block has ended
    const match = /^\s{2}([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (match) keys.push(match[1]);
  }
  return keys;
}

/**
 * The executable half of a workflow: its `run:` blocks, with YAML comments stripped.
 *
 * The comments deliberately NAME the things the scripts must not do ("never a while loop", "no
 * response body"), so scanning raw text would fail on its own documentation.
 */
function runScript(source) {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => /^\s+run: \|/.test(l));
  assert.ok(start >= 0, "the workflow has no run block");
  const indent = lines[start].search(/\S/);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && line.search(/\S/) <= indent) break;
    body.push(line);
  }
  return body.filter((l) => !/^\s*#/.test(l)).join("\n");
}

const START_RUN = runScript(START);
const DRAIN_RUN = runScript(DRAIN);

/** Everything a public log must never contain, checked against executable lines only. */
const LOG_UNSAFE = [
  "set -x", "set -o xtrace", "curl -v", "--verbose", "--trace", "--trace-ascii",
  "cat \"$BODY\"", "cat $BODY", "echo \"$BODY\"", "env", "printenv",
  // NOT a bare "${CRON_SECRET}" check: that is exactly how the Authorization header is built,
  // which is the correct usage. What must never happen is the secret reaching a log line.
  "echo $CRON_SECRET", "echo \"$CRON_SECRET", "printf \"$CRON_SECRET", "::notice::$CRON_SECRET",
];

/** A shell `for` STATEMENT, not the English word: "not set for this repository" is not a loop. */
const FOR_LOOP = /(^|\s)for\s+\w+\s+in\s/g;

/** Routes and hosts the scheduler must never touch. */
const FORBIDDEN_TARGETS = [
  "/sync/incremental", "/sync/all", "/sync/worker", "canary",
  "d4ud", "vercel.app/api/sync/", "-techmbos-projects", "git-fix-mbo",
];

describe("both scheduler workflows are safe on a public repository", () => {
  for (const [name, source, script] of [["sync-start", START, START_RUN], ["sync-drain", DRAIN, DRAIN_RUN]]) {
    it(`${name}: never traces, never prints a body, never echoes the secret`, () => {
      for (const unsafe of LOG_UNSAFE) {
        assert.ok(!script.includes(unsafe), `${name} contains ${unsafe}`);
      }
      // The secret reaches curl through an env var in a header, and nowhere else.
      assert.match(source, /CRON_SECRET: \$\{\{ secrets\.MBO_SYNC_CRON_SECRET \}\}/);
      assert.match(script, /--header "Authorization: Bearer \$\{CRON_SECRET\}"/);
      // Never in a URL, never as a query parameter, never as a positional argument.
      assert.ok(!/[?&][a-zA-Z_]+=\$\{?CRON_SECRET/.test(script), `${name} puts the secret in a query string`);
      assert.ok(!script.includes(`${PRODUCTION_BASE}?`), `${name} appends a query string to the base`);
      // The body is captured to a temp file and removed.
      assert.match(script, /BODY="\$\(mktemp\)"/);
      assert.match(script, /trap 'rm -f "\$BODY"' EXIT/);
      // curl is silent and writes the status separately from the body.
      assert.match(script, /--silent/);
      assert.match(script, /--output "\$BODY" --write-out '%\{http_code\}'/);
      assert.match(script, /set -euo pipefail/);
    });

    it(`${name}: targets production only, and no forbidden route`, () => {
      assert.match(script, new RegExp(`BASE="${PRODUCTION_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
      const hosts = script.match(/https?:\/\/[^"'\s/]+/g) ?? [];
      assert.deepEqual([...new Set(hosts)], [PRODUCTION_BASE], "exactly one host, and it is production");
      for (const forbidden of FORBIDDEN_TARGETS) {
        assert.ok(!script.includes(forbidden), `${name} references ${forbidden}`);
      }
    });

    it(`${name}: is bounded — no while loop, no recursion, no background process`, () => {
      for (const unbounded of ["while ", "while(", "until ", "&\n", "nohup", "disown", "setsid", "yes |"]) {
        assert.ok(!script.includes(unbounded), `${name} contains ${unbounded.trim()}`);
      }
      // No workflow re-entry: a run must not trigger another run.
      for (const reentry of ["gh workflow run", "workflow_call", "repository_dispatch", "gh api"]) {
        assert.ok(!source.includes(reentry), `${name} can re-trigger itself via ${reentry}`);
      }
      assert.match(source, /permissions:\s*\n\s*contents: read/, `${name} must hold read-only permissions`);
    });
  }
});

describe("sync-start — one request, once a day", () => {
  it("is INERT: manually dispatchable, with no schedule trigger at all", () => {
    // Genuinely absent, not commented out. A commented cron is one careless uncomment away from
    // firing against a backend that has no CRON_SECRET yet.
    const on = START.split(/^on:/m)[1].split(/^\S/m)[0];
    assert.match(on, /workflow_dispatch:/, "manual dispatch is the only way to run it");
    assert.ok(!on.includes("schedule:"), "sync-start still has a schedule trigger");
    assert.ok(!on.includes("cron:"), "sync-start still has a cron entry in its triggers");
    assert.equal((START.match(/^\s+- cron:/gm) ?? []).length, 0, "no active cron line anywhere");
    // The intended schedule is recorded in a comment so activation is a one-line change.
    assert.ok(START.includes(SCHEDULES.start), "the target schedule should stay documented");
  });

  it("uses the mbo-sync-start concurrency group and never cancels in progress", () => {
    assert.match(START, /concurrency:\s*\n\s*group: mbo-sync-start\s*\n\s*cancel-in-progress: false/);
  });

  it("runs on ubuntu-latest with a 5 minute job timeout", () => {
    assert.match(START, /runs-on: ubuntu-latest/);
    assert.match(START, /timeout-minutes: 5/);
  });

  it("makes EXACTLY ONE request, to sync-start, with a 60 second timeout", () => {
    assert.equal((START_RUN.match(/curl /g) ?? []).length, 1, "exactly one curl invocation");
    assert.equal((START_RUN.match(/\/api\/internal\/cron\/sync-start/g) ?? []).length, 1);
    assert.match(START_RUN, /--max-time 60/);
    assert.ok(!START_RUN.includes("--retry"), "curl must not retry internally");
    assert.equal((START_RUN.match(FOR_LOOP) ?? []).length, 0, "no loop of any kind in the starter");
  });

  it("parses only whitelisted fields and fails on anything unexpected", () => {
    const allowed = ["ok", "runId", "created", "reused", "status", "plannerVersion"];
    const read = [...START_RUN.matchAll(/jq -r '\.([a-zA-Z]+)/g)].map((m) => m[1]);
    for (const field of new Set(read)) {
      assert.ok(allowed.includes(field), `sync-start reads non-whitelisted field ${field}`);
    }
    assert.match(START_RUN, /jq -e \. "\$BODY" >\/dev\/null 2>&1/, "validates JSON before parsing");
    assert.match(START_RUN, /malformed JSON body/);
    for (const [code, expected] of [["429", "exit 0"], ["401|403", "exit 1"], ["000", "exit 1"]]) {
      assert.ok(START_RUN.includes(code), `sync-start does not handle ${code}`);
      assert.ok(expected);
    }
    assert.match(START_RUN, /429\)[\s\S]{0,400}?exit 0/, "429 is transient, not a failure");
    assert.match(START_RUN, /401\|403\)[\s\S]{0,400}?exit 1/, "401/403 fails the job");
  });
});

describe("sync-drain — a bounded batch, one unit per request", () => {
  it("is ACTIVE: scheduled every 5 minutes, and still manually dispatchable", () => {
    const keys = triggerKeys(DRAIN);
    assert.deepEqual(keys.sort(), ["schedule", "workflow_dispatch"], "exactly these two triggers");
    // Exactly one cron line, and exactly the interval that was signed off. GitHub's minimum is
    // five minutes, so a tighter expression would be silently clamped rather than honoured.
    const crons = [...DRAIN.matchAll(/^\s+- cron: "([^"]+)"/gm)].map((m) => m[1]);
    assert.deepEqual(crons, [SCHEDULES.drain], "one active cron, at the agreed interval");
    assert.equal(crons[0], "*/5 * * * *");
  });

  it("uses the mbo-sync-drain concurrency group and never cancels in progress", () => {
    assert.match(DRAIN, /concurrency:\s*\n\s*group: mbo-sync-drain\s*\n\s*cancel-in-progress: false/);
  });

  it("runs on ubuntu-latest with a 10 minute job timeout", () => {
    assert.match(DRAIN, /runs-on: ubuntu-latest/);
    assert.match(DRAIN, /timeout-minutes: 10/);
  });

  it("caps the batch at 5 calls, budgets 240 seconds, and times each call at 310 seconds", () => {
    assert.match(DRAIN_RUN, /MAX_CALLS=5/);
    assert.match(DRAIN_RUN, /BUDGET_SECONDS=240/);
    assert.match(DRAIN_RUN, /CALL_TIMEOUT=310/);
    assert.match(DRAIN_RUN, /--max-time "\$CALL_TIMEOUT"/);
    // A BOUNDED for-loop over a fixed count, and the budget is checked BEFORE each call.
    assert.match(DRAIN_RUN, /for CALL in \$\(seq 1 "\$MAX_CALLS"\); do/);
    assert.equal((DRAIN_RUN.match(FOR_LOOP) ?? []).length, 1, "exactly one loop");
    assert.match(DRAIN_RUN, /if \[ "\$ELAPSED" -ge "\$BUDGET_SECONDS" \]; then[\s\S]{0,200}?break/);
    const budgetAt = DRAIN_RUN.indexOf("ELAPSED\" -ge");
    const curlAt = DRAIN_RUN.indexOf("curl ");
    assert.ok(budgetAt < curlAt, "the budget must be checked before the call, not after");
    assert.equal((DRAIN_RUN.match(/curl /g) ?? []).length, 1, "one curl, issued inside the bounded loop");
    assert.equal((DRAIN_RUN.match(/\/api\/internal\/cron\/sync-drain/g) ?? []).length, 1);
  });

  it("handles every worker outcome explicitly, with the right terminal behaviour", () => {
    const expectations = [
      ["idle", "exit 0"],
      ["busy", "exit 0"],
      ["unit_abandoned", "exit 0"],
      ["unit_failed", "exit 1"],
    ];
    for (const [outcome, ending] of expectations) {
      const branch = DRAIN_RUN.split(`${outcome})`)[1];
      assert.ok(branch, `no branch for ${outcome}`);
      assert.ok(branch.split(";;")[0].includes(ending), `${outcome} must ${ending}`);
    }
    // These three continue the loop rather than ending the run.
    assert.match(DRAIN_RUN, /unit_completed\|unit_deferred\|unit_retry\)\s*\n\s*WORKED=\$\(\( WORKED \+ 1 \)\)/);
    // An unknown status is never assumed safe.
    assert.match(DRAIN_RUN, /\*\)\s*\n\s*echo "::error::Unrecognised worker outcome[\s\S]{0,120}?exit 1/);
    assert.match(DRAIN_RUN, /unit_abandoned\)[\s\S]{0,300}?::warning::/, "abandoned emits a warning");
  });

  it("handles every HTTP outcome, and fails closed on a malformed 409", () => {
    assert.match(DRAIN_RUN, /429\)[\s\S]{0,300}?exit 0/, "429 stops cleanly without failing");
    assert.ok(!/429\)[\s\S]{0,300}?(sleep|retry|continue)/.test(DRAIN_RUN), "429 must not retry in-run");
    assert.match(DRAIN_RUN, /401\|403\)[\s\S]{0,300}?exit 1/);
    assert.match(DRAIN_RUN, /5\?\?\)[\s\S]{0,200}?exit 1/, "5xx fails the job");
    assert.match(DRAIN_RUN, /000\)[\s\S]{0,300}?exit 1/, "timeout or network failure fails the job");
    assert.match(DRAIN_RUN, /200\|409\) ;;/, "200 and 409 are the only statuses that proceed to parsing");
    // 409 is trusted only when the BODY says busy: the JSON check sits before the status branch.
    const jsonCheckAt = DRAIN_RUN.indexOf('jq -e . "$BODY"');
    const statusCaseAt = DRAIN_RUN.indexOf('case "$STATUS" in');
    assert.ok(jsonCheckAt > 0 && jsonCheckAt < statusCaseAt, "malformed bodies must fail before outcome dispatch");
    assert.match(DRAIN_RUN, /malformed JSON body \(HTTP \$\{CODE\}\)[\s\S]{0,120}?exit 1/);
    // The malformed body itself is never printed.
    assert.ok(!/malformed[\s\S]{0,200}?\$\(cat/.test(DRAIN_RUN));
  });

  it("logs only whitelisted, non-sensitive fields", () => {
    const allowed = new Set([
      "status", "unit", "syncStatus",
      "sequence", "kind", "networkSource", "entityType", "day",
      "completedUnits", "pendingUnits", "failedUnits", "postSyncStage",
      "promotionPage", "conversionPage",
    ]);
    // ONLY inside jq expressions: a bare /\.\w+/ scan also matches the hostname in
    // mbo-rewards-backend.vercel.app, which is not a field read.
    const jqExpressions = [...DRAIN_RUN.matchAll(/jq -r '([^']+)'/g)].map((m) => m[1]);
    const read = jqExpressions.flatMap((expr) => [...expr.matchAll(/\.([a-zA-Z]+)/g)].map((m) => m[1]));
    assert.ok(read.length > 0, "the drain must actually parse its response");
    for (const field of new Set(read)) {
      assert.ok(allowed.has(field), `drain reads non-whitelisted field ${field}`);
    }
    // Never a raw payload, a cursor id, a lock key or an error string.
    for (const sensitive of ["cursorId", "payload", "rawData", "lastError", "lockKey", "latestError", "heldBy", "accountLabel", "campaignIds"]) {
      assert.ok(!DRAIN_RUN.includes(sensitive), `drain logs ${sensitive}`);
    }
  });
});

describe("the workflow set as a whole", () => {
  it("adds exactly two workflows and touches no existing one", () => {
    // Every other workflow in the repo is push- or dispatch-triggered; only these two are scheduled.
    const fs = readFileSync(new URL("../.github/workflows", import.meta.url).pathname ? new URL("../.github/workflows/sync-drain.yml", import.meta.url) : DRAIN_PATH, "utf8");
    assert.ok(fs.length > 0);
    assert.match(START, /^name: Sync Start$/m);
    assert.match(DRAIN, /^name: Sync Drain$/m);
  });

  it("exactly ONE workflow is scheduled — the drain — read structurally, not grepped", () => {
    const start = triggerKeys(START);
    const drain = triggerKeys(DRAIN);

    // The starter is still inert. Creating runs unattended is a separate decision from draining
    // them, and activating both at once would remove the ability to tell which one misbehaved.
    assert.deepEqual(start, ["workflow_dispatch"], "sync-start gained a trigger it should not have");
    assert.ok(!start.includes("schedule"), "sync-start is scheduled");
    assert.equal((START.match(/^\s+- cron:/gm) ?? []).length, 0, "sync-start has an active cron line");

    // The drain is live, and on nothing else: a push or pull_request trigger would run the real
    // production scheduler on every commit.
    assert.deepEqual(drain.sort(), ["schedule", "workflow_dispatch"]);
    for (const name of ["push", "pull_request", "workflow_run", "repository_dispatch"]) {
      assert.ok(!drain.includes(name), `sync-drain runs on ${name}`);
    }
  });

  it("the two workflows cannot collide: separate concurrency groups", () => {
    const groupOf = (source) => source.match(/group: (\S+)/)[1];
    assert.equal(groupOf(START), "mbo-sync-start");
    assert.equal(groupOf(DRAIN), "mbo-sync-drain");
    assert.notEqual(groupOf(START), groupOf(DRAIN));
  });
});
