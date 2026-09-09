/**
 * TEMPORARY preview-only Optimise certification route.
 *
 * These prove the GATE and the forced parameters. They are not evidence of
 * supplier behaviour: every dependency here is injected.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CERTIFICATION_TOKEN_HEADER,
  FORCED_MAX_CAMPAIGNS,
  FORCED_REGION,
  PREVIEW_CERTIFICATION_ROUTE,
  createOptimiseCertificationPreviewHandler,
  isPreviewRuntime,
  tokenMatches,
} from "../src/routes/internal/optimiseCertificationPreview.js";
import { sanitizeDeep, sanitizeErrorMessage } from "../scripts/lib/optimiseCertification.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROUTE_PATH = path.join(here, "..", "src", "routes", "internal", "optimiseCertificationPreview.js");

const REAL_TOKEN = "temporary-certification-token-value";

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

/** Records exactly what the handler asked the certification core to do. */
function fakeDependencies({ certification = null, credentials = null, onRun = () => {} } = {}) {
  const calls = { runCertification: [], adapterCreated: 0, httpClientCreated: 0 };
  const report = certification ?? {
    fieldReport: {
      statusCounts: { LIVE_VERIFIED: 1 },
      fields: [{ mboField: "campaignName", status: "LIVE_VERIFIED", normalizedValue: "Spring Sale" }],
      mappingGaps: [],
      newSupplierConcepts: [],
      redactions: [],
      fieldConflicts: [],
      ruleLineage: [],
      reviewRequired: [],
      listDetailConflicts: [],
      authorityRule: {},
    },
    meta: {
      campaignsCertified: 1,
      campaignListPages: 1,
      campaignListRequests: 1,
      detailRequestsIssued: 1,
      campaignDetailResponsesSucceeded: 1,
      campaignRowsWithDetailEvidence: 1,
      rowsReusingCachedDetail: 0,
      commissionGroupsFetched: 2,
      normalizedRuleCount: 2,
      detailRequestFailures: [],
      commissionRequestFailures: [],
      writesPerformed: 0,
      supplierMutations: 0,
    },
  };

  return {
    calls,
    load: async () => ({
      runCertification: async (options) => {
        calls.runCertification.push(options);
        onRun(options);
        return report;
      },
      renderSummaryMarkdown: () => "# Optimise live certification — SEA / default\n",
      sanitizeDeep,
      sanitizeErrorMessage,
      createHttpClient: () => {
        calls.httpClientCreated += 1;
        return { get: async () => ({ status: 200, data: { response: [] } }) };
      },
      createOptimiseAdapter: () => {
        calls.adapterCreated += 1;
        return { fetchCampaignDetail: async () => null, fetchCommissionGroups: async () => ({ groups: [] }) };
      },
      resolveOptimiseCredentials: async () =>
        credentials ?? {
          apiKey: "live-key-must-never-be-returned",
          agencyId: "118",
          contactId: "9001",
          accountLabel: "default",
          baseURL: "https://public.api.optimisemedia.com/v1",
          agencyMismatch: false,
          sources: { apiKey: "marketplace_account:API_KEY" },
        },
      selectOptimiseCommissionGroupCampaigns: (rows) => ({
        campaigns: rows.map((row) => ({ campaignId: String(row.id), currency: null })),
        campaignsInspected: rows.length,
        skippedNoId: 0,
        skippedByScope: 0,
        skippedDuplicate: 0,
        skippedByCap: 0,
      }),
    }),
  };
}

async function invoke({ env, headers = {}, deps = fakeDependencies() }) {
  const handler = createOptimiseCertificationPreviewHandler({ env, loadDependencies: deps.load });
  const res = mockRes();
  let nextError = null;
  await handler({ headers, body: {} }, res, (error) => {
    nextError = error;
  });
  return { res, deps, nextError };
}

const previewEnv = { VERCEL_ENV: "preview", CERTIFICATION_TOKEN: REAL_TOKEN };

test("production runtime: the route does not exist and the core is never invoked", async () => {
  for (const vercelEnv of ["production", "development", undefined, ""]) {
    const { res, deps } = await invoke({
      env: { VERCEL_ENV: vercelEnv, CERTIFICATION_TOKEN: REAL_TOKEN },
      headers: { [CERTIFICATION_TOKEN_HEADER]: REAL_TOKEN },
    });

    assert.equal(res.statusCode, 404, `VERCEL_ENV=${vercelEnv} must 404`);
    assert.deepEqual(res.body, { ok: false, message: "Not found." });
    assert.equal(deps.calls.runCertification.length, 0, "no certification run");
    assert.equal(deps.calls.httpClientCreated, 0, "no supplier client built");
  }

  assert.equal(isPreviewRuntime({ VERCEL_ENV: "production" }), false);
  assert.equal(isPreviewRuntime({ VERCEL_ENV: "preview" }), true);
  assert.equal(isPreviewRuntime({}), false);
});

test("preview runtime without a token header: unavailable", async () => {
  const { res, deps } = await invoke({ env: previewEnv, headers: {} });

  assert.equal(res.statusCode, 404);
  assert.equal(deps.calls.runCertification.length, 0);
});

test("preview runtime with a wrong token: unavailable", async () => {
  for (const wrong of ["nope", `${REAL_TOKEN}x`, REAL_TOKEN.slice(0, -1), "", " "]) {
    const { res, deps } = await invoke({
      env: previewEnv,
      headers: { [CERTIFICATION_TOKEN_HEADER]: wrong },
    });

    assert.equal(res.statusCode, 404, `token "${wrong.slice(0, 4)}…" must 404`);
    assert.equal(deps.calls.runCertification.length, 0);
  }
});

test("preview runtime with no CERTIFICATION_TOKEN configured: unavailable", async () => {
  const { res, deps } = await invoke({
    env: { VERCEL_ENV: "preview" },
    headers: { [CERTIFICATION_TOKEN_HEADER]: REAL_TOKEN },
  });

  assert.equal(res.statusCode, 404);
  assert.equal(deps.calls.runCertification.length, 0);
});

test("token comparison is exact and rejects non-strings", () => {
  assert.equal(tokenMatches(REAL_TOKEN, REAL_TOKEN), true);
  assert.equal(tokenMatches("other", REAL_TOKEN), false);
  assert.equal(tokenMatches("", ""), false);
  assert.equal(tokenMatches(undefined, REAL_TOKEN), false);
  assert.equal(tokenMatches(REAL_TOKEN, undefined), false);
  assert.equal(tokenMatches(["array"], REAL_TOKEN), false);
  // Differing lengths must not throw (digests are always equal length).
  assert.equal(tokenMatches("a", REAL_TOKEN), false);
});

test("valid token invokes the reviewed certification core", async () => {
  const { res, deps } = await invoke({
    env: previewEnv,
    headers: { [CERTIFICATION_TOKEN_HEADER]: REAL_TOKEN },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(deps.calls.runCertification.length, 1);
  assert.equal(deps.calls.adapterCreated, 1);
  assert.ok(res.body.fieldCertificationReport, "the field report is returned");
  assert.match(res.body.summary, /Optimise live certification/);
  assert.equal(res.body.meta.region, "sea");
  assert.equal(res.body.meta.campaignsCertified, 1);
  assert.ok(Date.parse(res.body.meta.generatedAt) > 0, "generatedAt is a timestamp");
});

test("region and sample size are forced, and request input is ignored", async () => {
  const deps = fakeDependencies();
  const handler = createOptimiseCertificationPreviewHandler({ env: previewEnv, loadDependencies: deps.load });
  const res = mockRes();

  await handler(
    {
      headers: { [CERTIFICATION_TOKEN_HEADER]: REAL_TOKEN },
      // A caller trying to widen the run must have no effect at all.
      body: { region: "uk", maxCampaigns: 500, scope: "all", accountLabel: "someone-else" },
      query: { region: "mena", maxCampaigns: 99 },
    },
    res,
    () => {},
  );

  const [options] = deps.calls.runCertification;
  assert.equal(options.region, FORCED_REGION);
  assert.equal(options.region, "sea");
  assert.equal(options.maxCampaigns, FORCED_MAX_CAMPAIGNS);
  assert.equal(options.maxCampaigns, 1);
  assert.equal(options.accountLabel, "default");
  assert.equal(options.scope, "joined");
  assert.equal(res.body.meta.region, "sea");
});

test("incomplete credentials report NAMES only and never reach the supplier", async () => {
  const deps = fakeDependencies({
    credentials: { apiKey: null, agencyId: "118", contactId: null, baseURL: "https://public.api.optimisemedia.com/v1", agencyMismatch: false, sources: {} },
  });
  const { res } = await invoke({
    env: previewEnv,
    headers: { [CERTIFICATION_TOKEN_HEADER]: REAL_TOKEN },
    deps,
  });

  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body.missingCredentials, ["apiKey", "contactId"]);
  assert.equal(deps.calls.runCertification.length, 0, "no supplier call attempted");
  assert.ok(!JSON.stringify(res.body).includes("118"), "no configured value is echoed");
});

test("no write, mutation or persistence path exists in the route", () => {
  const source = fs.readFileSync(ROUTE_PATH, "utf8");

  assert.ok(!/database\/prisma/.test(source), "the route must not import prisma");
  assert.ok(!/prisma\.[A-Za-z]+\.(create|update|upsert|delete)/.test(source), "no prisma mutation");
  assert.ok(!/\.(createMany|updateMany|deleteMany|executeRaw)\(/.test(source), "no bulk write");
  assert.ok(!/PersistenceService/.test(source), "no persistence service");
  assert.ok(!/writeFile|mkdir|appendFile/.test(source), "nothing is written to disk");
  // Only the read-only certification core is called.
  assert.ok(/runCertification/.test(source));
  assert.ok(!/fetchOffsetPaginated/.test(source), "no pagination helper");
});

test("the response is sanitized and carries no secret-shaped value", async () => {
  // A credential leaks into the certification result; the sanitizer must catch
  // it on the way out even though the core already sanitizes internally.
  const poisoned = {
    fieldReport: {
      statusCounts: {},
      fields: [{ mboField: "campaignName", status: "LIVE_VERIFIED", normalizedValue: "Spring Sale" }],
      mappingGaps: [],
      newSupplierConcepts: [{ supplierJsonPath: "$.integration", sanitizedSampleValue: { apiKey: "LEAKED-KEY-VALUE" } }],
      redactions: [],
      fieldConflicts: [],
      ruleLineage: [],
      reviewRequired: [],
      listDetailConflicts: [],
      authorityRule: {},
      stray: { authorization: "Bearer LEAKED-TOKEN", notes: ["Bearer LEAKED-TOKEN"] },
    },
    meta: {
      campaignsCertified: 1,
      campaignListPages: 1,
      campaignListRequests: 1,
      detailRequestsIssued: 1,
      campaignDetailResponsesSucceeded: 1,
      campaignRowsWithDetailEvidence: 1,
      rowsReusingCachedDetail: 0,
      commissionGroupsFetched: 0,
      normalizedRuleCount: 0,
      detailRequestFailures: [{ campaignId: "1", httpStatus: 502, code: null, message: "failed apikey=LEAKED-KEY-VALUE" }],
      commissionRequestFailures: [],
      writesPerformed: 0,
      supplierMutations: 0,
    },
  };

  const deps = fakeDependencies({ certification: poisoned });
  const { res } = await invoke({
    env: previewEnv,
    headers: { [CERTIFICATION_TOKEN_HEADER]: REAL_TOKEN },
    deps,
  });

  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes("LEAKED-KEY-VALUE"), "no api key in the response");
  assert.match(res.body.meta.detailRequestFailures[0].message, /apikey=\[REDACTED\]/);
  assert.ok(!serialized.includes("LEAKED-TOKEN"), "no bearer token in the response");
  assert.ok(!serialized.includes(REAL_TOKEN), "the certification token is never echoed");
  assert.ok(!serialized.includes("live-key-must-never-be-returned"), "no resolved credential is returned");

  // Ordinary certification evidence survives.
  assert.equal(res.body.fieldCertificationReport.fields[0].normalizedValue, "Spring Sale");
  assert.equal(res.body.meta.writesPerformed, 0);
  assert.equal(res.body.meta.supplierMutations, 0);

  // Raw and normalized supplier payloads are not part of the response at all.
  assert.equal(res.body.campaignsRaw, undefined);
  assert.equal(res.body.campaignDetailsRaw, undefined);
  assert.equal(res.body.campaignsNormalized, undefined);
  assert.equal(res.body.rulesNormalized, undefined);
});

test("the route is registered exactly once, as a temporary POST endpoint", () => {
  const routerSource = fs.readFileSync(path.join(here, "..", "src", "routes", "index.js"), "utf8");

  assert.equal(PREVIEW_CERTIFICATION_ROUTE, "/internal/certification/optimise");
  assert.match(routerSource, /router\.post\(PREVIEW_CERTIFICATION_ROUTE, optimiseCertificationPreviewHandler\)/);
  assert.equal((routerSource.match(/PREVIEW_CERTIFICATION_ROUTE/g) ?? []).length, 2, "imported once, mounted once");
  assert.match(routerSource, /TEMPORARY/, "the registration is labelled temporary");

  // It must not sit behind normal user auth: its own gate is the control.
  assert.ok(
    !/router\.post\(PREVIEW_CERTIFICATION_ROUTE,\s*authenticate/.test(routerSource),
    "the preview gate, not user auth, controls this route",
  );
});
