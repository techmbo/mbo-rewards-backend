/**
 * Epic 7 — Admin contract DTOs, permissions, allotment path, security.
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  toAdminCampaignListDto,
  toAdminPerformanceDto,
  toAdminOrderDto,
  toAdminProductFeedDto,
  formatAdminCommissionRuleType,
  V15_CLIENT_RULE_TYPES,
  CLIENT_FORBIDDEN_FINANCE_KEYS,
} from "../src/modules/ops/adminContract.dto.js";
import { AdminContractService } from "../src/modules/ops/adminContract.service.js";
import { allotCampaignsBodySchema } from "../src/modules/client/validators/schemas.js";
import { ROLE_PERMISSIONS, PERMISSIONS } from "../src/auth/permissions.js";
import { resolveRuleKind } from "../src/modules/commercial/commercialRuleEngine.js";
import { FORBIDDEN_CLIENT_ORDER_KEYS, toClientOrderDto } from "../src/modules/client/dto/clientReporting.dto.js";
import { CommercialService } from "../src/modules/commercial/services/commercial.service.js";

describe("Epic 7 — campaign admin DTO", () => {
  it("builds 03A-oriented list row with estimate note", () => {
    const dto = toAdminCampaignListDto({
      id: "cc1",
      displayName: "Ubuy UAE",
      status: "PUBLISHED",
      category: "Marketplace",
      countries: ["AE"],
      defaultCurrency: "USD",
      merchant: { displayName: "Ubuy" },
      primarySource: {
        id: "src1",
        relationshipStatus: "JOINED",
        supportsLink: true,
        grossCommission: "10",
        supplierCampaign: {
          supplier: "OPTIMISE",
          campaignStatus: "ACTIVE",
          trackingUrl: "https://example.com/t",
        },
      },
      commissionRuleCount: 1,
      assignmentCount: 2,
      productFeedAvailability: "AVAILABLE",
      operationalWarnings: [],
    });
    assert.equal(dto.brandName, "Ubuy");
    assert.equal(dto.networkSource, "OPTIMISE");
    assert.equal(dto.supplier, "OPTIMISE");
    assert.ok(dto.commissionDisplayNote.includes("estimate"));
    assert.equal(dto.assignmentCount, 2);
    assert.equal(dto.campaignStatus, "ACTIVE");
    assert.equal(dto.relationshipStatus, "JOINED");
  });
});

describe("Epic 7 — performance OPS vs FINANCE split", () => {
  it("redacts financial without permission", () => {
    const dto = toAdminPerformanceDto(
      {
        clickCount: 10,
        conversionCount: 2,
        grossCommission: 100,
        netCommission: 80,
        clientCommission: 70,
        mboCommission: 30,
      },
      { includeFinancial: false },
    );
    assert.equal(dto.operational.linkClicks, 10);
    assert.equal(dto.linkClicks, 10);
    assert.equal(dto.financial.state, "REDACTED");
    assert.equal(dto.financial.mboMargin, undefined);
    assert.equal(dto.financial.clientPayable, undefined);
    assert.equal(dto.grossCommission, null);
    assert.equal(dto.netCommission, null);
  });

  it("includes financial for staff with permission", () => {
    const dto = toAdminPerformanceDto(
      {
        clickCount: 10,
        grossCommission: 100,
        netCommission: 80,
        clientCommission: 70,
        mboCommission: 30,
      },
      { includeFinancial: true },
    );
    // 04A/04C: performance financial is gross/net commission only — not client payable / margin
    assert.equal(dto.financial.grossCommission, 100);
    assert.equal(dto.financial.netCommission, 80);
    assert.equal(dto.financial.clientPayable, undefined);
    assert.equal(dto.financial.mboMargin, undefined);
    assert.equal(dto.grossCommission, 100);
    assert.equal(dto.netCommission, 80);
  });
});

describe("Epic 7 — admin orders financial visibility", () => {
  it("redacts finance for insufficient permission", () => {
    const dto = toAdminOrderDto(
      {
        id: "ord1",
        validationStatus: "VALIDATION_APPROVED",
        clientPaymentStatus: "CLIENT_PAYMENT_PAYABLE",
        financialSummary: { clientPayable: 70, supplierReceivable: 100, mboMargin: 30, ftStatus: "HAS_FT" },
      },
      { includeFinancial: false },
    );
    assert.equal(dto.financial.state, "REDACTED");
  });

  it("shows split for staff finance permission", () => {
    const dto = toAdminOrderDto(
      {
        id: "ord1",
        validationStatus: "VALIDATION_APPROVED",
        financialSummary: {
          clientPayable: 70,
          supplierReceivable: 100,
          mboMargin: 30,
          ftStatus: "HAS_FT",
          adjustmentCount: 0,
          reversalCount: 0,
        },
      },
      { includeFinancial: true },
    );
    assert.equal(dto.financial.mboMargin, 30);
    assert.ok(dto.financial.note.includes("Staff"));
  });
});

describe("Epic 7 — permission matrix", () => {
  it("CLIENT cannot access ops finance or catalog admin permissions", () => {
    const client = ROLE_PERMISSIONS.CLIENT;
    assert.equal(client.includes(PERMISSIONS.FINANCE_OPS_READ), false);
    assert.equal(client.includes(PERMISSIONS.CATALOG_READ), false);
    assert.equal(client.includes(PERMISSIONS.OPS_READ), false);
    assert.equal(client.includes(PERMISSIONS.COMMISSION_MANAGE), false);
  });

  it("ANALYST lacks finance mutation and commission manage", () => {
    const analyst = ROLE_PERMISSIONS.ANALYST;
    assert.equal(analyst.includes(PERMISSIONS.COMMISSION_MANAGE), false);
    assert.equal(analyst.includes(PERMISSIONS.FINANCE_OPS_READ), false);
    assert.equal(analyst.includes(PERMISSIONS.PERFORMANCE_READ), true);
  });

  it("AdminContractService.canViewFinancial respects permissions", () => {
    const svc = new AdminContractService({ prisma: {} });
    assert.equal(svc.canViewFinancial([PERMISSIONS.PERFORMANCE_READ]), false);
    assert.equal(svc.canViewFinancial([PERMISSIONS.COMMISSION_READ]), true);
    assert.equal(svc.canViewFinancial([PERMISSIONS.FINANCE_OPS_READ]), true);
  });
});

describe("Epic 7 — commission vocabulary + TIERED hygiene", () => {
  it("lists five v15 client types; TIERED not implemented", () => {
    assert.equal(V15_CLIENT_RULE_TYPES.length, 5);
    const tiered = formatAdminCommissionRuleType("TIERED");
    assert.equal(tiered.status, "NOT_IMPLEMENTED");
    assert.equal(tiered.activatable, false);
    assert.equal(resolveRuleKind({ commissionType: "TIERED" }), "TIERED_NOT_IMPLEMENTED");
  });

  it("historical TIERED remains readable; activate blocked", async () => {
    // A historical TIERED row without persisted tier bands stays readable but can never be
    // activated, even with complete agreement lineage.
    const historical = {
      id: "rule-t",
      commissionType: "TIERED",
      status: "DRAFT",
      assignmentId: "a1",
      effectiveFrom: new Date(),
      agreementRef: "IO-2024-001",
      agreementApprovedAt: new Date("2024-01-01"),
      agreementApprovedBy: "finance-lead",
    };
    assert.equal(historical.commissionType, "TIERED");
    const svc = new CommercialService({
      commissionRepo: {
        findById: async () => historical,
        update: async () => {
          throw new Error("must not activate");
        },
      },
    });
    await assert.rejects(
      () => svc.activateCommissionRule("rule-t"),
      (e) => e.statusCode === 409 && /TIERED rules require tierMetric, tierPeriod and at least one persisted tier/.test(e.message),
    );
  });
});

describe("Epic 7 — canonical assignment path", () => {
  it("accepts assignments[{couponEntityId}] without couponEntityIds", () => {
    const parsed = allotCampaignsBodySchema.safeParse({
      assignments: [{ couponEntityId: "ent-1" }],
    });
    assert.equal(parsed.success, true);
  });

  it("still accepts legacy couponEntityIds", () => {
    const parsed = allotCampaignsBodySchema.safeParse({
      couponEntityIds: ["ent-1", "ent-2"],
    });
    assert.equal(parsed.success, true);
  });

  it("rejects empty body", () => {
    const parsed = allotCampaignsBodySchema.safeParse({});
    assert.equal(parsed.success, false);
  });
});

describe("Epic 7 — product feed admin DTO", () => {
  it("maps feed status and counts without fabricating", () => {
    const dto = toAdminProductFeedDto({
      id: "f1",
      supplier: "PARTNERIZE",
      feedStatus: "ACTIVE",
      feedName: "Main",
      errorCount: 2,
      _count: { feedItems: 10, products: 8 },
    });
    assert.equal(dto.status, "ACTIVE");
    assert.equal(dto.itemCount, 10);
    assert.equal(dto.errorCount, 2);
  });
});

describe("Epic 7 — client DTO forbidden fields", () => {
  it("client order DTO strips internals", () => {
    const dto = toClientOrderDto(
      {
        id: "o1",
        currency: "USD",
        orderValue: "10",
        validationStatus: "VALIDATION_APPROVED",
        clientPaymentStatus: "CLIENT_PAYMENT_PAYABLE",
        merchant: { displayName: "X" },
        items: [],
        supplier: "OPTIMISE",
        metadata: { secret: true },
      },
      { clientCommission: 7, commissionSource: "financial_transaction" },
    );
    for (const key of [...FORBIDDEN_CLIENT_ORDER_KEYS, ...CLIENT_FORBIDDEN_FINANCE_KEYS]) {
      assert.equal(Object.prototype.hasOwnProperty.call(dto, key), false, key);
    }
  });
});

describe("Epic 7 — service list campaigns uses prisma (mocked)", () => {
  it("does not fabricate missing merchant", async () => {
    const db = {
      canonicalCampaign: {
        findMany: mock.fn(async () => [
          {
            id: "cc1",
            displayName: "Camp",
            status: "PUBLISHED",
            merchantId: "m1",
            merchant: null,
            countries: [],
            sources: [],
            _count: { assignments: 0 },
            updatedAt: new Date(),
          },
        ]),
        count: mock.fn(async () => 1),
      },
      order: { groupBy: mock.fn(async () => []) },
      conversion: { groupBy: mock.fn(async () => []) },
      productFeed: { groupBy: mock.fn(async () => []) },
      exceptionCase: { count: mock.fn(async () => 0) },
    };
    const svc = new AdminContractService({ prisma: db });
    const out = await svc.listCampaigns({ take: 10 });
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].brandName, null);
    assert.equal(out.items[0].supplier, null);
    assert.equal(out.items[0].networkSource, null);
    assert.ok(out.items[0].operationalWarnings.includes("NO_ACTIVE_SOURCE"));
  });
});
