import fs from "node:fs";

function replaceRequired(source, from, to, label) {
  if (source.includes(to)) return source;
  if (!source.includes(from)) throw new Error(`Could not find ${label}`);
  return source.replace(from, to);
}

// 1. Reconciliation must sum signed immutable transaction deltas exactly once.
const reconciliationPath = "src/modules/finance/reconciliation.service.js";
let reconciliation = fs.readFileSync(reconciliationPath, "utf8");
reconciliation = replaceRequired(
  reconciliation,
  `    hasEvidence = true;\n    if (row?.transactionType === "REVERSAL") total -= value;\n    else total += value;`,
  `    // FinancialTransaction adjustment/reversal rows already carry signed deltas.\n    // Summing them directly avoids double-negating REVERSAL rows.\n    hasEvidence = true;\n    total += value;`,
  "signed financial reconciliation accumulation",
);
fs.writeFileSync(reconciliationPath, reconciliation);

// 2. Finance separation: no internal receivable fallback for bank receipt amount,
// invalid receipt dates fail closed, and payable eligibility requires reconciliation.
const separationPath = "src/modules/finance/financeSeparation.contract.js";
let separation = fs.readFileSync(separationPath, "utf8");
separation = replaceRequired(
  separation,
  `  const d = new Date(value);\n  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();`,
  `  const d = new Date(value);\n  return Number.isNaN(d.getTime()) ? null : d.toISOString();`,
  "invalid receipt date handling",
);
separation = replaceRequired(
  separation,
  `        amount: orderMeta.mboReceivedAmount ?? null,`,
  `        amount: firstPresent(\n          orderMeta.mboReceivedAmount,\n          orderMeta.mbo_received_amount,\n          orderMeta.bankReceivedAmount,\n          orderMeta.bank_received_amount,\n          orderMeta.reconciliationAmount,\n        ),`,
  "explicit order receipt amount",
);
separation = replaceRequired(
  separation,
  `          amount: ft.supplierReceivable ?? null,`,
  `          // Bank receipt amount must be explicit bank/reconciliation evidence.\n          // Never substitute the internal FinancialTransaction supplier receivable.\n          amount: firstPresent(\n            meta.mboReceivedAmount,\n            meta.mbo_received_amount,\n            meta.bankReceivedAmount,\n            meta.bank_received_amount,\n            meta.reconciliationAmount,\n            calc.mboReceivedAmount,\n            calc.mbo_received_amount,\n            calc.bankReceivedAmount,\n            calc.bank_received_amount,\n            calc.reconciliationAmount,\n          ),`,
  "explicit financial transaction receipt amount",
);
separation = replaceRequired(
  separation,
  `export function resolveFinanceEventStage({ order = null, financialTransactions = [] } = {}) {`,
  `export function resolveFinanceEventStage({\n  order = null,\n  financialTransactions = [],\n  reconciliationChecks = null,\n} = {}) {`,
  "finance stage reconciliation parameter",
);
separation = replaceRequired(
  separation,
  `  if (\n    networkPaymentEvidence ||\n    supplierPayment === "PAYMENT_RECEIVED" ||\n    supplierPayment === "PAYMENT_PAYABLE"\n  ) {\n    stages.push(FINANCE_EVENT.NETWORK_PAYMENT);\n  }`,
  `  if (networkPaymentEvidence || supplierPayment === "PAYMENT_RECEIVED") {\n    stages.push(FINANCE_EVENT.NETWORK_PAYMENT);\n  }`,
  "network payment stage semantics",
);
separation = replaceRequired(
  separation,
  `  if (resolveClientPayableEligibility({ order, financialTransactions }).eligible) {`,
  `  if (\n    resolveClientPayableEligibility({\n      order,\n      financialTransactions,\n      reconciliationChecks,\n    }).eligible\n  ) {`,
  "finance stage payable eligibility call",
);
separation = replaceRequired(
  separation,
  `  if (!hasMboActualReceipt({ order, financialTransactions })) {\n    return { eligible: false, reason: "MBO actual receipt required before client payable eligibility" };\n  }\n  if (reconciliationChecks?.length && shouldBlockClientPayableRelease(reconciliationChecks)) {`,
  `  if (!hasMboActualReceipt({ order, financialTransactions })) {\n    return { eligible: false, reason: "MBO actual receipt required before client payable eligibility" };\n  }\n  if (!Array.isArray(reconciliationChecks) || reconciliationChecks.length === 0) {\n    return { eligible: false, reason: "Reconciliation required before client payable eligibility" };\n  }\n  if (shouldBlockClientPayableRelease(reconciliationChecks)) {`,
  "strict payable reconciliation prerequisite",
);
fs.writeFileSync(separationPath, separation);

// 3. Blocking reconciliation pairs must actually MATCH; SKIPPED means evidence is absent.
const logicPath = "src/modules/finance/reconciliationLogic.contract.js";
let logic = fs.readFileSync(logicPath, "utf8");
logic = replaceRequired(
  logic,
  `export function shouldBlockClientPayableRelease(checks = []) {\n  return checks.some(\n    (check) =>\n      !check.ok &&\n      !check.skipped &&\n      check.material &&\n      CLIENT_PAYABLE_BLOCKING_PAIRS.has(check.pair),\n  );\n}`,
  `export function shouldBlockClientPayableRelease(checks = []) {\n  return checks.some(\n    (check) =>\n      CLIENT_PAYABLE_BLOCKING_PAIRS.has(check.pair) &&\n      check.status !== RECONCILIATION_STATUS.MATCHED,\n  );\n}`,
  "strict blocking reconciliation pairs",
);
fs.writeFileSync(logicPath, logic);

// 4. Every forward monetary client-payment state rechecks current finance truth.
const paymentPath = "src/modules/order/paymentState.service.js";
let payment = fs.readFileSync(paymentPath, "utf8");
if (!payment.includes("CLIENT_FINANCE_GATED_STATUSES")) {
  payment = payment.replace(
    `export const CLIENT_PAYMENT_TRANSITIONS = {`,
    `export const CLIENT_FINANCE_GATED_STATUSES = new Set([\n  "CLIENT_PAYMENT_PAYABLE",\n  "CLIENT_PAYMENT_INVOICED",\n  "CLIENT_PAYMENT_PROCESSING",\n  "CLIENT_PAYMENT_PAID",\n]);\n\nexport const CLIENT_PAYMENT_TRANSITIONS = {`,
  );
}
payment = replaceRequired(
  payment,
  `    if (toStatus === "CLIENT_PAYMENT_PAYABLE") {`,
  `    if (CLIENT_FINANCE_GATED_STATUSES.has(toStatus)) {`,
  "client finance gated transition",
);
payment = payment.replace(
  `        throw fail("Client payment cannot become PAYABLE before order confirmation.", 409);`,
  `        throw fail("Client payment cannot advance before order confirmation.", 409);`,
);
payment = payment.replace(
  `        throw fail("Supplier payment must be PAYMENT_RECEIVED before client payment can become PAYABLE.", 409);`,
  `        throw fail("Supplier payment must be PAYMENT_RECEIVED before client payment can advance.", 409);`,
);
fs.writeFileSync(paymentPath, payment);

// 5. Item-basis corrections must use the same deterministic runtime as initial recognition.
const financialPath = "src/modules/finance/financialTransaction.service.js";
let financial = fs.readFileSync(financialPath, "utf8");
const legacyStart = `      const assignmentId = order.clientAssignmentId || conversion.clientAssignmentId;\n      const rule = assignmentId`;
const netMarker = `      const { net } = await this.netPositionForConversion(conversion.id, db);`;
if (financial.includes(legacyStart)) {
  const start = financial.indexOf(legacyStart);
  const end = financial.indexOf(netMarker, start);
  if (end < 0) throw new Error("Could not find item-basis net position marker");
  const runtimeBlock = `      const attribution = resolveFinancialAttribution(order, conversion);\n      if (!attribution.resolved) {\n        await this.exceptions.report(\n          {\n            type: "COMMISSION_MISSING",\n            severity: "HIGH",\n            conversionId: conversion.id,\n            orderId: order.id,\n            clientId: order.clientId,\n            reason: attribution.reason,\n            metadata: { scope: "item_basis_sync" },\n          },\n          db,\n        );\n        results.push({ conversionId: conversion.id, action: "unresolved", reason: attribution.reason });\n        continue;\n      }\n\n      const assignmentId = attribution.assignmentId;\n      const transactionAt = conversion.conversionDate || order.orderDate || new Date();\n      const approvedBasis = resolveApprovedCommercialBasis(order, conversion);\n      const networkActual = resolveValidatedNetworkActualCommission({ approvedBasis, conversion });\n      if (!networkActual.ok) {\n        await this.exceptions.report(\n          {\n            type: "COMMISSION_INVALID",\n            severity: "HIGH",\n            conversionId: conversion.id,\n            orderId: order.id,\n            clientId: order.clientId,\n            reason: networkActual.reason,\n            metadata: { approvedBasis, scope: "item_basis_sync" },\n          },\n          db,\n        );\n        results.push({\n          conversionId: conversion.id,\n          action: "unresolved",\n          reason: networkActual.reason,\n          approvedBasis,\n        });\n        continue;\n      }\n\n      const originalCurrency =\n        networkActual.currency || conversion.currency || order.currency || approvedBasis.currency || null;\n      if (!originalCurrency) {\n        results.push({ conversionId: conversion.id, action: "unresolved", reason: "missing_currency" });\n        continue;\n      }\n\n      const factOverrides = { date: transactionAt };\n      if (approvedBasis.basisMode === "ITEM_LEVEL" && approvedBasis.approvedOrderValueOk) {\n        factOverrides.orderValue = approvedBasis.approvedOrderValue;\n      }\n      const campaignFact =\n        order.canonicalCampaignId ||\n        conversion.clientAssignment?.canonicalCampaignId ||\n        null;\n      if (campaignFact) factOverrides.campaign = campaignFact;\n\n      const runtime = await this.clientCommercialRuntime.evaluate(\n        {\n          assignmentId,\n          attributionResolved: true,\n          attributionStatus: "RESOLVED",\n          order,\n          conversion,\n          assignment:\n            conversion.clientAssignment?.id === assignmentId\n              ? conversion.clientAssignment\n              : null,\n          factOverrides,\n          networkActualCommission: networkActual.amount,\n          networkActualCurrency: originalCurrency,\n          validatedSupplierCommission: networkActual.amount,\n          provisionalAllowed: false,\n          orderCount: 1,\n          requireAgreementLineage: true,\n        },\n        db,\n      );\n\n      if (runtime.status !== "CALCULATED" || runtime.provisional === true) {\n        await this.exceptions.report(\n          {\n            type: "COMMISSION_INVALID",\n            severity: "HIGH",\n            conversionId: conversion.id,\n            orderId: order.id,\n            clientId: order.clientId,\n            reason: runtime.reason || runtime.status || "client_commercial_runtime_unresolved",\n            metadata: {\n              scope: "item_basis_sync",\n              runtimeStatus: runtime.status,\n              matchedClientCommissionRuleId: runtime.matchedClientCommissionRuleId ?? null,\n              approvedBasis,\n            },\n          },\n          db,\n        );\n        results.push({\n          conversionId: conversion.id,\n          action: "unresolved",\n          reason: runtime.reason || runtime.status,\n          approvedBasis,\n        });\n        continue;\n      }\n\n      const calc = {\n        supplierGross: networkActual.amount,\n        clientCommission: runtime.clientPayable,\n        mboMargin: runtime.mboMargin,\n      };\n\n`;
  financial = financial.slice(0, start) + runtimeBlock + financial.slice(end);
}
if (financial.includes("this.commissionRepo.findEffectiveForAssignment") || financial.includes("this.calculate({")) {
  throw new Error("Legacy client commercial calculator still remains in FinancialTransactionService");
}
fs.writeFileSync(financialPath, financial);

console.log("Finance safety hardening patch applied.");
