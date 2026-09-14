import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.PARTNERIZE_CERTIFICATION_MIN_INTERVAL_MS = "1";

const {
  COMMISSION_SCAN_ROW_LIMIT,
  COMMISSION_STRUCTURE_KEYS,
  chooseCommissionSampleRow,
  hasCommissionStructure,
  NetworkCertificationService,
  listProbeSourceObjects,
  summariseCommissionStructure,
} = await import("../src/modules/ops/networkCertification.service.js");
const { parseRunBody } = await import("../src/controllers/networkCertification.controller.js");
const {
  PARTNERIZE_CERTIFICATION_CAMPAIGN_SAMPLE_LIMIT,
  createPartnerizeAdapter,
} = await import("../src/adapters/partnerize.adapter.js");

const serviceSource = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");
const adapterSource = readFileSync("src/adapters/partnerize.adapter.js", "utf8");
const controllerSource = readFileSync("src/controllers/networkCertification.controller.js", "utf8");
const mapperSource = readFileSync("src/modules/supplier/mappers/partnerize.mapper.js", "utf8");

/**
 * Three DISTINCT payout outcomes, deliberately not uniform: two percentage rates that differ, and
 * a fixed amount described with different keys. Every value is a distinctive token so a leak test
 * can name it. If anything averages, merges or picks one of these, the count or the paths change.
 */
const OUTCOMES = [
  { name: "zzNewCustomerzz", type: "percentage", value: "zzrate12zz" },
  { name: "zzReturningzz", type: "percentage", value: "zzrate6zz" },
  { name: "zzFixedzz", type: "fixed", amount: "zzamount3zz", currency: "zzGBPzz" },
];
const CAMPAIGN_ROW = {
  campaign_id: "zzcampaignidzz",
  title: "zztitlezz",
  default_currency: "zzdefaultcurrencyzz",
  default_commission_rate: "zzdefaultratezz",
  default_commission_value: "zzdefaultvaluezz",
  commissions: OUTCOMES,
};

const ALL_VALUES = [
  ...OUTCOMES.flatMap((o) => Object.values(o)),
  CAMPAIGN_ROW.default_currency,
  CAMPAIGN_ROW.default_commission_rate,
  CAMPAIGN_ROW.default_commission_value,
  CAMPAIGN_ROW.campaign_id,
  CAMPAIGN_ROW.title,
];

/** Counts campaign fetches so "no extra supplier call" is observed, not assumed. */
function adapterFor(row = CAMPAIGN_ROW) {
  const fetches = [];
  // A single response may carry several rows. Passing an array models exactly that, and the fetch
  // counter proves the extra rows cost no extra request.
  const rows = row instanceof Error ? row : Array.isArray(row) ? row : [row];
  return {
    fetches,
    adapter: {
      fetchCertificationCampaignSample: async () => {
        fetches.push("campaigns");
        return rows instanceof Error ? Promise.reject(rows) : rows;
      },
      fetchCertificationVoucherSample: async () => {
        fetches.push("vouchers");
        return [{ voucher_code: "zzvoucherzz" }];
      },
      fetchCertificationSample: async () => {
        fetches.push("simple");
        return [{ a: 1 }];
      },
    },
  };
}

function serviceFor(adapter) {
  return new NetworkCertificationService({
    prisma: {},
    adapterFactory: () => adapter,
    partnerizeCredentialResolver: async () => ({
      applicationKey: "zzappkeyzz",
      userApiKey: "zzuserapikeyzz",
      publisherId: "zzpublisherzz",
      certificationCampaignId: "zzcertcampaignzz",
    }),
  });
}

const run = async (sourceObjects, row) => {
  const { adapter, fetches } = adapterFor(row);
  const result = await serviceFor(adapter).certify("partnerize", { sourceObjects });
  return { result, fetches, row: result.results.find((r) => r.sourceObject === "commission_structure") };
};

describe("partnerize commission structure — no invented endpoint", () => {
  it("1 — Partnerize exposes no commission or rate endpoint, so none is added", () => {
    // The adapter builds six paths in total. None is commission-scoped; the audit is asserted here
    // so a future probe cannot quietly introduce one.
    const paths = [...adapterSource.matchAll(/["`](\/user[^"`]*)["`]/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(paths)].sort(), [
      "/user",
      "/user/publisher",
      "/user/publisher/${encodeURIComponent(pubId)}/campaign/${encodeURIComponent(campaignId)}/voucher",
      "/user/publisher/${encodeURIComponent(resolved.publisherId)}",
      "/user/publisher/${encodeURIComponent(resolved.publisherId)}/campaign/a",
      "/user/publisher/${id}/campaign/${status}",
    ]);
    for (const invented of ["/commission", "/commissions", "/rate", "/rates", "/payout", "/terms"]) {
      assert.ok(!adapterSource.includes(`${invented}"`) && !adapterSource.includes(`${invented}\``));
    }
  });

  it("1b — the probe declares the campaign endpoint, marked as a derived subtree", () => {
    const start = serviceSource.indexOf("  commission_structure: {");
    const block = serviceSource.slice(start, serviceSource.indexOf("},", start));
    assert.match(block, /method: "GET"/);
    assert.match(block, /endpointKey: "GET \/user\/publisher\/\{publisherId\}\/campaign\/a \(embedded commission subtree\)"/);
    assert.match(block, /chain: "partnerizeCampaigns"/, "it must reuse the campaign chain");
    assert.match(block, /derivedFrom: "campaigns"/);
  });

  it("1c — it is registered on Partnerize only", () => {
    assert.deepEqual(listProbeSourceObjects("partnerize"), [
      "authenticate",
      "publishers",
      "campaigns",
      "vouchers",
      "conversions",
      "invoices",
      "payments",
      "commission_structure",
    ]);
    assert.ok(!listProbeSourceObjects("optimise").includes("commission_structure"));
  });
});

describe("partnerize commission structure — no extra supplier call", () => {
  it("2 — running it alone costs exactly one campaign request", async () => {
    const { fetches, row } = await run(["commission_structure"]);
    assert.deepEqual(fetches, ["campaigns"]);
    assert.equal(row.statusCategory, "OK");
  });

  it("2b — running it WITH campaigns still costs exactly one campaign request", async () => {
    for (const order of [
      ["campaigns", "commission_structure"],
      ["commission_structure", "campaigns"],
    ]) {
      const { fetches, result } = await run(order);
      assert.deepEqual(fetches, ["campaigns"], `two fetches for ${order.join("+")}`);
      assert.equal(result.results.length, 2);
      assert.deepEqual(result.results.map((r) => r.sourceObject).sort(), [
        "campaigns",
        "commission_structure",
      ]);
    }
  });

  it("2c — a campaign failure is reported on both rows without a second attempt", async () => {
    const notConfigured = Object.assign(new Error("no publisher"), { partnerizeNoPublisherId: true });
    const { fetches, result } = await run(["campaigns", "commission_structure"], notConfigured);
    assert.deepEqual(fetches, ["campaigns"]);
    for (const entry of result.results) {
      assert.equal(entry.statusCategory, "SKIPPED_NO_PUBLISHER_ID");
      assert.equal(entry.ok, false);
    }
  });
});

describe("partnerize commission structure — distinct outcomes stay distinct", () => {
  it("3 — three distinct outcomes are reported as three, never merged", async () => {
    const { row } = await run(["commission_structure"]);
    assert.equal(row.commissionsObservedType, "ARRAY");
    assert.equal(row.commissionOutcomeCount, 3, "outcomes were collapsed");
    // Two shapes: the two percentage outcomes share keys, the fixed one does not.
    assert.equal(row.distinctOutcomeShapeCount, 2);
  });

  it("3b — the count tracks the payload rather than being derived from paths", () => {
    for (const n of [0, 1, 2, 5, 17]) {
      const commissions = Array.from({ length: n }, (_, i) => ({ name: `zzn${i}zz`, value: `zzv${i}zz` }));
      const summary = summariseCommissionStructure({ ...CAMPAIGN_ROW, commissions });
      assert.equal(summary.commissionOutcomeCount, n, `${n} outcomes were not counted as ${n}`);
      // Identical shapes stay one shape; the OUTCOME count is what preserves distinctness.
      assert.equal(summary.distinctOutcomeShapeCount, n === 0 ? 0 : 1);
    }
  });

  it("3c — every outcome field appears as its own path, none dropped", async () => {
    const { row } = await run(["commission_structure"]);
    assert.deepEqual(row.fieldPaths.map((f) => f.path).sort(), [
      "commissions",
      "commissions[]",
      "commissions[].amount",
      "commissions[].currency",
      "commissions[].name",
      "commissions[].type",
      "commissions[].value",
      "default_commission_rate",
      "default_commission_value",
      "default_currency",
    ]);
    // The union covers keys unique to a single outcome, so no outcome's shape is discarded.
    const paths = row.fieldPaths.map((f) => f.path);
    for (const unique of ["commissions[].amount", "commissions[].currency"]) {
      assert.ok(paths.includes(unique), `${unique} was dropped`);
    }
  });

  it("3d — the defaults are reported as presence, alongside and not instead of the outcomes", async () => {
    const { row } = await run(["commission_structure"]);
    assert.equal(row.defaultCommissionRatePresent, true);
    assert.equal(row.defaultCommissionValuePresent, true);
    assert.equal(row.defaultCurrencyPresent, true);
    // Both defaults coexist with the collection: none of the three displaces another.
    assert.equal(row.commissionOutcomeCount, 3);
    assert.match(row.note, /never merged/);
    assert.match(row.note, /display and default context only/);
    assert.match(row.note, /not payout truth when commissions\[\] states more specific/);
    assert.match(row.note, /SupplierCommissionRule, one row per outcome/);
  });

  it("3e — nothing in the summariser averages, sums, sorts by value or picks one outcome", () => {
    const start = serviceSource.indexOf("export function summariseCommissionStructure");
    const body = serviceSource.slice(start, serviceSource.indexOf("\n}", start));
    for (const forbidden of [
      "reduce(",
      "Math.max",
      "Math.min",
      "parseFloat",
      "parseInt",
      "Number(",
      "average",
      "/ elements.length",
      "[0]",
      ".sort((",
      ".find(",
      ".filter(",
    ]) {
      assert.ok(!body.includes(forbidden), `the summariser uses ${forbidden}`);
    }
    // Shapes are computed from key NAMES only.
    assert.match(body, /Object\.keys\(element\)\.sort\(\)\.join\(","\)/);
    assert.ok(!body.includes("Object.values(element)"), "element values are read");
  });

  it("3f — non-collection shapes are reported as they are, not coerced into a list", () => {
    const cases = [
      [{ ...CAMPAIGN_ROW, commissions: null }, "NULL", null],
      [{ ...CAMPAIGN_ROW, commissions: { a: 1 } }, "OBJECT", null],
      [{ ...CAMPAIGN_ROW, commissions: "zzstringzz" }, "STRING", null],
      [{ ...CAMPAIGN_ROW, commissions: [] }, "ARRAY", 0],
    ];
    for (const [row, type, count] of cases) {
      const summary = summariseCommissionStructure(row);
      assert.equal(summary.commissionsObservedType, type);
      assert.equal(summary.commissionOutcomeCount, count);
    }
    const absent = { ...CAMPAIGN_ROW };
    delete absent.commissions;
    assert.equal(summariseCommissionStructure(absent).commissionsObservedType, "ABSENT");
    assert.equal(summariseCommissionStructure(absent).commissionsPresent, false);
  });

  it("3g — a campaign with no collection is its own outcome, not a failure", async () => {
    const { row } = await run(["commission_structure"], { ...CAMPAIGN_ROW, commissions: [] });
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK_NO_COMMISSION_COLLECTION_IN_BOUNDED_SAMPLE");
    assert.equal(row.commissionOutcomeCount, 0);
  });
});

describe("partnerize commission structure — nothing leaks, nothing is written", () => {
  it("4 — no commission value, currency, rate or identifier appears in the output", async () => {
    const { result } = await run(["campaigns", "commission_structure"]);
    const serialised = JSON.stringify(result);
    for (const value of ALL_VALUES) {
      assert.ok(!serialised.includes(value), `the value ${value} leaked`);
    }
    for (const credential of ["zzappkeyzz", "zzuserapikeyzz", "zzpublisherzz", "zzcertcampaignzz"]) {
      assert.ok(!serialised.includes(credential), `${credential} leaked`);
    }
    // What it does report: paths, categories, presence and counts.
    const row = result.results.find((r) => r.sourceObject === "commission_structure");
    for (const field of row.fieldPaths) {
      assert.ok(typeof field.path === "string");
      assert.ok(!ALL_VALUES.some((v) => JSON.stringify(field).includes(v)), "a field entry holds a value");
    }
  });

  it("4b — only the four commission keys are inspected; the rest of the campaign is not", async () => {
    assert.deepEqual([...COMMISSION_STRUCTURE_KEYS], [
      "commissions",
      "default_commission_rate",
      "default_commission_value",
      "default_currency",
    ]);
    const { row } = await run(["commission_structure"]);
    const paths = row.fieldPaths.map((f) => f.path);
    // Present in the campaign row, absent from the commission dictionary.
    for (const other of ["campaign_id", "title"]) {
      assert.ok(!paths.includes(other), `${other} appeared in the commission subtree`);
    }
    // And the full campaigns row still reports them, so nothing was lost overall.
    const { result } = await run(["campaigns", "commission_structure"]);
    const campaigns = result.results.find((r) => r.sourceObject === "campaigns");
    for (const other of ["campaign_id", "title"]) {
      assert.ok(campaigns.fieldPaths.some((f) => f.path === other), `${other} vanished from campaigns`);
    }
  });

  it("5 — no caller-controlled supplier path or identifier", async () => {
    for (const body of [
      { campaignId: "999" },
      { publisherId: "999" },
      { path: "/user/publisher/9/campaign/9" },
      { commissionEndpoint: "x" },
      { endpoint: "x" },
    ]) {
      assert.throws(() => parseRunBody(body), /Unsupported field/);
    }
    assert.match(
      controllerSource,
      /const allowed = new Set\(\["sourceObjects", "region", "accountLabel", "compareRaw", "windowPreset"\]\);/,
    );
    // An unknown source object is refused rather than dispatched.
    const { adapter, fetches } = adapterFor();
    await assert.rejects(
      serviceFor(adapter).certify("partnerize", { sourceObjects: ["commissions"] }),
      /Unknown source objects/,
    );
    assert.deepEqual(fetches, []);
  });

  it("6 — the commission chain writes nothing", () => {
    const start = serviceSource.indexOf("export function summariseCommissionStructure");
    const summary = serviceSource.slice(start, serviceSource.indexOf("\n}", start));
    const chainStart = serviceSource.indexOf("async certifyPartnerizeCampaigns");
    const chain = serviceSource.slice(chainStart, serviceSource.indexOf("\n  }\n", chainStart));
    for (const body of [summary, chain]) {
      for (const forbidden of [
        "this.db",
        "prisma",
        ".create(",
        ".update(",
        ".upsert(",
        ".delete(",
        "persistRawPayload",
        "promote",
      ]) {
        assert.ok(!body.includes(forbidden), `a commission code path does ${forbidden}`);
      }
    }
  });
});

describe("partnerize commission structure — existing behaviour unchanged", () => {
  it("7 — the campaigns row still reports the full dictionary", async () => {
    const { result } = await run(["campaigns"]);
    const campaigns = result.results.find((r) => r.sourceObject === "campaigns");
    assert.equal(campaigns.statusCategory, "OK");
    assert.equal(campaigns.sampleCount, 1);
    assert.equal(campaigns.endpointKey, "GET /user/publisher/{publisherId}/campaign/a");
    // Every campaign path, not just the commission subtree.
    const paths = campaigns.fieldPaths.map((f) => f.path);
    for (const expected of ["campaign_id", "title", "commissions", "commissions[].name"]) {
      assert.ok(paths.includes(expected), `${expected} missing from campaigns`);
    }
  });

  it("7b — vouchers is untouched and still costs its own single request", async () => {
    const { adapter, fetches } = adapterFor();
    const result = await serviceFor(adapter).certify("partnerize", { sourceObjects: ["vouchers"] });
    assert.deepEqual(fetches, ["vouchers"]);
    assert.equal(result.results[0].endpointKey, "GET /user/publisher/{publisherId}/campaign/{campaignId}/voucher");
  });

  it("7c — vouchers alongside commission_structure is one of each, never a shared fetch", async () => {
    const { adapter, fetches } = adapterFor();
    await serviceFor(adapter).certify("partnerize", {
      sourceObjects: ["vouchers", "commission_structure", "campaigns"],
    });
    assert.deepEqual(fetches.sort(), ["campaigns", "vouchers"]);
  });

  it("7d — the production mapper is untouched: commissions is still a passthrough", () => {
    // Certification reads the supplier shape; it does not change how sync maps it. Promoting
    // outcomes into SupplierCommissionRule is a later, separate change.
    assert.match(
      mapperSource.replace(/\s+/g, " "),
      /commissionGroups: base\.commissionGroups \?\? raw\.commissions \?\? raw\.active_commissions \?\? raw\.commission_groups/,
    );
    assert.ok(!mapperSource.includes("summariseCommissionStructure"));
  });

  it("7e — Optimise is unaffected", () => {
    assert.equal(listProbeSourceObjects("optimise").length, 11);
    assert.ok(!serviceSource.includes("OPTIMISE_PROBES.commission_structure"));
  });
});

/** Campaign rows carrying no commission structure, for building a multi-row response. */
const emptyRow = (i) => ({
  campaign_id: `zzempty${i}zz`,
  title: `zzemptytitle${i}zz`,
  default_commission_rate: "zzdefaultratezz",
  default_currency: "zzdefaultcurrencyzz",
  commissions: [],
});

describe("partnerize commission structure — bounded in-memory scan", () => {
  it("S1 — several rows in ONE response cost one request and are scanned in order", async () => {
    const rows = [emptyRow(1), emptyRow(2), CAMPAIGN_ROW, emptyRow(4)];
    const { fetches, row } = await run(["commission_structure"], rows);
    assert.deepEqual(fetches, ["campaigns"], "extra rows must not cost extra requests");
    assert.equal(row.campaignsInspectedCount, 3, "the scan stopped at the first non-empty row");
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.commissionOutcomeCount, 3);
  });

  it("S2 — the FIRST non-empty row wins; later richer rows do not displace it", async () => {
    const richer = {
      ...CAMPAIGN_ROW,
      commissions: [{ a: "zz1zz" }, { a: "zz2zz" }, { a: "zz3zz" }, { a: "zz4zz" }, { a: "zz5zz" }],
    };
    const first = { ...CAMPAIGN_ROW, commissions: [{ name: "zzonlyzz" }] };
    const { row } = await run(["commission_structure"], [emptyRow(1), first, richer]);
    assert.equal(row.campaignsInspectedCount, 2);
    assert.equal(row.commissionOutcomeCount, 1, "a later row with more outcomes was preferred");
    // No sorting or scoring: the chooser walks the response's own order.
    const start = serviceSource.indexOf("export function chooseCommissionSampleRow");
    const body = serviceSource.slice(start, serviceSource.indexOf("\n}", start));
    for (const forbidden of [".sort(", "Math.max", "reduce(", ".length >", "score"]) {
      assert.ok(!body.includes(forbidden), `the chooser uses ${forbidden}`);
    }
  });

  it("S3 — at most ten rows are inspected, however many arrive", async () => {
    assert.equal(COMMISSION_SCAN_ROW_LIMIT, 10);
    const twenty = Array.from({ length: 20 }, (_, i) => emptyRow(i));
    // The only non-empty row sits beyond the bound and must NOT be found.
    twenty[15] = CAMPAIGN_ROW;
    const { fetches, row } = await run(["commission_structure"], twenty);
    assert.deepEqual(fetches, ["campaigns"]);
    assert.equal(row.campaignsInspectedCount, 10, "the scan walked past its bound");
    assert.equal(row.statusCategory, "OK_NO_COMMISSION_COLLECTION_IN_BOUNDED_SAMPLE");
    assert.equal(row.commissionOutcomeCount, 0);
  });

  it("S3b — the adapter caps rows kept from one response at the same ceiling", async () => {
    const { CERTIFICATION_MAX_SCAN_ROWS, createPartnerizeAdapter } = await import(
      "../src/adapters/partnerize.adapter.js"
    );
    assert.equal(CERTIFICATION_MAX_SCAN_ROWS, 10);
    const calls = [];
    const adapter = createPartnerizeAdapter({
      applicationKey: "zzappkeyzz",
      userApiKey: "zzuserapikeyzz",
      publisherId: "zzpublisherzz",
      httpClient: {
        get: async (path, config = {}) => {
          calls.push({ path, params: config.params });
          return { data: { campaigns: Array.from({ length: 40 }, (_, i) => ({ campaign_id: `zzc${i}zz` })) } };
        },
      },
    });
    const rows = await adapter.fetchCertificationCampaignSample({ timeoutMs: 3000 });
    assert.equal(calls.length, 1, "one request");
    assert.equal(rows.length, 10, "more than the ceiling was kept");
    // The certification query: ten rows, offset zero, one participation status, one request.
    assert.deepEqual(calls[0].params, { limit: 10, offset: 0 });
    assert.equal(calls[0].path, "/user/publisher/zzpublisherzz/campaign/a");
  });

  it("S4 — no per-campaign fan-out: the scan issues nothing at all", () => {
    const start = serviceSource.indexOf("export function chooseCommissionSampleRow");
    const chooser = serviceSource.slice(start, serviceSource.indexOf("\n}", start));
    for (const forbidden of ["await", "fetch", "adapter", "httpClient", "sampleOnce", "async"]) {
      assert.ok(!chooser.includes(forbidden), `the chooser does ${forbidden}`);
    }
    // And the chain still makes exactly one campaign call on the multi-row path.
    const chainStart = serviceSource.indexOf("async certifyPartnerizeCampaigns");
    const chain = serviceSource.slice(chainStart, serviceSource.indexOf("\n  }\n", chainStart));
    assert.equal(chain.split("fetchCertificationCampaignSample").length - 1, 1);
    assert.ok(!/for \(|while \(/.test(chain), "the chain loops over campaigns");
  });

  it("S5 — an empty or absent collection never satisfies the scan", () => {
    for (const commissions of [[], null, undefined, {}, "", 0, "zzstringzz"]) {
      assert.equal(hasCommissionStructure({ commissions }), false, String(commissions));
    }
    for (const commissions of [[{ a: 1 }], [null], { a: 1 }]) {
      assert.equal(hasCommissionStructure({ commissions }), true, JSON.stringify(commissions));
    }
    assert.equal(hasCommissionStructure(null), false);
    assert.equal(hasCommissionStructure(), false);
  });

  it("S3c — the chooser enforces its own bound, independently of its caller", () => {
    // The service slices before calling, and the adapter caps before that, so the chooser's own
    // bound is never exercised through the chain. Tested directly, because defence in depth that
    // is never asserted is just an unverified claim.
    const rows = Array.from({ length: 40 }, (_, i) => emptyRow(i));
    rows[25] = CAMPAIGN_ROW;
    const chosen = chooseCommissionSampleRow(rows, COMMISSION_SCAN_ROW_LIMIT);
    assert.equal(chosen.campaignsInspectedCount, 10, "the chooser walked past its own bound");
    assert.equal(chosen.found, false, "it reached a row beyond the bound");
    // And a smaller explicit bound is honoured too.
    assert.equal(chooseCommissionSampleRow(rows, 3).campaignsInspectedCount, 3);
    assert.equal(chooseCommissionSampleRow(rows, 26).found, true);
  });

  it("S3d — the adapter clamps an inflated maxRows to the ceiling", () => {
    // No current caller passes more than the ceiling, so this is asserted at the source: the clamp
    // is what stops a future caller turning a scan into unbounded work.
    assert.match(
      adapterSource,
      /const maxRows = Math\.max\(1, Math\.min\(Number\(ctx\.maxRows\) \|\| 1, CERTIFICATION_MAX_SCAN_ROWS\)\);/,
    );
    assert.match(adapterSource, /export const CERTIFICATION_MAX_SCAN_ROWS = 10;/);
  });

  it("S5b — the chooser reports what it walked, even when it finds nothing", () => {
    assert.deepEqual(chooseCommissionSampleRow([], 10), {
      row: null,
      campaignsInspectedCount: 0,
      found: false,
    });
    const none = chooseCommissionSampleRow([emptyRow(1), emptyRow(2)], 10);
    assert.equal(none.found, false);
    assert.equal(none.campaignsInspectedCount, 2);
    // It falls back to the first row so the default_* presence flags are still reported.
    assert.equal(none.row.campaign_id, "zzempty1zz");
    for (const notAList of [null, undefined, "x", 42, {}]) {
      assert.deepEqual(chooseCommissionSampleRow(notAList, 10).campaignsInspectedCount, 0);
    }
  });

  it("S6 — nothing from any inspected row leaks, not just the chosen one", async () => {
    const rows = [emptyRow(1), emptyRow(2), CAMPAIGN_ROW];
    const { result } = await run(["campaigns", "commission_structure"], rows);
    const serialised = JSON.stringify(result);
    for (const value of [...ALL_VALUES, "zzempty1zz", "zzempty2zz", "zzemptytitle1zz", "zzemptytitle2zz"]) {
      assert.ok(!serialised.includes(value), `${value} leaked from an inspected row`);
    }
    // The count is the only thing the skipped rows contribute.
    const row = result.results.find((r) => r.sourceObject === "commission_structure");
    assert.equal(row.campaignsInspectedCount, 3);
  });

  it("S7 — the campaigns dictionary is still built from exactly one row", async () => {
    const rows = [CAMPAIGN_ROW, { ...emptyRow(2), zzextrafieldzz: 1 }];
    const { result } = await run(["campaigns", "commission_structure"], rows);
    const campaigns = result.results.find((r) => r.sourceObject === "campaigns");
    assert.equal(campaigns.sampleCount, 1, "the campaigns sample widened");
    assert.ok(
      !campaigns.fieldPaths.some((f) => f.path === "zzextrafieldzz"),
      "a second row bled into the campaigns dictionary",
    );
  });
});


describe("partnerize commission structure — the widened certification query", () => {
  /** One request against a stubbed client; returns what was actually sent. */
  async function requestFor(rows) {
    const calls = [];
    const adapter = createPartnerizeAdapter({
      applicationKey: "zzappkeyzz",
      userApiKey: "zzuserapikeyzz",
      publisherId: "zzpublisherzz",
      httpClient: {
        get: async (path, config = {}) => {
          calls.push({ path, params: config.params });
          return { data: { campaigns: rows } };
        },
      },
    });
    const kept = await adapter.fetchCertificationCampaignSample({ timeoutMs: 3000 });
    return { calls, kept };
  }

  it("W1 — the certification query is exactly { limit: 10, offset: 0 }", async () => {
    assert.equal(PARTNERIZE_CERTIFICATION_CAMPAIGN_SAMPLE_LIMIT, 10);
    const { calls } = await requestFor([{ campaign_id: "zzc1zz" }]);
    assert.equal(calls.length, 1, "exactly one HTTP request");
    assert.deepEqual(calls[0].params, { limit: 10, offset: 0 });
    assert.equal(calls[0].path, "/user/publisher/zzpublisherzz/campaign/a");
    // The constant is what the spec uses, so the two cannot drift.
    assert.match(
      adapterSource,
      /export const PARTNERIZE_CERTIFICATION_CAMPAIGN_SAMPLE_LIMIT = 10;/,
    );
    assert.match(
      adapterSource,
      /const PARTNERIZE_CAMPAIGN_SAMPLE_PAGE = Object\.freeze\(\{\s*limit: PARTNERIZE_CERTIFICATION_CAMPAIGN_SAMPLE_LIMIT,\s*offset: 0,\s*\}\);/,
    );
  });

  it("W2 — offset stays 0 and there is no second page, however many rows arrive", async () => {
    const { calls, kept } = await requestFor(
      Array.from({ length: 200 }, (_, i) => ({ campaign_id: `zzc${i}zz` })),
    );
    assert.equal(calls.length, 1, "a second page was requested");
    assert.equal(calls[0].params.offset, 0);
    assert.equal(kept.length, 10, "more than the ceiling was kept in memory");
  });

  it("W3 — publishers is NOT widened: it still samples one row", async () => {
    const calls = [];
    const adapter = createPartnerizeAdapter({
      applicationKey: "zzappkeyzz",
      userApiKey: "zzuserapikeyzz",
      publisherId: null,
      httpClient: {
        get: async (path, config = {}) => {
          calls.push({ path, params: config.params });
          if (path === "/user/publisher") return { data: { publishers: [{ publisher_id: "zzdiscoveredzz" }] } };
          return { data: { campaigns: [{ campaign_id: "zzc1zz" }] } };
        },
      },
    });
    await adapter.fetchCertificationCampaignSample({ timeoutMs: 3000 });
    const publishers = calls.find((c) => c.path === "/user/publisher");
    assert.deepEqual(publishers.params, { limit: 1, offset: 0 }, "the publishers sample was widened");
    assert.match(adapterSource, /const PARTNERIZE_SINGLE_ROW = \{ limit: 1, offset: 0 \};/);
  });

  it("W4 — production sync pagination is untouched and reads none of this", () => {
    // fetchPaginated derives its own limit from the caller's query, defaulting to 100, and loops
    // until a short page. Certification's constant is not referenced anywhere in it.
    assert.match(adapterSource, /const limit = Number\(query\.limit \?\? query\.page_size \?\? 100\);/);
    const start = adapterSource.indexOf("async function fetchPaginated");
    const body = adapterSource.slice(start, adapterSource.indexOf("\n  }", start));
    for (const forbidden of [
      "PARTNERIZE_CERTIFICATION_CAMPAIGN_SAMPLE_LIMIT",
      "PARTNERIZE_CAMPAIGN_SAMPLE_PAGE",
      "PARTNERIZE_SINGLE_ROW",
      "CERTIFICATION_MAX_SCAN_ROWS",
    ]) {
      assert.ok(!body.includes(forbidden), `sync pagination reads ${forbidden}`);
    }
    // Its loop and its stop condition are unchanged.
    assert.match(body, /for \(;;\) \{/);
    assert.match(body, /if \(!hasMore\(data, offset, limit, rows\.length\) \|\| rows\.length === 0\) break;/);
    assert.match(body, /offset \+= rows\.length;/);
    assert.match(body, /if \(page > 500\) break;/);
    // And the sync campaign fetcher still goes through it.
    assert.match(adapterSource, /collected\.push\(\.\.\.asArray\(await fetchPaginated\(path, params, stats\)\)\);/);
  });

  it("W5 — the widened page is certification-only: two constants, two callers", () => {
    // The certification page constant is used by the certification spec and nowhere else.
    assert.equal(adapterSource.split("PARTNERIZE_CAMPAIGN_SAMPLE_PAGE").length - 1, 2);
    const specStart = adapterSource.indexOf("  campaigns: {");
    const spec = adapterSource.slice(specStart, adapterSource.indexOf("  },", specStart));
    assert.match(spec, /params: \(\) => \(\{ \.\.\.PARTNERIZE_CAMPAIGN_SAMPLE_PAGE \}\)/);
    // No caller can supply either value.
    for (const body of [{ limit: 50 }, { offset: 10 }, { page: 2 }, { pageSize: 25 }]) {
      assert.throws(() => parseRunBody(body), /Unsupported field/);
    }
  });

  it("W6 — a wider page still costs one request through the whole chain", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => emptyRow(i));
    rows[6] = CAMPAIGN_ROW;
    const { fetches, row, result } = await run(["campaigns", "commission_structure"], rows);
    assert.deepEqual(fetches, ["campaigns"], "the widened page cost an extra request");
    assert.equal(row.campaignsInspectedCount, 7);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.commissionOutcomeCount, 3);
    // The campaigns dictionary is still one row.
    assert.equal(result.results.find((r) => r.sourceObject === "campaigns").sampleCount, 1);
    // And nothing from the nine other rows leaks.
    const serialised = JSON.stringify(result);
    for (const value of [...ALL_VALUES, "zzempty0zz", "zzempty9zz", "zzemptytitle3zz"]) {
      assert.ok(!serialised.includes(value), `${value} leaked`);
    }
  });
});
