import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.PARTNERIZE_CERTIFICATION_MIN_INTERVAL_MS = "1";

const {
  COMMISSION_STRUCTURE_KEYS,
  NetworkCertificationService,
  listProbeSourceObjects,
  summariseCommissionStructure,
} = await import("../src/modules/ops/networkCertification.service.js");
const { parseRunBody } = await import("../src/controllers/networkCertification.controller.js");

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
  return {
    fetches,
    adapter: {
      fetchCertificationCampaignSample: async () => {
        fetches.push("campaigns");
        return row instanceof Error ? Promise.reject(row) : [row];
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
    assert.match(row.note, /not payout truth when commissions\[\] states more specific outcomes/);
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
    assert.equal(row.statusCategory, "OK_NO_COMMISSION_COLLECTION");
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
