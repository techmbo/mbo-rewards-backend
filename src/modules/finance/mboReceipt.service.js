import { prisma } from "../../database/prisma.js";
import { fail } from "../../core/apiResponse.js";
import { auditService } from "../../platform/audit/audit.service.js";
import { PaymentStateService, CLIENT_FINANCE_GATED_STATUSES } from "../order/paymentState.service.js";
import { ReconciliationService } from "./reconciliation.service.js";
import { ExceptionCaseService } from "../order/exceptionCase.service.js";
import { extractMboActualReceipt, isNetworkPaymentEvidenceOnly } from "./financeSeparation.contract.js";
import {
  SERIALIZABLE_MONEY_TX_OPTIONS,
  isSerializationConflict,
  normalizeCurrency,
} from "./clientBalance.service.js";

/**
 * Admin finance action: record an ACTUAL MBO bank/reconciliation receipt for one order, then
 * attempt the existing client-payable transition.
 *
 * This is not supplier PAYMENT_RECEIVED (a network-side ledger fact). It is the MBO_ACTUAL_RECEIPT
 * event of the finance separation contract, entered by an ADMIN from bank evidence.
 *
 * Persistence: canonical receipt keys on Order.metadata — the exact keys the existing contract
 * (financeSeparation.extractMboActualReceipt) already reads — plus who recorded it and when.
 * Unrelated metadata is preserved. Callers cannot supply arbitrary metadata: the input is a
 * closed set of fields and the provenance (mboReceiptSource = BANK_RECONCILIATION) is set here.
 *
 * Transaction: one SERIALIZABLE interactive transaction covers read order → validate →
 * write receipt → attempt PaymentStateService.transitionClientPayment(PAYABLE). A business
 * refusal of the transition (409 — reconciliation mismatch, missing evidence) does NOT roll the
 * receipt back: the bank fact is real and stays recorded, the order keeps its client payment
 * status, and the existing reconciliation exceptions are reported. Any other error rolls the
 * whole operation back. Concurrent recordings of the same order conflict under SERIALIZABLE and
 * are retried a bounded number of times; the retry re-reads the order and sees the winner.
 *
 * Audit: the audit store writes on its own connection, not the transaction. Every audit event
 * raised during an attempt (the state machine's order.client_payment.changed, exception-case
 * audits) is buffered per attempt and written only after that attempt commits; a rolled-back or
 * retried attempt discards its buffer, so no audit row describes a write that did not commit.
 *
 * Idempotency: the same (orderId, receivedAt, amount, currency, bankReference) is a replay — no
 * metadata write, no audit, no duplicate transition. A different receipt for an order that
 * already carries receipt evidence is refused with 409: receipt evidence is never overwritten.
 */

export const MBO_RECEIPT_SOURCE = "BANK_RECONCILIATION";
export const MBO_RECEIPT_TARGET_STATUS = "CLIENT_PAYMENT_PAYABLE";

const RECEIPT_SERIALIZATION_RETRIES = 3;
const ALLOWED_INPUT_KEYS = new Set([
  "receivedAt",
  "amount",
  "currency",
  "bankReference",
  "reconciliationReference",
  "note",
  "clientId",
]);
/** Receipt keys the finance contract reads; any of them present means receipt evidence exists. */
const RECEIPT_DATE_KEYS = ["mboReceivedDateTime", "mbo_received_date_time", "bankReceivedAt", "bank_received_at"];
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const AMOUNT_PATTERN = /^\d+(\.\d{1,4})?$/;

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function amount4(value) {
  return Number(value).toFixed(4);
}

/**
 * Validate and normalise admin input. Throws 400 on anything malformed; never guesses.
 * @returns {{ receivedAt: string, amount: string, currency: string, bankReference: string,
 *   reconciliationReference: string|null, note: string|null, clientId: string|null }}
 */
export function parseMboReceiptInput(body = {}, { now = new Date() } = {}) {
  const input = asObject(body);
  const unknown = Object.keys(input).filter((key) => !ALLOWED_INPUT_KEYS.has(key));
  if (unknown.length) throw fail(`Unsupported receipt field(s): ${unknown.join(", ")}.`, 400);

  const received = input.receivedAt == null || input.receivedAt === "" ? null : new Date(input.receivedAt);
  if (!received || Number.isNaN(received.getTime())) throw fail("receivedAt must be a valid date-time.", 400);
  if (received.getTime() - now.getTime() > MAX_FUTURE_SKEW_MS) throw fail("receivedAt cannot be in the future.", 400);

  const rawAmount = input.amount == null ? "" : String(input.amount).trim();
  if (!AMOUNT_PATTERN.test(rawAmount) || !(Number(rawAmount) > 0)) {
    throw fail("amount must be a positive number with at most 4 decimal places.", 400);
  }

  const currency = normalizeCurrency(input.currency);
  if (!currency) throw fail("currency must be a 3-letter ISO code.", 400);

  const bankReference = typeof input.bankReference === "string" ? input.bankReference.trim() : "";
  if (!bankReference) throw fail("bankReference is required.", 400);
  if (bankReference.length > 128) throw fail("bankReference is too long.", 400);
  // A network status token is evidence that the network paid, not a bank reference for MBO.
  if (isNetworkPaymentEvidenceOnly(bankReference)) {
    throw fail("bankReference must identify the bank transfer, not a network payment status.", 400);
  }

  const reconciliationReference =
    input.reconciliationReference == null || String(input.reconciliationReference).trim() === ""
      ? null
      : String(input.reconciliationReference).trim().slice(0, 128);
  const note = input.note == null || String(input.note).trim() === "" ? null : String(input.note).trim().slice(0, 500);
  const clientId = input.clientId == null || input.clientId === "" ? null : String(input.clientId);

  return {
    receivedAt: received.toISOString(),
    amount: amount4(rawAmount),
    currency,
    bankReference,
    reconciliationReference,
    note,
    clientId,
  };
}

function receiptKey(r) {
  return [r.receivedAt, r.amount, r.currency, r.bankReference].join("|");
}

/** The receipt already on the order, in the same normal form as parsed input, or null. */
function existingReceipt(order, financialTransactions) {
  const meta = asObject(order?.metadata);
  const extracted = extractMboActualReceipt({ order, financialTransactions });
  const hasDateKey = RECEIPT_DATE_KEYS.some((key) => meta[key] != null && meta[key] !== "");
  if (!extracted && !hasDateKey) return null;
  if (!extracted) return { unverifiable: true };
  const amount = extracted.amount == null || extracted.amount === "" ? null : amount4(extracted.amount);
  const currency = normalizeCurrency(meta.mboReceivedCurrency ?? extracted.currency);
  return {
    receivedAt: extracted.dateTime,
    amount,
    currency,
    bankReference: extracted.bankReference == null ? null : String(extracted.bankReference),
    source: extracted.source ?? null,
  };
}

/** Ledger currency of the order: FT original currencies must agree with each other and the order. */
function ledgerCurrency(order, financialTransactions) {
  const set = new Set(
    (financialTransactions || []).map((ft) => normalizeCurrency(ft.originalCurrency)).filter(Boolean),
  );
  const orderCurrency = normalizeCurrency(order?.currency);
  if (set.size > 1) throw fail("Order ledger carries more than one currency; reconcile manually.", 409);
  const ftCurrency = set.size === 1 ? [...set][0] : null;
  if (ftCurrency && orderCurrency && ftCurrency !== orderCurrency) {
    throw fail("Order currency and ledger currency disagree; reconcile manually.", 409);
  }
  return ftCurrency ?? orderCurrency ?? null;
}

export class MboReceiptService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.audit = deps.audit ?? auditService;
    // Built per attempt around that attempt's deferred audit buffer (see recordReceipt).
    this.paymentStateFor =
      deps.paymentStateFor ??
      ((audit) =>
        new PaymentStateService({
          prisma: this.db,
          audit,
          exceptions: new ExceptionCaseService({ prisma: this.db, audit }),
        }));
    this.reconciliationFor =
      deps.reconciliationFor ??
      ((audit) =>
        new ReconciliationService({ prisma: this.db, exceptions: new ExceptionCaseService({ prisma: this.db, audit }) }));
    this.runInTransaction =
      deps.runInTransaction ??
      (typeof this.db?.$transaction === "function"
        ? (fn, options) => this.db.$transaction(fn, options)
        : (fn) => fn(this.db));
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * @param {string} orderId
   * @param {object} body  closed input: receivedAt, amount, currency, bankReference,
   *                       reconciliationReference?, note?, clientId?
   * @param {{ actorId: string }} actor  authenticated ADMIN user id
   */
  async recordReceipt(orderId, body, { actorId } = {}) {
    if (!orderId) throw fail("orderId is required.", 400);
    if (!actorId) throw fail("An authenticated admin actor is required.", 401);
    const input = parseMboReceiptInput(body, { now: this.now() });

    let attempts = 0;
    for (;;) {
      // Fresh buffer per attempt: a rolled-back attempt's events are dropped with it.
      const deferredAudits = [];
      const attemptAudit = { record: async (event) => { deferredAudits.push(event); } };
      try {
        const outcome = await this.runInTransaction(
          (tx) =>
            this.#recordInTransaction(tx, orderId, input, actorId, {
              paymentState: this.paymentStateFor(attemptAudit),
              reconciliation: this.reconciliationFor(attemptAudit),
            }),
          SERIALIZABLE_MONEY_TX_OPTIONS,
        );
        // Committed: flush the attempt's events (best-effort, like the services that raised them).
        for (const event of deferredAudits) {
          try {
            await this.audit.record(event);
          } catch {
            // audit best-effort
          }
        }
        let auditRecorded = null;
        if (outcome.recorded) {
          // After commit only: a rolled-back attempt must never leave an audit event behind.
          // The receipt is already committed, so an audit-store failure is reported in the
          // response (auditRecorded: false) instead of failing a request whose money fact stands.
          auditRecorded = true;
          try {
            await this.audit.record({
            aggregateType: "Order",
            aggregateId: orderId,
            action: "order.mbo_receipt.recorded",
            actorId,
            after: {
              orderId,
              clientId: outcome.clientId,
              receivedAt: input.receivedAt,
              amount: input.amount,
              currency: input.currency,
              bankReference: input.bankReference,
              reconciliationReference: input.reconciliationReference,
              source: MBO_RECEIPT_SOURCE,
              clientPaymentStatus: outcome.clientPaymentStatus,
              eligible: outcome.eligibility.eligible,
            },
            reason: input.note ?? undefined,
            });
          } catch {
            auditRecorded = false;
          }
        }
        return {
          orderId,
          clientId: outcome.clientId,
          replayed: !outcome.recorded,
          receipt: {
            receivedAt: input.receivedAt,
            amount: input.amount,
            currency: input.currency,
            bankReference: input.bankReference,
            reconciliationReference: input.reconciliationReference,
            source: MBO_RECEIPT_SOURCE,
          },
          clientPaymentStatus: outcome.clientPaymentStatus,
          eligibility: outcome.eligibility,
          auditRecorded,
        };
      } catch (error) {
        if (isSerializationConflict(error) && attempts < RECEIPT_SERIALIZATION_RETRIES) {
          attempts += 1;
          continue;
        }
        throw error;
      }
    }
  }

  async #recordInTransaction(tx, orderId, input, actorId, { paymentState, reconciliation }) {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) throw fail("Order not found.", 404);
    if (input.clientId && order.clientId !== input.clientId) throw fail("Order not found.", 404);
    if (!order.clientId) throw fail("Order has no client; receipt cannot release client payable.", 409);
    if (order.validationStatus !== "VALIDATION_APPROVED") {
      throw fail("Receipt can only be recorded for a VALIDATION_APPROVED order.", 409);
    }
    if (String(order.supplierPaymentStatus || "").toUpperCase() !== "PAYMENT_RECEIVED") {
      throw fail("Supplier payment must be PAYMENT_RECEIVED before an MBO receipt is recorded.", 409);
    }

    const financialTransactions = await tx.financialTransaction.findMany({
      where: { orderId },
      select: { id: true, originalCurrency: true, metadata: true, calculationMetadata: true },
    });
    const currency = ledgerCurrency(order, financialTransactions);
    if (!currency) throw fail("Order ledger currency is unknown; receipt currency cannot be verified.", 409);
    if (currency !== input.currency) {
      throw fail(`Receipt currency ${input.currency} does not match the order ledger currency ${currency}.`, 409);
    }

    const existing = existingReceipt(order, financialTransactions);
    let recorded = false;
    if (existing) {
      if (existing.unverifiable) {
        throw fail("Order already carries receipt data without bank provenance; reconcile manually.", 409);
      }
      if (receiptKey(existing) !== receiptKey(input)) {
        throw fail("A different MBO receipt is already recorded for this order; receipt evidence is not overwritten.", 409);
      }
    } else {
      const metadata = {
        ...asObject(order.metadata),
        mboReceivedDateTime: input.receivedAt,
        mboReceivedAmount: input.amount,
        mboReceivedCurrency: input.currency,
        mboReceiptSource: MBO_RECEIPT_SOURCE,
        bankReference: input.bankReference,
        ...(input.reconciliationReference ? { reconciliationReference: input.reconciliationReference } : {}),
        mboReceiptRecordedBy: actorId,
        mboReceiptRecordedAt: this.now().toISOString(),
        ...(input.note ? { mboReceiptNote: input.note } : {}),
      };
      await tx.order.update({ where: { id: orderId }, data: { metadata } });
      recorded = true;
    }

    // Already payable (or later): the receipt is a replay or a late record; never re-transition.
    if (CLIENT_FINANCE_GATED_STATUSES.has(order.clientPaymentStatus)) {
      return {
        recorded,
        clientId: order.clientId,
        clientPaymentStatus: order.clientPaymentStatus,
        eligibility: { eligible: true, reason: null, alreadyPayable: true },
      };
    }

    try {
      const updated = await paymentState.transitionClientPayment(
        orderId,
        MBO_RECEIPT_TARGET_STATUS,
        { reason: "mbo_receipt_recorded", actorId },
        tx,
      );
      return {
        recorded,
        clientId: order.clientId,
        clientPaymentStatus: updated.clientPaymentStatus,
        eligibility: { eligible: true, reason: null },
      };
    } catch (error) {
      // Only the state machine's business refusal is absorbed; the receipt stays recorded and the
      // refusal is returned and reported. Anything else (DB errors) aborts the transaction.
      if (error?.statusCode !== 409) throw error;
      const recon = await reconciliation.reconcileOrder(orderId, tx);
      return {
        recorded,
        clientId: order.clientId,
        clientPaymentStatus: order.clientPaymentStatus,
        eligibility: {
          eligible: false,
          reason: error.message,
          blockClientPayable: recon?.blockClientPayable ?? true,
          reconciliationChecks: recon?.checks ?? [],
        },
      };
    }
  }
}
