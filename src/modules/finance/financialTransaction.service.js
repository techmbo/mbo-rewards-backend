import { prisma } from "../../database/prisma.js";
import { isPrismaUniqueViolation } from "../../core/prismaErrors.js";
import { fail } from "../../core/apiResponse.js";
import { auditService } from "../../platform/audit/audit.service.js";
import { ClientCommercialRuntimeService } from "../commercial/services/clientCommercialRuntime.service.js";
import { ExceptionCaseService } from "../order/exceptionCase.service.js";
import { ALERT_CONDITION } from "../ops/alertException.contract.js";
import {
  resolveApprovedCommercialBasis,
  approvedBasisFingerprint,
} from "../order/approvedCommercialBasis.js";
import { netFinancialPosition } from "./commissionCalculation.service.js";
import { FxService, resolveReportingCurrency } from "./fx.service.js";

export function earnRecognitionKey(conversionId) {
  return `earn:${conversionId}`;
}

export function reversalRecognitionKey(conversionId, adjustmentType = "LATE_REJECTION") {
  return `rev:${adjustmentType}:${conversionId}`;
}

export function adjustmentRecognitionKey(conversionId, adjustmentType, correctionKey = "1") {
  return `adj:${adjustmentType}:${conversionId}:${correctionKey}`;
}

export function lateRejectionAdjustmentKey(conversionId) {
  return `LATE_REJECTION:${conversionId}`;
}

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

/**
 * Wave D financial recognition — single entry point.
 * Creates immutable COMMISSION_EARNED rows; adjustments create new signed rows.
 */
export class FinancialTransactionService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.audit = deps.audit ?? auditService;
    this.exceptions = deps.exceptions ?? new ExceptionCaseService({ prisma: this.db, audit: this.audit });
    this.fx = deps.fx ?? new FxService({ prisma: this.db, exceptions: this.exceptions });
    this.clientCommercialRuntime =
      deps.clientCommercialRuntime ??
      new ClientCommercialRuntimeService({ commissionRepo: deps.commissionRepo });
  }

  async findByRecognitionKey(recognitionKey, client = null) {
    const db = client ?? this.db;
    if (!db?.financialTransaction?.findUnique) return null;
    return db.financialTransaction.findUnique({ where: { recognitionKey } });
  }

  /**
   * Tenant-scoped load — clients cannot read another tenant's FT.
   */
  async getForClient(id, clientId, client = null) {
    const db = client ?? this.db;
    const row = await db.financialTransaction.findFirst({
      where: { id, clientId },
    });
    if (!row) throw fail("Financial transaction not found.", 404);
    return row;
  }

  async listForClient(clientId, { skip = 0, take = 50 } = {}, client = null) {
    if (!clientId) throw fail("clientId is required.", 400);
    const db = client ?? this.db;
    const [rows, total] = await Promise.all([
      db.financialTransaction.findMany({
        where: { clientId },
        orderBy: { effectiveAt: "desc" },
        skip,
        take,
      }),
      db.financialTransaction.count({ where: { clientId } }),
    ]);
    return { rows, total };
  }

  async applyFxBundle({ amounts, originalCurrency, reportingCurrency, effectiveDate, persistedFx }, client) {
    if (!reportingCurrency || originalCurrency === reportingCurrency) {
      return {
        ok: true,
        reportingCurrency: originalCurrency,
        fxRate: "1",
        fxSource: "identity",
        fxDate: effectiveDate,
        reporting: {
          supplierReceivable: amounts.supplierGross,
          clientPayable: amounts.clientCommission,
          mboMargin: amounts.mboMargin,
        },
      };
    }

    const rate = persistedFx?.fxRate ?? null;
    const supplierFx = await this.fx.convert({
      amount: amounts.supplierGross,
      fromCurrency: originalCurrency,
      toCurrency: reportingCurrency,
      effectiveDate,
      persistedRate: rate,
    }, client);
    if (!supplierFx.ok) return supplierFx;

    const clientFx = await this.fx.convert({
      amount: amounts.clientCommission,
      fromCurrency: originalCurrency,
      toCurrency: reportingCurrency,
      effectiveDate,
      persistedRate: supplierFx.fxRate,
    }, client);
    const marginFx = await this.fx.convert({
      amount: amounts.mboMargin,
      fromCurrency: originalCurrency,
      toCurrency: reportingCurrency,
      effectiveDate,
      persistedRate: supplierFx.fxRate,
    }, client);

    if (!clientFx.ok || !marginFx.ok) {
      return { ok: false, reason: clientFx.reason || marginFx.reason || "fx_failed" };
    }

    return {
      ok: true,
      reportingCurrency,
      fxRate: supplierFx.fxRate,
      fxSource: supplierFx.fxSource,
      fxDate: supplierFx.fxDate,
      reporting: {
        supplierReceivable: supplierFx.reportingAmount,
        clientPayable: clientFx.reportingAmount,
        mboMargin: marginFx.reportingAmount,
      },
    };
  }

  /**
   * Recognize financial truth for an approved conversion/order.
   */
  async recognizeConversion({ orderId, conversionId }, client = null) {
    const db = client ?? this.db;
    if (!conversionId) throw fail("conversionId is required.", 400);

    const recognitionKey = earnRecognitionKey(conversionId);
    const existing = await this.findByRecognitionKey(recognitionKey, db);
    if (existing) {
      return { record: existing, created: false, reused: true };
    }

    const conversion = await db.conversion.findUnique({
      where: { id: conversionId },
      include: {
        order: { include: { items: true } },
        clientAssignment: { include: { client: true } },
      },
    });
    if (!conversion) throw fail("Conversion not found.", 404);

    let order = conversion.order;
    if (orderId && (!order || order.id !== orderId)) {
      order = await db.order.findUnique({
        where: { id: orderId },
        include: { items: true },
      });
    }
    if (!order && conversion.orderId) {
      order = await db.order.findUnique({
        where: { id: conversion.orderId },
        include: { items: true },
      });
    }
    if (order && !Array.isArray(order.items)) {
      if (typeof db.order?.findUnique === "function") {
        const reloaded = await db.order.findUnique({
          where: { id: order.id },
          include: { items: true },
        });
        if (reloaded) order = reloaded;
      }
      // Missing items array ⇒ treat as no item-level decisions (FULL_ORDER_LEGACY).
      if (!Array.isArray(order.items)) {
        order = { ...order, items: [] };
      }
    }

    if (!order || order.validationStatus !== "VALIDATION_APPROVED") {
      await this.exceptions.report({
        type: "COMMISSION_INVALID",
        severity: "MEDIUM",
        conversionId,
        orderId: order?.id ?? null,
        reason: "Financial recognition requires VALIDATION_APPROVED",
        metadata: { validationStatus: order?.validationStatus ?? null },
      }, db);
      return { record: null, created: false, unresolved: true, reason: "validation_not_approved" };
    }

    const clientId =
      order.clientId ||
      conversion.clientAssignment?.clientId ||
      null;
    if (!clientId) {
      await this.exceptions.report({
        type: "COMMISSION_MISSING",
        severity: "HIGH",
        conversionId,
        orderId: order.id,
        reason: "Missing clientId for financial recognition",
      }, db);
      return { record: null, created: false, unresolved: true, reason: "missing_client" };
    }

    const attribution = resolveFinancialAttribution(order, conversion);
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

    const clientRecord = conversion.clientAssignment?.client ||
      (await db.client.findUnique({ where: { id: clientId } }));

    const reporting = resolveReportingCurrency({
      country: clientRecord?.country || order.metadata?.country || null,
      region: order.metadata?.region || null,
      clientCurrency: clientRecord?.currency || null,
    });

    if (!reporting.ok) {
      await this.exceptions.report({
        type: "INVALID_CURRENCY",
        severity: "HIGH",
        conversionId,
        orderId: order.id,
        clientId,
        reason: reporting.reason,
      }, db);
      return { record: null, created: false, unresolved: true, reason: reporting.reason };
    }

    const fxBundle = await this.applyFxBundle(
      {
        amounts: {
          supplierGross: calc.supplierGross,
          clientCommission: calc.clientCommission,
          mboMargin: calc.mboMargin,
        },
        originalCurrency: calc.currency,
        reportingCurrency: reporting.currency,
        effectiveDate: conversion.conversionDate || order.orderDate || new Date(),
      },
      db,
    );

    if (!fxBundle.ok) {
      await this.exceptions.report({
        type: "MISSING_FX_RATE",
        severity: "HIGH",
        conversionId,
        orderId: order.id,
        clientId,
        reason: fxBundle.reason,
        metadata: { from: calc.currency, to: reporting.currency },
      }, db);
      return { record: null, created: false, unresolved: true, reason: fxBundle.reason };
    }

    const data = {
      recognitionKey,
      transactionType: "COMMISSION_EARNED",
      status: "FINANCIAL_RECOGNIZED",
      orderId: order.id,
      conversionId,
      clientId,
      supplier: conversion.supplier || order.supplier,
      campaignSourceId: order.campaignSourceId || conversion.campaignSourceId || null,
      commissionRuleId: calc.ruleId,
      supplierReceivable: calc.supplierGross,
      clientPayable: calc.clientCommission,
      mboMargin: calc.mboMargin,
      originalCurrency: calc.currency,
      reportingSupplierReceivable: fxBundle.reporting.supplierReceivable,
      reportingClientPayable: fxBundle.reporting.clientPayable,
      reportingMboMargin: fxBundle.reporting.mboMargin,
      reportingCurrency: fxBundle.reportingCurrency,
      fxRate: fxBundle.fxRate,
      fxDate: fxBundle.fxDate ? new Date(fxBundle.fxDate) : null,
      fxSource: fxBundle.fxSource,
      ruleSnapshot: calc.ruleSnapshot,
      calculationMetadata: calc.calculationMetadata,
      effectiveAt: conversion.conversionDate || new Date(),
      metadata: {
        reportingPolicy: reporting.reason,
        displayCommission: calc.displayCommission || null,
        ruleKind: calc.ruleKind || null,
        approvedBasisFingerprint: approvedBasisFingerprint(approvedBasis),
        basisMode: approvedBasis.basisMode,
      },
    };

    try {
      const record = await db.financialTransaction.create({ data });
      try {
        await this.audit.record({
          aggregateType: "FinancialTransaction",
          aggregateId: record.id,
          action: "FINANCIAL_RECOGNIZED",
          after: {
            recognitionKey,
            clientPayable: record.clientPayable,
            supplierReceivable: record.supplierReceivable,
            mboMargin: record.mboMargin,
          },
        });
      } catch {
        // ignore
      }

      // Align Wave C client payment readiness when payable recognized.
      if (db.order?.update && order.clientPaymentStatus === "CLIENT_PAYMENT_NOT_READY") {
        try {
          await db.order.update({
            where: { id: order.id },
            data: {
              // Not yet PAYABLE until supplier received (Wave C rule) — leave NOT_READY or set based on supplier.
              // Recognition alone does not mean CLIENT_PAYMENT_PAYABLE.
            },
          });
        } catch {
          // ignore
        }
      }

      return { record, created: true, reused: false };
    } catch (error) {
      if (isPrismaUniqueViolation(error)) {
        const raced = await this.findByRecognitionKey(recognitionKey, db);
        await this.exceptions.report({
          condition: ALERT_CONDITION.DUPLICATE_PAYMENT_IMPORT,
          type: "DUPLICATE_FINANCIAL_RECOGNITION",
          conversionId,
          orderId: order.id,
          clientId,
          reason: "Concurrent duplicate recognition recovered",
        }, db);
        return { record: raced, created: false, reused: true };
      }
      throw error;
    }
  }

  /**
   * Late rejection / correction — preserve original; create signed reversal/adjustment.
   */
  async createAdjustment({
    originalTransactionId,
    adjustmentType,
    reason,
    supplierReceivableDelta,
    clientPayableDelta,
    mboMarginDelta,
    correctionKey = "1",
    createdBy = "system",
    metadata = null,
  }, client = null) {
    const db = client ?? this.db;
    const original = await db.financialTransaction.findUnique({
      where: { id: originalTransactionId },
    });
    if (!original) throw fail("Original financial transaction not found.", 404);

    const adjustmentKey =
      adjustmentType === "LATE_REJECTION"
        ? lateRejectionAdjustmentKey(original.conversionId)
        : `${adjustmentType}:${original.conversionId}:${correctionKey}`;

    const existingAdj = await db.commissionAdjustment.findUnique({
      where: { adjustmentKey },
    });
    if (existingAdj) {
      const result = existingAdj.resultTransactionId
        ? await db.financialTransaction.findUnique({ where: { id: existingAdj.resultTransactionId } })
        : null;
      return { adjustment: existingAdj, resultTransaction: result, created: false, reused: true };
    }

    const recognitionKey =
      adjustmentType === "LATE_REJECTION"
        ? reversalRecognitionKey(original.conversionId, adjustmentType)
        : adjustmentRecognitionKey(original.conversionId, adjustmentType, correctionKey);

    const existingTxn = await this.findByRecognitionKey(recognitionKey, db);
    if (existingTxn) {
      return { adjustment: existingAdj, resultTransaction: existingTxn, created: false, reused: true };
    }

    // Reuse original FX for historical consistency.
    const fxBundle = await this.applyFxBundle(
      {
        amounts: {
          supplierGross: supplierReceivableDelta,
          clientCommission: clientPayableDelta,
          mboMargin: mboMarginDelta,
        },
        originalCurrency: original.originalCurrency,
        reportingCurrency: original.reportingCurrency || original.originalCurrency,
        effectiveDate: original.fxDate || original.effectiveAt,
        persistedFx: { fxRate: original.fxRate },
      },
      db,
    );

    if (!fxBundle.ok) {
      await this.exceptions.report({
        type: "MISSING_FX_RATE",
        severity: "HIGH",
        conversionId: original.conversionId,
        orderId: original.orderId,
        clientId: original.clientId,
        reason: fxBundle.reason,
      }, db);
      throw fail(`FX required for adjustment: ${fxBundle.reason}`, 409);
    }

    const txnType = adjustmentType === "LATE_REJECTION" ? "REVERSAL" : "ADJUSTMENT";

    const resultTransaction = await db.financialTransaction.create({
      data: {
        recognitionKey,
        transactionType: txnType,
        status: adjustmentType === "LATE_REJECTION" ? "FINANCIAL_REVERSED" : "FINANCIAL_ADJUSTED",
        orderId: original.orderId,
        conversionId: original.conversionId,
        clientId: original.clientId,
        supplier: original.supplier,
        campaignSourceId: original.campaignSourceId,
        commissionRuleId: original.commissionRuleId,
        relatedTransactionId: original.id,
        supplierReceivable: String(supplierReceivableDelta),
        clientPayable: String(clientPayableDelta),
        mboMargin: String(mboMarginDelta),
        originalCurrency: original.originalCurrency,
        reportingSupplierReceivable: fxBundle.reporting.supplierReceivable,
        reportingClientPayable: fxBundle.reporting.clientPayable,
        reportingMboMargin: fxBundle.reporting.mboMargin,
        reportingCurrency: fxBundle.reportingCurrency,
        fxRate: fxBundle.fxRate,
        fxDate: fxBundle.fxDate ? new Date(fxBundle.fxDate) : null,
        fxSource: fxBundle.fxSource,
        ruleSnapshot: original.ruleSnapshot,
        calculationMetadata: {
          adjustmentType,
          reason,
          originalRecognitionKey: original.recognitionKey,
        },
        effectiveAt: new Date(),
        metadata,
      },
    });

    const adjustment = await db.commissionAdjustment.create({
      data: {
        adjustmentKey,
        adjustmentType,
        reason: reason ?? null,
        originalTransactionId: original.id,
        resultTransactionId: resultTransaction.id,
        orderId: original.orderId,
        conversionId: original.conversionId,
        clientId: original.clientId,
        supplierReceivableDelta: String(supplierReceivableDelta),
        clientPayableDelta: String(clientPayableDelta),
        mboMarginDelta: String(mboMarginDelta),
        currency: original.originalCurrency,
        reportingCurrency: fxBundle.reportingCurrency,
        fxRate: fxBundle.fxRate,
        createdBy,
        metadata,
      },
    });

    // Mark original as adjusted/reversed (values unchanged).
    await db.financialTransaction.update({
      where: { id: original.id },
      data: {
        status:
          adjustmentType === "LATE_REJECTION" ? "FINANCIAL_REVERSED" : "FINANCIAL_ADJUSTED",
      },
    });

    try {
      await this.audit.record({
        aggregateType: "CommissionAdjustment",
        aggregateId: adjustment.id,
        action: adjustmentType === "LATE_REJECTION" ? "FINANCIAL_REVERSED" : "FINANCIAL_ADJUSTED",
        after: {
          adjustmentKey,
          clientPayableDelta,
          supplierReceivableDelta,
          mboMarginDelta,
        },
        reason,
      });
    } catch {
      // ignore
    }

    return { adjustment, resultTransaction, created: true, reused: false };
  }

  async reverseForLateRejection({ conversionId, orderId, reason }, client = null) {
    const db = client ?? this.db;
    const earnKey = earnRecognitionKey(conversionId);
    const original = await this.findByRecognitionKey(earnKey, db);
    if (!original) {
      return { skipped: true, reason: "no_financial_recognition" };
    }

    return this.createAdjustment(
      {
        originalTransactionId: original.id,
        adjustmentType: "LATE_REJECTION",
        reason: reason || "Late validation rejection",
        supplierReceivableDelta: (-Number(original.supplierReceivable)).toFixed(4),
        clientPayableDelta: (-Number(original.clientPayable)).toFixed(4),
        mboMarginDelta: (-Number(original.mboMargin)).toFixed(4),
        createdBy: "system",
        metadata: { orderId: orderId || original.orderId },
      },
      db,
    );
  }

  /**
   * Epic 9 — after item validation changes on an already-approved order:
   * - If no earn yet → recognizeConversion (idempotent earn:{conversionId})
   * - If earn exists → COMMISSION_CORRECTION adjustment to reach new net (original earn immutable)
   *
   * Recognition key for earn remains earn:{conversionId}. Same approved basis fingerprint
   * yields the same correction key (idempotent). Does not reverse the entire order for one item.
   */
  async syncApprovedBasisForOrder({ orderId, reason } = {}, client = null) {
    const db = client ?? this.db;
    if (!orderId) throw fail("orderId is required.", 400);

    const order = await db.order.findUnique({
      where: { id: orderId },
      include: {
        items: true,
        conversions: {
          include: { clientAssignment: { include: { client: true } } },
        },
      },
    });
    if (!order) throw fail("Order not found.", 404);
    if (order.validationStatus !== "VALIDATION_APPROVED") {
      return { skipped: true, reason: "order_not_approved" };
    }

    const results = [];
    for (const conversion of order.conversions || []) {
      const recognitionKey = earnRecognitionKey(conversion.id);
      const existingEarn = await this.findByRecognitionKey(recognitionKey, db);

      if (!existingEarn) {
        const created = await this.recognizeConversion(
          { orderId: order.id, conversionId: conversion.id },
          db,
        );
        results.push({ conversionId: conversion.id, action: "recognize", ...created });
        continue;
      }

      const attribution = resolveFinancialAttribution(order, conversion);
      if (!attribution.resolved) {
        await this.exceptions.report(
          {
            type: "COMMISSION_MISSING",
            severity: "HIGH",
            conversionId: conversion.id,
            orderId: order.id,
            clientId: order.clientId,
            reason: attribution.reason,
            metadata: { scope: "item_basis_sync" },
          },
          db,
        );
        results.push({ conversionId: conversion.id, action: "unresolved", reason: attribution.reason });
        continue;
      }

      const assignmentId = attribution.assignmentId;
      const transactionAt = conversion.conversionDate || order.orderDate || new Date();
      const approvedBasis = resolveApprovedCommercialBasis(order, conversion);
      const networkActual = resolveValidatedNetworkActualCommission({ approvedBasis, conversion });
      if (!networkActual.ok) {
        await this.exceptions.report(
          {
            type: "COMMISSION_INVALID",
            severity: "HIGH",
            conversionId: conversion.id,
            orderId: order.id,
            clientId: order.clientId,
            reason: networkActual.reason,
            metadata: { approvedBasis, scope: "item_basis_sync" },
          },
          db,
        );
        results.push({
          conversionId: conversion.id,
          action: "unresolved",
          reason: networkActual.reason,
          approvedBasis,
        });
        continue;
      }

      const originalCurrency =
        networkActual.currency || conversion.currency || order.currency || approvedBasis.currency || null;
      if (!originalCurrency) {
        results.push({ conversionId: conversion.id, action: "unresolved", reason: "missing_currency" });
        continue;
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
        await this.exceptions.report(
          {
            type: "COMMISSION_INVALID",
            severity: "HIGH",
            conversionId: conversion.id,
            orderId: order.id,
            clientId: order.clientId,
            reason: runtime.reason || runtime.status || "client_commercial_runtime_unresolved",
            metadata: {
              scope: "item_basis_sync",
              runtimeStatus: runtime.status,
              matchedClientCommissionRuleId: runtime.matchedClientCommissionRuleId ?? null,
              approvedBasis,
            },
          },
          db,
        );
        results.push({
          conversionId: conversion.id,
          action: "unresolved",
          reason: runtime.reason || runtime.status,
          approvedBasis,
        });
        continue;
      }

      const calc = {
        supplierGross: networkActual.amount,
        clientCommission: runtime.clientPayable,
        mboMargin: runtime.mboMargin,
      };

      const { net } = await this.netPositionForConversion(conversion.id, db);
      const targetSupplier = Number(calc.supplierGross);
      const targetClient = Number(calc.clientCommission);
      const targetMargin = Number(calc.mboMargin);
      const curSupplier = Number(net.supplierReceivable);
      const curClient = Number(net.clientPayable);
      const curMargin = Number(net.mboMargin);

      const dSupplier = Number((targetSupplier - curSupplier).toFixed(4));
      const dClient = Number((targetClient - curClient).toFixed(4));
      const dMargin = Number((targetMargin - curMargin).toFixed(4));

      if (Math.abs(dSupplier) < 0.00015 && Math.abs(dClient) < 0.00015 && Math.abs(dMargin) < 0.00015) {
        results.push({
          conversionId: conversion.id,
          action: "noop",
          approvedBasis,
          fingerprint: approvedBasisFingerprint(approvedBasis),
        });
        continue;
      }

      // Deterministic correction key: same prior net + same basis ⇒ idempotent; intervening changes get a new key.
      const fp = approvedBasisFingerprint(approvedBasis);
      const correctionKey =
        `item_basis:${fp}:from:${curClient.toFixed(4)}_${curSupplier.toFixed(4)}`.slice(0, 180);

      const adj = await this.createAdjustment(
        {
          originalTransactionId: existingEarn.id,
          adjustmentType: "COMMISSION_CORRECTION",
          reason: reason || "Approved item basis changed",
          supplierReceivableDelta: dSupplier.toFixed(4),
          clientPayableDelta: dClient.toFixed(4),
          mboMarginDelta: dMargin.toFixed(4),
          correctionKey,
          createdBy: "system",
          metadata: {
            orderId: order.id,
            approvedBasis,
            fingerprint: fp,
            priorNet: net,
            target: {
              supplierReceivable: targetSupplier,
              clientPayable: targetClient,
              mboMargin: targetMargin,
            },
          },
        },
        db,
      );
      results.push({ conversionId: conversion.id, action: "adjust", ...adj, approvedBasis });
    }

    return { orderId: order.id, results };
  }

  async netPositionForConversion(conversionId, client = null) {
    const db = client ?? this.db;
    const rows = await db.financialTransaction.findMany({
      where: { conversionId },
      orderBy: { createdAt: "asc" },
    });
    return { rows, net: netFinancialPosition(rows) };
  }
}
