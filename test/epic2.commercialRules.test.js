/**
 * Epic 2 — Commercial Rules Engine tests (A–L + golden path).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  calculateCommercial,
  resolveRuleKind,
  V15_RULE_TYPES,
} from "../src/modules/commercial/commercialRuleEngine.js";
import { calculateCommission } from "../src/modules/finance/commissionCalculation.service.js";
import {
  FinancialTransactionService,
  earnRecognitionKey,
} from "../src/modules/finance/financialTransaction.service.js";
import { SupplierCommissionRuleService } from "../src/modules/commercial/services/supplierCommissionRule.service.js";

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
  id: "cv-1",
  supplier: "OPTIMISE",
  supplierCommission: "100.0000",
  approvedCommission: "100.0000",
  currency: "USD",
  status: "APPROVED",
  conversionDate: new Date("2025-06-01"),
  clientAssignmentId: "asg-1",
  campaignSourceId: "src-1",
  orderId: "ord-1",
};

function ratioRule(overrides = {}) {
  return {
    id: "rule-ratio",
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

describe("Epic 2 — rule kind compatibility", () => {
  it("aliases PERCENT to PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION", () => {
    assert.equal(
      resolveRuleKind({ commissionType: "PERCENT", grossCommission: 100, clientCommission: 70 }),
      V15_RULE_TYPES.PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION,
    );
    assert.equal(
      resolveRuleKind({ commissionType: "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION" }),
      V15_RULE_TYPES.PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION,
    );
  });

  it("maps legacy FIXED only when fixedAmount present", () => {
    assert.equal(resolveRuleKind({ commissionType: "FIXED" }), "LEGACY_FIXED_UNMAPPED");
    assert.equal(
      resolveRuleKind({ commissionType: "FIXED", fixedAmount: "5" }),
      V15_RULE_TYPES.FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER,
    );
  });

  it("defers TIERED", () => {
    assert.equal(resolveRuleKind({ commissionType: "TIERED" }), "TIERED_NOT_IMPLEMENTED");
  });
});

describe("Epic 2 — A percentage of actual supplier commission", () => {
  it("clientPayable = actual × share; margin reconciles", () => {
    const calc = calculateCommercial({
      order: approvedOrder,
      conversion: conversionBase,
      clientCommissionRule: ratioRule(),
    });
    assert.equal(calc.ok, true);
    assert.equal(calc.supplierGross, "100.0000");
    assert.equal(calc.clientCommission, "70.0000");
    assert.equal(calc.mboMargin, "30.0000");
    assert.equal(
      Number(calc.supplierGross) - Number(calc.clientCommission) - Number(calc.mboMargin),
      0,
    );
  });
});

describe("Epic 2 — B fixed percent of order value", () => {
  it("uses orderValue × percent, not supplier gross", () => {
    const calc = calculateCommercial({
      order: approvedOrder,
      conversion: conversionBase,
      clientCommissionRule: {
        ...ratioRule({
          commissionType: "FIXED_CLIENT_PERCENT_OF_ORDER_VALUE",
          orderValuePercent: "5",
          grossCommission: "100",
          clientCommission: "0",
          mboCommission: "100",
        }),
      },
    });
    assert.equal(calc.ok, true);
    // 200 × 5% = 10
    assert.equal(calc.clientCommission, "10.0000");
    assert.equal(calc.supplierGross, "100.0000");
    assert.equal(calc.mboMargin, "90.0000");
    assert.equal(calc.calculationMetadata.method, "fixed_client_percent_of_order_value");
    assert.equal(calc.calculationMetadata.orderValue, 200);
  });
});

describe("Epic 2 — C fixed amount per confirmed order", () => {
  it("pays fixed amount when confirmed", () => {
    const calc = calculateCommercial({
      order: approvedOrder,
      conversion: conversionBase,
      clientCommissionRule: ratioRule({
        commissionType: "FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER",
        fixedAmount: "12.5000",
      }),
    });
    assert.equal(calc.ok, true);
    assert.equal(calc.clientCommission, "12.5000");
    assert.equal(calc.mboMargin, "87.5000");
  });

  it("rejects rejected orders with zero payable path", () => {
    const calc = calculateCommercial({
      order: { ...approvedOrder, validationStatus: "VALIDATION_REJECTED" },
      conversion: { ...conversionBase, status: "REJECTED" },
      clientCommissionRule: ratioRule({
        commissionType: "FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER",
        fixedAmount: "12.5000",
      }),
    });
    assert.equal(calc.ok, false);
    assert.equal(calc.reason, "validation_rejected");
  });
});

describe("Epic 2 — D manual approved commission", () => {
  it("unapproved is not payable", () => {
    const calc = calculateCommercial({
      order: approvedOrder,
      conversion: conversionBase,
      clientCommissionRule: ratioRule({
        commissionType: "MANUAL_APPROVED_CLIENT_COMMISSION",
        manualAmount: "40",
        manualApproved: false,
      }),
    });
    assert.equal(calc.ok, false);
    assert.equal(calc.reason, "manual_commission_not_approved");
  });

  it("approved manual amount becomes payable", () => {
    const calc = calculateCommercial({
      order: approvedOrder,
      conversion: conversionBase,
      clientCommissionRule: ratioRule({
        commissionType: "MANUAL_APPROVED_CLIENT_COMMISSION",
        manualAmount: "40",
        manualApproved: true,
        manualApprovedBy: "ops-user",
      }),
    });
    assert.equal(calc.ok, true);
    assert.equal(calc.clientCommission, "40.0000");
    assert.equal(calc.mboMargin, "60.0000");
  });
});

describe("Epic 2 — E display range ≠ financial payable", () => {
  it("display fields do not replace actual × share payout", () => {
    const calc = calculateCommercial({
      order: approvedOrder,
      conversion: conversionBase,
      clientCommissionRule: ratioRule({
        commissionType: "DISPLAY_RANGE_WITH_ACTUAL_SPLIT",
        displayRangeMin: "1",
        displayRangeMax: "5",
        displayLabel: "1–5%",
        grossCommission: "100",
        clientCommission: "70",
      }),
    });
    assert.equal(calc.ok, true);
    assert.equal(calc.clientCommission, "70.0000");
    assert.equal(calc.displayCommission.displayRangeMin, 1);
    assert.equal(calc.displayCommission.displayRangeMax, 5);
    assert.notEqual(String(calc.clientCommission), String(calc.displayCommission.displayRangeMax));
  });
});

describe("Epic 2 — F SupplierCommissionRule fact attachment", () => {
  it("records supplierCommissionRuleId in calculation metadata when provided", () => {
    const calc = calculateCommercial({
      order: approvedOrder,
      conversion: conversionBase,
      clientCommissionRule: ratioRule(),
      supplierCommissionRule: {
        id: "scr-1",
        basis: "PERCENT_OF_SALE",
        ratePercent: "10",
        currency: "USD",
      },
    });
    assert.equal(calc.ok, true);
    assert.equal(calc.calculationMetadata.supplierCommissionRuleId, "scr-1");
  });

  it("SupplierCommissionRuleService upserts and finds effective", async () => {
    const store = [];
    const db = {
      supplierCommissionRule: {
        findFirst: async ({ where }) =>
          store.find(
            (r) =>
              r.campaignSourceId === where.campaignSourceId &&
              r.effectiveFrom.getTime() === where.effectiveFrom.getTime(),
          ) || null,
        create: async ({ data }) => {
          const row = { id: `scr-${store.length + 1}`, ...data };
          store.push(row);
          return row;
        },
        update: async ({ where, data }) => {
          const idx = store.findIndex((r) => r.id === where.id);
          store[idx] = { ...store[idx], ...data };
          return store[idx];
        },
        findMany: async ({ where }) => {
          return store
            .filter((r) => r.campaignSourceId === where.campaignSourceId)
            .sort((a, b) => b.effectiveFrom - a.effectiveFrom);
        },
      },
    };
    const svc = new SupplierCommissionRuleService({ prisma: db });
    const created = await svc.upsertNormalizedFact({
      campaignSourceId: "src-1",
      supplier: "IMPACT",
      basis: "PERCENT_OF_SALE",
      ratePercent: "8",
      currency: "USD",
      effectiveFrom: new Date("2025-01-01"),
    });
    assert.equal(created.id, "scr-1");
    const found = await svc.findEffectiveForCampaignSource("src-1", new Date("2025-06-01"));
    assert.equal(found.id, "scr-1");
  });
});

describe("Epic 2 — G missing rule", () => {
  it("unresolved with no fabricated payable", () => {
    const calc = calculateCommercial({
      order: approvedOrder,
      conversion: conversionBase,
      clientCommissionRule: null,
    });
    assert.equal(calc.ok, false);
    assert.equal(calc.reason, "missing_effective_commission_rule");
    assert.equal(calc.clientCommission, undefined);
  });
});

describe("Epic 2 — H currency mismatch", () => {
  it("blocks silent conversion", () => {
    const calc = calculateCommercial({
      order: approvedOrder,
      conversion: conversionBase,
      clientCommissionRule: ratioRule({ currency: "INR" }),
    });
    assert.equal(calc.ok, false);
    assert.equal(calc.reason, "currency_mismatch");
  });
});

describe("Epic 2 — finance path uses engine (calculateCommission delegate)", () => {
  it("PERCENT path still works via finance facade", () => {
    const calc = calculateCommission({
      order: approvedOrder,
      conversion: conversionBase,
      clientCommissionRule: ratioRule(),
    });
    assert.equal(calc.ok, true);
    assert.equal(calc.ruleKind, V15_RULE_TYPES.PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION);
  });
});

function epic2FinanceMock({ rule = ratioRule(), conversionOverrides = {}, orderOverrides = {} } = {}) {
  const ft = new Map();
  const adj = new Map();
  const exceptions = [];
  const conversion = {
    ...conversionBase,
    ...conversionOverrides,
    order: { ...approvedOrder, ...orderOverrides },
    clientAssignment: {
      id: "asg-1",
      clientId: "client-a",
      client: { id: "client-a", country: "AE", currency: "USD" },
    },
  };

  return {
    exceptions,
    ft,
    db: {
      conversion: {
        findUnique: async () => ({ ...conversion, order: { ...conversion.order } }),
      },
      order: {
        findUnique: async () => ({ ...conversion.order }),
        update: async () => ({}),
      },
      client: {
        findUnique: async ({ where }) =>
          where.id === "client-a"
            ? { id: "client-a", country: "AE", currency: "USD" }
            : where.id === "client-b"
              ? { id: "client-b", country: "IN", currency: "INR" }
              : null,
      },
      financialTransaction: {
        findUnique: async ({ where }) => {
          if (where.recognitionKey) {
            return [...ft.values()].find((r) => r.recognitionKey === where.recognitionKey) || null;
          }
          return ft.get(where.id) || null;
        },
        findMany: async ({ where }) =>
          [...ft.values()].filter((r) => {
            if (where.conversionId && r.conversionId !== where.conversionId) return false;
            if (where.clientId && r.clientId !== where.clientId) return false;
            return true;
          }),
        create: async ({ data }) => {
          const row = { id: `ft-${ft.size + 1}`, ...data };
          ft.set(row.id, row);
          return row;
        },
        update: async ({ where, data }) => {
          const row = { ...ft.get(where.id), ...data };
          ft.set(where.id, row);
          return row;
        },
      },
      commissionAdjustment: {
        findUnique: async ({ where }) => adj.get(where.adjustmentKey) || null,
        create: async ({ data }) => {
          const row = { id: `adj-${adj.size + 1}`, ...data };
          adj.set(data.adjustmentKey, row);
          return row;
        },
      },
      exceptionCase: {
        create: async ({ data }) => {
          exceptions.push(data);
          return { id: `ex-${exceptions.length}`, ...data };
        },
        findFirst: async () => null,
        update: async () => ({}),
      },
    },
    commissionRepo: {
      findEffectiveForAssignment: async (assignmentId) => {
        if (assignmentId !== "asg-1") return null;
        return rule.assignmentId === assignmentId ? rule : null;
      },
    },
  };
}

describe("Epic 2 — I/J reversal + idempotency via FT", () => {
  it("duplicate recognition yields one earn FT; late rejection adds REVERSAL without mutating original", async () => {
    const { db, commissionRepo, ft } = epic2FinanceMock();
    const { FxService } = await import("../src/modules/finance/fx.service.js");
    const { ExceptionCaseService } = await import("../src/modules/order/exceptionCase.service.js");
    const svc2 = new FinancialTransactionService({
      prisma: db,
      commissionRepo,
      audit: { record: async () => ({}) },
      exceptions: new ExceptionCaseService({ prisma: db, audit: { record: async () => ({}) } }),
      fx: new FxService({ rateProvider: new Map([["USD:USD:2025-06-01", "1"]]), prisma: db }),
    });

    const first = await svc2.recognizeConversion({ conversionId: "cv-1", orderId: "ord-1" });
    assert.equal(first.created, true);
    assert.equal(String(first.record.clientPayable), "70.0000");
    assert.equal(String(first.record.mboMargin), "30.0000");
    const originalId = first.record.id;
    const originalPayable = first.record.clientPayable;

    const second = await svc2.recognizeConversion({ conversionId: "cv-1", orderId: "ord-1" });
    assert.equal(second.reused, true);
    assert.equal(ft.size, 1);

    const rev = await svc2.reverseForLateRejection({
      conversionId: "cv-1",
      orderId: "ord-1",
      reason: "network rejected",
    });
    assert.ok(rev.record || rev.adjustment);
    assert.equal(String(ft.get(originalId).clientPayable), String(originalPayable));
    assert.equal(ft.size, 2);
  });
});

describe("Epic 2 — K tenant isolation on rule resolution", () => {
  it("Client B assignment does not receive Client A rule", async () => {
    const rule = ratioRule({ assignmentId: "asg-a" });
    const { db } = epic2FinanceMock({ rule });
    const commissionRepo = {
      findEffectiveForAssignment: async (assignmentId) =>
        assignmentId === "asg-a" ? rule : null,
    };
    db.conversion.findUnique = async () => ({
      ...conversionBase,
      id: "cv-b",
      clientAssignmentId: "asg-b",
      order: {
        ...approvedOrder,
        id: "ord-b",
        clientId: "client-b",
        clientAssignmentId: "asg-b",
      },
      clientAssignment: {
        id: "asg-b",
        clientId: "client-b",
        client: { id: "client-b", country: "IN", currency: "INR" },
      },
    });

    const { FxService } = await import("../src/modules/finance/fx.service.js");
    const { ExceptionCaseService } = await import("../src/modules/order/exceptionCase.service.js");
    const svc = new FinancialTransactionService({
      prisma: db,
      commissionRepo,
      audit: { record: async () => ({}) },
      exceptions: new ExceptionCaseService({ prisma: db, audit: { record: async () => ({}) } }),
      fx: new FxService({
        rateProvider: new Map([["USD:INR:2025-06-01", "83"]]),
        prisma: db,
      }),
    });
    const result = await svc.recognizeConversion({ conversionId: "cv-b", orderId: "ord-b" });
    assert.equal(result.unresolved, true);
    assert.equal(result.reason, "missing_effective_commission_rule");
  });
});

describe("Epic 2 — L golden path Client→Rule→Conversion→Engine→FT", () => {
  it("proves calculated clientPayable and mboMargin on FT", async () => {
    const rule = ratioRule({
      commissionType: "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION",
      grossCommission: "100",
      clientCommission: "60",
      mboCommission: "40",
    });
    const { db, commissionRepo } = epic2FinanceMock({
      rule,
      conversionOverrides: {
        supplierCommission: "250.0000",
        approvedCommission: "250.0000",
      },
    });
    const supplierFacts = {
      findEffectiveForCampaignSource: async () => ({
        id: "scr-gold",
        basis: "PERCENT_OF_SALE",
        ratePercent: "10",
      }),
    };
    const { FxService } = await import("../src/modules/finance/fx.service.js");
    const { ExceptionCaseService } = await import("../src/modules/order/exceptionCase.service.js");
    const svc = new FinancialTransactionService({
      prisma: db,
      commissionRepo,
      supplierCommissionRules: supplierFacts,
      audit: { record: async () => ({}) },
      exceptions: new ExceptionCaseService({ prisma: db, audit: { record: async () => ({}) } }),
      fx: new FxService({
        rateProvider: new Map([["USD:USD:2025-06-01", "1"]]),
        prisma: db,
      }),
    });

    const enginePreview = calculateCommercial({
      order: approvedOrder,
      conversion: {
        ...conversionBase,
        supplierCommission: "250.0000",
        approvedCommission: "250.0000",
      },
      clientCommissionRule: rule,
      supplierCommissionRule: { id: "scr-gold" },
    });
    assert.equal(enginePreview.clientCommission, "150.0000");
    assert.equal(enginePreview.mboMargin, "100.0000");

    const recognized = await svc.recognizeConversion({ conversionId: "cv-1", orderId: "ord-1" });
    assert.equal(recognized.created, true);
    assert.equal(recognized.record.recognitionKey, earnRecognitionKey("cv-1"));
    assert.equal(String(recognized.record.supplierReceivable), "250.0000");
    assert.equal(String(recognized.record.clientPayable), "150.0000");
    assert.equal(String(recognized.record.mboMargin), "100.0000");
    assert.equal(
      Number(recognized.record.supplierReceivable) -
        Number(recognized.record.clientPayable) -
        Number(recognized.record.mboMargin),
      0,
    );
    assert.equal(recognized.record.calculationMetadata.supplierCommissionRuleId, "scr-gold");
  });
});
