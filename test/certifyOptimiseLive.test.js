/**
 * Tests for the Optimise live certification runner.
 *
 * These prove the RUNNER behaves safely. They are not, and must never be read
 * as, proof of live supplier behaviour: every response here is injected.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { selectOptimiseCommissionGroupCampaigns } from "../src/jobs/optimiseCommissionGroupSync.js";
import {
  AUTHORITY_CLASS,
  CAMPAIGN_LIST_MAX_ATTEMPTS,
  REVIEW_REASON_FIELDS,
  averageCommissionDisplay,
  campaignStatusEvidencePaths,
  reviewReasonForField,
  semanticComparison,
  outcomeEvidenceFor,
  relationshipEvidencePaths,
  safeRequestFailure,
  sanitizeErrorMessage,
  fetchCampaignListPage,
  materiallyDiffer,
  presentNamespaces,
  selectCertificationCampaigns,
  extractCampaignDetail,
  extractCampaignRows,
  mergeListAndDetail,
  FIELD_STATUS,
  MAX_CERTIFIED_CAMPAIGNS,
  REDACTED,
  assertStatusEnum,
  commissionPresentation,
  deriveStatus,
  discoverNewConcepts,
  networkSourceFor,
  renderSummaryMarkdown,
  runCertification,
  sanitizeDeep,
} from "../scripts/lib/optimiseCertification.mjs";
import {
  EVIDENCE_ROOT,
  REGION_ENV_NAMES,
  credentialReport,
  parseArgs,
  resolveOutputDir,
  safeAccountLabel,
} from "../scripts/certify-optimise-live.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CORE_PATH = path.join(here, "..", "scripts", "lib", "optimiseCertification.mjs");
const ROUTE_SOURCE_PATH = path.join(here, "..", "src", "routes", "internal", "optimiseCertificationPreview.js");
const CLI_PATH = path.join(here, "..", "scripts", "certify-optimise-live.mjs");

/** joinedCampaign() puts campaignId in its own namespace; use this to key fixtures. */
const campaignKey = (id) => String(Number(id) + 500000);

function joinedCampaign(id, overrides = {}) {
  return {
    // Distinct by construction: productId = id, campaignId = id + 500000, so a
    // cross-namespace substitution is immediately visible in any assertion.
    id,
    productId: String(id),
    campaignId: String(Number(id) + 500000),
    campaignName: `Campaign ${id}`,
    advertiserName: `Advertiser ${id}`,
    status: "live",
    publishers: [{ campaignSubStatus: "live" }],
    currencyCode: "USD",
    trackingURL: `https://track.example.com/${id}`,
    vertical: { primary: "Retail" },
    markets: [{ name: "Singapore" }],
    startDate: "2026-01-01",
    ...overrides,
  };
}

/**
 * HTTP transport double for the campaign LIST call. It always reports a full
 * page plus a `hasMore` marker, so a paginating implementation would keep going.
 */
function fakeHttpClient({ rows, envelope = null }) {
  const calls = [];
  return {
    calls,
    async get(url, config = {}) {
      calls.push({ url, params: config.params ?? {} });
      const limit = Number(config.params?.limit ?? rows.length);
      const page = rows.slice(0, limit);
      return {
        status: 200,
        data: envelope ? envelope(page) : { response: page, hasMore: true, totalCount: rows.length },
      };
    },
  };
}

/** Adapter double for the per-campaign GET calls. */
function fakeAdapter({ groupsByCampaign = {}, detailByCampaign = {}, detailError = null } = {}) {
  const calls = { fetchCampaignDetail: [], fetchCommissionGroups: [] };
  return {
    calls,
    agencyId: "118",
    contactId: "9001",
    async fetchCampaignDetail(productId) {
      calls.fetchCampaignDetail.push(String(productId));
      if (detailError) throw detailError;
      return detailByCampaign[String(productId)] ?? null;
    },
    async fetchCommissionGroups(campaignId) {
      calls.fetchCommissionGroups.push(String(campaignId));
      return {
        campaignId: String(campaignId),
        groups: groupsByCampaign[String(campaignId)] ?? [],
        envelopeKind: "array",
        httpStatus: 200,
        fetchedAt: new Date("2026-09-09T00:00:00.000Z"),
      };
    },
  };
}

function certify({ rows, adapter = fakeAdapter(), httpClient = null, envelope = null, ...options } = {}) {
  const client = httpClient ?? fakeHttpClient({ rows: rows ?? [], envelope });
  return runCertification({
    httpClient: client,
    adapter,
    region: "sea",
    accountLabel: "default",
    now: () => new Date("2026-09-09T00:00:00.000Z"),
    ...options,
  });
}

test("caps the certified campaign sample at 5 and issues one request per campaign", async () => {
  const rows = Array.from({ length: 12 }, (_, index) => joinedCampaign(1000 + index));
  const adapter = fakeAdapter();
  const httpClient = fakeHttpClient({ rows });

  const report = await certify({ rows, adapter, httpClient });

  assert.equal(report.meta.campaignsCertified, MAX_CERTIFIED_CAMPAIGNS);
  assert.equal(report.campaignsRaw.length, MAX_CERTIFIED_CAMPAIGNS);
  assert.equal(adapter.calls.fetchCampaignDetail.length, MAX_CERTIFIED_CAMPAIGNS);
  assert.equal(adapter.calls.fetchCommissionGroups.length, MAX_CERTIFIED_CAMPAIGNS);
  assert.equal(httpClient.calls.length, 1);
});

test("HARD CAP: exactly one outbound /campaigns request even when another page exists", async () => {
  // The transport returns a full page of 5 and advertises more pages. A
  // paginating implementation would issue a second request; this must not.
  const rows = Array.from({ length: 40 }, (_, index) => joinedCampaign(3000 + index));
  const httpClient = fakeHttpClient({ rows });

  const report = await certify({ rows, httpClient });

  const campaignListCalls = httpClient.calls.filter((call) => call.url === "/campaigns");
  assert.equal(campaignListCalls.length, 1, "exactly one GET /campaigns");
  assert.equal(httpClient.calls.length, 1, "no other request goes through this client");

  const [call] = campaignListCalls;
  assert.equal(call.params.limit, MAX_CERTIFIED_CAMPAIGNS);
  assert.equal(call.params.offset, 0);
  assert.equal(call.params.extendedData, true);
  assert.equal(call.params.returnPublishersForCampaign, true);
  assert.equal(call.params.agencyId, "118");
  assert.equal(call.params.contactId, "9001");

  assert.equal(report.meta.campaignListRequests, 1);
  assert.equal(report.meta.campaignListPage.paginationDisabled, true);
  assert.equal(report.meta.campaignListPage.rowsReturnedBySupplier, MAX_CERTIFIED_CAMPAIGNS);
  assert.equal(report.meta.campaignsCertified, MAX_CERTIFIED_CAMPAIGNS);
});

test("a supplier that ignores the limit cannot widen the sample", async () => {
  const rows = Array.from({ length: 30 }, (_, index) => joinedCampaign(4000 + index));
  // Envelope ignores `limit` and returns everything.
  const httpClient = fakeHttpClient({ rows, envelope: () => ({ response: rows }) });

  const report = await certify({ rows, httpClient });

  assert.equal(httpClient.calls.length, 1);
  assert.equal(report.meta.campaignListPage.truncatedBySupplierOverrun, true);
  assert.equal(report.meta.campaignListPage.rowsUsed, MAX_CERTIFIED_CAMPAIGNS);
  assert.equal(report.meta.campaignsCertified, MAX_CERTIFIED_CAMPAIGNS);
});

test("an explicit --max-campaigns above the hard cap cannot widen the sample", async () => {
  const rows = Array.from({ length: 20 }, (_, index) => joinedCampaign(2000 + index));

  const report = await certify({ rows, maxCampaigns: 50 });

  assert.equal(report.meta.campaignsCertified, MAX_CERTIFIED_CAMPAIGNS);
  assert.equal(parseArgs(["sea", "default", "--max-campaigns", "50"]).maxCampaigns, MAX_CERTIFIED_CAMPAIGNS);
});

test("only read methods are used and nothing is written", async () => {
  const forbidden = ["create", "update", "upsert", "delete", "createMany", "updateMany", "deleteMany", "executeRaw"];
  const adapter = fakeAdapter();
  const guarded = new Proxy(adapter, {
    get(target, property) {
      if (forbidden.includes(String(property))) {
        throw new Error(`Certification attempted a write method: ${String(property)}`);
      }
      return target[property];
    },
  });

  const report = await certify({ rows: [joinedCampaign(1)], adapter: guarded });

  assert.equal(report.meta.writesPerformed, 0);
  assert.equal(report.meta.supplierMutations, 0);

  // Structural proof: the certification core cannot reach the database at all.
  const coreSource = fs.readFileSync(CORE_PATH, "utf8");
  assert.ok(!/from\s+["'][^"']*database\/prisma/.test(coreSource), "core must not import prisma");
  assert.ok(!/PersistenceService|SupplierCommissionRuleService/.test(coreSource), "core must not import persistence");

  for (const source of [coreSource, fs.readFileSync(CLI_PATH, "utf8")]) {
    assert.ok(!/prisma\.[A-Za-z]+\.(create|update|upsert|delete)/.test(source), "no prisma mutation calls");
    assert.ok(!/\.(createMany|updateMany|deleteMany|executeRaw)\(/.test(source), "no bulk write calls");
  }
});

test("sanitizer removes credential-shaped fields but preserves campaign evidence", () => {
  const payload = {
    id: "555",
    campaignName: "Spring Sale",
    advertiserName: "Acme",
    currencyCode: "USD",
    commission: "5%",
    trackingURL: "https://track.example.com/555?sub=abc",
    countries: ["SG", "MY"],
    apikey: "should-not-appear",
    Authorization: "Bearer should-not-appear",
    nested: { password: "should-not-appear", contactEmail: "person@example.com", databaseUrl: "postgres://u:p@host/db" },
    connection: "postgresql://user:secretpw@localhost:5432/db",
  };

  const { value, redactions } = sanitizeDeep(payload);
  const serialized = JSON.stringify(value);

  assert.ok(!serialized.includes("should-not-appear"), "credential values must not survive");
  assert.ok(!serialized.includes("secretpw"), "embedded connection-string password must not survive");
  assert.ok(!serialized.includes("person@example.com"), "PII must not survive");

  assert.equal(value.campaignName, "Spring Sale");
  assert.equal(value.advertiserName, "Acme");
  assert.equal(value.currencyCode, "USD");
  assert.equal(value.commission, "5%");
  assert.equal(value.trackingURL, "https://track.example.com/555?sub=abc");
  assert.deepEqual(value.countries, ["SG", "MY"]);
  assert.equal(value.id, "555");

  assert.equal(value.apikey, REDACTED);
  assert.equal(value.connection, REDACTED);
  assert.ok(redactions.length >= 5, "every redaction is reported by path");
  assert.ok(redactions.every((entry) => typeof entry.path === "string" && typeof entry.reason === "string"));
});

test("explicit zero commission survives into the certification output", async () => {
  const report = await certify({
    rows: [joinedCampaign(300)],
    adapter: fakeAdapter({ groupsByCampaign: { [campaignKey(300)]: [{ id: "gz", name: "Zero Group", commission: "0%" }] } }),
  });
  const [entry] = report.rulesNormalized;

  assert.equal(entry.ruleCount, 1);
  assert.equal(entry.rules[0].ratePercent, 0);
  assert.equal(entry.rules[0].commissionType, "PERCENTAGE");
  assert.equal(entry.presentation.outcomes[0].explicitZero, true);

  // A zero rate is a real value, never "missing".
  const rateField = report.fieldReport.fields.find(
    (field) => field.scope === "commission" && field.mboField === "ratePercent",
  );
  assert.equal(rateField.status, "LIVE_VERIFIED");
  assert.equal(rateField.normalizedValue, 0);
});

test("multiple commission outcomes stay separate and are never flattened or averaged into one", async () => {
  const report = await certify({
    rows: [joinedCampaign(400)],
    adapter: fakeAdapter({
      groupsByCampaign: {
        [campaignKey(400)]: [
          { id: "g1", name: "Standard", commission: "5%" },
          { id: "g2", name: "Premium", commission: "12%" },
          { id: "g3", name: "Flat", commission: "USD 8" },
        ],
      },
    }),
  });
  const [entry] = report.rulesNormalized;

  assert.equal(entry.ruleCount, 3);
  assert.equal(new Set(entry.rules.map((rule) => rule.outcomeKey)).size, 3, "outcome keys stay distinct");
  assert.equal(entry.presentation.outcomeCount, 3);
  assert.deepEqual(
    entry.presentation.outcomes.map((outcome) => outcome.label),
    ["Commission 1", "Commission 2", "Commission 3"],
  );
  assert.equal(entry.presentation.distinctRulesPreserved, true);

  // Percent and fixed together is MIXED, and a mixed set yields no average.
  assert.equal(entry.presentation.mixed, true);
  assert.equal(entry.presentation.averageDisplay, "MIXED");
  assert.equal(entry.presentation.averageUsableAsFinancialInput, false);
});

test("a uniform percent set produces a display-only average that is never a financial input", () => {
  const presentation = commissionPresentation([
    { commissionType: "PERCENTAGE", ratePercent: 4, fixedAmount: null, currency: null },
    { commissionType: "PERCENTAGE", ratePercent: 6, fixedAmount: null, currency: null },
  ]);

  assert.equal(presentation.mixed, false);
  assert.equal(presentation.averageDisplay, "5%");
  assert.equal(presentation.averageIsDisplayOnly, true);
  assert.equal(presentation.averageUsableAsFinancialInput, false);
  assert.equal(presentation.outcomeCount, 2);
});

test("banded groups keep one canonical rule per band", async () => {
  const report = await certify({
    rows: [joinedCampaign(500)],
    adapter: fakeAdapter({
      groupsByCampaign: {
        [campaignKey(500)]: [
          {
            id: "gb",
            name: "Banded",
            bandType: "orderValue",
            bands: [{ lower: 0, upper: 100, commission: "3%" }, { lower: 100, commission: "6%" }],
          },
        ],
      },
    }),
  });
  const [entry] = report.rulesNormalized;

  assert.equal(entry.ruleCount, 2);
  assert.deepEqual(entry.rules.map((rule) => rule.ratePercent), [3, 6]);
  assert.ok(entry.rules.every((rule) => rule.commissionModel === "BANDED:orderValue"));
  assert.equal(new Set(entry.rules.map((rule) => rule.couponOrTier)).size, 2);
});

test("detailed commission groups are RULE_DEFINITION and campaign summary is SUMMARY_ONLY", async () => {
  const report = await certify({
    rows: [joinedCampaign(600, { commissionCost: "7%" })],
    adapter: fakeAdapter({ groupsByCampaign: { [campaignKey(600)]: [{ id: "g1", name: "Standard", commission: "5%" }] } }),
  });

  const summaryField = report.fieldReport.fields.find((field) => field.mboField === "campaignCommissionSummary");
  assert.equal(summaryField.sourceAuthorityClass, "SUMMARY_ONLY");

  const ruleFields = report.fieldReport.fields.filter((field) => field.scope === "commission");
  assert.ok(ruleFields.length > 0);
  assert.ok(ruleFields.every((field) => field.sourceAuthorityClass === "RULE_DEFINITION"));

  assert.equal(report.fieldReport.authorityRule["GET /campaigns/{campaignId}/commission-groups"], "RULE_DEFINITION");

  // The campaign-level summary never becomes a canonical rule.
  assert.equal(report.rulesNormalized[0].ruleCount, 1);
  assert.equal(report.rulesNormalized[0].rules[0].sourceGroupId, "g1");
});

test("region selection drives the network source and the credential variable names", () => {
  assert.equal(networkSourceFor("sea"), "optimise_sea");
  assert.equal(networkSourceFor("MENA"), "optimise_mena");
  assert.equal(networkSourceFor("uk"), "optimise_uk");

  assert.equal(parseArgs(["mena", "house"]).region, "mena");
  assert.equal(parseArgs(["mena", "house"]).accountLabel, "house");
  assert.equal(parseArgs(["uk"]).accountLabel, "default");
  assert.equal(parseArgs(["sea", "default", "--scope", "all"]).scope, "all");
  assert.equal(parseArgs(["sea"]).scope, "joined");

  assert.equal(REGION_ENV_NAMES.sea.apiKey, "OPTIMISE_API_KEY");
  assert.equal(REGION_ENV_NAMES.mena.apiKey, "OPTIMISE_MENA_API_KEY");
  assert.equal(REGION_ENV_NAMES.uk.contactId, "OPTIMISE_UK_CONTACT_ID");
});

test("incomplete credentials fail safely and never echo a secret", () => {
  const report = credentialReport(
    { apiKey: null, agencyId: "118", contactId: null, accountLabel: "default", baseURL: "https://public.api.optimisemedia.com/v1", sources: {} },
    "sea",
  );

  assert.equal(report.complete, false);
  assert.equal(report.missing.length, 2);
  assert.ok(report.missing.some((line) => line.includes("OPTIMISE_API_KEY")));
  assert.ok(report.missing.some((line) => line.includes("OPTIMISE_SEA_CONTACT_ID")));

  const printed = report.lines.join("\n");
  assert.ok(printed.includes("apiKey: MISSING"));
  assert.ok(printed.includes("agencyId: PRESENT"));
  assert.ok(printed.includes("base URL host: public.api.optimisemedia.com"));
  assert.ok(!printed.includes("https://public.api.optimisemedia.com/v1"), "only the host is printed, never a full URL");
});

test("a complete credential set is reported without printing any value", () => {
  const secret = "live-key-must-never-print";
  const report = credentialReport(
    {
      apiKey: secret,
      agencyId: "118",
      contactId: "9001",
      accountLabel: "Main Account!",
      baseURL: "https://public.api.optimisemedia.com/v1",
      sources: { apiKey: "marketplace_account:API_KEY" },
    },
    "sea",
  );

  const printed = report.lines.join("\n");
  assert.equal(report.complete, true);
  assert.ok(!printed.includes(secret));
  assert.ok(!printed.includes("9001"), "contactId is reported as PRESENT, never echoed");
  assert.ok(printed.includes("database credential source available: YES"));
  assert.equal(safeAccountLabel("Main Account!"), "MainAccount");
});

test("every emitted field status and authority class is a member of the enum", async () => {
  const report = await certify({
    rows: [joinedCampaign(700)],
    adapter: fakeAdapter({ groupsByCampaign: { [campaignKey(700)]: [{ id: "g1", name: "Standard", commission: "5%" }] } }),
  });

  assert.ok(report.fieldReport.fields.length > 0);
  for (const field of report.fieldReport.fields) {
    assert.ok(FIELD_STATUS.includes(field.status), `unexpected status ${field.status}`);
    assert.ok(AUTHORITY_CLASS.includes(field.sourceAuthorityClass), `unexpected class ${field.sourceAuthorityClass}`);
  }

  const total = Object.values(report.fieldReport.statusCounts).reduce((sum, count) => sum + count, 0);
  assert.equal(total, report.fieldReport.fields.length);

  assert.throws(
    () => assertStatusEnum([{ mboField: "x", status: "PROBABLY_FINE", sourceAuthorityClass: "RULE_DEFINITION" }]),
    /Invalid certification status/,
  );
  assert.throws(
    () => assertStatusEnum([{ mboField: "x", status: "LIVE_VERIFIED", sourceAuthorityClass: "TRUST_ME" }]),
    /Invalid sourceAuthorityClass/,
  );
});

test("status derivation distinguishes a lost value from an untraceable one", () => {
  assert.equal(deriveStatus({ rawPresent: true, normalizedValue: "Acme" }), "LIVE_VERIFIED");
  assert.equal(deriveStatus({ rawPresent: true, normalizedValue: null }), "MAPPING_GAP");
  assert.equal(deriveStatus({ rawPresent: true, normalizedValue: "UNKNOWN" }), "MAPPING_GAP");
  assert.equal(deriveStatus({ rawPresent: false, normalizedValue: "derived" }), "VERIFY_LIVE");
  assert.equal(deriveStatus({ rawPresent: false, normalizedValue: null }), "MAPPED_NOT_IN_SAMPLE");
  assert.equal(deriveStatus({ rawPresent: true, normalizedValue: "x", notAvailable: true }), "NOT_AVAILABLE_FROM_ENDPOINT");
  assert.equal(deriveStatus({ rawPresent: true, normalizedValue: "x", reviewReason: "payout_basis_unknown" }), "REVIEW_REQUIRED");

  // Zero and false are real supplier values, not absences.
  assert.equal(deriveStatus({ rawPresent: true, normalizedValue: 0 }), "LIVE_VERIFIED");
  assert.equal(deriveStatus({ rawPresent: true, normalizedValue: false }), "LIVE_VERIFIED");
});

test("unrecognized supplier fields are surfaced as new concepts, sanitized", () => {
  const concepts = discoverNewConcepts({
    id: "1",
    campaignName: "Known",
    newCommissionLadder: [{ tier: 1, payout: "4%" }],
    apikey: "must-not-appear",
  });

  const ladder = concepts.find((concept) => concept.supplierJsonPath === "$.newCommissionLadder");
  assert.ok(ladder, "unknown supplier field is reported");
  assert.equal(ladder.conceptKind, "commission");
  assert.equal(ladder.currentMboResult, "not carried by current normalization");

  const key = concepts.find((concept) => concept.supplierJsonPath === "$.apikey");
  assert.ok(key, "even an unexpected credential-shaped key is reported as a concept");
  assert.ok(!JSON.stringify(concepts).includes("must-not-appear"), "its value is still redacted");
});

test("mapping gaps are recorded for review and never auto-corrected", async () => {
  // Optimise returns advertiserId, but the canonical campaign carries no
  // supplier merchant id — a real value the normalization drops today.
  const report = await certify({ rows: [joinedCampaign(800, { advertiserId: "77" })] });
  const gap = report.fieldReport.mappingGaps.find((entry) => entry.proposedMboStandardField === "supplierMerchantId");

  assert.ok(gap, "a lost supplier value is reported as MAPPING_GAP");
  assert.equal(gap.supplierJsonPath, "list:$.advertiserId");
  assert.equal(gap.sanitizedSampleValue, "77");
  assert.equal(gap.conceptKind, "identity");
  assert.match(gap.proposedMinimalCorrection, /do not change production mapping/i);

  // The gap is reported only. No production mapping is altered by the runner.
  const merchantField = report.fieldReport.fields.find((field) => field.mboField === "supplierMerchantId");
  assert.equal(merchantField.status, "MAPPING_GAP");
  assert.equal(merchantField.normalizedValue, null);
});

test("a field the mapper nests under normalizedPayload still certifies as verified", async () => {
  const report = await certify({ rows: [joinedCampaign(810, { terms: "Standard affiliate terms" })] });
  const termsField = report.fieldReport.fields.find((field) => field.mboField === "terms");

  assert.equal(termsField.rawSourcePath, "terms");
  assert.equal(termsField.status, "LIVE_VERIFIED");
  assert.equal(termsField.normalizedValue, "Standard affiliate terms");
});

test("the summary renders the counts, authority rule and gap review posture", async () => {
  const markdown = renderSummaryMarkdown(
    await certify({
      rows: [joinedCampaign(900)],
      adapter: fakeAdapter({ groupsByCampaign: { [campaignKey(900)]: [{ id: "g1", name: "Standard", commission: "5%" }] } }),
    }),
  );

  assert.match(markdown, /# Optimise live certification — SEA \/ default/);
  assert.match(markdown, /Database writes: 0 · Supplier mutations: 0/);
  assert.match(markdown, /LIVE_VERIFIED/);
  assert.match(markdown, /display only, never a financial input/);
  assert.match(markdown, /GET \/campaigns\/500900\/commission-groups/, "commission groups use the campaignId namespace");
  assert.match(markdown, /GET \/campaigns\/900\b/, "detail uses the productId namespace");
});

test("a failed commission-group request is recorded, never silently treated as empty", async () => {
  const adapter = {
    agencyId: "118",
    contactId: "9001",
    async fetchCampaignDetail() {
      return null;
    },
    async fetchCommissionGroups() {
      const error = new Error("upstream 503");
      error.response = { status: 503 };
      throw error;
    },
  };

  const report = await certify({ rows: [joinedCampaign(1)], adapter });

  assert.equal(report.meta.commissionRequestFailures.length, 1);
  assert.equal(report.meta.commissionRequestFailures[0].httpStatus, 503);
  assert.equal(report.meta.normalizedRuleCount, 0);
  assert.equal(report.rulesNormalized.length, 0, "a failure never yields an invented empty rule set");
});

test("the six evidence artifacts are written and carry no credential values", async () => {
  const { mkdtemp, readFile, readdir, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const { writeArtifacts } = await import("../scripts/certify-optimise-live.mjs");

  const report = await certify({
    rows: [joinedCampaign(950, { apikey: "must-not-reach-disk", contactEmail: "person@example.com" })],
    adapter: fakeAdapter({ groupsByCampaign: { [campaignKey(950)]: [{ id: "g1", name: "Standard", commission: "5%" }] } }),
  });

  const dir = await mkdtemp(path.join(os.tmpdir(), "optimise-cert-"));
  try {
    const written = await writeArtifacts(dir, report);

    assert.deepEqual(written, [
      "01-campaigns-raw.sanitized.json",
      "02-campaign-details-raw.sanitized.json",
      "03-campaigns-mbo-normalized.json",
      "04-commission-groups-raw.sanitized.json",
      "05-commission-rules-mbo-normalized.json",
      "06-field-certification-report.json",
      "07-summary.md",
    ]);
    assert.deepEqual((await readdir(dir)).sort(), [...written].sort());

    for (const name of written) {
      const contents = await readFile(path.join(dir, name), "utf8");
      assert.ok(!contents.includes("must-not-reach-disk"), `${name} must not contain a credential value`);
      assert.ok(!contents.includes("person@example.com"), `${name} must not contain PII`);
      if (name.endsWith(".json")) JSON.parse(contents);
    }

    // Ordinary supplier evidence must survive into the raw artifact.
    const raw = JSON.parse(await readFile(path.join(dir, "01-campaigns-raw.sanitized.json"), "utf8"));
    assert.equal(raw.campaigns[0].raw.campaignName, "Campaign 950");
    assert.equal(raw.campaigns[0].raw.apikey, REDACTED);

    const groups = JSON.parse(await readFile(path.join(dir, "04-commission-groups-raw.sanitized.json"), "utf8"));
    assert.equal(groups.commissionGroups[0].groups[0].commission, "5%");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("campaign detail is fetched for every selected campaign and preserved separately", async () => {
  const adapter = fakeAdapter({
    detailByCampaign: { 1200: { id: 1200, description: "Detail-only description", terms: "Detail terms" } },
  });

  const report = await certify({ rows: [joinedCampaign(1200)], adapter });

  assert.deepEqual(adapter.calls.fetchCampaignDetail, ["1200"]);
  assert.equal(report.campaignDetailsRaw.length, 1);
  assert.equal(report.campaignDetailsRaw[0].fetched, true);
  assert.equal(report.campaignDetailsRaw[0].raw.description, "Detail-only description");
  assert.equal(report.meta.detailRequestsIssued, 1);
  assert.equal(report.meta.campaignDetailResponsesSucceeded, 1);
  assert.equal(report.meta.campaignRowsWithDetailEvidence, 1);

  // List and detail stay in separate artifacts.
  assert.equal(report.campaignsRaw[0].raw.description, undefined);
  assert.ok(report.meta.endpointsCalled.includes("GET /campaigns/1200"));
});

test("a field present only in campaign detail is certified against its detail path", async () => {
  const report = await certify({
    rows: [joinedCampaign(1210)],
    adapter: fakeAdapter({ detailByCampaign: { 1210: { id: 1210, terms: "Detail-only terms" } } }),
  });

  const termsField = report.fieldReport.fields.find((field) => field.mboField === "terms");

  assert.equal(termsField.rawValuePresent, true);
  assert.equal(termsField.rawSourceOrigin, "detail");
  assert.equal(termsField.qualifiedRawSourcePath, "detail:$.terms");
  assert.equal(termsField.status, "LIVE_VERIFIED");
  assert.equal(termsField.normalizedValue, "Detail-only terms");

  assert.ok(report.campaignsNormalized[0].detailOnlyKeys.includes("terms"));
});

test("NOT_AVAILABLE_FROM_ENDPOINT requires absence from BOTH list and detail", async () => {
  const withoutEvidence = await certify({ rows: [joinedCampaign(1220)] });
  const absent = withoutEvidence.fieldReport.fields.find((field) => field.mboField === "productCapability");
  assert.equal(absent.status, "NOT_AVAILABLE_FROM_ENDPOINT");

  const withDetailEvidence = await certify({
    rows: [joinedCampaign(1221)],
    adapter: fakeAdapter({ detailByCampaign: { 1221: { id: 1221, productFeedUrl: "https://feeds.example.com/1221.csv" } } }),
  });
  const present = withDetailEvidence.fieldReport.fields.find((field) => field.mboField === "productCapability");

  assert.notEqual(present.status, "NOT_AVAILABLE_FROM_ENDPOINT");
  assert.equal(present.status, "VERIFY_LIVE");
  assert.equal(present.rawSourceOrigin, "detail");
  assert.equal(present.qualifiedRawSourcePath, "detail:$.productFeedUrl");
});

test("advertiser identity found only in detail is still reported as an identity MAPPING_GAP", async () => {
  const report = await certify({
    rows: [joinedCampaign(1230)],
    adapter: fakeAdapter({ detailByCampaign: { 1230: { id: 1230, advertiserId: "A-99" } } }),
  });

  const gap = report.fieldReport.mappingGaps.find((entry) => entry.proposedMboStandardField === "supplierMerchantId");

  assert.ok(gap, "detail-sourced advertiser identity is a gap too");
  assert.equal(gap.supplierJsonPath, "detail:$.advertiserId");
  assert.equal(gap.sourceResponse, "detail");
  assert.equal(gap.sanitizedSampleValue, "A-99");
  assert.equal(gap.conceptKind, "identity");
  assert.equal(gap.currentMboResult, null);
  assert.match(gap.proposedMinimalCorrection, /do not change production mapping/i);
});

test("a failed campaign-detail request is recorded and never invented", async () => {
  const error = new Error("detail unavailable");
  error.response = { status: 404 };
  const report = await certify({ rows: [joinedCampaign(1240)], adapter: fakeAdapter({ detailError: error }) });

  assert.equal(report.meta.detailRequestFailures.length, 1);
  assert.equal(report.meta.detailRequestFailures[0].httpStatus, 404);
  assert.equal(report.meta.detailRequestFailures[0].identifierKind, "productId", "detail fails against a productId, not a campaignId");
  assert.equal(report.campaignDetailsRaw[0].fetched, false);
  assert.equal(report.campaignDetailsRaw[0].raw, null);
  // Certification still proceeds on the list evidence alone.
  assert.equal(report.meta.campaignsCertified, 1);
});

test("list and detail disagreements are recorded, with the list value kept", async () => {
  const report = await certify({
    rows: [joinedCampaign(1250, { status: "live" })],
    adapter: fakeAdapter({ detailByCampaign: { 1250: { id: 1250, status: "paused", terms: "T" } } }),
  });

  const [entry] = report.meta.listDetailConflicts;
  assert.ok(entry, "a disagreement between two real responses is surfaced");
  const conflict = entry.conflicts.find((item) => item.key === "status");
  assert.equal(conflict.listValue, "live");
  assert.equal(conflict.detailValue, "paused");

  const { merged } = mergeListAndDetail({ status: "live" }, { status: "paused", terms: "T" });
  assert.equal(merged.status, "live", "list wins, matching what the production sync stores");
  assert.equal(merged.terms, "T", "detail fills what the list omits");
});

test("a nested credential cannot survive through rawPayload, normalizedPayload, rawRuleReference or nested arrays", async () => {
  const poison = "nested-secret-must-not-survive";
  const report = await certify({
    rows: [
      joinedCampaign(1260, {
        // Nested object, nested array, and array-of-objects, all carrying secrets.
        integration: {
          credentials: { apiKey: poison },
          settings: { apiKey: poison, timeoutMs: 30000 },
          endpoints: [{ authorization: `Bearer ${poison}`, url: "https://api.example.com" }],
        },
        publishers: [{ campaignSubStatus: "live", accessToken: poison }],
      }),
    ],
    adapter: fakeAdapter({
      detailByCampaign: { 1260: { id: 1260, owner: { contactEmail: "person@example.com", secret: poison } } },
      groupsByCampaign: {
        [campaignKey(1260)]: [{ id: "g1", name: "Standard", commission: "5%", meta: { tokens: [{ token: poison }] } }],
      },
    }),
  });

  const everything = JSON.stringify(report);
  assert.ok(!everything.includes(poison), "no artifact may carry the nested credential");
  assert.ok(!everything.includes("person@example.com"), "no artifact may carry nested PII");

  // Each specific carrier the production mapper creates.
  const normalized = report.campaignsNormalized[0].normalized;
  // A whole credential-named subtree is redacted outright.
  assert.equal(normalized.rawPayload.integration.credentials, REDACTED);
  // A credential key nested inside an ordinary object is redacted in place,
  // leaving its harmless siblings intact.
  assert.equal(normalized.rawPayload.integration.settings.apiKey, REDACTED);
  assert.equal(normalized.rawPayload.integration.settings.timeoutMs, 30000);
  // Inside an array of objects.
  assert.equal(normalized.rawPayload.integration.endpoints[0].authorization, REDACTED);
  assert.equal(normalized.rawPayload.integration.endpoints[0].url, "https://api.example.com");
  assert.equal(normalized.rawPayload.publishers[0].accessToken, REDACTED);
  assert.ok(JSON.stringify(normalized.normalizedPayload).length > 0);

  const rule = report.rulesNormalized[0].rules[0];
  // `tokens` is itself a credential-shaped key, so the whole array goes.
  assert.equal(rule.rawRuleReference.group.meta.tokens, REDACTED);
  assert.equal(rule.metadata.commissionGroupId, "g1", "ordinary rule evidence survives sanitization");

  // And the ordinary campaign evidence is untouched.
  assert.equal(normalized.rawPayload.publishers[0].campaignSubStatus, "live");
  assert.equal(report.campaignsRaw[0].raw.campaignName, "Campaign 1260");
});

test("campaign list and detail envelopes are read safely and fail closed when unrecognised", () => {
  assert.deepEqual(extractCampaignRows([{ id: 1 }]).rows, [{ id: 1 }]);
  assert.deepEqual(extractCampaignRows({ response: [{ id: 2 }] }).rows, [{ id: 2 }]);
  assert.deepEqual(extractCampaignRows({ data: { results: [{ id: 3 }] } }).rows, [{ id: 3 }]);
  assert.deepEqual(extractCampaignRows({ id: 4 }).rows, [{ id: 4 }]);
  assert.deepEqual(extractCampaignRows(null).rows, []);

  // An unrecognised non-empty envelope must never read as "zero campaigns".
  assert.throws(() => extractCampaignRows({ unexpected: { shape: true } }), /envelope not recognised/);

  assert.deepEqual(extractCampaignDetail({ data: { id: 9 } }), { id: 9 });
  assert.deepEqual(extractCampaignDetail([{ id: 10 }]), { id: 10 });
  assert.deepEqual(extractCampaignDetail({ id: 11 }), { id: 11 });
  assert.equal(extractCampaignDetail(null), null);
});


/* ------------------------------------------------------------------ *
 * Rule 1 — list/detail conflict must be REVIEW_REQUIRED
 * ------------------------------------------------------------------ */

test("a conflicting list/detail value becomes REVIEW_REQUIRED, not LIVE_VERIFIED", async () => {
  const report = await certify({
    rows: [joinedCampaign(2100, { status: "live" })],
    adapter: fakeAdapter({ detailByCampaign: { 2100: { id: 2100, status: "paused" } } }),
  });

  const field = report.fieldReport.fields.find((entry) => entry.mboField === "campaignStatus");

  assert.equal(field.status, "REVIEW_REQUIRED");
  assert.equal(field.statusReason, "supplier_list_detail_conflict");
  assert.equal(field.listDetailConflict, true);
  assert.equal(field.listSourcePath, "list:$.status");
  assert.equal(field.listValue, "live");
  assert.equal(field.detailSourcePath, "detail:$.status");
  assert.equal(field.detailValue, "paused");
  // Production precedence is untouched: the canonical value is still the list one.
  assert.equal(field.normalizedValue, "ACTIVE");

  const conflict = report.fieldReport.fieldConflicts.find((entry) => entry.mboField === "campaignStatus");
  assert.ok(conflict, "the conflict is recorded in fieldConflicts");
  assert.equal(conflict.reason, "supplier_list_detail_conflict");
  // The reporting label names both namespaces; the identifiers are explicit.
  assert.equal(conflict.campaignKey, "productId=2100 campaignId=502100");
});

test("the conflict rule covers identity, relationship, geography, money, dates, URLs and terms", async () => {
  const report = await certify({
    rows: [
      joinedCampaign(2110, {
        advertiserId: "LIST-1",
        status: "live",
        publishers: [{ campaignSubStatus: "live" }],
        markets: [{ name: "Singapore" }],
        currencyCode: "USD",
        startDate: "2026-01-01",
        endDate: "2026-06-01",
        trackingURL: "https://track.example.com/list",
        deepLinkURL: "https://shop.example.com/list",
        commissionCost: "5%",
        terms: "List terms",
        campaignName: "List name",
        advertiserName: "List advertiser",
      }),
    ],
    adapter: fakeAdapter({
      detailByCampaign: {
        2110: {
          id: 2110,
          advertiserId: "DETAIL-1",
          status: "paused",
          publishers: [{ campaignSubStatus: "pending" }],
          markets: [{ name: "Malaysia" }],
          currencyCode: "SGD",
          startDate: "2026-02-01",
          endDate: "2026-07-01",
          trackingURL: "https://track.example.com/detail",
          deepLinkURL: "https://shop.example.com/detail",
          commissionCost: "9%",
          terms: "Detail terms",
          campaignName: "Detail name",
          advertiserName: "Detail advertiser",
        },
      },
    }),
  });

  const byField = new Map(report.fieldReport.fields.filter((f) => f.scope === "campaign").map((f) => [f.mboField, f]));
  const mustReview = [
    "supplierMerchantId",
    "campaignStatus",
    "relationshipStatus",
    "isJoined",
    "countries",
    "currency",
    "startDate",
    "endDate",
    "supplierTrackingUrl",
    "destinationUrl",
    "campaignCommissionSummary",
    "terms",
    "campaignName",
    "merchantName",
  ];

  for (const mboField of mustReview) {
    const field = byField.get(mboField);
    assert.ok(field, `${mboField} is certified`);
    assert.equal(field.status, "REVIEW_REQUIRED", `${mboField} must be REVIEW_REQUIRED on conflict`);
    assert.equal(field.statusReason, "supplier_list_detail_conflict", `${mboField} reason`);
    assert.ok(field.listValue !== null && field.detailValue !== null, `${mboField} keeps both supplier values`);
  }

  assert.equal(report.fieldReport.fieldConflicts.length >= mustReview.length, true);
});

test("formatting-only differences are not conflicts", async () => {
  const report = await certify({
    rows: [joinedCampaign(2120, { status: "live", startDate: "2026-01-01" })],
    adapter: fakeAdapter({
      detailByCampaign: { 2120: { id: 2120, status: " LIVE ", startDate: "2026-01-01T00:00:00.000Z" } },
    }),
  });

  const status = report.fieldReport.fields.find((entry) => entry.mboField === "campaignStatus");
  const startDate = report.fieldReport.fields.find((entry) => entry.mboField === "startDate");

  assert.equal(status.listDetailConflict, false, "case and whitespace are not a material difference");
  assert.equal(status.status, "LIVE_VERIFIED");
  assert.equal(startDate.listDetailConflict, false, "the same instant in two formats is not a conflict");
  assert.equal(report.fieldReport.fieldConflicts.length, 0);
});

test("materiallyDiffer ignores formatting but catches real disagreement", () => {
  assert.equal(materiallyDiffer("live", " LIVE "), false);
  assert.equal(materiallyDiffer("2026-01-01", "2026-01-01T00:00:00.000Z"), false);
  assert.equal(materiallyDiffer(["SG"], ["SG"]), false);
  assert.equal(materiallyDiffer(5, 5), false);
  assert.equal(materiallyDiffer("live", "paused"), true);
  assert.equal(materiallyDiffer(["SG"], ["MY"]), true);
  assert.equal(materiallyDiffer("2026-01-01", "2026-02-01"), true);
  // Date.parse accepts these as 2001-01-01; they must still read as different.
  assert.equal(materiallyDiffer("LIST-1", "DETAIL-1"), true);
  assert.equal(materiallyDiffer("ADV-7", "ADV-8"), true);
  // A value present on only one side is not a conflict; it is coverage.
  assert.equal(materiallyDiffer(null, "paused"), false);
  assert.equal(materiallyDiffer("live", undefined), false);
});

/* ------------------------------------------------------------------ *
 * Rule 2 — a failed detail request cannot prove absence
 * ------------------------------------------------------------------ */

test("terms absent from the list with a failed detail request is VERIFY_LIVE, never NOT_AVAILABLE_FROM_ENDPOINT", async () => {
  const error = new Error("detail unavailable");
  error.response = { status: 500 };
  const listRow = joinedCampaign(2200);
  delete listRow.terms;

  const report = await certify({ rows: [listRow], adapter: fakeAdapter({ detailError: error }) });

  const terms = report.fieldReport.fields.find((entry) => entry.mboField === "terms");

  assert.equal(terms.rawValuePresent, false);
  assert.equal(terms.status, "VERIFY_LIVE");
  assert.notEqual(terms.status, "NOT_AVAILABLE_FROM_ENDPOINT");
  assert.equal(terms.statusReason, "campaign_detail_request_failed");
  assert.equal(report.meta.detailRequestFailures.length, 1);
});

test("a failed detail request also blocks NOT_AVAILABLE_FROM_ENDPOINT for capability probes", async () => {
  const error = new Error("detail unavailable");
  error.response = { status: 503 };

  const report = await certify({ rows: [joinedCampaign(2210)], adapter: fakeAdapter({ detailError: error }) });

  for (const mboField of ["couponCapability", "productCapability"]) {
    const field = report.fieldReport.fields.find((entry) => entry.mboField === mboField);
    assert.equal(field.status, "VERIFY_LIVE", `${mboField} cannot be proven absent`);
    assert.equal(field.statusReason, "campaign_detail_request_failed");
  }

  assert.equal(
    report.fieldReport.fields.filter((f) => f.scope === "campaign" && f.status === "NOT_AVAILABLE_FROM_ENDPOINT").length,
    0,
    "nothing may be declared unavailable while an endpoint went unanswered",
  );
});

test("NOT_AVAILABLE_FROM_ENDPOINT still applies when both endpoints answered and the field was absent", async () => {
  const report = await certify({
    rows: [joinedCampaign(2220)],
    adapter: fakeAdapter({ detailByCampaign: { 2220: { id: 2220, description: "Present" } } }),
  });

  const productCapability = report.fieldReport.fields.find((entry) => entry.mboField === "productCapability");

  assert.equal(report.meta.detailRequestFailures.length, 0);
  assert.equal(productCapability.status, "NOT_AVAILABLE_FROM_ENDPOINT");
  assert.equal(productCapability.statusReason, null);
});

/* ------------------------------------------------------------------ *
 * Rule 3 — retry wraps ONE request and never paginates
 * ------------------------------------------------------------------ */

test("the single /campaigns request is retried on 5xx without ever advancing the offset", async () => {
  const rows = Array.from({ length: 5 }, (_, index) => joinedCampaign(5000 + index));
  const calls = [];
  let failuresLeft = 2;

  const httpClient = {
    async get(url, config = {}) {
      calls.push({ url, params: config.params ?? {} });
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        const error = new Error("upstream 503");
        error.response = { status: 503 };
        throw error;
      }
      return { status: 200, data: { response: rows, hasMore: true } };
    },
  };

  const page = await fetchCampaignListPage({
    httpClient,
    agencyId: "118",
    contactId: "9001",
    limit: MAX_CERTIFIED_CAMPAIGNS,
    delayMs: 1,
  });

  assert.equal(calls.length, 3, "two failures plus one success");
  assert.equal(page.attempts, 3);
  assert.equal(page.maxAttempts, CAMPAIGN_LIST_MAX_ATTEMPTS);
  assert.equal(page.rows.length, MAX_CERTIFIED_CAMPAIGNS);

  // Every attempt is the SAME page: offset never moves, limit never grows.
  assert.ok(calls.every((call) => call.url === "/campaigns"));
  assert.ok(calls.every((call) => call.params.offset === 0), "offset stays 0 — retries are not pagination");
  assert.ok(calls.every((call) => call.params.limit === MAX_CERTIFIED_CAMPAIGNS));
  assert.ok(calls.length <= CAMPAIGN_LIST_MAX_ATTEMPTS, "never more attempts than the documented budget");
});

test("a non-retryable status is not retried", async () => {
  const calls = [];
  const httpClient = {
    async get(url, config = {}) {
      calls.push({ url, params: config.params ?? {} });
      const error = new Error("forbidden");
      error.response = { status: 403 };
      throw error;
    },
  };

  await assert.rejects(
    () => fetchCampaignListPage({ httpClient, agencyId: "118", contactId: "9001", delayMs: 1 }),
    /forbidden/,
  );
  assert.equal(calls.length, 1, "a 403 is final; one request only");
});


/* ------------------------------------------------------------------ *
 * Review item 1 & 2 — rule lineage must not come from array position
 * ------------------------------------------------------------------ */

test("REGRESSION: a fan-out rule is traced to its own group, never the group at the same array index", async () => {
  // Group A fans out into two band rules, so rules[2] is group B while
  // groups[2] does not exist. Index-based lineage would mis-attribute rule 2.
  const groupA = {
    id: "A",
    name: "Banded A",
    bandType: "orderValue",
    bands: [{ lower: 0, upper: 100, commission: "3%" }, { lower: 100, commission: "7%" }],
  };
  const groupB = { id: "B", name: "Ordinary B", commission: "11%" };

  const report = await certify({
    rows: [joinedCampaign(3100)],
    adapter: fakeAdapter({ groupsByCampaign: { [campaignKey(3100)]: [groupA, groupB] } }),
  });

  const [entry] = report.rulesNormalized;
  assert.equal(entry.ruleCount, 3, "A-band-1, A-band-2, B");

  const lineage = report.fieldReport.ruleLineage;
  assert.equal(lineage.length, 3);
  assert.deepEqual(lineage.map((item) => item.sourceGroupId), ["A", "A", "B"]);
  assert.deepEqual(lineage.map((item) => item.bandIndex), [0, 1, null]);
  assert.ok(lineage.every((item) => item.resolvedBy === "rawRuleReference.group"), "production lineage is primary");

  // The third rule resolves to group B even though groups[2] is undefined.
  const third = outcomeEvidenceFor(entry.rules[2], [groupA, groupB]);
  assert.equal(third.group.id, "B");
  assert.equal(third.band, null);

  const first = outcomeEvidenceFor(entry.rules[0], [groupA, groupB]);
  const second = outcomeEvidenceFor(entry.rules[1], [groupA, groupB]);
  assert.equal(first.group.id, "A");
  assert.equal(second.group.id, "A", "band 2 is still group A, not group B");
  assert.equal(first.band.commission, "3%");
  assert.equal(second.band.commission, "7%");
  assert.equal(second.sourcePath, "commission-groups[0].bands[1]");
});

test("REGRESSION: a band rate is certified from its own band evidence, not left VERIFY_LIVE", async () => {
  const groupA = {
    id: "A",
    name: "Banded A",
    bandType: "orderValue",
    bands: [{ lower: 0, upper: 100, commission: "3%" }, { lower: 100, commission: "7%" }],
  };
  const groupB = { id: "B", name: "Ordinary B", commission: "11%" };

  const report = await certify({
    rows: [joinedCampaign(3110)],
    adapter: fakeAdapter({ groupsByCampaign: { [campaignKey(3110)]: [groupA, groupB] } }),
  });

  const rates = report.fieldReport.fields.filter((f) => f.scope === "commission" && f.mboField === "ratePercent");
  assert.equal(rates.length, 3);

  // Each band rate traces to its OWN band, not to the group-level value.
  assert.equal(rates[0].normalizedValue, 3);
  assert.equal(rates[0].rawSourceOrigin, "band");
  assert.equal(rates[0].qualifiedRawSourcePath, "commission-groups[0].bands[0].commission");
  assert.equal(rates[0].rawValuePresent, true, "band evidence is found, not missing");

  assert.equal(rates[1].normalizedValue, 7);
  assert.equal(rates[1].rawSourceOrigin, "band");
  assert.equal(rates[1].qualifiedRawSourcePath, "commission-groups[0].bands[1].commission");
  assert.equal(rates[1].rawValuePresent, true);

  // Band evidence is located, but production still withholds verification of
  // band selection, so the certification must not claim more than the mapper.
  assert.equal(rates[0].status, "REVIEW_REQUIRED");
  assert.equal(rates[0].statusReason, "band_selection_semantics_not_verified_live");
  assert.equal(rates[1].status, "REVIEW_REQUIRED");

  // The ordinary, unambiguous rule traces to the group level and IS verified.
  assert.equal(rates[2].normalizedValue, 11);
  assert.equal(rates[2].rawSourceOrigin, "group");
  assert.equal(rates[2].qualifiedRawSourcePath, "commission-groups[1].commission");
  assert.equal(rates[2].status, "LIVE_VERIFIED");

  // Identity still comes from the owning group, per rule.
  const groupIds = report.fieldReport.fields.filter((f) => f.mboField === "sourceGroupId");
  assert.deepEqual(groupIds.map((f) => f.normalizedValue), ["A", "A", "B"]);
});

test("the sourceGroupId fallback is used only when production lineage is absent", () => {
  const groups = [{ id: "A", commission: "5%" }, { id: "B", commission: "9%" }];
  const withoutLineage = { sourceGroupId: "B", sourcePath: "commission-groups[1]", rawRuleReference: null };

  const evidence = outcomeEvidenceFor(withoutLineage, groups);
  assert.equal(evidence.group.id, "B");
  assert.equal(evidence.resolvedBy, "sourceGroupId_fallback");

  const unresolvable = outcomeEvidenceFor({ sourceGroupId: "ZZZ", rawRuleReference: null }, groups);
  assert.deepEqual(unresolvable.group, {});
  assert.equal(unresolvable.resolvedBy, "unresolved");
});

/* ------------------------------------------------------------------ *
 * Review item 3 — average commission rules
 * ------------------------------------------------------------------ */

test("average commission follows the locked MBO rules", () => {
  const percent = (rate) => ({ commissionType: "PERCENTAGE", ratePercent: rate, fixedAmount: null, currency: null, basis: "PERCENT_OF_SALE" });
  const fixed = (amount, currency, basis) => ({ commissionType: "FIXED", ratePercent: null, fixedAmount: amount, currency, basis });

  // 5% + 15% → 10%
  assert.equal(averageCommissionDisplay([percent(5), percent(15)]).display, "10%");
  // 0% + 10% → 5%, explicit zero included in the mean
  const withZero = averageCommissionDisplay([percent(0), percent(10)]);
  assert.equal(withZero.display, "5%");
  assert.equal(withZero.value, 5);
  assert.equal(withZero.mixed, false);

  // USD 5/order + USD 15/order → USD 10/order
  const sameBasis = averageCommissionDisplay([fixed(5, "USD", "FIXED_PER_ORDER"), fixed(15, "USD", "FIXED_PER_ORDER")]);
  assert.equal(sameBasis.display, "USD 10/order");
  assert.equal(sameBasis.value, 10);
  assert.equal(sameBasis.currency, "USD");
  assert.equal(sameBasis.basis, "FIXED_PER_ORDER");
  assert.equal(sameBasis.mixed, false);

  // USD 5/order + EUR 5/order → MIXED
  const twoCurrencies = averageCommissionDisplay([fixed(5, "USD", "FIXED_PER_ORDER"), fixed(5, "EUR", "FIXED_PER_ORDER")]);
  assert.equal(twoCurrencies.display, "MIXED");
  assert.equal(twoCurrencies.mixedReason, "mixed_currencies");

  // USD 5/item + USD 5/order → MIXED
  const twoBases = averageCommissionDisplay([fixed(5, "USD", "FIXED_PER_ITEM"), fixed(5, "USD", "FIXED_PER_ORDER")]);
  assert.equal(twoBases.display, "MIXED");
  assert.equal(twoBases.mixedReason, "mixed_bases");

  // 5% + USD 5 → MIXED
  const twoKinds = averageCommissionDisplay([percent(5), fixed(5, "USD", "FIXED_AMOUNT")]);
  assert.equal(twoKinds.display, "MIXED");
  assert.equal(twoKinds.mixedReason, "mixed_commission_types");

  // A single fixed item-based outcome renders its basis.
  assert.equal(averageCommissionDisplay([fixed(4, "USD", "FIXED_PER_ITEM")]).display, "USD 4/item");
  // An unknown basis cannot be averaged into a meaningful figure.
  assert.equal(averageCommissionDisplay([fixed(4, "USD", "UNKNOWN")]).mixedReason, "fixed_basis_unknown");

  // Never a payout input, in every branch.
  for (const outcomes of [[percent(5)], [fixed(5, "USD", "FIXED_PER_ORDER")], [percent(5), fixed(5, "USD", "FIXED_AMOUNT")]]) {
    assert.equal(commissionPresentation(outcomes.map((o) => ({ ...o }))).averageUsableAsFinancialInput, false);
  }
});

/* ------------------------------------------------------------------ *
 * Review item 4 — sanitization of primitives and error messages
 * ------------------------------------------------------------------ */

test("a secret in a primitive array element is redacted", () => {
  const { value, redactions } = sanitizeDeep({ notes: ["Bearer real-secret", "harmless note"] });

  assert.equal(value.notes[0], REDACTED);
  assert.equal(value.notes[1], "harmless note", "ordinary array evidence survives");
  assert.ok(redactions.some((entry) => entry.path === "$.notes[0]" && entry.reason === "secret_value_pattern"));

  // And a bare string handed straight in.
  assert.equal(sanitizeDeep("Bearer real-secret").value, REDACTED);
});

test("supplier error messages are scrubbed and stored as a whitelist", () => {
  assert.equal(
    sanitizeErrorMessage("Request failed: GET /campaigns?apikey=REALKEY123&limit=5"),
    "Request failed: GET /campaigns?apikey=[REDACTED]&limit=5",
  );
  assert.equal(sanitizeErrorMessage("bad header Bearer REALTOKEN"), "bad header Bearer [REDACTED]");
  assert.equal(sanitizeErrorMessage("db postgres://u:realpw@host/db"), "db postgres://u:[REDACTED]@host/db");
  assert.ok(sanitizeErrorMessage("x".repeat(500)).length <= 301);

  const axiosLike = new Error("connect failed for apikey=REALKEY123");
  axiosLike.code = "ECONNRESET";
  axiosLike.response = { status: 502, headers: { authorization: "Bearer REALTOKEN" }, data: { secret: "REALKEY123" } };
  axiosLike.config = { headers: { apikey: "REALKEY123" }, url: "https://host/campaigns?apikey=REALKEY123" };
  axiosLike.request = { _header: "GET /campaigns\nauthorization: Bearer REALTOKEN" };

  const record = safeRequestFailure("77", axiosLike);

  assert.deepEqual(Object.keys(record).sort(), ["code", "httpStatus", "identifier", "identifierKind", "message"]);
  assert.equal(record.identifier, "77");
  assert.equal(record.identifierKind, "campaignId");
  assert.equal(record.httpStatus, 502);
  assert.equal(record.code, "ECONNRESET");
  assert.ok(!JSON.stringify(record).includes("REALKEY123"), "no api key survives");
  assert.ok(!JSON.stringify(record).includes("REALTOKEN"), "no bearer token survives");
  assert.equal(record.config, undefined);
  assert.equal(record.request, undefined);
});

test("a secret in a failing request cannot reach any artifact", async () => {
  const detailError = new Error("detail failed: https://host/campaigns/1?apikey=REALKEY123");
  detailError.response = { status: 502, headers: { authorization: "Bearer REALTOKEN" } };
  detailError.config = { headers: { apikey: "REALKEY123" } };

  const report = await certify({
    rows: [joinedCampaign(3200, { notes: ["Bearer REALTOKEN"] })],
    adapter: fakeAdapter({ detailError }),
  });

  const everything = JSON.stringify(report);
  assert.ok(!everything.includes("REALKEY123"), "no api key anywhere in the report");
  assert.ok(!everything.includes("REALTOKEN"), "no bearer token anywhere in the report");
  assert.equal(report.meta.detailRequestFailures[0].httpStatus, 502);
  assert.match(report.meta.detailRequestFailures[0].message, /apikey=\[REDACTED\]/);

  const markdown = renderSummaryMarkdown(report);
  assert.ok(!markdown.includes("REALKEY123") && !markdown.includes("REALTOKEN"), "nor in the summary");
});

/* ------------------------------------------------------------------ *
 * Review item 5 — campaign status evidence precedence
 * ------------------------------------------------------------------ */

test("campaign status evidence follows production precedence, not the top-level status", async () => {
  const report = await certify({
    rows: [joinedCampaign(3300, { advertiserCampaignStatus: "paused", status: "live" })],
  });

  const field = report.fieldReport.fields.find((entry) => entry.mboField === "campaignStatus");

  assert.equal(field.normalizedValue, "PAUSED", "production used the advertiser status");
  assert.equal(field.rawSourcePath, "advertiserCampaignStatus");
  assert.notEqual(field.rawSourcePath, "status");
  assert.equal(field.listValue, "paused");
  assert.equal(field.status, "LIVE_VERIFIED");

  // Path selection mirrors the mapper's own fallthrough.
  assert.deepEqual(campaignStatusEvidencePaths({ advertiserCampaignStatus: "paused", status: "live" }), ["advertiserCampaignStatus"]);
  assert.deepEqual(campaignStatusEvidencePaths({ advertiser_campaign_status: "live" }), ["advertiser_campaign_status"]);
  // An advertiser value production cannot normalize is not the evidence.
  assert.deepEqual(campaignStatusEvidencePaths({ advertiserCampaignStatus: "???", status: "live" }), ["status", "campaignStatus", "subStatus"]);
  assert.deepEqual(campaignStatusEvidencePaths({ status: "live" }), ["status", "campaignStatus", "subStatus"]);
});

/* ------------------------------------------------------------------ *
 * Review item 6 — relationship evidence comes from production
 * ------------------------------------------------------------------ */

test("relationship evidence is taken from the production mapper's own evidenceSource", () => {
  assert.deepEqual(relationshipEvidencePaths({ rejectedDate: "2026-01-05", publishers: [{ campaignSubStatus: "live" }] }), ["rejectedDate"]);
  assert.deepEqual(relationshipEvidencePaths({ publishers: [{ campaignSubStatus: "live" }] }), ["publishers[].campaignSubStatus"]);
  assert.deepEqual(relationshipEvidencePaths({ publisherEligibility: "eligible" }), ["publisherEligibility"]);
  assert.deepEqual(relationshipEvidencePaths({ status: "live" }), ["status"]);
  assert.deepEqual(relationshipEvidencePaths({ status: "paused", cancelledDate: "2026-02-01" }), ["cancelledDate"]);
});

test("a rejected campaign traces relationship evidence to rejectedDate, not the publisher block", async () => {
  const report = await certify({
    rows: [joinedCampaign(3400, { rejectedDate: "2026-01-05" })],
    scope: "all",
  });

  const relationship = report.fieldReport.fields.find((entry) => entry.mboField === "relationshipStatus");
  const isJoined = report.fieldReport.fields.find((entry) => entry.mboField === "isJoined");

  assert.equal(relationship.normalizedValue, "NOT_JOINED");
  assert.equal(relationship.rawSourcePath, "rejectedDate");
  assert.equal(relationship.listValue, "2026-01-05");
  assert.equal(isJoined.rawSourcePath, "rejectedDate");
  assert.equal(isJoined.normalizedValue, false);
});

test("a joined campaign traces relationship evidence to the publisher sub-status", async () => {
  const report = await certify({ rows: [joinedCampaign(3410)] });

  const relationship = report.fieldReport.fields.find((entry) => entry.mboField === "relationshipStatus");

  assert.equal(relationship.normalizedValue, "JOINED");
  assert.equal(relationship.rawSourcePath, "publishers[].campaignSubStatus");
  assert.equal(relationship.status, "LIVE_VERIFIED");
});

/* ------------------------------------------------------------------ *
 * Review item 7 — request counting
 * ------------------------------------------------------------------ */

test("retries are counted as outbound requests while the page count stays 1", async () => {
  const rows = Array.from({ length: 5 }, (_, index) => joinedCampaign(6000 + index));
  let failuresLeft = 2;
  const calls = [];
  const httpClient = {
    async get(url, config = {}) {
      calls.push({ url, params: config.params ?? {} });
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        const error = new Error("upstream 503");
        error.response = { status: 503 };
        throw error;
      }
      return { status: 200, data: { response: rows, hasMore: true } };
    },
  };

  const report = await runCertification({
    httpClient,
    adapter: fakeAdapter(),
    region: "sea",
    accountLabel: "default",
    now: () => new Date("2026-09-09T00:00:00.000Z"),
    listRetryDelayMs: 1,
  });

  assert.equal(calls.length, 3, "two 503s then a success");
  assert.equal(report.meta.campaignListRequests, 3, "actual outbound attempts");
  assert.equal(report.meta.campaignListPages, 1, "still one logical page");
  assert.equal(report.meta.campaignListPage.attempts, 3);

  const markdown = renderSummaryMarkdown(report);
  assert.match(markdown, /Campaign-list pages: 1/);
  assert.match(markdown, /Outbound GET \/campaigns requests, retries included: 3/);
});

/* ------------------------------------------------------------------ *
 * Review item 8 — evidence cannot be written outside certification-output
 * ------------------------------------------------------------------ */

test("evidence output is confined to certification-output/", () => {
  const inside = path.join(EVIDENCE_ROOT, "optimise", "sea", "run-1");
  assert.equal(resolveOutputDir(inside), inside);
  assert.equal(resolveOutputDir(EVIDENCE_ROOT), EVIDENCE_ROOT);

  for (const bad of ["/tmp/evidence", path.join(EVIDENCE_ROOT, "..", "src"), path.join(EVIDENCE_ROOT, "..", "..", "escape"), `${EVIDENCE_ROOT}-sibling`]) {
    assert.throws(() => resolveOutputDir(bad), /Refusing to write supplier evidence outside/, `must reject ${bad}`);
  }

  assert.ok(EVIDENCE_ROOT.endsWith(`${path.sep}certification-output`));
});


/* ------------------------------------------------------------------ *
 * Final review 1 — semantic conflicts across DIFFERENT raw paths
 * ------------------------------------------------------------------ */

test("A) list status=live vs detail advertiserCampaignStatus=paused is a semantic conflict", async () => {
  const listRow = joinedCampaign(4100, { status: "live" });
  delete listRow.advertiserCampaignStatus;

  const report = await certify({
    rows: [listRow],
    adapter: fakeAdapter({ detailByCampaign: { 4100: { id: 4100, advertiserCampaignStatus: "paused" } } }),
  });

  const field = report.fieldReport.fields.find((entry) => entry.mboField === "campaignStatus");

  // The two responses share no raw path, so only a semantic comparison finds this.
  assert.equal(field.status, "REVIEW_REQUIRED");
  assert.equal(field.statusReason, "supplier_list_detail_conflict");
  assert.equal(field.conflictKind, "semantic");
  assert.equal(field.listSemanticValue, "ACTIVE");
  assert.equal(field.detailSemanticValue, "PAUSED");

  // Both sides keep their own evidence source and value.
  assert.equal(field.listSourcePath, "list:$.status");
  assert.equal(field.listValue, "live");
  assert.equal(field.detailSourcePath, "detail:$.advertiserCampaignStatus");
  assert.equal(field.detailValue, "paused");

  // The merged canonical value is preserved untouched (detail wins here because
  // production prefers advertiserCampaignStatus on the merged payload).
  assert.equal(field.normalizedValue, "PAUSED");

  const conflict = report.fieldReport.fieldConflicts.find((entry) => entry.mboField === "campaignStatus");
  assert.ok(conflict);
  assert.equal(conflict.listSemanticValue, "ACTIVE");
  assert.equal(conflict.detailSemanticValue, "PAUSED");
});

test("B) list publishers live vs detail rejectedDate is a relationship conflict", async () => {
  const report = await certify({
    rows: [joinedCampaign(4110)],
    adapter: fakeAdapter({ detailByCampaign: { 4110: { id: 4110, rejectedDate: "2026-03-01" } } }),
  });

  const relationship = report.fieldReport.fields.find((entry) => entry.mboField === "relationshipStatus");
  const isJoined = report.fieldReport.fields.find((entry) => entry.mboField === "isJoined");

  assert.equal(relationship.status, "REVIEW_REQUIRED");
  assert.equal(relationship.statusReason, "supplier_list_detail_conflict");
  assert.equal(relationship.conflictKind, "semantic");
  assert.equal(relationship.listSemanticValue, "JOINED");
  assert.equal(relationship.detailSemanticValue, "NOT_JOINED");
  assert.equal(relationship.listSourcePath, "list:$.publishers[].campaignSubStatus");
  assert.equal(relationship.detailSourcePath, "detail:$.rejectedDate");

  assert.equal(isJoined.status, "REVIEW_REQUIRED");
  assert.equal(isJoined.statusReason, "supplier_list_detail_conflict");
  assert.equal(isJoined.listSemanticValue, true);
  assert.equal(isJoined.detailSemanticValue, false);
});

test("semantic agreement through different spellings is NOT a conflict", async () => {
  const listRow = joinedCampaign(4120, { status: "live" });

  const report = await certify({
    rows: [listRow],
    // Different raw field, same production meaning (ACTIVE).
    adapter: fakeAdapter({ detailByCampaign: { 4120: { id: 4120, advertiserCampaignStatus: "active" } } }),
  });

  const field = report.fieldReport.fields.find((entry) => entry.mboField === "campaignStatus");
  assert.equal(field.listDetailConflict, false, "same meaning, different wording, is agreement");
  assert.equal(field.status, "LIVE_VERIFIED");
  assert.equal(field.listSemanticValue, "ACTIVE");
  assert.equal(field.detailSemanticValue, "ACTIVE");
});

test("semanticComparison only compares when BOTH responses carry sufficient evidence", () => {
  const statusSpec = { evidenceResolver: "campaignStatus", mboField: "campaignStatus" };
  const relationshipSpec = { evidenceResolver: "relationship", mboField: "relationshipStatus" };

  assert.equal(semanticComparison(statusSpec, { status: "live" }, {}).comparable, false, "no detail evidence");
  assert.equal(semanticComparison(statusSpec, {}, { status: "paused" }).comparable, false, "no list evidence");

  const both = semanticComparison(statusSpec, { status: "live" }, { advertiserCampaignStatus: "paused" });
  assert.equal(both.comparable, true);
  assert.equal(both.differs, true);

  assert.equal(semanticComparison(relationshipSpec, { publishers: [{ campaignSubStatus: "live" }] }, {}).comparable, false);
  const rel = semanticComparison(relationshipSpec, { publishers: [{ campaignSubStatus: "live" }] }, { rejectedDate: "2026-03-01" });
  assert.equal(rel.comparable, true);
  assert.equal(rel.listSemantic, "JOINED");
  assert.equal(rel.detailSemantic, "NOT_JOINED");

  // A spec with no resolver is never compared semantically.
  assert.equal(semanticComparison({ mboField: "campaignName" }, { a: 1 }, { a: 2 }).comparable, false);
});

/* ------------------------------------------------------------------ *
 * Final review 2 — production review reasons must reach the verdict
 * ------------------------------------------------------------------ */

test("a bare numeric commission is REVIEW_REQUIRED, never LIVE_VERIFIED", async () => {
  // 8.5 with no %, currency or unit. Production parses ratePercent 8.5 but
  // records commission_unit_not_explicit.
  const report = await certify({
    rows: [joinedCampaign(4200)],
    adapter: fakeAdapter({ groupsByCampaign: { [campaignKey(4200)]: [{ id: "N", name: "Bare", commission: 8.5 }] } }),
  });

  const rule = report.rulesNormalized[0].rules[0];
  assert.equal(rule.ratePercent, 8.5, "production still parses the number");
  assert.deepEqual(rule.metadata.reviewReasons, ["commission_unit_not_explicit"]);

  const byField = new Map(report.fieldReport.fields.filter((f) => f.scope === "commission").map((f) => [f.mboField, f]));
  for (const mboField of ["commissionType", "supplierRuleType", "ratePercent", "basis"]) {
    assert.equal(byField.get(mboField).status, "REVIEW_REQUIRED", `${mboField} must not be verified`);
    assert.equal(byField.get(mboField).statusReason, "commission_unit_not_explicit");
  }
  assert.notEqual(byField.get("ratePercent").status, "LIVE_VERIFIED");
});

test("a banded rule keeps band selection unverified", async () => {
  const report = await certify({
    rows: [joinedCampaign(4210)],
    adapter: fakeAdapter({
      groupsByCampaign: {
        [campaignKey(4210)]: [{ id: "B", name: "Banded", bandType: "orderValue", bands: [{ lower: 0, upper: 100, commission: "3%" }, { lower: 100, commission: "7%" }] }],
      },
    }),
  });

  const byField = report.fieldReport.fields.filter((f) => f.scope === "commission");
  for (const mboField of ["ratePercent", "bands", "couponOrTier"]) {
    const entries = byField.filter((f) => f.mboField === mboField);
    assert.ok(entries.length > 0, `${mboField} certified`);
    for (const entry of entries) {
      assert.equal(entry.status, "REVIEW_REQUIRED", `${mboField} must reflect unverified band selection`);
      assert.equal(entry.statusReason, "band_selection_semantics_not_verified_live");
    }
  }
});

test("a condition-bearing rule keeps its condition semantics unverified", async () => {
  const report = await certify({
    rows: [joinedCampaign(4220)],
    adapter: fakeAdapter({
      groupsByCampaign: {
        [campaignKey(4220)]: [{ id: "C", name: "Cond", commission: "5%", conditions: [{ type: "newCustomer", value: true }] }],
      },
    }),
  });

  const rule = report.rulesNormalized[0].rules[0];
  assert.ok(rule.metadata.reviewReasons.includes("optimise_condition_semantics_not_verified_live"));

  const conditions = report.fieldReport.fields.find((f) => f.scope === "commission" && f.mboField === "conditions");
  assert.equal(conditions.status, "REVIEW_REQUIRED");
  assert.equal(conditions.statusReason, "optimise_condition_semantics_not_verified_live");
  assert.notEqual(conditions.status, "LIVE_VERIFIED");
});

test("an unambiguous rule is still LIVE_VERIFIED", async () => {
  const report = await certify({
    rows: [joinedCampaign(4230)],
    adapter: fakeAdapter({ groupsByCampaign: { [campaignKey(4230)]: [{ id: "P", name: "Plain", commission: "11%" }] } }),
  });

  const rule = report.rulesNormalized[0].rules[0];
  assert.deepEqual(rule.metadata.reviewReasons, [], "production raised nothing");

  const rate = report.fieldReport.fields.find((f) => f.scope === "commission" && f.mboField === "ratePercent");
  assert.equal(rate.status, "LIVE_VERIFIED");
  assert.equal(rate.statusReason, null);
});

test("review reasons map to the fields they make unsafe", () => {
  assert.equal(reviewReasonForField("ratePercent", ["commission_unit_not_explicit"]), "commission_unit_not_explicit");
  assert.equal(reviewReasonForField("basis", ["payout_basis_unknown"]), "payout_basis_unknown");
  assert.equal(reviewReasonForField("currency", ["fixed_payout_currency_missing"]), "fixed_payout_currency_missing");
  assert.equal(reviewReasonForField("sourceGroupId", ["supplier_group_id_missing"]), "supplier_group_id_missing");
  assert.equal(reviewReasonForField("bands", ["band_identity_insufficient"]), "band_identity_insufficient");
  // Unrelated fields are untouched by an unrelated reason.
  assert.equal(reviewReasonForField("sourceGroupName", ["commission_unit_not_explicit"]), null);
  assert.equal(reviewReasonForField("ratePercent", []), null);
  assert.ok(Object.keys(REVIEW_REASON_FIELDS).includes("commission_unit_not_explicit"));
});

/* ------------------------------------------------------------------ *
 * Final review 3 — deep list/detail merge
 * ------------------------------------------------------------------ */

test("detail fills nested leaves the list omits, and the list leaf still wins", () => {
  const { merged, conflicts } = mergeListAndDetail(
    { landingPage: { id: 12 }, vertical: { primary: "Retail" } },
    { landingPage: { websiteUrl: "https://brand.com", id: 99 }, vertical: { secondary: "Fashion" } },
  );

  assert.equal(merged.landingPage.id, 12, "list leaf wins the real conflict");
  assert.equal(merged.landingPage.websiteUrl, "https://brand.com", "detail-only nested leaf survives");
  assert.equal(merged.vertical.primary, "Retail");
  assert.equal(merged.vertical.secondary, "Fashion");

  const idConflict = conflicts.find((entry) => entry.key === "landingPage.id");
  assert.ok(idConflict, "the leaf conflict is recorded at its path");
  assert.equal(idConflict.listValue, 12);
  assert.equal(idConflict.detailValue, 99);
});

test("arrays stay whole supplier values and are never element-merged", () => {
  const { merged } = mergeListAndDetail(
    { markets: [{ name: "Singapore" }] },
    { markets: [{ name: "Malaysia" }, { name: "Thailand" }] },
  );

  assert.deepEqual(merged.markets, [{ name: "Singapore" }], "the list array is kept intact, not unioned");

  const detailOnly = mergeListAndDetail({}, { markets: [{ name: "Malaysia" }] });
  assert.deepEqual(detailOnly.merged.markets, [{ name: "Malaysia" }], "a detail-only array is taken whole");
});

test("REGRESSION: a detail-only landingPage.websiteUrl reaches production mapping and is not a false MAPPING_GAP", async () => {
  const listRow = joinedCampaign(4300, { landingPage: { id: 12 } });
  delete listRow.deepLinkURL;

  const report = await certify({
    rows: [listRow],
    adapter: fakeAdapter({
      detailByCampaign: { 4300: { id: 4300, landingPage: { websiteUrl: "https://brand.com" } } },
    }),
  });

  // The merged payload handed to mapOptimiseCampaign carries both leaves.
  const normalized = report.campaignsNormalized[0].normalized;
  assert.equal(normalized.rawPayload.landingPage.id, 12);
  assert.equal(normalized.rawPayload.landingPage.websiteUrl, "https://brand.com");

  const destinationUrl = report.fieldReport.fields.find((entry) => entry.mboField === "destinationUrl");
  assert.equal(destinationUrl.normalizedValue, "https://brand.com", "production mapped the detail-only leaf");
  assert.equal(destinationUrl.rawSourceOrigin, "detail");
  assert.equal(destinationUrl.qualifiedRawSourcePath, "detail:$.landingPage.websiteUrl");
  assert.equal(destinationUrl.status, "LIVE_VERIFIED");
  assert.notEqual(destinationUrl.status, "MAPPING_GAP");

  assert.equal(
    report.fieldReport.mappingGaps.some((gap) => gap.proposedMboStandardField === "destinationUrl"),
    false,
    "no phantom gap for a leaf the shallow merge would have dropped",
  );
});


/* ------------------------------------------------------------------ *
 * Identifier namespaces — Optimise keys its two endpoints differently
 * ------------------------------------------------------------------ */

/** A row whose three identifiers are all different, with no scope filtering surprises. */
function tripleIdRow({ id, campaignId, productId, ...rest }) {
  return {
    id,
    campaignId,
    productId,
    campaignName: `Campaign ${id}`,
    publishers: [{ campaignSubStatus: "live" }],
    currencyCode: "USD",
    ...rest,
  };
}

test("id, campaignId and productId all different: each endpoint gets its own namespace", async () => {
  const adapter = fakeAdapter();
  const report = await certify({
    rows: [tripleIdRow({ id: "AAA", campaignId: "BBB", productId: "CCC" })],
    adapter,
  });

  assert.deepEqual(adapter.calls.fetchCampaignDetail, ["CCC"], "detail uses productId");
  assert.deepEqual(adapter.calls.fetchCommissionGroups, ["BBB"], "commission groups use campaignId");

  // The generic id is dispatched nowhere.
  const dispatched = [...adapter.calls.fetchCampaignDetail, ...adapter.calls.fetchCommissionGroups];
  assert.ok(!dispatched.includes("AAA"), "generic id is never dispatched");
  assert.ok(report.meta.endpointsCalled.includes("GET /campaigns/CCC"));
  assert.ok(report.meta.endpointsCalled.includes("GET /campaigns/BBB/commission-groups"));
  assert.ok(!report.meta.endpointsCalled.some((e) => e.includes("AAA")));
  assert.equal(report.fieldReport.identifierDiagnostics.length, 0);
});

test("two rows sharing a campaignId issue only ONE commission-group request", async () => {
  const adapter = fakeAdapter();
  const report = await certify({
    rows: [
      tripleIdRow({ id: "1", campaignId: "SHARED", productId: "P1" }),
      tripleIdRow({ id: "2", campaignId: "SHARED", productId: "P2" }),
    ],
    adapter,
  });

  assert.deepEqual(adapter.calls.fetchCommissionGroups, ["SHARED"], "deduped by campaignId");
  // Detail is NOT deduped away: the productIds differ, so both are legitimate.
  assert.deepEqual(adapter.calls.fetchCampaignDetail.sort(), ["P1", "P2"]);
  assert.equal(report.meta.duplicateCommissionRequestsSkipped, 1);
  assert.equal(report.meta.duplicateDetailRequestsSkipped, 0);
  assert.equal(report.meta.commissionGroupRequestsIssued, 1);
  assert.equal(report.meta.detailRequestsIssued, 2);
});

test("two rows sharing a productId issue only ONE detail request", async () => {
  const adapter = fakeAdapter();
  const report = await certify({
    rows: [
      tripleIdRow({ id: "1", campaignId: "C1", productId: "SHARED" }),
      tripleIdRow({ id: "2", campaignId: "C2", productId: "SHARED" }),
    ],
    adapter,
  });

  assert.deepEqual(adapter.calls.fetchCampaignDetail, ["SHARED"], "deduped by productId");
  assert.deepEqual(adapter.calls.fetchCommissionGroups.sort(), ["C1", "C2"]);
  assert.equal(report.meta.duplicateDetailRequestsSkipped, 1);
  assert.equal(report.meta.duplicateCommissionRequestsSkipped, 0);
});

test("the same scalar in DIFFERENT namespaces on different rows must not collide", async () => {
  // Row A's productId and Row B's campaignId are both "123" and mean different things.
  const rowA = tripleIdRow({ id: "A", campaignId: "CA", productId: "123", campaignName: "Row A" });
  const rowB = tripleIdRow({ id: "B", campaignId: "123", productId: "PB", campaignName: "Row B" });

  const adapter = fakeAdapter({
    detailByCampaign: { 123: { id: "A", terms: "Terms belonging to row A" }, PB: { id: "B", terms: "Terms belonging to row B" } },
  });

  const report = await certify({ rows: [rowA, rowB], adapter });

  assert.deepEqual(adapter.calls.fetchCampaignDetail.sort(), ["123", "PB"]);
  assert.deepEqual(adapter.calls.fetchCommissionGroups.sort(), ["123", "CA"]);

  // Each certified campaign kept ITS OWN source row — no lookup collision.
  assert.equal(report.campaignsRaw.length, 2);
  const names = report.campaignsRaw.map((entry) => entry.raw.campaignName);
  assert.deepEqual(names, ["Row A", "Row B"], "rows travel with the selection, not via a shared id map");

  const termsEntries = report.fieldReport.fields.filter((f) => f.mboField === "terms");
  assert.equal(termsEntries[0].normalizedValue, "Terms belonging to row A");
  assert.equal(termsEntries[1].normalizedValue, "Terms belonging to row B");
});

test("productId missing: detail is skipped with a diagnostic, commission groups still run", async () => {
  const adapter = fakeAdapter();
  const row = tripleIdRow({ id: "X1", campaignId: "C9", productId: undefined });
  delete row.productId;

  const report = await certify({ rows: [row], adapter });

  assert.deepEqual(adapter.calls.fetchCampaignDetail, [], "detail not called");
  assert.deepEqual(adapter.calls.fetchCommissionGroups, ["C9"], "commission groups still run");

  const diagnostics = report.fieldReport.identifierDiagnostics;
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].missingIdentifier, "productId");
  assert.equal(diagnostics[0].endpoint, "GET /campaigns/{productId}");
  assert.equal(diagnostics[0].status, "REVIEW_REQUIRED");
  assert.deepEqual(diagnostics[0].identifiersPresent, ["campaignId", "genericId"]);
});

test("campaignId missing: commission groups skipped with a diagnostic, detail still runs", async () => {
  const adapter = fakeAdapter();
  const row = tripleIdRow({ id: "X2", campaignId: undefined, productId: "P9" });
  delete row.campaignId;

  const report = await certify({ rows: [row], adapter });

  assert.deepEqual(adapter.calls.fetchCampaignDetail, ["P9"], "detail still runs");
  assert.deepEqual(adapter.calls.fetchCommissionGroups, [], "commission groups not called");

  const diagnostics = report.fieldReport.identifierDiagnostics;
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].missingIdentifier, "campaignId");
  assert.equal(diagnostics[0].endpoint, "GET /campaigns/{campaignId}/commission-groups");
  assert.equal(diagnostics[0].status, "REVIEW_REQUIRED");
});

test("only a generic id present: NEITHER endpoint is called, with two diagnostics", async () => {
  const adapter = fakeAdapter();
  const row = { id: "ONLY-ID", campaignName: "Bare", publishers: [{ campaignSubStatus: "live" }] };

  const report = await certify({ rows: [row], adapter });

  assert.deepEqual(adapter.calls.fetchCampaignDetail, [], "generic id is not a productId");
  assert.deepEqual(adapter.calls.fetchCommissionGroups, [], "generic id is not a campaignId");

  const diagnostics = report.fieldReport.identifierDiagnostics;
  assert.equal(diagnostics.length, 2);
  assert.deepEqual(diagnostics.map((d) => d.missingIdentifier).sort(), ["campaignId", "productId"]);
  assert.ok(diagnostics.every((d) => d.status === "REVIEW_REQUIRED"));
  assert.ok(diagnostics.every((d) => d.identifiersPresent.includes("genericId")));
  assert.equal(report.meta.endpointsCalled.filter((e) => e.includes("ONLY-ID")).length, 0);
});

test("legacyId is evidence only and is never dispatched", async () => {
  const adapter = fakeAdapter();
  const row = { id: "G1", legacyId: "L1", campaignName: "Legacy", publishers: [{ campaignSubStatus: "live" }] };

  await certify({ rows: [row], adapter });

  const dispatched = [...adapter.calls.fetchCampaignDetail, ...adapter.calls.fetchCommissionGroups];
  assert.deepEqual(dispatched, [], "neither id nor legacyId reaches an endpoint");
  assert.deepEqual(presentNamespaces({ genericId: "G1", legacyId: "L1", productId: null, campaignId: null }), ["genericId", "legacyId"]);
});

test("a skipped detail request never lets a field read as NOT_AVAILABLE_FROM_ENDPOINT", async () => {
  const adapter = fakeAdapter();
  const row = tripleIdRow({ id: "X3", campaignId: "C3", productId: undefined });
  delete row.productId;
  delete row.terms;

  const report = await certify({ rows: [row], adapter });

  const terms = report.fieldReport.fields.find((f) => f.mboField === "terms");
  assert.equal(terms.rawValuePresent, false);
  assert.equal(terms.status, "VERIFY_LIVE");
  assert.notEqual(terms.status, "NOT_AVAILABLE_FROM_ENDPOINT");
  assert.equal(terms.statusReason, "campaign_detail_identifier_missing");

  assert.equal(
    report.fieldReport.fields.filter((f) => f.scope === "campaign" && f.status === "NOT_AVAILABLE_FROM_ENDPOINT").length,
    0,
    "absence is never inferred from an endpoint we chose not to call",
  );
});

test("identifier REVIEW_REQUIRED is counted and shown, never hidden behind clean field counts", async () => {
  const adapter = fakeAdapter();
  const row = { id: "ONLY-ID", campaignName: "Bare", publishers: [{ campaignSubStatus: "live" }] };

  const report = await certify({ rows: [row], adapter });

  assert.equal(report.fieldReport.identifierReviewRequiredCount, 2);
  assert.equal(report.fieldReport.identifierDiagnosticCounts.REVIEW_REQUIRED, 2);
  assert.equal(report.meta.identifierReviewRequiredCount, 2);
  assert.equal(report.meta.identifierEndpointsSkipped, 2);
  assert.equal(report.meta.identifiersFullyResolved, false, "a run with unresolved endpoint identity is not fully verified");

  const markdown = renderSummaryMarkdown(report);
  assert.match(markdown, /ENDPOINT IDENTITY UNRESOLVED — 2 REVIEW_REQUIRED identifier diagnostic\(s\)/);
  assert.match(markdown, /NOT fully verified/);
  assert.match(markdown, /## Identifier diagnostics/);
  assert.match(markdown, /GET \/campaigns\/\{productId\}/);
  assert.match(markdown, /GET \/campaigns\/\{campaignId\}\/commission-groups/);
  assert.match(markdown, /No identifier was substituted across namespaces/);

  // A clean run says so, and says it is fully verified.
  const cleanReport = await certify({ rows: [tripleIdRow({ id: "A", campaignId: "B", productId: "C" })] });
  assert.equal(cleanReport.meta.identifiersFullyResolved, true);
  assert.match(renderSummaryMarkdown(cleanReport), /Identifier diagnostics: none/);
});

test("the certification selector carries rows and namespaces, and never dedupes across them", () => {
  const rows = [
    { id: "1", productId: "P", campaignId: "C", publishers: [{ campaignSubStatus: "live" }] },
    { id: "2", productId: "P", campaignId: "C", publishers: [{ campaignSubStatus: "live" }] },
    { name: "no identifiers at all", publishers: [{ campaignSubStatus: "live" }] },
    { id: "3", status: "notapplied" },
  ];

  const joined = selectCertificationCampaigns(rows, { scope: "joined", maxCampaigns: 5 });

  // Selection does NOT dedupe: request-level dedupe happens per namespace at dispatch.
  assert.equal(joined.campaigns.length, 2, "both identical-identifier rows are kept as rows");
  assert.equal(joined.skippedNoIdentifier, 1);
  assert.equal(joined.skippedByScope, 1);
  assert.equal(joined.campaignsInspected, 4);

  const [first] = joined.campaigns;
  assert.equal(first.rowIndex, 0);
  assert.equal(first.row, rows[0], "the source row travels by reference");
  assert.deepEqual(first.identifiers, { productId: "P", campaignId: "C", genericId: "1", legacyId: null });

  const capped = selectCertificationCampaigns(rows, { scope: "all", maxCampaigns: 1 });
  assert.equal(capped.campaigns.length, 1);
  assert.equal(capped.skippedByCap, 2);
});

test("the certified canonical identity mirrors production, never the display key", async () => {
  // campaignEntityFor must receive the value production's resolveOptimiseCampaignId
  // would embed in Entity.externalId — not the human-readable campaignKey.
  const report = await certify({
    rows: [tripleIdRow({ id: "PROD-ID", campaignId: "CMP", productId: "PRD" })],
  });

  const supplierCampaignId = report.fieldReport.fields.find((f) => f.mboField === "supplierCampaignId");
  assert.equal(supplierCampaignId.normalizedValue, "PROD-ID", "production coalesces id first; certification reports that");
  assert.ok(
    !String(supplierCampaignId.normalizedValue).includes("="),
    "the display key must never leak into canonical identity",
  );

  const [campaign] = report.campaignsRaw;
  assert.equal(campaign.campaignKey, "productId=PRD campaignId=CMP");
  assert.deepEqual(campaign.identifiers, { productId: "PRD", campaignId: "CMP", genericId: "PROD-ID", legacyId: null });
  assert.equal(campaign.campaignId, undefined, "no field named campaignId holds a non-campaignId value");
});

test("every emitted campaignId field holds ONLY the explicit supplier campaignId", async () => {
  const report = await certify({
    rows: [tripleIdRow({ id: "I", campaignId: "C", productId: "P" })],
    adapter: fakeAdapter({ groupsByCampaign: { C: [{ id: "g1", name: "Standard", commission: "5%" }] } }),
  });

  // Records that legitimately carry campaignId carry the supplier value.
  assert.equal(report.groupsRaw[0].campaignId, "C");
  assert.equal(report.rulesNormalized[0].campaignId, "C");
  assert.equal(report.fieldReport.ruleLineage[0].campaignId, "C");

  // Records keyed for display carry campaignKey plus explicit identifiers.
  assert.equal(report.campaignsNormalized[0].campaignKey, "productId=P campaignId=C");
  assert.equal(report.campaignDetailsRaw[0].campaignKey, "productId=P campaignId=C");
  for (const entry of report.fieldReport.fields) {
    assert.equal(entry.campaignId, undefined, `${entry.mboField} must not carry a campaignId label`);
    assert.equal(entry.campaignKey, "productId=P campaignId=C");
    assert.deepEqual(entry.identifiers, { productId: "P", campaignId: "C", genericId: "I", legacyId: null });
  }
});

/* ------------------------------------------------------------------ *
 * Shared productId: one request, but every row keeps the evidence
 * ------------------------------------------------------------------ */

test("rows sharing a productId all receive the single detail response", async () => {
  const adapter = fakeAdapter({
    detailByCampaign: { P: { id: "P", terms: "Detail-only terms", landingPage: { websiteUrl: "https://brand.example/p" } } },
  });

  const report = await certify({
    rows: [
      tripleIdRow({ id: "1", campaignId: "C1", productId: "P" }),
      tripleIdRow({ id: "2", campaignId: "C2", productId: "P" }),
    ],
    adapter,
  });

  assert.deepEqual(adapter.calls.fetchCampaignDetail, ["P"], "exactly one detail request");
  assert.deepEqual(adapter.calls.fetchCommissionGroups.sort(), ["C1", "C2"]);
  assert.equal(report.meta.detailRequestsIssued, 1);
  assert.equal(report.meta.rowsReusingCachedDetail, 1);
  assert.equal(report.meta.campaignsCertified, 2);

  // BOTH rows carry the detail payload — the deduplicated row must not lose it.
  assert.equal(report.campaignDetailsRaw.length, 2);
  for (const entry of report.campaignDetailsRaw) {
    assert.equal(entry.fetched, true, "a cached row still counts as fetched");
    assert.equal(entry.raw.terms, "Detail-only terms");
  }
  // One shared productId: 1 request, 1 successful response, 2 rows with evidence.
  assert.equal(report.meta.detailRequestsIssued, 1, "one unique productId request attempted");
  assert.equal(report.meta.campaignDetailResponsesSucceeded, 1, "one successful response");
  assert.equal(report.meta.campaignRowsWithDetailEvidence, 2, "both rows hold detail evidence");
  assert.equal(report.meta.rowsReusingCachedDetail, 1, "one row reused the cached result");

  // BOTH rows normalize and certify the detail-only fields.
  const terms = report.fieldReport.fields.filter((f) => f.mboField === "terms");
  assert.equal(terms.length, 2);
  for (const field of terms) {
    assert.equal(field.normalizedValue, "Detail-only terms");
    assert.equal(field.rawSourceOrigin, "detail");
    assert.equal(field.status, "LIVE_VERIFIED");
    assert.notEqual(field.status, "NOT_AVAILABLE_FROM_ENDPOINT");
  }

  const destination = report.fieldReport.fields.filter((f) => f.mboField === "destinationUrl");
  assert.equal(destination.length, 2);
  for (const field of destination) {
    assert.equal(field.normalizedValue, "https://brand.example/p");
    assert.equal(field.status, "LIVE_VERIFIED");
  }

  // And nothing is falsely declared absent on the deduplicated row.
  assert.equal(
    report.fieldReport.fields.filter((f) => f.scope === "campaign" && f.status === "NOT_AVAILABLE_FROM_ENDPOINT" && f.mboField === "terms").length,
    0,
  );
});

test("a shared-productId detail FAILURE is inherited by every row that reuses it", async () => {
  const error = new Error("detail unavailable");
  error.response = { status: 403 };
  const adapter = fakeAdapter({ detailError: error });

  const rowA = tripleIdRow({ id: "1", campaignId: "C1", productId: "P" });
  const rowB = tripleIdRow({ id: "2", campaignId: "C2", productId: "P" });
  delete rowA.terms;
  delete rowB.terms;

  const report = await certify({ rows: [rowA, rowB], adapter });

  assert.deepEqual(adapter.calls.fetchCampaignDetail, ["P"], "the failure is not retried per row");
  assert.equal(report.meta.detailRequestFailures.length, 1);
  assert.equal(report.meta.detailRequestFailures[0].identifierKind, "productId");
  assert.equal(report.meta.rowsReusingCachedDetail, 1);

  // BOTH rows must remain VERIFY_LIVE — absence is never inferred from a failure.
  const terms = report.fieldReport.fields.filter((f) => f.mboField === "terms");
  assert.equal(terms.length, 2);
  for (const field of terms) {
    assert.equal(field.status, "VERIFY_LIVE");
    assert.equal(field.statusReason, "campaign_detail_request_failed");
    assert.notEqual(field.status, "NOT_AVAILABLE_FROM_ENDPOINT");
  }
  assert.equal(
    report.fieldReport.fields.filter((f) => f.scope === "campaign" && f.status === "NOT_AVAILABLE_FROM_ENDPOINT").length,
    0,
    "a cached failure blocks absence claims on every sharing row",
  );
});

/* ------------------------------------------------------------------ *
 * Zero certified campaigns cannot resolve anything
 * ------------------------------------------------------------------ */

test("no certifiable rows: identifier resolution is NOT established", async () => {
  const adapter = fakeAdapter();
  // Rows with no usable identifier in any namespace.
  const rows = [
    { campaignName: "No identifiers", publishers: [{ campaignSubStatus: "live" }] },
    { campaignName: "Also none", status: "live" },
  ];

  const report = await certify({ rows, adapter });

  assert.equal(report.meta.campaignsCertified, 0);
  assert.deepEqual(adapter.calls.fetchCampaignDetail, []);
  assert.deepEqual(adapter.calls.fetchCommissionGroups, []);
  assert.equal(report.fieldReport.identifierDiagnostics.length, 0, "nothing was selected, so nothing was diagnosed");
  assert.equal(report.meta.identifierReviewRequiredCount, 0);

  // The bare count is zero, but resolution must NOT read as achieved.
  assert.notEqual(report.meta.identifiersFullyResolved, true);
  assert.equal(report.meta.identifiersFullyResolved, false);
  assert.equal(report.meta.identifierResolutionEstablished, false);

  const markdown = renderSummaryMarkdown(report);
  assert.match(markdown, /NO CERTIFIABLE CAMPAIGN ROWS/);
  assert.match(markdown, /endpoint identifier resolution not established/i);
  assert.ok(
    !markdown.includes("every endpoint had its required identifier"),
    "an empty run must never claim every endpoint had its identifier",
  );
  assert.equal(report.meta.identifierResolutionEstablished, false);
});

test("detail metrics report requests, successes and rows as SEPARATE numbers", async () => {
  const adapter = fakeAdapter({ detailByCampaign: { P: { id: "P", terms: "Shared detail terms" } } });

  const report = await certify({
    rows: [
      tripleIdRow({ id: "1", campaignId: "C1", productId: "P" }),
      tripleIdRow({ id: "2", campaignId: "C2", productId: "P" }),
    ],
    adapter,
  });

  // The exact scenario: 2 rows, 1 shared productId, 1 request, 1 success, 2 rows with evidence.
  assert.equal(report.meta.campaignsCertified, 2);
  assert.equal(report.meta.detailRequestsIssued, 1);
  assert.equal(report.meta.campaignDetailResponsesSucceeded, 1);
  assert.equal(report.meta.campaignRowsWithDetailEvidence, 2);
  assert.equal(report.meta.rowsReusingCachedDetail, 1);
  assert.equal(adapter.calls.fetchCampaignDetail.length, 1);

  // Rows-with-evidence must never be labelled as responses fetched.
  const markdown = renderSummaryMarkdown(report);
  assert.match(markdown, /Campaign detail requests issued: 1 · responses succeeded: 1 · failures: 0/);
  assert.match(markdown, /Campaign rows with detail evidence: 2 \(rows reusing a cached detail result: 1\)/);
  assert.ok(!markdown.includes("Campaign detail responses fetched: 2"), "rows are never reported as responses");
  assert.ok(!/responses fetched/i.test(markdown), "the ambiguous wording is gone entirely");
});

test("a failed shared request counts as a request but not a success, and yields no evidence", async () => {
  const error = new Error("detail unavailable");
  error.response = { status: 403 };
  const adapter = fakeAdapter({ detailError: error });

  const report = await certify({
    rows: [
      tripleIdRow({ id: "1", campaignId: "C1", productId: "P" }),
      tripleIdRow({ id: "2", campaignId: "C2", productId: "P" }),
    ],
    adapter,
  });

  assert.equal(report.meta.detailRequestsIssued, 1, "attempted once");
  assert.equal(report.meta.campaignDetailResponsesSucceeded, 0, "no successful response");
  assert.equal(report.meta.campaignRowsWithDetailEvidence, 0, "no row holds detail evidence");
  assert.equal(report.meta.rowsReusingCachedDetail, 1, "the second row still reused the cached outcome");
  assert.equal(report.meta.detailRequestFailures.length, 1);
});

test("the preview wrapper does not load the production sync job or Prisma to build its dependencies", () => {
  const source = fs.readFileSync(ROUTE_SOURCE_PATH, "utf8");
  assert.ok(!/optimiseCommissionGroupSync/.test(source), "no production commission-group sync import");
  assert.ok(!/syncModule/.test(source), "no residual sync module binding");
  assert.ok(!/database\/prisma/.test(source), "no direct prisma import");
});
