import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FinancialTransactionService,
  resolveFinancialAttribution,
  resolveValidatedNetworkActualCommission,
} from "../src/modules/finance/financialTransaction.service.js";

function baseOrder(overrides = {}) {
  return {
    id: "order-1",
    clientId: "client-1",
    clientAssignmentId: "assignment-1",
    validationStatus: "VALIDATION_APPROVED",
    clientPaymentStatus: "CLIENT_PAYMENT_NOT_READY",
    orderValue: "500.00",
    orderDate: new Date("2026-09-01T10:00:00.000Z"),
    currency: "USD",
    supplier: "CJ",
    campaignSourceId: "source-1",
    metadata: {},
    items: [],
    ...overrides,
  };
}

function baseConversion(order, overrides = {}) {
  return {
    id: "conversion-1",
    orderId: order.id,
    order,
    clientAssignmentId: "assignment-1",
    clientAssignment: {
      id: "assignment-1",
      clientId: "client-1",
      canonicalCampaignId: "campaign-1",
      client: { id: "client-1", currency: "USD", country: "US" },
    },
    conversionDate: new Date("2026-09-01T10:00:00.000Z"),
    approvedCommission: "100.00",
    supplierCommission: "100.00",
    currency: "USD",
    supplier: "CJ",
    campaignSourceId: "source-1",
    metadata: {},
    ...overrides,
  };
}

function createHarness({ order = baseOrder(), conversion = null, runtimeResult = null } = {}) {
  const resolvedConversion = conversion ?? baseConversion(order);
  let createdData = null;
  const exceptionRows = [];
  const runtimeCalls = [];

  const db = {
    financialTransaction: {
      findUnique: async () => null,
      create: async ({ data }) => {
        createdData = data;
        return { id: "ft-1", ...data };
      },
    },
    conversion: {
      findUnique: async () => resolvedConversion,
    },
    order: {
      findUnique: async () => order,
      update: async () => order,
    },
    client: {
      findUnique: async () => resolvedConversion.clientAssignment?.client ?? null,
    },
  };

  const runtime = {
    evaluate: async (input) => {
      runtimeCalls.push(input);
      return runtimeResult ?? {
        status: "CALCULATED",
        reason: "non_negative_margin",
        matchedClientCommissionRuleId: "rule-specific",
        matchedRuleSnapshot: {
          id: "rule-specific",
          assignmentId: "assignment-1",
          commissionType: "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION",
        },
        ruleKind: "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION",
        ruleSelectionStatus: "MATCHED",
        clientPayable: 70,
        mboMargin: 30,
        payoutBasis: "NETWORK_ACTUAL_COMMISSION",
        provisional: false,
        payable: false,
        tierSelection: null,
        lineage: { status: "COMPLETE", agreementRef: "IO-1" },
        marginProtection: { status: "ALLOWED", margin: 30 },
        facts: { country: "US" },
      };
    },
  };

  const service = new FinancialTransactionService({
    prisma: db,
    clientCommercialRuntime: runtime,
    exceptions: {
      report: async (row) => {
        exceptionRows.push(row);
        return row;
      },
    },
    audit: { record: async () => null },
    fx: { convert: async () => { throw new Error("FX conversion should not be needed for USD identity."); } },
  });

  return {
    service,
    db,
    runtimeCalls,
    exceptionRows,
    getCreatedData: () => createdData,
  };
}

describe("FinancialTransaction deterministic client-commercial runtime", () => {
  it("fails closed when order and conversion assignment attribution conflict", () => {
    const result = resolveFinancialAttribution(
      { clientAssignmentId: "assignment-A", clientId: "client-1" },
      { clientAssignmentId: "assignment-B", clientAssignment: { clientId: "client-1" } },
    );
    assert.equal(result.resolved, false);
    assert.equal(result.reason, "assignment_attribution_conflict");
  });

  it("uses approved item commission as network actual at item-level grain", () => {
    const result = resolveValidatedNetworkActualCommission({
      approvedBasis: {
        basisMode: "ITEM_LEVEL",
        approvedSupplierCommissionOk: true,
        approvedSupplierCommission: 40,
        currency: "USD",
      },
      conversion: { approvedCommission: 100, supplierCommission: 100, currency: "USD" },
    });
    assert.equal(result.ok, true);
    assert.equal(result.amount, 40);
    assert.equal(result.source, "sum_approved_order_item_commission");
  });

  it("persists a FinancialTransaction only from a CALCULATED deterministic runtime result", async () => {
    const harness = createHarness();
    const result = await harness.service.recognizeConversion({ conversionId: "conversion-1" });

    assert.equal(result.created, true);
    assert.equal(harness.runtimeCalls.length, 1);
    assert.equal(harness.runtimeCalls[0].assignmentId, "assignment-1");
    assert.equal(harness.runtimeCalls[0].networkActualCommission, 100);
    assert.equal(harness.runtimeCalls[0].provisionalAllowed, false);

    const data = harness.getCreatedData();
    assert.equal(data.commissionRuleId, "rule-specific");
    assert.equal(Number(data.supplierReceivable), 100);
    assert.equal(Number(data.clientPayable), 70);
    assert.equal(Number(data.mboMargin), 30);
    assert.equal(data.calculationMetadata.engine, "ClientCommercialRuntimeService");
    assert.equal(data.calculationMetadata.deterministicRuleSelection, true);
  });

  it("does not persist provisional client-commercial calculations", async () => {
    const harness = createHarness({
      runtimeResult: {
        status: "PROVISIONAL",
        reason: "network_actual_commission_not_yet_available",
        matchedClientCommissionRuleId: "rule-1",
        clientPayable: 70,
        mboMargin: null,
        provisional: true,
        payable: false,
      },
    });

    const result = await harness.service.recognizeConversion({ conversionId: "conversion-1" });
    assert.equal(result.unresolved, true);
    assert.equal(harness.getCreatedData(), null);
    assert.equal(harness.exceptionRows.length, 1);
  });

  it("does not persist a blocked negative-margin calculation", async () => {
    const harness = createHarness({
      runtimeResult: {
        status: "BLOCKED_NEGATIVE_MARGIN",
        reason: "client_payable_exceeds_supplier_commission",
        matchedClientCommissionRuleId: "rule-1",
        clientPayable: 120,
        mboMargin: -20,
        provisional: false,
        payable: false,
      },
    });

    const result = await harness.service.recognizeConversion({ conversionId: "conversion-1" });
    assert.equal(result.unresolved, true);
    assert.equal(harness.getCreatedData(), null);
  });

  it("passes only approved item economics into runtime and recognition", async () => {
    const order = baseOrder({
      orderValue: "300.00",
      items: [
        {
          id: "item-approved",
          lineKey: "A",
          validationStatus: "VALIDATION_APPROVED",
          itemValue: "120.00",
          commission: "40.00",
        },
        {
          id: "item-rejected",
          lineKey: "B",
          validationStatus: "VALIDATION_REJECTED",
          itemValue: "180.00",
          commission: "60.00",
        },
      ],
    });
    const conversion = baseConversion(order, { approvedCommission: "100.00", supplierCommission: "100.00" });
    const harness = createHarness({
      order,
      conversion,
      runtimeResult: {
        status: "CALCULATED",
        reason: "non_negative_margin",
        matchedClientCommissionRuleId: "rule-item",
        matchedRuleSnapshot: { id: "rule-item", assignmentId: "assignment-1", commissionType: "PERCENT" },
        ruleKind: "PERCENT",
        ruleSelectionStatus: "MATCHED",
        clientPayable: 30,
        mboMargin: 10,
        payoutBasis: "NETWORK_ACTUAL_COMMISSION",
        provisional: false,
        payable: false,
        marginProtection: { status: "ALLOWED", margin: 10 },
        facts: {},
      },
    });

    const result = await harness.service.recognizeConversion({ conversionId: "conversion-1" });
    assert.equal(result.created, true);
    assert.equal(harness.runtimeCalls[0].networkActualCommission, 40);
    assert.equal(harness.runtimeCalls[0].factOverrides.orderValue, 120);
    assert.equal(Number(harness.getCreatedData().supplierReceivable), 40);
  });
});
