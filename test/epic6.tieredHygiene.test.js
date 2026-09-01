/**
 * Epic 6-A — TIERED commercial rule hygiene (no client tier bands).
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  calculateCommercial,
  resolveRuleKind,
  V15_RULE_TYPES,
} from "../src/modules/commercial/commercialRuleEngine.js";
import { CommercialService } from "../src/modules/commercial/services/commercial.service.js";
import {
  createCommissionRuleBodySchema,
  TIERED_NOT_IMPLEMENTED_MESSAGE,
} from "../src/modules/commercial/validators/schemas.js";
import {
  FinancialTransactionService,
  earnRecognitionKey,
} from "../src/modules/finance/financialTransaction.service.js";
import { FxService } from "../src/modules/finance/fx.service.js";
import { ExceptionCaseService } from "../src/modules/order/exceptionCase.service.js";
import { FORBIDDEN_CLIENT_ORDER_KEYS, toClientOrderDto } from "../src/modules/client/dto/clientReporting.dto.js";

const approvedOrder = {
  id: "ord-1",
  validationStatus: "VALIDATION_APPROVED",
  currency: "USD",
  orderValue: "200.0000",
  orderDate: new Date("2025-06-01"),
  campaignSourceId: "src-1",
  clientId: "client-a",
  clientAssignmentId: "asg-1",
  supplier: "OPTIMISE",
  clientPaymentStatus: "CLIENT_PAYMENT_NOT_READY",
  metadata: {},
};

const conversionBase = {
  id: "cv-tier",
  supplier: "OPTIMISE",
  supplierCommission: "1000.0000",
  approvedCommission: "1000.0000",
  currency: "USD",
  status: "APPROVED",
  conversionDate: new Date("2025-06-01"),
  clientAssignmentId: "asg-1",
  campaignSourceId: "src-1",
  orderId: "ord-1",
};

function ratioRule(overrides = {}) {
  return {
    id: "rule-1",
    assignmentId: "asg-1",
    grossCommission: "100",
    clientCommission: "70",
    mboCommission: "30",
    commissionType: "PERCENT",
    status: "EFFECTIVE",
    currency: "USD",
    effectiveFrom: new Date("2025-01-01"),
    ...overrides,
  };
}

describe("Epic 6-A — TIERED never calculates as PERCENT", () => {
  it("TEST 1+2: TIERED → TIERED_NOT_IMPLEMENTED / tiered_not_implemented (not PERCENT)", () => {
    assert.equal(resolveRuleKind({ commissionType: "TIERED" }), "TIERED_NOT_IMPLEMENTED");
    assert.notEqual(
      resolveRuleKind({ commissionType: "TIERED", grossCommission: 100, clientCommission: 70 }),
      V15_RULE_TYPES.PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION,
    );
    const calc = calculateCommercial({
      order: approvedOrder,
      conversion: conversionBase,
      clientCommissionRule: ratioRule({ commissionType: "TIERED" }),
    });
    assert.equal(calc.ok, false);
    assert.equal(calc.reason, "tiered_not_implemented");
    assert.equal(calc.clientCommission, undefined);
  });

  it("TEST 3: financial recognition does not create FT for unresolved TIERED", async () => {
    const ftStore = new Map();
    const exceptions = [];
    const db = {
      conversion: {
        findUnique: async () => ({
          ...conversionBase,
          order: approvedOrder,
          clientAssignment: { id: "asg-1", clientId: "client-a" },
        }),
      },
      financialTransaction: {
        findUnique: async ({ where }) => ftStore.get(where.recognitionKey) || null,
        create: async ({ data }) => {
          const row = { id: "ft-should-not", ...data };
          ftStore.set(data.recognitionKey, row);
          return row;
        },
        update: async () => ({}),
      },
      exceptionCase: {
        findFirst: async () => null,
        create: async ({ data }) => {
          exceptions.push(data);
          return { id: "ex1", ...data };
        },
        update: async () => ({}),
      },
      campaignSource: { findUnique: async () => null },
      supplierCommissionRule: { findFirst: async () => null, findMany: async () => [] },
    };
    const finance = new FinancialTransactionService({
      prisma: db,
      audit: { record: async () => ({}) },
      exceptions: new ExceptionCaseService({ prisma: db, audit: { record: async () => ({}) } }),
      fx: new FxService({ rateProvider: new Map([["USD:USD:2025-06-01", "1"]]) }),
      commissionRepo: {
        findEffectiveForAssignment: async () =>
          ratioRule({ commissionType: "TIERED", status: "EFFECTIVE" }),
      },
    });
    const out = await finance.recognizeConversion({ conversionId: "cv-tier", orderId: "ord-1" });
    assert.equal(out.unresolved, true);
    assert.equal(out.reason, "tiered_not_implemented");
    assert.equal(out.record, null);
    assert.equal(ftStore.size, 0);
    assert.ok(exceptions.some((e) => e.type === "COMMISSION_INVALID"));
  });
});

describe("Epic 6-A — existing Epic 2 engines unchanged", () => {
  it("TEST 4+5: PERCENT and PERCENT_OF_ACTUAL unchanged", () => {
    for (const commissionType of ["PERCENT", "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION"]) {
      const calc = calculateCommercial({
        order: approvedOrder,
        conversion: conversionBase,
        clientCommissionRule: ratioRule({ commissionType }),
      });
      assert.equal(calc.ok, true);
      assert.equal(calc.clientCommission, "700.0000");
      assert.equal(calc.mboMargin, "300.0000");
      assert.equal(Number(calc.supplierGross) - Number(calc.clientCommission) - Number(calc.mboMargin), 0);
    }
  });

  it("TEST 6: FIXED_CLIENT_PERCENT_OF_ORDER_VALUE unchanged", () => {
    const calc = calculateCommercial({
      order: approvedOrder,
      conversion: conversionBase,
      clientCommissionRule: ratioRule({
        commissionType: "FIXED_CLIENT_PERCENT_OF_ORDER_VALUE",
        orderValuePercent: "5",
        clientCommission: "0",
        mboCommission: "100",
      }),
    });
    assert.equal(calc.ok, true);
    assert.equal(calc.clientCommission, "10.0000"); // 200 * 5%
  });

  it("TEST 7: FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER unchanged", () => {
    const calc = calculateCommercial({
      order: approvedOrder,
      conversion: conversionBase,
      clientCommissionRule: ratioRule({
        commissionType: "FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER",
        fixedAmount: "5",
        clientCommission: "5",
        mboCommission: "95",
      }),
    });
    assert.equal(calc.ok, true);
    assert.equal(calc.clientCommission, "5.0000");
  });

  it("TEST 8: MANUAL_APPROVED_CLIENT_COMMISSION unchanged", () => {
    const calc = calculateCommercial({
      order: approvedOrder,
      conversion: conversionBase,
      clientCommissionRule: ratioRule({
        commissionType: "MANUAL_APPROVED_CLIENT_COMMISSION",
        manualAmount: "12.5",
        manualApproved: true,
        clientCommission: "12.5",
        mboCommission: "87.5",
      }),
    });
    assert.equal(calc.ok, true);
    assert.equal(calc.clientCommission, "12.5000");
  });

  it("TEST 9: DISPLAY_RANGE_WITH_ACTUAL_SPLIT unchanged (payout = share of actual)", () => {
    const calc = calculateCommercial({
      order: approvedOrder,
      conversion: conversionBase,
      clientCommissionRule: ratioRule({
        commissionType: "DISPLAY_RANGE_WITH_ACTUAL_SPLIT",
        displayRangeMin: "3",
        displayRangeMax: "5",
        displayLabel: "Up to 5%",
      }),
    });
    assert.equal(calc.ok, true);
    assert.equal(calc.clientCommission, "700.0000");
    assert.ok(calc.displayCommission);
  });
});

describe("Epic 6-A — historical TIERED + activation block", () => {
  it("TEST 10: historical TIERED records remain readable; activate blocked", async () => {
    const historical = {
      id: "rule-tier-hist",
      assignmentId: "asg-1",
      commissionType: "TIERED",
      status: "DRAFT",
      grossCommission: "100",
      clientCommission: "70",
      mboCommission: "30",
      effectiveFrom: new Date("2024-01-01"),
    };
    const svc = new CommercialService({
      commissionRepo: {
        findById: async () => historical,
        findOverlappingEffective: async () => [],
        supersedeActiveRules: async () => {},
        update: async () => {
          throw new Error("must not activate TIERED");
        },
      },
      assignmentRepo: { findById: async () => null },
    });
    // Readable shape preserved
    assert.equal(historical.commissionType, "TIERED");
    assert.equal(historical.status, "DRAFT");
    await assert.rejects(
      () => svc.activateCommissionRule("rule-tier-hist"),
      (e) =>
        e.statusCode === 409 &&
        String(e.message).includes("TIERED_CLIENT_RULE_NOT_IMPLEMENTED"),
    );
  });

  it("blocks create with activate:true for TIERED (zod + service)", () => {
    const parsed = createCommissionRuleBodySchema.safeParse({
      assignmentId: "asg-1",
      commissionType: "TIERED",
      grossCommission: "100",
      clientCommission: "70",
      effectiveFrom: "2025-01-01",
      activate: true,
    });
    assert.equal(parsed.success, false);
    const draftOk = createCommissionRuleBodySchema.safeParse({
      assignmentId: "asg-1",
      commissionType: "TIERED",
      grossCommission: "100",
      clientCommission: "70",
      effectiveFrom: "2025-01-01",
      activate: false,
    });
    assert.equal(draftOk.success, true);
    assert.ok(TIERED_NOT_IMPLEMENTED_MESSAGE.includes("TIERED_CLIENT_RULE_NOT_IMPLEMENTED"));
  });

  it("service rejects create activate for TIERED before write", async () => {
    const svc = new CommercialService({
      commissionRepo: {
        create: async () => {
          throw new Error("must not create EFFECTIVE TIERED");
        },
      },
      assignmentRepo: {
        findById: async () => ({
          id: "asg-1",
          status: "ACTIVE",
          published: true,
          canonicalCampaign: { defaultCurrency: "USD" },
        }),
      },
    });
    await assert.rejects(
      () =>
        svc.createCommissionRule({
          assignmentId: "asg-1",
          commissionType: "TIERED",
          grossCommission: "100",
          clientCommission: "70",
          effectiveFrom: new Date("2025-01-01"),
          activate: true,
        }),
      (e) => String(e.message).includes("TIERED_CLIENT_RULE_NOT_IMPLEMENTED"),
    );
  });
});

describe("Epic 6-A — client reporting + supplier-tiered via % of actual", () => {
  it("TEST 11: client order DTO never exposes supplier tier internals", () => {
    const dto = toClientOrderDto(
      {
        id: "ord-1",
        currency: "USD",
        orderValue: "100",
        orderDate: new Date(),
        validationStatus: "VALIDATION_APPROVED",
        clientPaymentStatus: "CLIENT_PAYMENT_PAYABLE",
        merchant: { displayName: "Brand" },
        items: [],
        supplier: "OPTIMISE",
        metadata: { supplierTier: "gold", commission_type: "TIERED" },
      },
      { clientCommission: 700, commissionSource: "financial_transaction" },
    );
    assert.equal(dto.clientCommission, 700);
    for (const key of FORBIDDEN_CLIENT_ORDER_KEYS) {
      assert.equal(Object.prototype.hasOwnProperty.call(dto, key), false);
    }
    assert.equal(dto.metadata, undefined);
    assert.equal(dto.supplierTier, undefined);
  });

  it("TEST 12: supplier-tiered campaign using PERCENT_OF_ACTUAL uses actual supplier commission", () => {
    // Supplier internal tier produced ₹1000 actual; client share 70%
    const calc = calculateCommercial({
      order: { ...approvedOrder, currency: "INR" },
      conversion: {
        ...conversionBase,
        currency: "INR",
        supplierCommission: "1000",
        approvedCommission: "1000",
        metadata: { supplierCommissionType: "TIERED", note: "supplier-side only" },
      },
      clientCommissionRule: ratioRule({
        commissionType: "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION",
        currency: "INR",
      }),
    });
    assert.equal(calc.ok, true);
    assert.equal(calc.supplierGross, "1000.0000");
    assert.equal(calc.clientCommission, "700.0000");
    assert.equal(calc.mboMargin, "300.0000");
    assert.equal(calc.calculationMetadata.neverUsedCampaignSnapshot, true);
    assert.equal(calc.ruleKind, V15_RULE_TYPES.PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION);
  });
});
