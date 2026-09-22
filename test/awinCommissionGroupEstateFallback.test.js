import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.AWIN_MIN_INTERVAL_MS = "1";
process.env.LOG_LEVEL = "silent";

const { createAwinAdapter } = await import("../src/adapters/awin.adapter.js");
const { NetworkCertificationService } = await import(
  "../src/modules/ops/networkCertification.service.js"
);

/**
 * Phase 22 step 2 — the commission_groups probe resolves an advertiser from MBO's own estate.
 *
 * Certified live in production: SKIPPED_NO_ADVERTISER_ID, campaignsInspectedCount 0. Discovery
 * reads /programmes with relationship=joined, this account has joined nothing, and the probe
 * therefore never reached the endpoint it exists to certify. The advertisers are not unknown —
 * 1,418 Awin SupplierCampaign rows are already derived and certified, and their supplierCampaignId
 * IS the advertiser id.
 *
 * This is a PROBE-ONLY change. Nothing here fetches offers, plans a sync, maps a commission group
 * or writes a rule.
 */

const TOKEN = "zzaccesstokenzz";
const PUBLISHER_ID = "zzpub9876zz";
const SAMPLE_ADVERTISER_ID = "778899";
const ESTATE_ADVERTISER_ID = "104455";

const PROGRAMME_ROW = { id: SAMPLE_ADVERTISER_ID, name: "zzadvertisernamezz", currencyCode: "GBP" };
const GROUP_ROW = {
  groupId: 4455,
  groupCode: "zzgroupcodezz",
  groupName: "zzgroupnamezz",
  percentage: 7.25,
  amount: 3.5,
  currency: "GBP",
  type: "percentage",
  conditions: [{ conditionType: "zzconditiontypezz", value: "zzconditionvaluezz" }],
};

function spyHttp({ programmes = [], groups = [GROUP_ROW] } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      get: async (path, config = {}) => {
        calls.push({ path, params: config.params });
        if (path.includes("commissiongroups")) return { data: { commissionGroups: groups } };
        if (path.includes("/programmes")) return { data: { programmes } };
        throw new Error(`unexpected path ${path}`);
      },
      post: async () => ({ data: { data: [] } }),
    },
  };
}

/** A prisma double that records every call and can only read. */
function dbSpy({ rows = [], throws = false, absent = false } = {}) {
  const queries = [];
  const writes = [];
  if (absent) return { queries, writes, client: {} };
  const forbid = (name) => (...args) => { writes.push({ name, args }); throw new Error(`write attempted: ${name}`); };
  return {
    queries,
    writes,
    client: {
      supplierCampaign: {
        findMany: async (query) => {
          queries.push(query);
          if (throws) throw new Error("zzdatabaseunavailablezz");
          const matched = rows.filter((row) => {
            const where = query.where ?? {};
            if (where.supplier && row.supplier !== where.supplier) return false;
            if ("archivedAt" in where && row.archivedAt !== where.archivedAt) return false;
            return true;
          });
          matched.sort((a, b) =>
            String(a.supplierCampaignId) < String(b.supplierCampaignId) ? -1 : 1,
          );
          const selected = matched.map((row) => ({ supplierCampaignId: row.supplierCampaignId }));
          return query.take ? selected.slice(0, query.take) : selected;
        },
        create: forbid("create"),
        update: forbid("update"),
        upsert: forbid("upsert"),
        deleteMany: forbid("deleteMany"),
      },
    },
  };
}

async function certify({ programmes = [], groups = [GROUP_ROW], db = dbSpy() } = {}) {
  const spy = spyHttp({ programmes, groups });
  const service = new NetworkCertificationService({
    prisma: db.client,
    adapterFactory: (config) => createAwinAdapter({ ...config, httpClient: spy.client }),
    awinCredentialResolver: async () => ({ accessToken: TOKEN, publisherId: PUBLISHER_ID }),
  });
  const result = await service.certify("awin", { sourceObjects: ["commission_groups"] });
  return { entry: result.results[0], spy, db };
}

const groupCall = (spy) => spy.calls.find((c) => c.path.includes("commissiongroups"));

const awinRow = (id, over = {}) => ({
  supplier: "AWIN",
  supplierCampaignId: id,
  archivedAt: null,
  ...over,
});

describe("Phase 22 — the campaigns sample still wins", () => {
  it("A. a sampled advertiser id is used, and the estate is never queried", async () => {
    const db = dbSpy({ rows: [awinRow(ESTATE_ADVERTISER_ID)] });
    const { entry, spy } = await certify({ programmes: [PROGRAMME_ROW], db });

    assert.equal(entry.statusCategory, "OK");
    assert.equal(entry.advertiserIdResolved, true);
    assert.equal(entry.advertiserIdSource, "campaigns_sample");
    assert.equal(entry.campaignsInspectedCount, 1);
    assert.deepEqual(db.queries, [], "a joined account must not pay for a database read");
    assert.equal(groupCall(spy).params.advertiserId, SAMPLE_ADVERTISER_ID);
  });
});

describe("Phase 22 — the canonical estate supplies the id when the sample is empty", () => {
  it("B. one Awin SupplierCampaign resolves the advertiser and the probe proceeds", async () => {
    const db = dbSpy({ rows: [awinRow(ESTATE_ADVERTISER_ID)] });
    const { entry, spy } = await certify({ programmes: [], db });

    assert.equal(entry.statusCategory, "OK");
    assert.equal(entry.advertiserIdResolved, true);
    assert.equal(entry.advertiserIdSource, "canonical_supplier_campaign");
    assert.equal(entry.campaignsInspectedCount, 0, "the sample really was empty");
    assert.equal(groupCall(spy).params.advertiserId, ESTATE_ADVERTISER_ID);
  });

  it("C. the fallback query is bounded to one row of one column, deterministically ordered", async () => {
    const db = dbSpy({ rows: [awinRow("300"), awinRow("100"), awinRow("200")] });
    const { entry, spy } = await certify({ programmes: [], db });

    assert.equal(db.queries.length, 1, "exactly one database read");
    const query = db.queries[0];
    assert.equal(query.take, 1, "the read is not bounded to a single row");
    assert.deepEqual(query.select, { supplierCampaignId: true }, "more than the id was selected");
    assert.deepEqual(query.orderBy, { supplierCampaignId: "asc" }, "the ordering is not deterministic");
    // Deterministic means two runs pick the same advertiser.
    assert.equal(groupCall(spy).params.advertiserId, "100");
    assert.equal(entry.advertiserIdSource, "canonical_supplier_campaign");

    const second = await certify({ programmes: [], db: dbSpy({ rows: [awinRow("300"), awinRow("100"), awinRow("200")] }) });
    assert.equal(groupCall(second.spy).params.advertiserId, "100", "a second run chose a different advertiser");
  });

  it("D. only live Awin rows are eligible", async () => {
    const db = dbSpy({ rows: [awinRow(ESTATE_ADVERTISER_ID)] });
    await certify({ programmes: [], db });

    assert.deepEqual(
      db.queries[0].where,
      { supplier: "AWIN", archivedAt: null },
      "the fallback is not scoped to live Awin campaigns",
    );

    // Another network's rows can never answer an Awin probe.
    const foreign = dbSpy({ rows: [{ supplier: "TRACKIER", supplierCampaignId: "10240", archivedAt: null }] });
    const { entry, spy } = await certify({ programmes: [], db: foreign });
    assert.equal(entry.statusCategory, "SKIPPED_NO_ADVERTISER_ID");
    assert.equal(groupCall(spy), undefined, "a Trackier campaign reached the Awin endpoint");

    // An archived Awin campaign is not evidence of a live advertiser either.
    const archived = dbSpy({ rows: [awinRow(ESTATE_ADVERTISER_ID, { archivedAt: new Date() })] });
    const archivedRun = await certify({ programmes: [], db: archived });
    assert.equal(archivedRun.entry.statusCategory, "SKIPPED_NO_ADVERTISER_ID");
  });

  it("F. the supplier commissiongroups request is made exactly once", async () => {
    const db = dbSpy({ rows: [awinRow(ESTATE_ADVERTISER_ID)] });
    const { spy } = await certify({ programmes: [], db });

    const groupCalls = spy.calls.filter((c) => c.path.includes("commissiongroups"));
    assert.equal(groupCalls.length, 1, "the endpoint was called more than once");
    assert.equal(spy.calls.length, 2, "the chain must stay at two supplier requests");
    assert.ok(spy.calls[0].path.includes("/programmes"), "discovery still runs first");
  });

  it("an estate-resolved advertiser with no groups reports OK_NO_ROWS, not a skip", async () => {
    const db = dbSpy({ rows: [awinRow(ESTATE_ADVERTISER_ID)] });
    const { entry, spy } = await certify({ programmes: [], groups: [], db });

    assert.equal(entry.statusCategory, "OK_NO_ROWS");
    assert.equal(entry.ok, true);
    assert.equal(entry.advertiserIdResolved, true);
    assert.equal(entry.advertiserIdSource, "canonical_supplier_campaign");
    assert.equal(entry.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.ok(groupCall(spy), "the endpoint was reached, which is the whole point");
  });
});

describe("Phase 22 — the skip is preserved when nothing can resolve an id", () => {
  it("E. no canonical Awin campaign keeps SKIPPED_NO_ADVERTISER_ID", async () => {
    const db = dbSpy({ rows: [] });
    const { entry, spy } = await certify({ programmes: [], db });

    assert.equal(entry.statusCategory, "SKIPPED_NO_ADVERTISER_ID");
    assert.equal(entry.ok, false);
    assert.equal(entry.advertiserIdResolved, false);
    assert.equal(entry.advertiserIdSource, null);
    assert.equal(entry.campaignsInspectedCount, 0);
    assert.equal(entry.sampleCount, 0);
    assert.deepEqual(entry.fieldPaths, []);
    assert.equal(entry.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.equal(groupCall(spy), undefined, "no commission-group request may be made");
    assert.equal(spy.calls.length, 1, "the skip still costs exactly one supplier request");
    assert.match(entry.note, /no commission-group request was made/i);
    assert.match(entry.note, /canonical/i, "the note must say the estate was tried too");
  });

  it("a database that cannot answer skips rather than failing the probe", async () => {
    for (const db of [dbSpy({ throws: true }), dbSpy({ absent: true })]) {
      const { entry, spy } = await certify({ programmes: [], db });
      assert.equal(entry.statusCategory, "SKIPPED_NO_ADVERTISER_ID");
      assert.ok(!("supplierStatusCode" in entry), "a database problem was reported as a supplier failure");
      assert.equal(groupCall(spy), undefined);
    }
  });

  it("a row with a blank supplierCampaignId is not an advertiser id", async () => {
    for (const value of ["", "   ", null]) {
      const db = dbSpy({ rows: [awinRow(value)] });
      const { entry } = await certify({ programmes: [], db });
      assert.equal(entry.statusCategory, "SKIPPED_NO_ADVERTISER_ID", JSON.stringify(value));
    }
  });
});

describe("Phase 22 — read-only and structural only", () => {
  it("G. no write is attempted on any path", async () => {
    for (const programmes of [[], [PROGRAMME_ROW]]) {
      for (const groups of [[], [GROUP_ROW]]) {
        const db = dbSpy({ rows: [awinRow(ESTATE_ADVERTISER_ID)] });
        await certify({ programmes, groups, db });
        assert.deepEqual(db.writes, [], "a write was attempted");
        for (const query of db.queries) {
          assert.ok(!("data" in query), "a read query carried write data");
        }
      }
    }
  });

  it("H. the response carries structure only — no supplier or campaign values", async () => {
    const db = dbSpy({ rows: [awinRow(ESTATE_ADVERTISER_ID, { campaignName: "zzcampaignnamezz" })] });
    const { entry } = await certify({ programmes: [], db });

    for (const field of [
      "sampleCount", "fieldPaths", "fieldCount",
      "statusCategory", "advertiserIdResolved", "campaignsInspectedCount",
    ]) {
      assert.ok(field in entry, `the response lost ${field}`);
    }
    // `schema` is carried on the outcomes that have nothing to describe — the skip and OK_NO_ROWS —
    // and not on OK, where fieldPaths IS the schema. That is the service's existing shape, observed
    // rather than introduced here, and the fallback does not change it.
    assert.ok(!("schema" in entry), "OK gained a schema field");
    const skipped = await certify({ programmes: [], db: dbSpy({ rows: [] }) });
    assert.equal(skipped.entry.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    const noRows = await certify({ programmes: [], groups: [], db: dbSpy({ rows: [awinRow(ESTATE_ADVERTISER_ID)] }) });
    assert.equal(noRows.entry.schema, "UNKNOWN_NEEDS_LIVE_DATA");

    const serialized = JSON.stringify(entry);
    for (const banned of [
      ESTATE_ADVERTISER_ID, SAMPLE_ADVERTISER_ID, TOKEN, PUBLISHER_ID,
      "zzcampaignnamezz", "zzgroupcodezz", "zzgroupnamezz", "zzconditionvaluezz",
      "7.25", "3.5", "GBP",
    ]) {
      assert.ok(!serialized.includes(banned), `the response leaked ${banned}`);
    }

    // fieldPaths is a dictionary of path descriptors — a path string plus observed type categories
    // and presence counts — and never a value. The BANNED sweep above already covers the whole
    // serialized entry; this pins the shape so a future change cannot start attaching samples.
    assert.ok(entry.fieldPaths.length > 0);
    for (const descriptor of entry.fieldPaths) {
      assert.equal(typeof descriptor.path, "string");
      assert.ok(!descriptor.path.includes("zz"), `a value reached a fieldPath: ${descriptor.path}`);
      for (const key of Object.keys(descriptor)) {
        assert.ok(
          [
            "path", "observedType", "exampleCategory", "nullableObserved",
            "arrayObserved", "objectObserved", "presentCount", "sampleCount",
          ].includes(key),
          `fieldPaths gained an unexpected key: ${key}`,
        );
      }
      // exampleCategory is a CATEGORY label (STRING/NUMBER/REDACTED/...), never an example value.
      assert.ok(/^[A-Z_]+$/.test(descriptor.exampleCategory), descriptor.exampleCategory);
      assert.ok(/^[A-Z_]+$/.test(descriptor.observedType), descriptor.observedType);
    }
    // The new field is a constant label, not data.
    assert.ok(["campaigns_sample", "canonical_supplier_campaign", null].includes(entry.advertiserIdSource));
  });

  it("nothing in the chain fetches offers, plans a sync or writes a commission rule", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");
    const start = src.indexOf("async certifyAwinCommissionGroups(");
    const body = src.slice(start, src.indexOf("\n  }\n", start));
    for (const forbidden of [
      "fetchCoupons", "fetchCouponsPage", "promotions", "SupplierCommissionRule",
      "commissionRule", "supplierCommission", "upsertManyRawEntities", "materialize",
    ]) {
      assert.ok(!body.includes(forbidden), `the probe reaches ${forbidden}`);
    }
  });
});
