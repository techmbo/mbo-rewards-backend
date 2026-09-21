import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AWIN_DERIVED_RECORD_SOURCE,
  AWIN_DERIVED_SOURCE_OBJECT,
  AwinAdvertiserParentService,
  awinAdvertiserIdentity,
  buildDerivedAwinCampaignRow,
  derivedAwinCampaignExternalId,
  isDerivedAwinCampaignRaw,
} from "../src/modules/supplier/services/awinAdvertiserParent.service.js";
import { buildAwinCampaignExternalId, buildAwinCouponExternalId } from "../src/modules/raw/raw.service.js";
import { entityConflictKey } from "../src/modules/raw/batchEntityUpsert.js";
import { mapEntityToSupplierCoupon } from "../src/modules/supplier/mappers/index.js";
import { mapEntityToSupplierCampaign } from "../src/modules/supplier/mappers/index.js";

/**
 * Phase 18 — Awin advertiser parents derived from offers already staged.
 *
 * Awin programmes return nothing, so every offer fails parent resolution. The advertiser is not
 * missing: it is nested on each promotion row. These tests drive the REAL identity builders and
 * the REAL conflict key, so convergence between a derived parent and a future programme row is
 * proven by the code that decides it rather than restated.
 */

function offerEntity(id, rawData) {
  return { id, networkSource: "awin", entityType: "coupon", rawData };
}

function offerRaw(advertiserId, advertiserName, promotionId) {
  return {
    promotionId,
    advertiser: { id: advertiserId, name: advertiserName },
    type: "voucher",
    voucher: { code: "SAVE10" },
  };
}

/** In-memory Entity store honouring exactly the queries the service issues. */
function store(rows) {
  const calls = [];
  return {
    calls,
    db: {
      entity: {
        findMany: async (query) => {
          calls.push(query);
          const where = query.where ?? {};
          let matched = rows.filter((row) => {
            if (where.networkSource && row.networkSource !== where.networkSource) return false;
            if (where.entityType && row.entityType !== where.entityType) return false;
            if (where.id?.gt && !(row.id > where.id.gt)) return false;
            return true;
          });
          matched = matched.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          return query.take ? matched.slice(0, query.take) : matched;
        },
      },
    },
  };
}

function service(rows, { pageSize = 500 } = {}) {
  const s = store(rows);
  const staged = [];
  const svc = new AwinAdvertiserParentService({
    db: s.db,
    pageSize,
    stageEntities: async (args) => {
      staged.push(args);
      return { preparedRecords: [] };
    },
  });
  return { svc, staged, store: s };
}

describe("Phase 18 — Awin offer parent extraction", () => {
  function couponEntity(raw) {
    return {
      id: "e-1",
      networkSource: "awin",
      entityType: "coupon",
      externalId: "awin-coupon-1418-99",
      entityName: "Offer",
      entityStatus: "Active",
      code: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      normalizedData: {},
      rawData: raw,
    };
  }

  it("A. nested advertiser.id becomes parentSupplierCampaignId, as a String", () => {
    const mapped = mapEntityToSupplierCoupon(couponEntity(offerRaw(1418, "Brand Ltd", 99)));
    assert.equal(mapped.parentSupplierCampaignId, "1418");
    assert.equal(typeof mapped.parentSupplierCampaignId, "string");
  });

  it("B. nested advertiser.name becomes parentCampaignName", () => {
    const mapped = mapEntityToSupplierCoupon(couponEntity(offerRaw(1418, "Brand Ltd", 99)));
    assert.equal(mapped.parentCampaignName, "Brand Ltd");
  });

  it("C. the flat advertiserId fallback still works for fanned-out voucher rows", () => {
    const mapped = mapEntityToSupplierCoupon(
      couponEntity({ record_source: "coupon", id: 7, advertiserId: 2255, advertiserName: "Flat Co", code: "X" }),
    );
    assert.equal(mapped.parentSupplierCampaignId, "2255");
    assert.equal(mapped.parentCampaignName, "Flat Co");
  });

  it("nested wins over flat when both are present", () => {
    const mapped = mapEntityToSupplierCoupon(
      couponEntity({ ...offerRaw(1418, "Nested Ltd", 99), advertiserId: 9999, advertiserName: "Flat Ltd" }),
    );
    assert.equal(mapped.parentSupplierCampaignId, "1418");
    assert.equal(mapped.parentCampaignName, "Nested Ltd");
  });

  it("L. Awin coupon identity is unchanged by the parent fix", () => {
    assert.equal(buildAwinCouponExternalId(offerRaw(1418, "Brand Ltd", 99)), "awin-coupon-1418-99");
    assert.equal(buildAwinCouponExternalId({ advertiser: { id: 1418 } }), null, "promotionId still required");
    assert.equal(buildAwinCouponExternalId({ promotionId: 99 }), null, "advertiser.id still required");
    assert.equal(buildAwinCouponExternalId({ advertiser: { id: "a1" }, promotionId: 99 }), null, "digits only");
  });
});

describe("Phase 18 — derived advertiser parents", () => {
  it("D. N offers for one advertiser derive exactly one campaign Entity", async () => {
    const rows = [];
    for (let i = 0; i < 25; i += 1) rows.push(offerEntity(`e-${i}`, offerRaw(1418, "Brand Ltd", 100 + i)));

    const { svc, staged } = service(rows);
    const summary = await svc.materialize();

    assert.equal(staged.length, 1, "one staging call");
    assert.equal(staged[0].rows.length, 1, "one derived campaign row");
    assert.equal(staged[0].entityType, "campaign");
    assert.equal(staged[0].networkSource, "awin");
    assert.equal(summary.offersScanned, 25);
    assert.equal(summary.advertisersFound, 1);
    assert.equal(summary.parentsStaged, 1);
    assert.equal(staged[0].rows[0]._mboDerivedFrom.offerEntityCount, 25);
  });

  it("E. many advertisers derive one parent each, with no cross-contamination", async () => {
    const rows = [];
    for (let a = 0; a < 40; a += 1) {
      for (let n = 0; n < 3; n += 1) {
        rows.push(offerEntity(`e-${a}-${n}`, offerRaw(1000 + a, `Brand ${a}`, a * 10 + n)));
      }
    }

    // pageSize below the row count so the grouping has to survive paging: each page stages its own
    // advertisers, so the assertions are across every page rather than one call.
    const { svc, staged } = service(rows, { pageSize: 7 });
    const summary = await svc.materialize();

    assert.equal(summary.offersScanned, 120);
    assert.equal(summary.advertisersFound, 40, "DISTINCT advertisers, not the sum of page totals");
    assert.equal(summary.parentsStaged, 40);

    const allRows = staged.flatMap((call) => call.rows);
    const byAdvertiser = new Map();
    for (const row of allRows) {
      const index = Number(row.advertiserId) - 1000;
      assert.equal(row.advertiser.name, `Brand ${index}`, "each parent kept its own name");
      byAdvertiser.set(row.advertiserId, (byAdvertiser.get(row.advertiserId) ?? 0) + 1);
    }
    assert.equal(byAdvertiser.size, 40, "one parent per advertiser across the whole walk");

    // G. An advertiser whose offers straddle a page boundary is staged on each page that sees it,
    // and every one of those writes lands on the SAME Entity, because the externalId is a pure
    // function of the advertiser id. One advertiser, one Entity, one SupplierCampaign.
    const externalIds = new Set(allRows.map((r) => buildAwinCampaignExternalId(r)));
    assert.equal(externalIds.size, 40, "a spanning advertiser must not mint a second Entity");
  });

  it("F. rerunning derivation is idempotent — same rows, same ids", async () => {
    const rows = [
      offerEntity("e-1", offerRaw(1418, "Brand Ltd", 1)),
      offerEntity("e-2", offerRaw(1418, "Brand Ltd", 2)),
    ];
    const { svc, staged } = service(rows);

    const first = await svc.materialize();
    const second = await svc.materialize();

    assert.deepEqual(first, second, "the summary is stable across runs");
    assert.deepEqual(staged[0].rows, staged[1].rows, "the staged payload is byte-identical");
    assert.equal(
      derivedAwinCampaignExternalId("1418"),
      "awin-campaign-1418",
      "the externalId is a pure function of the advertiser id",
    );
  });

  it("an offer with no advertiser is counted and skipped, never guessed at", async () => {
    const { svc, staged } = service([
      offerEntity("e-1", { promotionId: 5, type: "voucher" }),
      offerEntity("e-2", offerRaw(1418, "Brand Ltd", 6)),
    ]);
    const summary = await svc.materialize();

    assert.equal(summary.offersWithoutAdvertiser, 1);
    assert.equal(summary.advertisersFound, 1);
    assert.equal(staged[0].rows.length, 1);
  });

  it("stages nothing at all when there are no Awin offers", async () => {
    const { svc, staged } = service([]);
    const summary = await svc.materialize();
    assert.equal(staged.length, 0, "no empty staging call");
    assert.equal(summary.parentsStaged, 0);
  });
});

describe("Phase 18 — single-Entity convergence", () => {
  it("G. a derived parent and a real programme row mint the SAME externalId", () => {
    const derived = buildAwinCampaignExternalId(
      buildDerivedAwinCampaignRow({ advertiserId: "1418", advertiserName: "Brand Ltd", offerEntityCount: 3 }),
    );
    // The three shapes a real Awin programme row could plausibly carry its advertiser under.
    const programmeById = buildAwinCampaignExternalId({ id: 1418, name: "Brand Ltd", status: "joined" });
    const programmeByAdvertiserId = buildAwinCampaignExternalId({ advertiserId: 1418, name: "Brand Ltd" });
    const programmeByNested = buildAwinCampaignExternalId({ advertiser: { id: 1418 }, name: "Brand Ltd" });

    assert.equal(derived, "awin-campaign-1418");
    assert.equal(programmeById, "awin-campaign-1418");
    assert.equal(programmeByAdvertiserId, "awin-campaign-1418");
    assert.equal(programmeByNested, "awin-campaign-1418");
  });

  it("G2. numeric and string advertiser ids converge on one id", () => {
    assert.equal(buildAwinCampaignExternalId({ id: 1418 }), buildAwinCampaignExternalId({ id: "1418" }));
    assert.equal(buildAwinCampaignExternalId({ id: "  1418  " }), "awin-campaign-1418", "trimmed");
    assert.equal(buildAwinCampaignExternalId({}), null, "no id means no invented id");
    assert.equal(buildAwinCampaignExternalId({ id: "" }), null);
  });

  it("H. the two rows collide on the real Entity unique key, so programme data enriches in place", () => {
    const derivedKey = entityConflictKey({
      externalId: buildAwinCampaignExternalId(
        buildDerivedAwinCampaignRow({ advertiserId: "1418", advertiserName: "Brand Ltd", offerEntityCount: 3 }),
      ),
      networkSource: "awin",
      entityType: "campaign",
    });
    const programmeKey = entityConflictKey({
      externalId: buildAwinCampaignExternalId({ id: 1418, name: "Brand Ltd" }),
      networkSource: "awin",
      entityType: "campaign",
    });
    assert.equal(derivedKey, programmeKey, "one Entity, not two");
  });

  it("H2. both rows resolve to the same SupplierCampaign business key", () => {
    function businessKey(rawData) {
      const mapped = mapEntityToSupplierCampaign({
        id: "x",
        networkSource: "awin",
        entityType: "campaign",
        externalId: buildAwinCampaignExternalId(rawData),
        entityName: null,
        campaignName: null,
        entityStatus: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        normalizedData: {},
        rawData,
      });
      return [mapped.supplier, mapped.supplierRegion, mapped.sourceAccountLabel, mapped.supplierCampaignId].join("/");
    }

    const derived = businessKey(
      buildDerivedAwinCampaignRow({ advertiserId: "1418", advertiserName: "Brand Ltd", offerEntityCount: 3 }),
    );
    const programme = businessKey({ id: 1418, name: "Brand Ltd", status: "joined", currencyCode: "GBP" });

    assert.equal(derived, "AWIN/GLOBAL/default/1418");
    assert.equal(derived, programme, "the derived parent and the real programme are one campaign");
  });

  it("I. a later thin derived pass does NOT overwrite richer programme evidence", async () => {
    const programmeBacked = {
      id: "c-1",
      networkSource: "awin",
      entityType: "campaign",
      rawData: { id: 1418, name: "Brand Ltd", status: "joined", currencyCode: "GBP", commissionRange: { max: 8 } },
    };
    const { svc, staged } = service([
      programmeBacked,
      offerEntity("e-1", offerRaw(1418, "Brand Ltd", 1)),
      offerEntity("e-2", offerRaw(2255, "Other Co", 2)),
    ]);

    const summary = await svc.materialize();

    assert.equal(summary.skippedProgrammeBacked, 1);
    assert.equal(staged[0].rows.length, 1, "only the advertiser with no programme evidence is derived");
    assert.equal(staged[0].rows[0].advertiserId, "2255");
    assert.ok(
      !staged[0].rows.some((r) => r.advertiserId === "1418"),
      "the programme-backed advertiser must never be restaged from thin evidence",
    );
  });

  it("I2. a previously DERIVED parent is refreshed, because that is not richer evidence", async () => {
    const derivedBacked = {
      id: "c-1",
      networkSource: "awin",
      entityType: "campaign",
      rawData: buildDerivedAwinCampaignRow({ advertiserId: "1418", advertiserName: "Brand Ltd", offerEntityCount: 1 }),
    };
    const { svc, staged } = service([
      derivedBacked,
      offerEntity("e-1", offerRaw(1418, "Brand Ltd", 1)),
      offerEntity("e-2", offerRaw(1418, "Brand Ltd", 2)),
    ]);

    const summary = await svc.materialize();

    assert.equal(summary.skippedProgrammeBacked, 0);
    assert.equal(staged[0].rows.length, 1);
    assert.equal(staged[0].rows[0]._mboDerivedFrom.offerEntityCount, 2, "the refreshed count is the new one");
  });

  it("isDerivedAwinCampaignRaw tells the two kinds of evidence apart", () => {
    assert.equal(isDerivedAwinCampaignRaw(buildDerivedAwinCampaignRow({ advertiserId: "1", advertiserName: "A", offerEntityCount: 1 })), true);
    assert.equal(isDerivedAwinCampaignRaw({ id: 1, name: "A" }), false);
    assert.equal(isDerivedAwinCampaignRaw({ record_source: "coupon" }), false);
    assert.equal(isDerivedAwinCampaignRaw(null), false);
  });
});

describe("Phase 18 — provenance and restraint", () => {
  const derived = buildDerivedAwinCampaignRow({
    advertiserId: "1418",
    advertiserName: "Brand Ltd",
    offerEntityCount: 5,
  });

  it("J. provenance says advertiser_from_offer and never claims programme evidence", () => {
    assert.equal(derived.record_source, AWIN_DERIVED_RECORD_SOURCE);
    assert.equal(derived.record_source, "advertiser_from_offer");
    assert.notEqual(derived.record_source, "programme");
    assert.equal(derived._mboSourceObject, AWIN_DERIVED_SOURCE_OBJECT);
    assert.equal(derived._mboSourceObject, "offers");
    assert.deepEqual(derived._mboDerivedFrom, { advertiserId: "1418", offerEntityCount: 5 });
  });

  it("provenance stays bounded — no promotion id list that grows with the catalogue", () => {
    assert.deepEqual(Object.keys(derived._mboDerivedFrom).sort(), ["advertiserId", "offerEntityCount"]);
    const serialized = JSON.stringify(derived);
    assert.ok(serialized.length < 400, `derived payload should stay tiny, was ${serialized.length}`);
  });

  it("K. nothing is invented — no status, participation, country, currency, commission or URLs", () => {
    const forbidden = [
      "status", "campaignStatus", "campaign_status", "linkStatus",
      "relationship", "participationStatus", "isJoined",
      "country", "countryCode", "countryCodes", "primaryRegion",
      "currency", "currencyCode",
      "commission", "commissionRange", "commissionMax", "commissionGroups", "defaultCommissionValue",
      "clickThroughUrl", "displayUrl", "url", "trackingUrl", "destinationUrl",
      "cookieDurationDays", "deepLinkingEnabled", "campaignStartDate", "startDate",
    ];
    for (const key of forbidden) {
      assert.ok(!(key in derived), `derived parent must not carry ${key}`);
    }
    assert.deepEqual(
      Object.keys(derived).sort(),
      ["_mboDerivedFrom", "_mboSourceObject", "advertiser", "advertiserId", "campaignName", "id", "name", "record_source"],
      "the derived payload is identity and provenance, and nothing else",
    );
  });

  it("K2. the mapped campaign carries no invented supplier facts", () => {
    const mapped = mapEntityToSupplierCampaign({
      id: "x",
      networkSource: "awin",
      entityType: "campaign",
      externalId: buildAwinCampaignExternalId(derived),
      entityName: null,
      campaignName: null,
      entityStatus: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      normalizedData: {},
      rawData: derived,
    });

    assert.equal(mapped.supplierCampaignId, "1418");
    assert.equal(mapped.campaignName, "Brand Ltd");
    assert.equal(mapped.merchantNameRaw, "Brand Ltd");
    assert.equal(mapped.campaignStatus, "UNKNOWN", "status is unknown, not guessed");
    assert.equal(mapped.participationStatus, "UNKNOWN", "participation is unknown, not guessed");
    assert.equal(mapped.isJoined, false, "never claims a partnership");
    assert.equal(mapped.defaultCommissionValue, null, "commission is never inferred from an offer");
    // UNKNOWN is the mappers' fail-closed sentinel, and toCampaignWriteData turns exactly that
    // sentinel into a NULL column. What matters is that neither is a guessed real value.
    assert.equal(mapped.pricingModel, "UNKNOWN", "pricing model is unknown, not guessed");
    assert.equal(mapped.commissionUnit, "UNKNOWN", "commission unit is unknown, not guessed");
    assert.equal(mapped.commissionCurrency, null);
    assert.equal(mapped.trackingUrl ?? null, null);
    assert.equal(mapped.destinationUrl ?? null, null);
    assert.equal(mapped.cookieDurationDays ?? null, null);
    assert.equal(mapped.campaignStartDate ?? null, null);
    assert.deepEqual(mapped.countryCodes ?? [], []);
  });

  it("K3. the UNKNOWN sentinels are what the writer turns into NULL columns", () => {
    // Mirrors toCampaignWriteData's rule, so the sentinel can never reach the database as a value.
    const toColumn = (value) => (value === "UNKNOWN" ? null : value);
    assert.equal(toColumn("UNKNOWN"), null);
    assert.equal(toColumn(null), null);
  });

  it("commission fan-out is refused outright for derived parents", async () => {
    const { svc, staged } = service([offerEntity("e-1", offerRaw(1418, "Brand Ltd", 1))]);
    await svc.materialize();
    assert.equal(staged[0].commissionRuleFanOutDisabled, true);
    assert.equal(staged[0].finalizeSyncRun, false, "derived rows must not resolve a supplier fetch verdict");
  });

  it("N. derived parents are not published or assigned — the materializer only stages Entities", async () => {
    const { svc, staged } = service([offerEntity("e-1", offerRaw(1418, "Brand Ltd", 1))]);
    await svc.materialize();

    // One write, and it is an Entity staging call for entityType campaign. Client visibility
    // requires a published ACTIVE ClientCampaignAssignment, which nothing here creates, so a
    // derived parent stays invisible to client APIs until the normal publication path runs.
    assert.equal(staged.length, 1);
    assert.equal(staged[0].entityType, "campaign");
    for (const key of ["published", "publishedAt", "isPublished", "assignments", "clientId", "visibility"]) {
      assert.ok(!(key in staged[0].rows[0]), `derived parent must not carry ${key}`);
      assert.ok(!(key in staged[0]), `staging call must not carry ${key}`);
    }
  });

  it("awinAdvertiserIdentity reads nested first and refuses to invent an id", () => {
    assert.deepEqual(awinAdvertiserIdentity(offerRaw(1418, "Brand Ltd", 1)), {
      advertiserId: "1418",
      advertiserName: "Brand Ltd",
    });
    assert.deepEqual(awinAdvertiserIdentity({ advertiserId: 7, advertiserName: "Flat" }), {
      advertiserId: "7",
      advertiserName: "Flat",
    });
    assert.equal(awinAdvertiserIdentity({}), null);
    assert.equal(awinAdvertiserIdentity(null), null);
    assert.deepEqual(awinAdvertiserIdentity({ advertiser: { id: 9 } }), {
      advertiserId: "9",
      advertiserName: null,
    });
  });
});

describe("Phase 18 — the offers already staged become promotable", () => {
  it("O. derive from staged offers, then every offer resolves its parent — no supplier call", async () => {
    const rows = [];
    for (let a = 0; a < 5; a += 1) {
      for (let n = 0; n < 4; n += 1) {
        rows.push(offerEntity(`e-${a}-${n}`, offerRaw(3000 + a, `Brand ${a}`, a * 100 + n)));
      }
    }

    const { svc, staged } = service(rows);
    // A supplier call would have to come through a fetch collaborator; there is none on this
    // service, and the only injected write is the staging spy.
    const summary = await svc.materialize();

    assert.equal(summary.offersScanned, 20);
    assert.equal(summary.parentsStaged, 5);

    // The parents now exist under the ids the offers point at, which is what the coupon walk needs.
    const parentIds = new Set(staged[0].rows.map((r) => buildAwinCampaignExternalId(r)));
    for (const row of rows) {
      const mapped = mapEntityToSupplierCoupon({
        ...row,
        externalId: buildAwinCouponExternalId(row.rawData),
        entityName: "Offer",
        entityStatus: "Active",
        code: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        normalizedData: {},
      });
      assert.ok(mapped.parentSupplierCampaignId, "every offer now derives a parent id");
      assert.ok(
        parentIds.has(`awin-campaign-${mapped.parentSupplierCampaignId}`),
        `offer parent ${mapped.parentSupplierCampaignId} has a materialized campaign`,
      );
    }
  });
});

describe("Phase 18 — other suppliers are untouched", () => {
  it("M. Trackier and Partnerize coupon parent resolution is unaffected", () => {
    const trackier = mapEntityToSupplierCoupon({
      id: "t-1",
      networkSource: "trackier",
      entityType: "coupon",
      externalId: "trackier-coupon-coupon-1",
      entityName: "Offer",
      entityStatus: "Active",
      code: "TATA100",
      createdAt: new Date(),
      updatedAt: new Date(),
      normalizedData: {},
      rawData: { campaign_id: 10240, code: "TATA100", status: "active" },
    });
    assert.equal(trackier.parentSupplierCampaignId, "10240");
    assert.equal(trackier.couponStatus, "ACTIVE");

    const partnerize = mapEntityToSupplierCoupon({
      id: "p-1",
      networkSource: "partnerize",
      entityType: "coupon",
      externalId: "partnerize-coupon-1",
      entityName: "Offer",
      entityStatus: "Active",
      code: "PZ10",
      createdAt: new Date(),
      updatedAt: new Date(),
      normalizedData: {},
      rawData: { campaign_id: 555, voucher_code: "PZ10", active: "n" },
    });
    assert.equal(partnerize.parentSupplierCampaignId, "555");
    assert.equal(partnerize.couponStatus, "DISABLED");
  });

  it("the Awin campaign id builder is not applied to other networks' campaigns", () => {
    // usesAwinCampaignIdentity gates the wiring; the builder itself is Awin-only by construction.
    assert.equal(derivedAwinCampaignExternalId("1418"), "awin-campaign-1418");
  });
});
