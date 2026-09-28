import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CONNECTION_AUDIT_TYPE,
  ConnectionError,
  NEW_CONNECTION_SWITCHES,
  NetworkConnectionService,
  summariseTestResult,
} from "../src/modules/integrations/networkConnection.service.js";
import {
  createAwsSecretsManagerProvider,
  registerCredentialProvider,
  resetCredentialProvidersForTests,
} from "../src/modules/integrations/credentials/credentialResolver.js";

const NOW = new Date("2026-09-27T10:00:00.000Z");

afterEach(() => resetCredentialProvidersForTests());

function store(initial = []) {
  const rows = initial.map((r) => ({ ...r }));
  let seq = rows.length;
  return {
    rows,
    marketplaceAccount: {
      findMany: async () => rows.map((r) => ({ ...r })),
      findUnique: async ({ where }) => {
        const hit = where.id
          ? rows.find((r) => r.id === where.id)
          : rows.find((r) => r.platform === where.platform_accountLabel.platform && r.accountLabel === where.platform_accountLabel.accountLabel);
        return hit ? { ...hit } : null;
      },
      create: async ({ data }) => {
        const row = { id: `nc-${++seq}`, updatedAt: NOW, ...data };
        rows.push(row);
        return { ...row };
      },
      update: async ({ where, data }) => {
        const row = rows.find((r) => r.id === where.id);
        Object.assign(row, data);
        return { ...row };
      },
    },
  };
}

function harness({ rows = [], certify = null, resolveSlots = null, startScopedRun = null } = {}) {
  const db = store(rows);
  const audits = [];
  const certifyCalls = [];
  const service = new NetworkConnectionService({
    prisma: db,
    now: () => NOW,
    audit: { record: async (event) => audits.push(event) },
    certify:
      certify ??
      (async (network, options) => {
        certifyCalls.push({ network, options });
        return { results: [{ sourceObject: options.sourceObjects[0], ok: true, statusCategory: "OK", sampleCount: 1, fieldPaths: [{ path: "id" }] }] };
      }),
    resolveSlots: resolveSlots ?? (async () => ({ provider: "env", values: {}, missingRequired: [] })),
    startScopedRun,
  });
  return { service, db, audits, certifyCalls };
}

const actor = { id: "u1", email: "ops@example.test" };
const code = async (promise) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ConnectionError, error?.message);
    return error.code;
  }
  return null;
};

describe("create — the server builds the reference; no request can carry a secret", () => {
  it("creates Optimise SEA paused, campaign-only, provider-referenced and audited", async () => {
    const { service, db, audits } = harness();
    const dto = await service.create({ platform: "optimise_sea", credentialProvider: "env" }, { actor });
    const row = db.rows[0];
    assert.equal(row.secretRef, "env:optimise_sea");
    assert.equal(row.credentialSource, "PROVIDER_REF");
    assert.equal(row.encryptedAccessToken, null);
    assert.equal(row.pausedReason, "PENDING_ACTIVATION");
    assert.deepEqual(dto.switches, NEW_CONNECTION_SWITCHES);
    assert.equal(dto.switches.campaignSyncEnabled, true);
    assert.equal(dto.switches.conversionSyncEnabled, false);
    assert.equal(dto.paused, true);
    assert.equal(dto.credentialProvider, "env");
    assert.ok(!JSON.stringify(dto).includes("env:optimise_sea"));
    assert.equal(audits.length, 1);
    assert.equal(audits[0].aggregateType, CONNECTION_AUDIT_TYPE);
    assert.equal(audits[0].action, "network_connection.create");
    assert.equal(audits[0].actorEmail, actor.email);
    assert.equal(audits[0].before, null);
    assert.ok(!JSON.stringify(audits[0]).includes("env:optimise_sea"));
  });

  it("refuses secrets, references, variable names and anything else not in the contract", async () => {
    const { service, db } = harness();
    for (const extra of [{ apiKey: "x" }, { secretRef: "env:DATABASE_URL" }, { envName: "DATABASE_URL" }, { encryptedAccessToken: "x" }, { pausedAt: null }]) {
      assert.equal(await code(service.create({ platform: "optimise_sea", credentialProvider: "env", ...extra })), "unsupported_fields");
    }
    assert.equal(db.rows.length, 0);
  });

  it("refuses unknown platforms, providers, labels, environments and switches", async () => {
    const { service } = harness();
    assert.equal(await code(service.create({ platform: "rakuten", credentialProvider: "env" })), "platform_not_allowed");
    assert.equal(await code(service.create({ platform: "awin", credentialProvider: "vault" })), "invalid_provider");
    assert.equal(await code(service.create({ platform: "awin", credentialProvider: "aws-sm" })), "provider_not_configured");
    assert.equal(await code(service.create({ platform: "awin", credentialProvider: "env", accountLabel: "../etc" })), "invalid_account_label");
    assert.equal(await code(service.create({ platform: "awin", credentialProvider: "env", environment: "staging" })), "invalid_environment");
    assert.equal(await code(service.create({ platform: "awin", credentialProvider: "env", switches: { deleteAll: true } })), "invalid_switches");
    assert.equal(await code(service.create({ platform: "awin", credentialProvider: "env", switches: { campaignSyncEnabled: "yes" } })), "invalid_switches");
  });

  it("the env provider backs exactly one connection per platform", async () => {
    const { service } = harness();
    assert.equal(await code(service.create({ platform: "boostiny", credentialProvider: "env", accountLabel: "second" })), "env_provider_single_account");
  });

  it("an existing connection is never overwritten", async () => {
    const { service } = harness({ rows: [{ id: "x", platform: "awin", accountLabel: "default" }] });
    assert.equal(await code(service.create({ platform: "awin", credentialProvider: "env" })), "connection_exists");
  });

  it("a create that loses the unique-constraint race is a 409, not a 500", async () => {
    const { service, db, audits } = harness();
    db.marketplaceAccount.create = async () => {
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    };
    assert.equal(await code(service.create({ platform: "awin", credentialProvider: "env" })), "connection_exists");
    assert.equal(audits.length, 0);
  });

  it("an AWS-backed connection gets the canonical secret id for its own platform/environment/label", async () => {
    registerCredentialProvider(createAwsSecretsManagerProvider({ fetchSecretString: async () => "{}" }));
    const { service, db } = harness();
    await service.create({ platform: "boostiny", accountLabel: "mbo-main", credentialProvider: "aws-sm", environment: "SANDBOX" });
    assert.equal(db.rows[0].secretRef, "aws-sm:mbo/sandbox/networks/boostiny/mbo-main");
  });
});

describe("test → resume → initial sync", () => {
  const pending = () => ({
    id: "c1",
    platform: "optimise_sea",
    accountLabel: "default",
    environment: "PRODUCTION",
    credentialSource: "PROVIDER_REF",
    secretRef: "env:optimise_sea",
    pausedAt: NOW,
    pausedReason: "PENDING_ACTIVATION",
    credentialHealth: "UNKNOWN",
    syncEnabled: true,
    campaignSyncEnabled: true,
  });

  it("resume and initial sync are refused before a passing test", async () => {
    const { service } = harness({ rows: [pending()] });
    assert.equal(await code(service.resume("c1", {}, { actor })), "test_required");
    assert.equal(await code(service.initialSync("c1", { actor })), "connection_paused");
  });

  it("Test Connection makes one read-only campaigns probe and records a value-free verdict", async () => {
    const { service, db, certifyCalls, audits } = harness({ rows: [pending()] });
    const out = await service.test("c1", { actor });
    assert.deepEqual(certifyCalls, [{ network: "optimise", options: { sourceObjects: ["campaigns"], region: "sea", accountLabel: "default", compareRaw: false } }]);
    assert.equal(out.test.status, "PASSED");
    assert.equal(db.rows[0].lastTestStatus, "PASSED");
    assert.equal(db.rows[0].credentialHealth, "HEALTHY");
    assert.equal(db.rows[0].lastTestAt, NOW);
    assert.ok(!("fieldPaths" in db.rows[0].lastTestResult));
    assert.equal(db.rows[0].pausedAt, NOW, "testing never resumes");
    assert.equal(audits.at(-1).action, "network_connection.test");
  });

  it("missing credentials are reported by slot without any supplier call", async () => {
    const { service, db, certifyCalls } = harness({
      rows: [pending()],
      resolveSlots: async () => ({ provider: "env", values: {}, missingRequired: ["contactId"] }),
    });
    const out = await service.test("c1", { actor });
    assert.equal(out.test.status, "NOT_CONFIGURED");
    assert.deepEqual(out.test.missingSlots, ["contactId"]);
    assert.equal(certifyCalls.length, 0);
    assert.equal(db.rows[0].credentialHealth, "NOT_CONFIGURED");
  });

  it("a 401 probe marks the credentials FAILED with a safe code and no supplier text", async () => {
    const { service, db } = harness({
      rows: [pending()],
      certify: async () => ({ results: [{ sourceObject: "campaigns", ok: false, statusCategory: "AUTH", supplierStatusCode: 401, supplierMessage: "Invalid key abc" }] }),
    });
    const out = await service.test("c1", { actor });
    assert.equal(out.test.status, "FAILED");
    assert.equal(db.rows[0].credentialHealth, "FAILED");
    assert.equal(db.rows[0].lastFailureCode, "HTTP_401");
    assert.ok(!JSON.stringify(db.rows[0].lastTestResult).includes("Invalid key"));
  });

  it("after a pass: resume, then a campaigns-only initial sync through the scoped durable run", async () => {
    const started = [];
    const { service, db, audits } = harness({
      rows: [pending()],
      startScopedRun: async (scope) => {
        started.push(scope);
        return { runId: "run-1", created: true };
      },
    });
    await service.test("c1", { actor });
    const resumed = await service.resume("c1", { reason: "Optimise SEA go-live approved" }, { actor });
    assert.equal(resumed.paused, false);
    assert.equal(db.rows[0].pausedReason, null);
    const out = await service.initialSync("c1", { actor });
    assert.deepEqual(started, [{ platform: "optimise_sea", accountLabel: "default", sourceObject: "campaigns" }]);
    assert.equal(out.run.runId, "run-1");
    assert.deepEqual(
      audits.map((a) => a.action),
      ["network_connection.test", "network_connection.resume", "network_connection.initial_sync"],
    );
    assert.equal(audits[1].reason, "Optimise SEA go-live approved");
  });

  it("a failure recorded after the last test requires a fresh test before resume", async () => {
    const { service } = harness({
      rows: [{ ...pending(), lastTestStatus: "PASSED", lastTestAt: new Date("2026-09-01"), lastFailureAt: new Date("2026-09-02"), pausedReason: "AUTH_FAILED" }],
    });
    assert.equal(await code(service.resume("c1", {}, { actor })), "test_required");
  });

  it("initial sync is refused when campaign sync is switched off, and for Impact (no bounded source)", async () => {
    const { service } = harness({
      rows: [
        { ...pending(), pausedAt: null, lastTestStatus: "PASSED", campaignSyncEnabled: false },
        { id: "i1", platform: "impact", accountLabel: "default", credentialSource: "PROVIDER_REF", secretRef: "env:impact", pausedAt: null },
      ],
      startScopedRun: async () => ({ runId: "x" }),
    });
    assert.equal(await code(service.initialSync("c1", { actor })), "campaign_sync_disabled");
    assert.equal(await code(service.initialSync("i1", { actor })), "initial_sync_unavailable");
    assert.equal(await code(service.test("i1", { actor })), "test_unavailable");
  });
});

describe("update and pause", () => {
  const active = () => ({
    id: "c2",
    platform: "trackier",
    accountLabel: "default",
    environment: "PRODUCTION",
    credentialSource: "PROVIDER_REF",
    secretRef: "env:trackier",
    pausedAt: null,
    lastTestStatus: "PASSED",
    lastTestAt: NOW,
    credentialHealth: "HEALTHY",
  });

  it("switches update in place; unknown switches and secret fields are refused", async () => {
    const { service, db } = harness({ rows: [active()] });
    const dto = await service.update("c2", { switches: { couponSyncEnabled: true } }, { actor });
    assert.equal(dto.switches.couponSyncEnabled, true);
    assert.equal(db.rows[0].couponSyncEnabled, true);
    assert.equal(await code(service.update("c2", { apiKey: "x" })), "unsupported_fields");
    assert.equal(await code(service.update("c2", { secretRef: "env:DATABASE_URL" })), "unsupported_fields");
    assert.equal(await code(service.update("c2", {})), "nothing_to_update");
  });

  it("changing provider rebuilds the reference and discards the previous test verdict", async () => {
    registerCredentialProvider(createAwsSecretsManagerProvider({ fetchSecretString: async () => "{}" }));
    const { service, db } = harness({ rows: [active()] });
    await service.update("c2", { credentialProvider: "aws-sm" }, { actor });
    assert.equal(db.rows[0].secretRef, "aws-sm:mbo/production/networks/trackier/default");
    assert.equal(db.rows[0].lastTestStatus, null);
    assert.equal(db.rows[0].credentialHealth, "UNKNOWN");
  });

  it("pause records MANUAL and is idempotent", async () => {
    const { service, db, audits } = harness({ rows: [active()] });
    await service.pause("c2", { reason: "supplier maintenance" }, { actor });
    assert.equal(db.rows[0].pausedReason, "MANUAL");
    await service.pause("c2", {}, { actor });
    assert.equal(audits.length, 1);
  });

  it("an encrypted legacy connection is not managed here", async () => {
    const { service } = harness({ rows: [{ ...active(), credentialSource: "ENCRYPTED_DB", secretRef: "mbo-sm://local-encrypted/network-account/c2" }] });
    assert.equal(await code(service.update("c2", { switches: { syncEnabled: false } })), "connection_not_provider_managed");
    assert.equal(await code(service.test("c2")), "connection_not_provider_managed");
  });

  it("unknown ids are 404", async () => {
    const { service } = harness();
    assert.equal(await code(service.get("nope")), "connection_not_found");
  });
});

describe("summaries and wiring", () => {
  it("summariseTestResult keeps categories and counts only", () => {
    const s = summariseTestResult(
      { results: [{ sourceObject: "profile", ok: true, statusCategory: "OK", sampleCount: 1, fieldPaths: [{ path: "email" }], supplierMessage: "hi" }] },
      { network: "trackier", sourceObject: "profile" },
    );
    assert.deepEqual(s.result, { network: "trackier", region: null, sourceObject: "profile", ok: true, statusCategory: "OK", supplierStatusCode: null, sampleCount: 1, readOnly: true });
  });

  it("routes: reads need integrations:read, changes need integrations:manage, initial sync is admin + sync:trigger", () => {
    const routes = readFileSync("src/routes/index.js", "utf8");
    const block = routes.split("// Network Connections")[1].split('router.get("/ops/admin/commission-vocabulary"')[0];
    for (const mutation of ["createNetworkConnectionHandler", "updateNetworkConnectionHandler", "pauseNetworkConnectionHandler", "resumeNetworkConnectionHandler", "testNetworkConnectionHandler", "initialSyncNetworkConnectionHandler"]) {
      const route = block.split(mutation)[0].split("router.").at(-1);
      assert.match(route, /PERMISSIONS\.INTEGRATIONS_MANAGE/, mutation);
      assert.match(route, /connectionAudit\(/, mutation);
    }
    const initial = block.split("initialSyncNetworkConnectionHandler")[0].split("router.").at(-1);
    assert.match(initial, /requireAdminRole/);
    assert.match(initial, /PERMISSIONS\.SYNC_TRIGGER/);
    const test = block.split("testNetworkConnectionHandler")[0].split("router.").at(-1);
    assert.match(test, /certificationRateLimiter/);
  });

  it("the legacy connect endpoint refuses to overwrite a provider-managed connection", () => {
    const controller = readFileSync("src/controllers/marketplaceAccounts.controller.js", "utf8");
    assert.match(controller, /existing\?\.credentialSource === "PROVIDER_REF"/);
    assert.match(controller, /connection_provider_managed/);
  });
});
