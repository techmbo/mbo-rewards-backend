/**
 * v15 contract completion — remaining deriable fields + payment admin grain.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  toAdminCampaignListDto,
  toAdminPerformanceDto,
  toAdminPaymentStatusDto,
  CLIENT_FORBIDDEN_FINANCE_KEYS,
} from "../src/modules/ops/adminContract.dto.js";
import {
  deriveIsAssignable,
  deriveMappingStatus,
  mapCanonicalPaymentStatus,
  mapCampaignType,
  parseExactDiscountPercent,
} from "../src/modules/ops/v15FieldContract.js";
import { toPartnerCampaignDto } from "../src/modules/client/dto/partnerCampaign.dto.js";
import { toClientPaymentStatusDto } from "../src/modules/client/dto/clientReporting.dto.js";

describe("v15 completion — isAssignable matrix", () => {
  const base = {
    campaignStatus: "ACTIVE",
    relationshipStatus: "JOINED",
    supportsLink: true,
    supportsCoupon: false,
    supportsDeeplink: false,
    commissionAvailable: true,
  };

  it("true only when active + joined + channel + commission", () => {
    assert.equal(deriveIsAssignable(base), true);
  });

  it("false when not active", () => {
    assert.equal(deriveIsAssignable({ ...base, campaignStatus: "PAUSED" }), false);
  });

  it("false when not joined", () => {
    assert.equal(deriveIsAssignable({ ...base, relationshipStatus: "NOT_JOINED" }), false);
  });

  it("false without channel support", () => {
    assert.equal(
      deriveIsAssignable({
        ...base,
        supportsLink: false,
        supportsCoupon: false,
        supportsDeeplink: false,
      }),
      false,
    );
  });

  it("false without commission", () => {
    assert.equal(deriveIsAssignable({ ...base, commissionAvailable: false }), false);
  });

  it("true with APPROVED relationship", () => {
    assert.equal(deriveIsAssignable({ ...base, relationshipStatus: "APPROVED" }), true);
  });
});

describe("v15 completion — mappingStatus never invents MAPPED", () => {
  it("returns NEEDS_REVIEW even with merchant + raw payload", () => {
    assert.equal(
      deriveMappingStatus({ syncConflict: false, merchantId: "m1", rawPayloadId: "r1" }),
      "NEEDS_REVIEW",
    );
  });

  it("returns ERROR on syncConflict", () => {
    assert.equal(deriveMappingStatus({ syncConflict: true, merchantId: "m1", rawPayloadId: "r1" }), "ERROR");
  });
});

describe("v15 completion — 03G keys + sources", () => {
  it("exposes website/logo/type/status/ids/supports/rules", () => {
    const dto = toAdminCampaignListDto({
      id: "cc1",
      displayName: "Canon Name",
      category: "Travel",
      merchant: {
        displayName: "Brand",
        website: "https://brand.example",
        logoUrl: "https://cdn.example/logo.png",
      },
      primarySource: {
        id: "src-uuid",
        relationshipStatus: "JOINED",
        supportsLink: true,
        supportsCoupon: true,
        grossCommission: 5,
        supplierCampaign: {
          supplier: "OPTIMISE",
          supplierCampaignId: "sup-1",
          campaignType: "CPA",
          campaignStatus: "ACTIVE",
          trackingUrl: "https://supplier.example/t",
          deepLinkingEnabled: false,
          lastSyncedAt: new Date("2026-08-01"),
          rawPayloadId: "raw-9",
          merchantId: "m1",
        },
      },
      commissionRuleCount: 3,
      discountPercent: 12,
    });

    assert.equal(dto.networkSource, "OPTIMISE");
    assert.equal(dto.brandWebsiteLink, "https://brand.example");
    assert.equal(dto.brandLogoLink, "https://cdn.example/logo.png");
    assert.equal(dto.campaignType, "CPA");
    assert.equal(dto.campaignStatus, "ACTIVE");
    assert.equal(dto.relationshipStatus, "JOINED");
    assert.equal(dto.supplierCampaignId, "sup-1");
    assert.equal(dto.campaignSourceId, "src-uuid");
    assert.equal(dto.linkSupport, true);
    assert.equal(dto.couponSupport, true);
    assert.equal(dto.deeplinkSupport, false);
    assert.equal(dto.commissionRuleCount, 3);
    assert.equal(dto.discountPercent, 12);
    assert.ok(dto.lastSyncedAt);
    assert.equal(dto.rawPayloadLink, "/ops/raw-payloads/raw-9");
    assert.equal(dto.isAssignable, true);
  });
});

describe("v15 completion — 06C channel campaignType", () => {
  it("sets campaignType from channel capabilities (not CPS/CPA commercial model)", () => {
    const dto = toPartnerCampaignDto({
      assignmentId: "a1",
      assignmentStatus: "ACTIVE",
      campaign: {
        brand: "B",
        displayName: "C",
        countries: ["IN"],
        campaignTypeRaw: null,
        pricingModelRaw: null,
        supplierCampaignStatus: "ACTIVE",
        validity: {},
      },
      coupon: { code: "SAVE10", discountPercentage: "10" },
      sourceCapabilities: { supportsLink: true, supportsCoupon: true },
      tracking: { mboTrackingUrl: "https://mborewards.com/t/x" },
      commercial: null,
    });
    // 06C: campaignType = COUPON | LINK | COUPON_LINK | DEEPLINK
    assert.equal(dto.campaignType, "COUPON_LINK");
    assert.equal(dto.channelType, "COUPON_LINK");
    assert.equal(dto.commercialModel, null);
    assert.equal(dto.link, "https://mborewards.com/t/x");
    assert.equal(dto.primaryCountry, "IN");
    assert.deepEqual(dto.secondaryCountries, []);
    assert.equal(dto.currency, "INR");
  });
});

describe("v15 completion — 04C gross/net semantics", () => {
  it("keeps netCommission as approved supplier commission, not clientPayable", () => {
    const dto = toAdminPerformanceDto(
      {
        reportDate: "2026-07-01",
        brandName: "Ubuy",
        clickCount: 5,
        conversionCount: 3,
        approvedConversionCount: 2,
        grossCommission: 100,
        netCommission: 80,
        clientCommission: 55,
        mboCommission: 25,
        currency: "USD",
        country: "AE",
      },
      { includeFinancial: true },
    );
    assert.equal(dto.brandName, "Ubuy");
    assert.equal(dto.linkClicks, 5);
    assert.equal(dto.grossOrders, 3);
    assert.equal(dto.netOrders, 2);
    assert.equal(dto.grossCommission, 100);
    assert.equal(dto.netCommission, 80);
    assert.notEqual(dto.netCommission, dto.financial.clientPayable);
    assert.equal(dto.month, 7);
    assert.equal(dto.year, 2026);
    assert.equal(dto.customerType, null);
    assert.equal(dto.discountPercent, null);
  });
});

describe("v15 completion — 05C admin payment vs client payment", () => {
  it("maps canonical payment statuses without collapse", () => {
    assert.equal(
      mapCanonicalPaymentStatus({ supplierPaymentStatus: "PAYMENT_INVOICED" }),
      "ADVERTISER_INVOICED",
    );
    assert.equal(mapCanonicalPaymentStatus({ supplierPaymentStatus: "PAYMENT_PAYABLE" }), "PAYABLE");
    assert.equal(mapCanonicalPaymentStatus({ validationStatus: "VALIDATION_REJECTED" }), "REJECTED");
  });

  it("admin payableCommission is supplier receivable labeled", () => {
    const dto = toAdminPaymentStatusDto({
      billingMonth: 7,
      billingYear: 2026,
      brandName: "Ubuy",
      campaignType: "CPS",
      campaignSourceId: "src1",
      payableOrders: 2,
      payableCommission: 556,
      paymentStatus: "PAYABLE",
      currency: "USD",
      date: "2026-07-01",
      payableCommissionSource: "financial_transaction.supplierReceivable",
    });
    assert.equal(dto.payableCommission, 556);
    assert.equal(dto.payableCommissionSource, "financial_transaction.supplierReceivable");
    assert.equal(dto.brandName, "Ubuy");
    assert.equal(dto.campaignType, "CPS");
    assert.ok(dto.note.toLowerCase().includes("supplier"));
  });

  it("client payment-status remains separate shape (client payable)", () => {
    const clientDto = toClientPaymentStatusDto({
      billingMonth: 7,
      billingYear: 2026,
      payableOrders: 2,
      payableCommission: 70,
      paymentStatus: "Payable",
      currency: "USD",
      commissionSource: "financial_transaction",
    });
    assert.equal(clientDto.payableCommission, 70);
    assert.equal(clientDto.brandName, null);
    assert.ok(!("supplierReceivable" in clientDto));
  });
});

describe("v15 completion — security forbidden keys on client DTO", () => {
  it("strips supplier finance keys", () => {
    const dto = toPartnerCampaignDto({
      assignmentId: "a",
      assignmentStatus: "ACTIVE",
      campaign: { brand: "B", displayName: "D", countries: ["AE"], validity: {} },
      tracking: { mboTrackingUrl: "https://mborewards.com/t/z" },
      sourceCapabilities: { supportsLink: true },
      commercial: { clientSharePercent: 50, commissionType: "PERCENT", currency: "USD" },
    });
    for (const key of CLIENT_FORBIDDEN_FINANCE_KEYS) {
      assert.equal(dto[key], undefined);
    }
  });
});

describe("v15 completion — helpers", () => {
  it("mapCampaignType and exact discount", () => {
    assert.equal(mapCampaignType("CPS", null), "CPS");
    assert.equal(parseExactDiscountPercent("15%"), 15);
    assert.equal(parseExactDiscountPercent("AED 50 off"), null);
  });
});
