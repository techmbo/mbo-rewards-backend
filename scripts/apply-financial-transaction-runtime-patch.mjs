import fs from "node:fs";

const financePath = "src/modules/finance/financialTransaction.service.js";
let source = fs.readFileSync(financePath, "utf8");

source = source.replace(
  'import { CommissionRuleRepository } from "../commercial/repositories/commercial.repository.js";\n',
  'import { ClientCommercialRuntimeService } from "../commercial/services/clientCommercialRuntime.service.js";\n',
);
source = source.replace(
  'import { calculateCommission, netFinancialPosition } from "./commissionCalculation.service.js";',
  'import { netFinancialPosition } from "./commissionCalculation.service.js";',
);

if (!source.includes("export function resolveFinancialAttribution")) {
  const anchor = `export function lateRejectionAdjustmentKey(conversionId) {
  return \`LATE_REJECTION:\${conversionId}\`;
}
`;
  const helpers = `${anchor}
function finiteNumber(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function resolveFinancialAttribution(order = {}, conversion = {}) {
  const orderAssignmentId = order?.clientAssignmentId ?? null;
  const conversionAssignmentId = conversion?.clientAssignmentId ?? null;
  const orderClientId = order?.clientId ?? null;
  const conversionClientId = conversion?.clientAssignment?.clientId ?? null;

  if (orderAssignmentId && conversionAssignmentId && orderAssignmentId !== conversionAssignmentId) {
    return {
      resolved: false,
      reason: "assignment_attribution_conflict",
      assignmentId: null,
      orderAssignmentId,
      conversionAssignmentId,
    };
  }
  if (orderClientId && conversionClientId && orderClientId !== conversionClientId) {
    return {
      resolved: false,
      reason: "client_attribution_conflict",
      assignmentId: null,
      orderAssignmentId,
      conversionAssignmentId,
    };
  }

  const assignmentId = orderAssignmentId || conversionAssignmentId || null;
  return {
    resolved: Boolean(assignmentId),
    reason: assignmentId ? "resolved" : "missing_assignment",
    assignmentId,
    orderAssignmentId,
    conversionAssignmentId,
  };
}

export function resolveValidatedNetworkActualCommission({ approvedBasis = null, conversion = null } = {}) {
  const itemLevel = approvedBasis?.basisMode === "ITEM_LEVEL";
  const raw = itemLevel
    ? approvedBasis?.approvedSupplierCommissionOk
      ? approvedBasis.approvedSupplierCommission
      : null
    : conversion?.approvedCommission != null && conversion.approvedCommission !== ""
      ? conversion.approvedCommission
      : conversion?.supplierCommission;
  const amount = finiteNumber(raw);
  if (amount == null) {
    return {
      ok: false,
      reason: itemLevel ? "missing_approved_item_supplier_commission" : "missing_network_actual_commission",
      amount: null,
      currency: approvedBasis?.currency ?? conversion?.currency ?? null,
    };
  }
  if (amount < 0) {
    return {
      ok: false,
      reason: "negative_network_actual_commission",
      amount: null,
      currency: approvedBasis?.currency ?? conversion?.currency ?? null,
    };
  }
  return {
    ok: true,
    amount,
    currency: approvedBasis?.currency ?? conversion?.currency ?? null,
    source: itemLevel
      ? "sum_approved_order_item_commission"
      : conversion?.approvedCommission != null && conversion.approvedCommission !== ""
        ? "conversion.approvedCommission"
        : "conversion.supplierCommission",
  };
}
`;
  if (!source.includes(anchor)) throw new Error("Could not find lateRejectionAdjustmentKey anchor.");
  source = source.replace(anchor, helpers);
}

source = source.replace(
  `    this.commissionRepo = deps.commissionRepo ?? new CommissionRuleRepository();
    this.calculate = deps.calculate ?? calculateCommission;
    this.supplierCommissionRules = deps.supplierCommissionRules ?? null;`,
  `    this.clientCommercialRuntime =
      deps.clientCommercialRuntime ??
      new ClientCommercialRuntimeService({ commissionRepo: deps.commissionRepo });`,
);

const startMarker = `    const assignmentId = order.clientAssignmentId || conversion.clientAssignmentId;`;
const endMarker = `    const clientRecord = conversion.clientAssignment?.client ||`;
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);
if (start < 0 || end < 0) {
  throw new Error("Could not locate legacy financial commission resolution block.");
}

const replacement = `    const attribution = resolveFinancialAttribution(order, conversion);
    if (!attribution.resolved) {
      await this.exceptions.report({
        type: "COMMISSION_MISSING",
        severity: "HIGH",
        conversionId,
        orderId: order.id,
        clientId,
        reason: attribution.reason,
        metadata: {
          orderAssignmentId: attribution.orderAssignmentId,
          conversionAssignmentId: attribution.conversionAssignmentId,
        },
      }, db);
      return {
        record: null,
        created: false,
        unresolved: true,
        reason: attribution.reason,
      };
    }
    const assignmentId = attribution.assignmentId;
    const transactionAt = conversion.conversionDate || order.orderDate || new Date();
    const approvedBasis = resolveApprovedCommercialBasis(order, conversion);
    const networkActual = resolveValidatedNetworkActualCommission({ approvedBasis, conversion });

    if (!networkActual.ok) {
      await this.exceptions.report({
        type: "COMMISSION_INVALID",
        severity: "HIGH",
        conversionId,
        orderId: order.id,
        clientId,
        reason: networkActual.reason,
        metadata: { approvedBasis },
      }, db);
      return {
        record: null,
        created: false,
        unresolved: true,
        reason: networkActual.reason,
        approvedBasis,
      };
    }

    const originalCurrency =
      networkActual.currency || conversion.currency || order.currency || approvedBasis.currency || null;
    if (!originalCurrency) {
      await this.exceptions.report({
        type: "INVALID_CURRENCY",
        severity: "HIGH",
        conversionId,
        orderId: order.id,
        clientId,
        reason: "Missing original currency on conversion/order",
      }, db);
      return { record: null, created: false, unresolved: true, reason: "missing_currency" };
    }

    const factOverrides = { date: transactionAt };
    if (approvedBasis.basisMode === "ITEM_LEVEL" && approvedBasis.approvedOrderValueOk) {
      factOverrides.orderValue = approvedBasis.approvedOrderValue;
    }
    const campaignFact =
      order.canonicalCampaignId ||
      conversion.clientAssignment?.canonicalCampaignId ||
      null;
    if (campaignFact) factOverrides.campaign = campaignFact;

    const runtime = await this.clientCommercialRuntime.evaluate(
      {
        assignmentId,
        attributionResolved: true,
        attributionStatus: "RESOLVED",
        order,
        conversion,
        assignment:
          conversion.clientAssignment?.id === assignmentId
            ? conversion.clientAssignment
            : null,
        factOverrides,
        networkActualCommission: networkActual.amount,
        networkActualCurrency: originalCurrency,
        validatedSupplierCommission: networkActual.amount,
        provisionalAllowed: false,
        orderCount: 1,
        requireAgreementLineage: true,
      },
      db,
    );

    if (runtime.status !== "CALCULATED" || runtime.provisional === true) {
      const exceptionType = String(runtime.reason || "").includes("currency")
        ? "INVALID_CURRENCY"
        : runtime.status === "NO_MATCH"
          ? "COMMISSION_MISSING"
          : "COMMISSION_INVALID";
      await this.exceptions.report({
        type: exceptionType,
        severity: "HIGH",
        conversionId,
        orderId: order.id,
        clientId,
        reason: runtime.reason || runtime.status || "client_commercial_runtime_unresolved",
        metadata: {
          runtimeStatus: runtime.status,
          ruleSelectionStatus: runtime.ruleSelectionStatus ?? null,
          matchedClientCommissionRuleId: runtime.matchedClientCommissionRuleId ?? null,
          payoutBasis: runtime.payoutBasis ?? null,
          marginProtection: runtime.marginProtection ?? null,
          approvedBasis,
        },
      }, db);
      return {
        record: null,
        created: false,
        unresolved: true,
        reason: runtime.reason || runtime.status,
        approvedBasis,
      };
    }

    const calc = {
      supplierGross: networkActual.amount,
      clientCommission: runtime.clientPayable,
      mboMargin: runtime.mboMargin,
      currency: originalCurrency,
      ruleId: runtime.matchedClientCommissionRuleId,
      ruleSnapshot: runtime.matchedRuleSnapshot ?? {
        id: runtime.matchedClientCommissionRuleId,
        assignmentId,
      },
      calculationMetadata: {
        engine: "ClientCommercialRuntimeService",
        deterministicRuleSelection: true,
        ruleSelectionStatus: runtime.ruleSelectionStatus,
        payoutBasis: runtime.payoutBasis,
        provisional: false,
        marginProtection: runtime.marginProtection,
        tierSelection: runtime.tierSelection,
        lineage: runtime.lineage,
        facts: runtime.facts,
        networkActualCommissionSource: networkActual.source,
        approvedBasis,
      },
      displayCommission: runtime.displayCommission ?? null,
      ruleKind: runtime.ruleKind ?? runtime.matchedRuleSnapshot?.commissionType ?? null,
    };

`;
source = source.slice(0, start) + replacement + source.slice(end);

fs.writeFileSync(financePath, source);

const runtimePath = "src/modules/commercial/services/clientCommercialRuntime.service.js";
let runtimeSource = fs.readFileSync(runtimePath, "utf8");

if (!runtimeSource.includes("function snapshotClientCommercialRule")) {
  runtimeSource = runtimeSource.replace(
    `function transactionDate({ order = null, conversion = null, overrides = {} } = {}) {
  return firstDefined(overrides.date, order?.orderDate, conversion?.conversionDate, new Date());
}
`,
    `function transactionDate({ order = null, conversion = null, overrides = {} } = {}) {
  return firstDefined(overrides.date, order?.orderDate, conversion?.conversionDate, new Date());
}

function jsonSafe(value) {
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === "object") {
    if (typeof value.toJSON === "function") return jsonSafe(value.toJSON());
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]),
    );
  }
  return value;
}

function snapshotClientCommercialRule(rule = {}) {
  const keys = [
    "id",
    "assignmentId",
    "commissionType",
    "grossCommission",
    "clientCommission",
    "mboCommission",
    "currency",
    "orderValuePercent",
    "fixedAmount",
    "manualAmount",
    "manualApproved",
    "manualApprovedAt",
    "manualApprovedBy",
    "displayRangeMin",
    "displayRangeMax",
    "displayLabel",
    "priority",
    "priorityVerified",
    "agreementRef",
    "agreementApprovedAt",
    "agreementApprovedBy",
    "subsidyApproved",
    "subsidyApprovalRef",
    "subsidyApprovedAt",
    "subsidyApprovedBy",
    "tierMetric",
    "tierPeriod",
    "effectiveFrom",
    "effectiveUntil",
    "status",
    "conditions",
    "tiers",
  ];
  return Object.fromEntries(
    keys.filter((key) => rule[key] !== undefined).map((key) => [key, jsonSafe(rule[key])]),
  );
}
`,
  );
}

runtimeSource = runtimeSource.replace(
  `      matchedClientCommissionRuleId: match.matchedClientCommissionRuleId,
      ruleSelectionStatus: match.status,`,
  `      matchedClientCommissionRuleId: match.matchedClientCommissionRuleId,
      matchedRuleSnapshot: snapshotClientCommercialRule(rule),
      ruleKind: rule.commissionType ?? null,
      displayCommission:
        String(rule.commissionType || "").toUpperCase() === "DISPLAY_RANGE_WITH_ACTUAL_SPLIT"
          ? {
              displayRangeMin: rule.displayRangeMin ?? null,
              displayRangeMax: rule.displayRangeMax ?? null,
              displayLabel: rule.displayLabel ?? null,
              financialBasis: calculation.payoutBasis ?? null,
            }
          : null,
      ruleSelectionStatus: match.status,`,
);

fs.writeFileSync(runtimePath, runtimeSource);
console.log("Financial transaction recognition now uses deterministic client commercial runtime.");
