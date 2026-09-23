import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

const {
  MBO_CAMPAIGN_STATUSES,
  MBO_RELATIONSHIP_STATUSES,
  MBO_CAMPAIGN_TYPES,
  MBO_COMMISSION_TYPES,
  MBO_ORDER_STATUSES,
  mapCampaignStatus,
  mapRelationshipStatus,
  resolveRelationshipStatus,
  mapCampaignType,
  resolveMboCampaignCurrency,
  normalizeCommissionType,
  mapMboOrderStatus,
} = await import("../src/modules/ops/v15FieldContract.js");
const { toAdminCampaignListDto, toAdminOrderDto } = await import("../src/modules/ops/adminContract.dto.js");
const { toSupplierCommissionRuleDto } = await import("../src/modules/commercial/supplierCommissionRule.contract.js");
const { toSupplierCampaignSummaryDto } = await import("../src/modules/supplier/dto/supplierCampaign.dto.js");
const { campaignStatusToDb, relationshipStatusToDb } = await import("../src/modules/ops/importedRecords.filters.js");

describe("locked decision 1 — campaign status", () => {
  it("PENDING is INACTIVE; every output is in the MBO list", () => {
    assert.equal(mapCampaignStatus("PENDING"), "INACTIVE");
    for (const stored of ["ACTIVE", "PAUSED", "PENDING", "RETIRED", "UNKNOWN", "DISABLED", "whatever"]) {
      assert.ok(MBO_CAMPAIGN_STATUSES.includes(mapCampaignStatus(stored)), stored);
    }
    assert.equal(mapCampaignStatus(null), null);
  });

  it("the admin campaign keeps the stored source status beside the canonical one", () => {
    const dto = toAdminCampaignListDto({
      id: "cc-1",
      primarySource: { id: "cs-1", relationshipStatus: "NOT_JOINED", supplierCampaign: { id: "sc-1", supplier: "AWIN", campaignStatus: "PENDING" } },
    });
    assert.equal(dto.campaignStatus, "INACTIVE");
    assert.equal(dto.sourceCampaignStatus, "PENDING");
  });
});

describe("locked decision 2 — relationship", () => {
  it("NOT_JOINED → NOT_APPLIED and REQUIRES_APPROVAL → PENDING; output is always canonical", () => {
    assert.equal(mapRelationshipStatus("NOT_JOINED"), "NOT_APPLIED");
    assert.equal(mapRelationshipStatus("REQUIRES_APPROVAL"), "PENDING");
    for (const v of ["JOINED", "APPROVED", "NOT_JOINED", "NOT_APPLIED", "PENDING", "REQUIRES_APPROVAL", "REJECTED", "SUSPENDED", "odd"]) {
      assert.ok(MBO_RELATIONSHIP_STATUSES.includes(mapRelationshipStatus(v)), v);
    }
    assert.equal(resolveRelationshipStatus({ relationshipStatus: "UNKNOWN" }, { participationStatus: "NOT_JOINED" }), "NOT_APPLIED");
  });

  it("admin campaign and supplier outputs carry the canonical value and the stored source value", () => {
    const dto = toAdminCampaignListDto({
      id: "cc-2",
      primarySource: { id: "cs-2", relationshipStatus: "NOT_JOINED", supplierCampaign: { id: "sc-2", supplier: "CJ" } },
    });
    assert.equal(dto.relationshipStatus, "NOT_APPLIED");
    assert.equal(dto.sourceRelationshipStatus, "NOT_JOINED");
  });

  it("filters accept canonical values and still accept the stored ones", () => {
    assert.deepEqual(relationshipStatusToDb("NOT_APPLIED"), ["NOT_JOINED"]);
    assert.deepEqual(relationshipStatusToDb("NOT_JOINED"), ["NOT_JOINED"]);
    assert.deepEqual(campaignStatusToDb("INACTIVE"), ["PENDING"]);
    assert.deepEqual(campaignStatusToDb("EXPIRED"), ["RETIRED"]);
  });
});

describe("locked decision 3 — campaign type (TIERED is not a campaign model)", () => {
  it("resolves from the underlying model; tier wording never decides", () => {
    assert.equal(mapCampaignType("TIERED", "CPS"), "CPS");
    assert.equal(mapCampaignType("Tiered CPA", null), "CPA");
    assert.equal(mapCampaignType("TIERED", null), "UNKNOWN");
    assert.equal(mapCampaignType("TIERED", "UNKNOWN"), "UNKNOWN");
    assert.equal(mapCampaignType(null, null), null);
  });

  it("HYBRID only when the source says so or names more than one genuine model", () => {
    assert.equal(mapCampaignType("HYBRID", null), "HYBRID");
    assert.equal(mapCampaignType("CPS + CPL", null), "HYBRID");
    assert.equal(mapCampaignType("CPS", "HYBRID"), "CPS");
    assert.equal(mapCampaignType(null, "HYBRID"), "HYBRID");
  });

  it("every output is in the MBO list", () => {
    for (const [t, p] of [["TIERED", null], ["COUPON", "CPA"], ["cost per lead", null], ["app install", null], ["per click", null], ["x", "y"]]) {
      assert.ok(MBO_CAMPAIGN_TYPES.includes(mapCampaignType(t, p)), `${t}/${p}`);
    }
  });
});

describe("locked decision 4 — campaign currency", () => {
  it("India-only → INR, other mapped regions → USD, original kept", () => {
    assert.deepEqual(resolveMboCampaignCurrency({ countries: ["IN"], originalCurrency: "inr" }), { currency: "INR", originalCurrency: "INR" });
    assert.deepEqual(resolveMboCampaignCurrency({ countries: ["GB"], originalCurrency: "GBP" }), { currency: "USD", originalCurrency: "GBP" });
    assert.deepEqual(resolveMboCampaignCurrency({ countries: ["AE"], originalCurrency: null }), { currency: "USD", originalCurrency: null });
    assert.deepEqual(resolveMboCampaignCurrency({ countries: [], originalCurrency: "INR" }), { currency: "INR", originalCurrency: "INR" });
    assert.deepEqual(resolveMboCampaignCurrency({ countries: [], originalCurrency: null }), { currency: null, originalCurrency: null });
  });

  it("the admin campaign never overwrites the network currency", () => {
    const dto = toAdminCampaignListDto({
      id: "cc-3",
      primarySource: { id: "cs-3", supplierCampaign: { id: "sc-3", supplier: "AWIN", countryCodes: ["GB"], currencyCode: "GBP" } },
    });
    assert.equal(dto.currency, "USD");
    assert.equal(dto.originalCurrency, "GBP");
  });
});

describe("locked decision 5 — commission type", () => {
  it("network wording never escapes unchanged", () => {
    const cases = [
      [{ supplierRuleType: "SALE", basis: "PERCENT_OF_SALE" }, "PERCENT"],
      [{ supplierRuleType: "SALE", basis: "FIXED_AMOUNT" }, "FIXED"],
      [{ supplierRuleType: "FLAT" }, "FIXED"],
      [{ supplierRuleType: "FIXED_PER_ORDER" }, "FIXED"],
      [{ basis: "PERCENT_OF_SALE" }, "PERCENT"],
      [{ supplierRuleType: "CPM" }, "OTHER"],
      [{ supplierRuleType: "PERFORMANCE_INCENTIVE" }, "OTHER"],
      [{ supplierRuleType: "tiered" }, "TIER"],
      [{ supplierRuleType: "CPA", basis: "FIXED_AMOUNT" }, "CPA"],
      [{ supplierRuleType: "SALE" }, "CPS"],
    ];
    for (const [input, expected] of cases) {
      const out = normalizeCommissionType(input);
      assert.equal(out, expected, JSON.stringify(input));
      assert.ok(MBO_COMMISSION_TYPES.includes(out));
    }
    assert.equal(normalizeCommissionType({}), null);
  });

  it("the rule listing returns the canonical type and keeps the raw wording", () => {
    const dto = toSupplierCommissionRuleDto({ id: "r1", supplierRuleType: "FIXED_PER_ORDER", basis: "FIXED_AMOUNT" });
    assert.equal(dto.commissionType, "FIXED");
    assert.equal(dto.rawCommissionType, "FIXED_PER_ORDER");
  });

  it("rules embedded in the admin campaign carry the canonical type", () => {
    const dto = toAdminCampaignListDto({
      id: "cc-4",
      primarySource: { id: "cs-4", supplierCampaign: { id: "sc-4", supplier: "OPTIMISE" } },
      supplierCommissionRules: [{ id: "r2", supplierRuleType: "SALE", basis: "PERCENT_OF_SALE", ratePercent: 5 }],
    });
    assert.equal(dto.supplierCommissionRules[0].commissionType, "PERCENT");
    assert.equal(dto.supplierCommissionRules[0].supplierRuleType, "SALE");
  });
});

describe("locked decision 6 — order status never carries payment state", () => {
  it("order status is lifecycle only", () => {
    assert.equal(mapMboOrderStatus({ mboOrderStatus: "REVERSED" }), "REVERSED");
    assert.equal(mapMboOrderStatus({ validationStatus: "VALIDATION_APPROVED" }), "CONFIRMED");
    assert.equal(mapMboOrderStatus({ validationStatus: "VALIDATION_NEEDS_REVIEW" }), "UNKNOWN");
    assert.equal(mapMboOrderStatus({ mboOrderStatus: "PAID" }), "UNKNOWN");
  });

  it("a paid order reports its payment state in paymentStatus, not orderStatus", () => {
    for (const supplierPaymentStatus of ["PAYMENT_RECEIVED", "PAYMENT_PAYABLE", "PAYMENT_INVOICED"]) {
      const dto = toAdminOrderDto({
        id: "o1",
        validationStatus: "VALIDATION_APPROVED",
        supplierPaymentStatus,
        networkContext: {},
      });
      assert.equal(dto.orderStatus, "CONFIRMED");
      assert.ok(MBO_ORDER_STATUSES.includes(dto.orderStatus));
      assert.ok(["PAID", "PAYABLE", "ADVERTISER_INVOICED"].includes(dto.paymentStatus), dto.paymentStatus);
    }
  });
});

describe("source-record API speaks the same vocabulary", () => {
  it("supplier campaign summary returns canonical status plus the stored source value", () => {
    const dto = toSupplierCampaignSummaryDto({ id: "sc-9", supplier: "BOOSTINY", campaignStatus: "RETIRED" });
    assert.equal(dto.campaignStatus, "EXPIRED");
    assert.equal(dto.sourceCampaignStatus, "RETIRED");
  });
});
