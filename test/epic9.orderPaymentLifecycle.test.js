/**
 * Epic 9 Phase 1 — OrderItem validation → approved commercial basis → FT.
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  resolveApprovedCommercialBasis,
  approvedBasisFingerprint,
} from "../src/modules/order/approvedCommercialBasis.js";
import { ItemValidationService } from "../src/modules/order/itemValidation.service.js";
import {
  calculateCommercial,
  resolveRuleKind,
  V15_RULE_TYPES,
} from "../src/modules/commercial/commercialRuleEngine.js";
import {
  earnRecognitionKey,
  FinancialTransactionService,
} from "../src/modules/finance/financialTransaction.service.js";
import { netFinancialPosition } from "../src/modules/finance/commissionCalculation.service.js";
import {
  toClientOrderDto,
  toClientOrderItemDto,
  FORBIDDEN_CLIENT_ORDER_KEYS,
} from "../src/modules/client/dto/clientReporting.dto.js";
import { toAdminOrderDto } from "../src/modules/ops/adminContract.dto.js";
import { ROLE_PERMISSIONS, PERMISSIONS } from "../src/auth/permissions.js";
import { mapClientFacingOrderStatus } from "../src/modules/client/dto/clientReporting.dto.js";

const percentRule = {
  id: "r-pct",
  status: "EFFECTIVE",
  commissionType: "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION",
  grossCommission: "100",
  clientCommission: "70",
  mboCommission: "30",
  currency: "USD",
  // Financial recognition requires approved commercial agreement lineage.
  agreementRef: "IO-2025-001",
  agreementApprovedAt: new Date("2025-01-01"),
  agreementApprovedBy: "finance-lead",
};

const orderValueRule = {
  id: "r-ov",
  status: "EFFECTIVE",
  commissionType: "FIXED_CLIENT_PERCENT_OF_ORDER_VALUE",
  orderValuePercent: "10",
  grossCommission: "100",
  clientCommission: "70",
  currency: "USD",
};

const fixedAmountRule = {
  id: "r-fix",
  status: "EFFECTIVE",
  commissionType: "FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER",
  fixedAmount: "50",
  grossCommission: "100",
  clientCommission: "70",
  currency: "USD",
};

const manualRule = {
  id: "r-man",
  status: "EFFECTIVE",
  commissionType: "MANUAL_APPROVED_CLIENT_COMMISSION",
  manualApproved: true,
  manualApprovedAt: new Date("2025-05-01"),
  manualApprovedBy: "ops-user",
  manualAmount: "25",
  currency: "USD",
};

const displayRule = {
  id: "r-disp",
  status: "EFFECTIVE",
  commissionType: "DISPLAY_RANGE_WITH_ACTUAL_SPLIT",
  grossCommission: "100",
  clientCommission: "70",
  displayRangeMin: "5",
  displayRangeMax: "15",
  currency: "USD",
};

function orderWithItems(items, overrides = {}) {
  return {
    id: "ord-1",
    validationStatus: "VALIDATION_APPROVED",
    orderValue: "300",
    currency: "USD",
    items,
    ...overrides,
  };
}

const conv = {
  id: "conv-1",
  status: "APPROVED",
  supplierCommission: "100",
  approvedCommission: "100",
  currency: "USD",
};

describe("Epic 9 — approved commercial basis", () => {
  it("historical order with no item statuses → FULL_ORDER_LEGACY", () => {
    const basis = resolveApprovedCommercialBasis(
      orderWithItems([
        { lineKey: "a", itemValue: "100", commission: "40", validationStatus: null },
        { lineKey: "b", itemValue: "200", commission: "60", validationStatus: null },
      ]),
      conv,
    );
    assert.equal(basis.basisMode, "FULL_ORDER_LEGACY");
    assert.equal(basis.approvedOrderValue, 300);
    assert.equal(basis.approvedSupplierCommission, 100);
    assert.equal(basis.allItemsApproved, true);
  });

  it("all items approved → item-level full approved basis", () => {
    const basis = resolveApprovedCommercialBasis(
      orderWithItems([
        { lineKey: "a", itemValue: "100", commission: "40", validationStatus: "VALIDATION_APPROVED" },
        { lineKey: "b", itemValue: "200", commission: "60", validationStatus: "VALIDATION_APPROVED" },
      ]),
      conv,
    );
    assert.equal(basis.basisMode, "ITEM_LEVEL");
    assert.equal(basis.approvedItemCount, 2);
    assert.equal(basis.approvedOrderValue, 300);
    assert.equal(basis.approvedSupplierCommission, 100);
    assert.equal(basis.allItemsApproved, true);
  });

  it("partial approval → only approved items contribute", () => {
    const basis = resolveApprovedCommercialBasis(
      orderWithItems([
        { lineKey: "a", itemValue: "100", commission: "40", validationStatus: "VALIDATION_APPROVED" },
        { lineKey: "b", itemValue: "200", commission: "60", validationStatus: "VALIDATION_REJECTED" },
      ]),
      conv,
    );
    assert.equal(basis.approvedItemCount, 1);
    assert.equal(basis.rejectedItemCount, 1);
    assert.equal(basis.approvedOrderValue, 100);
    assert.equal(basis.approvedSupplierCommission, 40);
    assert.equal(basis.allItemsApproved, false);
  });

  it("rejected item → zero contribution", () => {
    const basis = resolveApprovedCommercialBasis(
      orderWithItems([
        { lineKey: "a", itemValue: "100", commission: "40", validationStatus: "VALIDATION_REJECTED" },
      ]),
      conv,
    );
    assert.equal(basis.approvedOrderValue, 0);
    assert.equal(basis.approvedSupplierCommission, 0);
    assert.equal(basis.approvedItemCount, 0);
  });

  it("pending item → zero contribution", () => {
    const basis = resolveApprovedCommercialBasis(
      orderWithItems([
        { lineKey: "a", itemValue: "100", commission: "40", validationStatus: "VALIDATION_PENDING" },
        { lineKey: "b", itemValue: "50", commission: "10", validationStatus: "VALIDATION_APPROVED" },
      ]),
      conv,
    );
    assert.equal(basis.pendingItemCount, 1);
    assert.equal(basis.approvedOrderValue, 50);
    assert.equal(basis.approvedSupplierCommission, 10);
  });

  it("missing item commission fails approvedSupplierCommissionOk", () => {
    const basis = resolveApprovedCommercialBasis(
      orderWithItems([
        { lineKey: "a", itemValue: "100", commission: null, validationStatus: "VALIDATION_APPROVED" },
      ]),
      conv,
    );
    assert.equal(basis.approvedSupplierCommissionOk, false);
    assert.equal(basis.approvedSupplierCommission, null);
  });
});

describe("Epic 9 — commercial rules with approved basis", () => {
  it("PERCENT uses approved supplier commission", () => {
    const basis = resolveApprovedCommercialBasis(
      orderWithItems([
        { lineKey: "a", itemValue: "100", commission: "40", validationStatus: "VALIDATION_APPROVED" },
        { lineKey: "b", itemValue: "200", commission: "60", validationStatus: "VALIDATION_REJECTED" },
      ]),
      conv,
    );
    const calc = calculateCommercial({
      order: orderWithItems([]),
      conversion: conv,
      clientCommissionRule: percentRule,
      approvedBasis: basis,
    });
    assert.equal(calc.ok, true);
    assert.equal(Number(calc.supplierGross), 40);
    assert.equal(Number(calc.clientCommission), 28);
    assert.equal(Number(calc.mboMargin), 12);
    assert.equal(calc.calculationMetadata.basisMode, "ITEM_LEVEL");
  });

  it("FIXED % of order value uses approved order value", () => {
    const basis = resolveApprovedCommercialBasis(
      orderWithItems([
        { lineKey: "a", itemValue: "100", commission: "40", validationStatus: "VALIDATION_APPROVED" },
        { lineKey: "b", itemValue: "200", commission: "60", validationStatus: "VALIDATION_REJECTED" },
      ]),
      conv,
    );
    const calc = calculateCommercial({
      order: orderWithItems([], { orderValue: "300", validationStatus: "VALIDATION_APPROVED" }),
      conversion: conv,
      clientCommissionRule: orderValueRule,
      approvedBasis: basis,
    });
    assert.equal(calc.ok, true);
    assert.equal(Number(calc.clientCommission), 10); // 10% of 100
    assert.equal(Number(calc.supplierGross), 40);
  });

  it("FIXED amount fails closed on partial approval", () => {
    const basis = resolveApprovedCommercialBasis(
      orderWithItems([
        { lineKey: "a", itemValue: "100", commission: "40", validationStatus: "VALIDATION_APPROVED" },
        { lineKey: "b", itemValue: "100", commission: "30", validationStatus: "VALIDATION_APPROVED" },
        { lineKey: "c", itemValue: "100", commission: "30", validationStatus: "VALIDATION_PENDING" },
      ]),
      conv,
    );
    const calc = calculateCommercial({
      order: orderWithItems([], { validationStatus: "VALIDATION_APPROVED" }),
      conversion: conv,
      clientCommissionRule: fixedAmountRule,
      approvedBasis: basis,
    });
    assert.equal(calc.ok, false);
    assert.equal(calc.reason, "partial_approval_fixed_amount_unresolved");
  });

  it("FIXED amount succeeds when all items approved", () => {
    const basis = resolveApprovedCommercialBasis(
      orderWithItems([
        { lineKey: "a", itemValue: "100", commission: "40", validationStatus: "VALIDATION_APPROVED" },
        { lineKey: "b", itemValue: "100", commission: "60", validationStatus: "VALIDATION_APPROVED" },
      ]),
      conv,
    );
    const calc = calculateCommercial({
      order: orderWithItems([], { validationStatus: "VALIDATION_APPROVED" }),
      conversion: { ...conv, supplierCommission: "100" },
      clientCommissionRule: fixedAmountRule,
      approvedBasis: basis,
    });
    assert.equal(calc.ok, true);
    assert.equal(Number(calc.clientCommission), 50);
    assert.equal(Number(calc.supplierGross), 100);
  });

  it("MANUAL rule remains correct with item basis supplier", () => {
    const basis = resolveApprovedCommercialBasis(
      orderWithItems([
        { lineKey: "a", itemValue: "100", commission: "80", validationStatus: "VALIDATION_APPROVED" },
      ]),
      conv,
    );
    const calc = calculateCommercial({
      order: orderWithItems([], { validationStatus: "VALIDATION_APPROVED" }),
      conversion: conv,
      clientCommissionRule: manualRule,
      approvedBasis: basis,
    });
    assert.equal(calc.ok, true);
    assert.equal(Number(calc.clientCommission), 25);
    assert.equal(Number(calc.supplierGross), 80);
  });

  it("DISPLAY_RANGE payout uses approved supplier × share", () => {
    const basis = resolveApprovedCommercialBasis(
      orderWithItems([
        { lineKey: "a", itemValue: "100", commission: "100", validationStatus: "VALIDATION_APPROVED" },
      ]),
      conv,
    );
    const calc = calculateCommercial({
      order: orderWithItems([], { validationStatus: "VALIDATION_APPROVED" }),
      conversion: conv,
      clientCommissionRule: displayRule,
      approvedBasis: basis,
    });
    assert.equal(calc.ok, true);
    assert.equal(Number(calc.clientCommission), 70);
    assert.ok(calc.displayCommission);
  });

  it("TIERED remains unresolved", () => {
    assert.equal(resolveRuleKind({ commissionType: "TIERED" }), "TIERED_NOT_IMPLEMENTED");
    const calc = calculateCommercial({
      order: orderWithItems([], { validationStatus: "VALIDATION_APPROVED" }),
      conversion: conv,
      clientCommissionRule: { status: "EFFECTIVE", commissionType: "TIERED" },
      approvedBasis: resolveApprovedCommercialBasis(orderWithItems([]), conv),
    });
    assert.equal(calc.ok, false);
    assert.equal(calc.reason, "tiered_not_implemented");
  });

  it("missing commission basis → no fabricated payable", () => {
    const basis = resolveApprovedCommercialBasis(
      orderWithItems([
        { lineKey: "a", itemValue: "100", commission: null, validationStatus: "VALIDATION_APPROVED" },
      ]),
      conv,
    );
    const calc = calculateCommercial({
      order: orderWithItems([], { validationStatus: "VALIDATION_APPROVED" }),
      conversion: conv,
      clientCommissionRule: percentRule,
      approvedBasis: basis,
    });
    assert.equal(calc.ok, false);
    assert.equal(calc.reason, "missing_approved_item_supplier_commission");
  });

  it("FULL_ORDER_LEGACY preserves Epic 2 percent behavior", () => {
    const basis = resolveApprovedCommercialBasis(
      orderWithItems([{ lineKey: "a", itemValue: "100", validationStatus: null }]),
      conv,
    );
    const calc = calculateCommercial({
      order: orderWithItems([], { validationStatus: "VALIDATION_APPROVED", orderValue: "300" }),
      conversion: conv,
      clientCommissionRule: percentRule,
      approvedBasis: basis,
    });
    assert.equal(calc.ok, true);
    assert.equal(Number(calc.clientCommission), 70);
    assert.equal(calc.calculationMetadata.basisMode, "FULL_ORDER_LEGACY");
  });
});

describe("Epic 9 — FT identity and margin", () => {
  it("earn recognition key remains earn:{conversionId}", () => {
    assert.equal(earnRecognitionKey("conv-xyz"), "earn:conv-xyz");
  });

  it("margin identity holds on partial percent calc", () => {
    const basis = resolveApprovedCommercialBasis(
      orderWithItems([
        { lineKey: "a", itemValue: "100", commission: "40", validationStatus: "VALIDATION_APPROVED" },
      ]),
      conv,
    );
    const calc = calculateCommercial({
      order: orderWithItems([], { validationStatus: "VALIDATION_APPROVED" }),
      conversion: conv,
      clientCommissionRule: percentRule,
      approvedBasis: basis,
    });
    const s = Number(calc.supplierGross);
    const c = Number(calc.clientCommission);
    const m = Number(calc.mboMargin);
    assert.ok(Math.abs(s - c - m) < 0.00015);
  });

  it("netFinancialPosition after earn + correction", () => {
    const rows = [
      { supplierReceivable: 100, clientPayable: 70, mboMargin: 30 },
      { supplierReceivable: -60, clientPayable: -42, mboMargin: -18 },
    ];
    const net = netFinancialPosition(rows);
    assert.equal(Number(net.supplierReceivable), 40);
    assert.equal(Number(net.clientPayable), 28);
    assert.equal(net.reconciles, true);
  });

  it("syncApprovedBasisForOrder creates correction without mutating earn amounts", async () => {
    const earn = {
      id: "ft-earn",
      recognitionKey: "earn:conv-1",
      conversionId: "conv-1",
      orderId: "ord-1",
      clientId: "client-a",
      supplier: "OPTIMISE",
      supplierReceivable: "100",
      clientPayable: "70",
      mboMargin: "30",
      originalCurrency: "USD",
      reportingCurrency: "USD",
      fxRate: "1",
      campaignSourceId: null,
      commissionRuleId: "r-pct",
      ruleSnapshot: {},
      effectiveAt: new Date(),
      fxDate: null,
    };
    const created = [];
    const db = {
      order: {
        findUnique: mock.fn(async () => ({
          id: "ord-1",
          validationStatus: "VALIDATION_APPROVED",
          clientId: "client-a",
          clientAssignmentId: "asg-1",
          currency: "USD",
          orderValue: "300",
          orderDate: new Date(),
          supplier: "OPTIMISE",
          campaignSourceId: null,
          items: [
            { lineKey: "a", itemValue: "100", commission: "40", validationStatus: "VALIDATION_APPROVED" },
            { lineKey: "b", itemValue: "200", commission: "60", validationStatus: "VALIDATION_REJECTED" },
          ],
          conversions: [
            {
              id: "conv-1",
              clientAssignmentId: "asg-1",
              conversionDate: new Date(),
              supplierCommission: "100",
              approvedCommission: "100",
              currency: "USD",
              supplier: "OPTIMISE",
              clientAssignment: { clientId: "client-a", client: { id: "client-a", country: "US", currency: "USD" } },
            },
          ],
        })),
      },
      financialTransaction: {
        findUnique: mock.fn(async ({ where }) => {
          if (where.recognitionKey === "earn:conv-1") return earn;
          if (where.id === "ft-earn") return earn;
          return created.find((r) => r.recognitionKey === where.recognitionKey) || null;
        }),
        findMany: mock.fn(async () => [earn, ...created.filter((c) => c.conversionId === "conv-1")]),
        create: mock.fn(async ({ data }) => {
          const row = { id: `ft-${created.length + 2}`, ...data };
          created.push(row);
          return row;
        }),
        update: mock.fn(async ({ where, data }) => {
          if (where.id === "ft-earn") {
            // Status only — amounts immutable
            assert.equal(data.supplierReceivable, undefined);
            assert.equal(data.clientPayable, undefined);
            return { ...earn, ...data };
          }
          return data;
        }),
      },
      commissionAdjustment: {
        findUnique: mock.fn(async () => null),
        create: mock.fn(async ({ data }) => ({ id: "adj-1", ...data })),
      },
    };
    const finance = new FinancialTransactionService({
      prisma: db,
      commissionRepo: {
        findEffectiveForAssignment: async () => percentRule,
        findEffectiveRulesForAssignment: async () => [percentRule],
      },
      exceptions: { report: async () => ({}) },
      audit: { record: async () => {} },
      fx: {
        convert: async () => ({ ok: true, reportingAmount: "0", fxRate: "1", fxSource: "identity", fxDate: new Date() }),
      },
    });
    // Bypass FX complexity — identity path when currencies match
    finance.applyFxBundle = async ({ amounts, originalCurrency, reportingCurrency }) => ({
      ok: true,
      reportingCurrency: reportingCurrency || originalCurrency,
      fxRate: "1",
      fxSource: "identity",
      fxDate: new Date(),
      reporting: {
        supplierReceivable: String(amounts.supplierGross),
        clientPayable: String(amounts.clientCommission),
        mboMargin: String(amounts.mboMargin),
      },
    });

    const out = await finance.syncApprovedBasisForOrder({ orderId: "ord-1" }, db);
    assert.equal(out.results[0].action, "adjust");
    assert.equal(created.length, 1);
    assert.equal(Number(created[0].clientPayable), -42); // 70 → 28
    assert.equal(Number(earn.clientPayable), 70); // original immutable
  });
});

describe("Epic 9 — item validation service + tenant isolation", () => {
  it("rejects cross-tenant item transition", async () => {
    const svc = new ItemValidationService({
      prisma: {
        orderItem: {
          findUnique: async () => ({
            id: "item-1",
            validationStatus: "VALIDATION_PENDING",
            order: { id: "ord-1", clientId: "client-a", supplier: "OPTIMISE", items: [], conversions: [] },
          }),
        },
      },
      exceptions: { report: async () => ({}) },
      audit: { record: async () => {} },
      finance: { syncApprovedBasisForOrder: async () => ({}) },
    });
    await assert.rejects(
      () => svc.transitionItem("item-1", "VALIDATION_APPROVED", { expectedClientId: "client-b" }),
      /tenant/i,
    );
  });

  it("idempotent same-status transition", async () => {
    const svc = new ItemValidationService({
      prisma: {
        orderItem: {
          findUnique: async () => ({
            id: "item-1",
            validationStatus: "VALIDATION_APPROVED",
            order: {
              id: "ord-1",
              clientId: "client-a",
              supplier: "OPTIMISE",
              validationStatus: "VALIDATION_APPROVED",
              items: [],
              conversions: [],
            },
          }),
        },
      },
      exceptions: { report: async () => ({}) },
      audit: { record: async () => {} },
      finance: { syncApprovedBasisForOrder: async () => ({}) },
    });
    const out = await svc.transitionItem("item-1", "VALIDATION_APPROVED", { expectedClientId: "client-a" });
    assert.equal(out.unchanged, true);
  });
});

describe("Epic 9 — client DTO safety + Epic 1/8 regression", () => {
  it("client item DTO exposes safe validation without supplier commission", () => {
    const dto = toClientOrderItemDto({
      lineKey: "a",
      sku: "SKU",
      quantity: 1,
      unitPrice: "10",
      itemValue: "10",
      commission: "99",
      validationStatus: "VALIDATION_APPROVED",
      currency: "USD",
    });
    assert.equal(dto.itemValidationStatus, "APPROVED");
    assert.equal(dto.clientCommission, null);
    assert.equal(dto.commission, undefined);
  });

  it("client order DTO strips forbidden finance fields", () => {
    const dto = toClientOrderDto(
      {
        id: "o1",
        currency: "USD",
        orderValue: "10",
        validationStatus: "VALIDATION_APPROVED",
        clientPaymentStatus: "CLIENT_PAYMENT_PAYABLE",
        merchant: { displayName: "B" },
        items: [],
        mboMargin: 1,
        supplierReceivable: 2,
      },
      { clientCommission: 7, commissionSource: "financial_transaction" },
    );
    for (const key of FORBIDDEN_CLIENT_ORDER_KEYS) {
      assert.equal(Object.prototype.hasOwnProperty.call(dto, key), false, key);
    }
    assert.equal(dto.orderStatus, "Payable");
  });

  it("payment-status vocabulary unchanged; Paid not from validation alone", () => {
    assert.equal(
      mapClientFacingOrderStatus({
        validationStatus: "VALIDATION_APPROVED",
        clientPaymentStatus: "CLIENT_PAYMENT_NOT_READY",
      }),
      "Confirmed",
    );
  });
});

describe("Epic 9 — admin permission gating", () => {
  it("ANALYST lacks OPS_MANAGE; OPERATIONS has it", () => {
    assert.equal(ROLE_PERMISSIONS.ANALYST.includes(PERMISSIONS.OPS_MANAGE), false);
    assert.equal(ROLE_PERMISSIONS.OPERATIONS.includes(PERMISSIONS.OPS_MANAGE), true);
    assert.equal(ROLE_PERMISSIONS.CLIENT.includes(PERMISSIONS.OPS_MANAGE), false);
  });

  it("admin order DTO redacts finance without permission", () => {
    const dto = toAdminOrderDto(
      {
        id: "ord-1",
        validationStatus: "VALIDATION_APPROVED",
        items: [{ id: "i1", lineKey: "a", validationStatus: "VALIDATION_APPROVED", commission: "40" }],
        itemValidationSummary: { total: 1, approved: 1, rejected: 0, pending: 0, needsReview: 0, unknown: 0 },
        financialSummary: { clientPayable: 28, supplierReceivable: 40, mboMargin: 12, ftStatus: "HAS_FT" },
      },
      { includeFinancial: false },
    );
    assert.equal(dto.financial.state, "REDACTED");
    assert.equal(dto.items[0].itemCommission, undefined);
  });

  it("admin order DTO shows item commission with finance permission", () => {
    const dto = toAdminOrderDto(
      {
        id: "ord-1",
        validationStatus: "VALIDATION_APPROVED",
        items: [{ id: "i1", lineKey: "a", validationStatus: "VALIDATION_APPROVED", commission: "40", itemValue: "100" }],
        financialSummary: { clientPayable: 28, supplierReceivable: 40, mboMargin: 12, ftStatus: "HAS_FT" },
      },
      { includeFinancial: true },
    );
    assert.equal(dto.financial.mboMargin, 12);
    assert.equal(dto.items[0].itemCommission, 40);
  });

  it("admin order DTO falls back to networkContext for brand/campaign/coupon/confirmed", () => {
    const dto = toAdminOrderDto(
      {
        id: "ord-thin",
        supplier: "OPTIMISE",
        supplierOrderId: "conv:abc",
        validationStatus: "VALIDATION_APPROVED",
        orderDate: "2026-04-09T00:00:00.000Z",
        networkContext: {
          network: "OPTIMISE",
          merchantName: "Noon EGYPT",
          campaignName: "Coupon Campaign",
          campaignType: "Coupon + Link",
          couponCode: "mp393",
          couponLink: "https://clk.example/t",
          confirmedDate: "2026-04-09T00:00:00.000Z",
          paymentStatus: "PENDING",
          commissionCurrency: "USD",
        },
        financialSummary: {
          supplierReceivable: 0.21,
          clientPayable: null,
          mboMargin: null,
          ftStatus: "NO_FT",
          source: "conversion",
        },
      },
      { includeFinancial: true },
    );
    assert.equal(dto.merchantName, "Noon EGYPT");
    assert.equal(dto.campaignName, "Coupon Campaign");
    assert.equal(dto.campaignType, "Coupon + Link");
    assert.equal(dto.couponCode, "mp393");
    assert.equal(dto.couponCodeOrLink, "mp393 / https://clk.example/t");
    assert.equal(dto.confirmedDate, "2026-04-09T00:00:00.000Z");
    assert.equal(dto.orderStatus, "CONFIRMED");
    assert.equal(dto.supplierActualCommission, 0.21);
    assert.equal(dto.paymentStatus, "PENDING");
  });

  it("admin order DTO exposes client/mbo share percents from networkContext", () => {
    const dto = toAdminOrderDto(
      {
        id: "ord-share",
        validationStatus: "VALIDATION_APPROVED",
        networkContext: {
          clientSharePercent: 70,
          mboSharePercent: 30,
        },
        financialSummary: {
          supplierReceivable: 10,
          clientPayable: 7,
          mboMargin: 3,
          ftStatus: "HAS_FT",
        },
      },
      { includeFinancial: true },
    );
    assert.equal(dto.clientSharePercent, 70);
    assert.equal(dto.mboSharePercent, 30);
  });
});

describe("Epic 9 — fingerprint + five rule kinds spot", () => {
  it("fingerprint stable for same approved set", () => {
    const b1 = resolveApprovedCommercialBasis(
      orderWithItems([
        { lineKey: "b", itemValue: "1", commission: "1", validationStatus: "VALIDATION_APPROVED" },
        { lineKey: "a", itemValue: "2", commission: "2", validationStatus: "VALIDATION_APPROVED" },
      ]),
      conv,
    );
    const b2 = resolveApprovedCommercialBasis(
      orderWithItems([
        { lineKey: "a", itemValue: "2", commission: "2", validationStatus: "VALIDATION_APPROVED" },
        { lineKey: "b", itemValue: "1", commission: "1", validationStatus: "VALIDATION_APPROVED" },
      ]),
      conv,
    );
    assert.equal(approvedBasisFingerprint(b1), approvedBasisFingerprint(b2));
  });

  it("five v15 kinds still resolve", () => {
    assert.equal(V15_RULE_TYPES.PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION, "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION");
    assert.equal(resolveRuleKind(percentRule), V15_RULE_TYPES.PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION);
    assert.equal(resolveRuleKind(orderValueRule), V15_RULE_TYPES.FIXED_CLIENT_PERCENT_OF_ORDER_VALUE);
    assert.equal(resolveRuleKind(fixedAmountRule), V15_RULE_TYPES.FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER);
    assert.equal(resolveRuleKind(manualRule), V15_RULE_TYPES.MANUAL_APPROVED_CLIENT_COMMISSION);
    assert.equal(resolveRuleKind(displayRule), V15_RULE_TYPES.DISPLAY_RANGE_WITH_ACTUAL_SPLIT);
  });
});
