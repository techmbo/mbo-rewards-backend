import { shouldBlockClientPayableRelease } from "./reconciliationLogic.contract.js";

/**
 * Pointer 17 — Finance separation contract.
 * Distinct events: Confirmed Order → Network Invoice → Network Payment →
 * MBO Actual Receipt → Client Payable Eligibility → Client Payment/Withdrawal.
 * Network payment tokens (PAID, AVAILABLE, etc.) are evidence only — never MBO bank receipt.
 */

export const FINANCE_EVENT = Object.freeze({
  CONFIRMED_ORDER: "CONFIRMED_ORDER",
  NETWORK_INVOICE: "NETWORK_INVOICE",
  NETWORK_PAYMENT: "NETWORK_PAYMENT",
  MBO_ACTUAL_RECEIPT: "MBO_ACTUAL_RECEIPT",
  CLIENT_PAYABLE_ELIGIBILITY: "CLIENT_PAYABLE_ELIGIBILITY",
  CLIENT_PAYMENT: "CLIENT_PAYMENT",
});

/** Network-side payment evidence — must not imply MBO bank receipt. */
export const NETWORK_PAYMENT_EVIDENCE = Object.freeze([
  "PAID",
  "AVAILABLE",
  "PAYMENT_SENT",
  "PAYMENT SENT",
  "WITHDRAWN",
  "INVOICED",
  "PAYABLE",
  "SETTLED",
  "RECEIVED",
]);

const BANK_RECEIPT_META_KEYS = Object.freeze([
  "mboReceivedDateTime",
  "mbo_received_date_time",
  "bankReceivedAt",
  "bank_received_at",
]);

const BANK_RECEIPT_SOURCE_KEYS = Object.freeze([
  "mboReceiptSource",
  "bankReference",
  "reconciliationId",
  "reconciliationReference",
]);

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeLookup(value) {
  if (value == null || value === "") return null;
  return String(value).trim().toUpperCase().replace(/\s+/g, "_");
}

export function isNetworkPaymentEvidenceOnly(raw) {
  const key = normalizeLookup(raw);
  if (!key) return false;
  return NETWORK_PAYMENT_EVIDENCE.some((token) => key === normalizeLookup(token));
}

export function shouldNotInferMboReceiptFromNetworkPayment({ networkPaymentStatus = null, supplierPaymentStatus = null } = {}) {
  if (isNetworkPaymentEvidenceOnly(networkPaymentStatus)) return true;
  // Supplier PAYMENT_RECEIVED from sync alone is network-side ledger — not bank receipt.
  if (String(supplierPaymentStatus || "").toUpperCase() === "PAYMENT_RECEIVED") return true;
  return false;
}

function firstPresent(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

function hasBankReceiptProvenance(meta = {}) {
  const bag = asObject(meta);
  const calc = asObject(bag.calculationMetadata);
  if (String(bag.mboReceiptSource || "").toUpperCase() === "BANK_RECONCILIATION") return true;
  if (String(bag.evidenceSource || "").toUpperCase().includes("BANK")) return true;
  for (const key of BANK_RECEIPT_SOURCE_KEYS) {
    if (bag[key] || calc[key]) return true;
  }
  return false;
}

function parseReceiptDateTime(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * MBO actual receipt — internal bank/reconciliation fact only.
 * Never derived from network payment status or supplierPaymentChangedAt.
 */
export function extractMboActualReceipt({ order = null, financialTransactions = [] } = {}) {
  const orderMeta = asObject(order?.metadata);
  for (const key of BANK_RECEIPT_META_KEYS) {
    const dateTime = parseReceiptDateTime(orderMeta[key]);
    if (dateTime && hasBankReceiptProvenance(orderMeta)) {
      return {
        dateTime,
        date: dateTime.slice(0, 10),
        time: dateTime.includes("T") ? dateTime.slice(11, 16) : null,
        amount: firstPresent(
          orderMeta.mboReceivedAmount,
          orderMeta.mbo_received_amount,
          orderMeta.bankReceivedAmount,
          orderMeta.bank_received_amount,
          orderMeta.reconciliationAmount,
        ),
        currency: orderMeta.mboReceivedCurrency ?? order?.currency ?? null,
        source: orderMeta.mboReceiptSource || "BANK_RECONCILIATION",
        bankReference: orderMeta.bankReference ?? orderMeta.reconciliationReference ?? null,
      };
    }
  }

  for (const ft of financialTransactions || []) {
    const meta = asObject(ft.metadata);
    const calc = asObject(ft.calculationMetadata);
    for (const key of BANK_RECEIPT_META_KEYS) {
      const dateTime = parseReceiptDateTime(meta[key] ?? calc[key]);
      if (dateTime && hasBankReceiptProvenance({ ...meta, ...calc })) {
        return {
          dateTime,
          date: dateTime.slice(0, 10),
          time: dateTime.includes("T") ? dateTime.slice(11, 16) : null,
          // Bank receipt amount must be explicit bank/reconciliation evidence.
          // Never substitute the internal FinancialTransaction supplier receivable.
          amount: firstPresent(
            meta.mboReceivedAmount,
            meta.mbo_received_amount,
            meta.bankReceivedAmount,
            meta.bank_received_amount,
            meta.reconciliationAmount,
            calc.mboReceivedAmount,
            calc.mbo_received_amount,
            calc.bankReceivedAmount,
            calc.bank_received_amount,
            calc.reconciliationAmount,
          ),
          currency: ft.originalCurrency ?? order?.currency ?? null,
          source: meta.mboReceiptSource || calc.mboReceiptSource || "FINANCIAL_TRANSACTION",
          bankReference: meta.bankReference ?? calc.bankReference ?? calc.reconciliationId ?? null,
          financialTransactionId: ft.id ?? null,
        };
      }
    }
  }

  return null;
}

export function hasMboActualReceipt(context = {}) {
  return extractMboActualReceipt(context) != null;
}

export function resolveFinanceEventStage({
  order = null,
  financialTransactions = [],
  reconciliationChecks = null,
} = {}) {
  const validation = String(order?.validationStatus || "").toUpperCase();
  const supplierPayment = String(order?.supplierPaymentStatus || "").toUpperCase();
  const clientPayment = String(order?.clientPaymentStatus || "").toUpperCase();
  const receipt = extractMboActualReceipt({ order, financialTransactions });
  const orderMeta = asObject(order?.metadata);
  const networkPaymentEvidence = orderMeta.networkPaymentEvidence ?? orderMeta.networkPaymentStatus ?? null;

  const stages = [];
  if (validation === "VALIDATION_APPROVED") stages.push(FINANCE_EVENT.CONFIRMED_ORDER);
  if (supplierPayment === "PAYMENT_INVOICED" || supplierPayment === "PAYMENT_PAYABLE") {
    stages.push(FINANCE_EVENT.NETWORK_INVOICE);
  }
  if (networkPaymentEvidence || supplierPayment === "PAYMENT_RECEIVED") {
    stages.push(FINANCE_EVENT.NETWORK_PAYMENT);
  }
  if (receipt) stages.push(FINANCE_EVENT.MBO_ACTUAL_RECEIPT);
  if (
    resolveClientPayableEligibility({
      order,
      financialTransactions,
      reconciliationChecks,
    }).eligible
  ) {
    stages.push(FINANCE_EVENT.CLIENT_PAYABLE_ELIGIBILITY);
  }
  if (
    clientPayment === "CLIENT_PAYMENT_PAID" ||
    clientPayment === "CLIENT_PAYMENT_PROCESSING" ||
    clientPayment === "CLIENT_PAYMENT_INVOICED"
  ) {
    stages.push(FINANCE_EVENT.CLIENT_PAYMENT);
  }

  return stages;
}

export function resolveClientPayableEligibility({
  order = null,
  financialTransactions = [],
  reconciliationChecks = null,
} = {}) {
  const validation = String(order?.validationStatus || "").toUpperCase();
  if (validation !== "VALIDATION_APPROVED") {
    return { eligible: false, reason: "Order not confirmed" };
  }
  if (!hasMboActualReceipt({ order, financialTransactions })) {
    return { eligible: false, reason: "MBO actual receipt required before client payable eligibility" };
  }
  if (!Array.isArray(reconciliationChecks) || reconciliationChecks.length === 0) {
    return { eligible: false, reason: "Reconciliation required before client payable eligibility" };
  }
  if (shouldBlockClientPayableRelease(reconciliationChecks)) {
    const blocking = reconciliationChecks.find((c) => !c.ok && !c.skipped && c.material);
    return {
      eligible: false,
      reason: blocking?.mismatchReason
        ? `Reconciliation mismatch blocks client payable: ${blocking.mismatchReason}`
        : "Reconciliation mismatch blocks client payable release",
    };
  }
  return { eligible: true, reason: null };
}

export function buildNetworkPaymentEvidenceMetadata(existing = {}, rawNetworkPaymentStatus = null) {
  const base = asObject(existing);
  if (rawNetworkPaymentStatus == null || rawNetworkPaymentStatus === "") return base;
  return {
    ...base,
    networkPaymentEvidence: String(rawNetworkPaymentStatus),
    networkPaymentStatus: String(rawNetworkPaymentStatus),
  };
}

export function formatMboReceivedDateTime(receipt = null) {
  if (!receipt?.dateTime) return null;
  const date = receipt.date || String(receipt.dateTime).slice(0, 10);
  const time = receipt.time;
  return time ? `${date} ${time}` : date;
}
