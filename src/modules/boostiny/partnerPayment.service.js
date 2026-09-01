import { randomUUID } from "node:crypto";
import { prisma } from "../../database/prisma.js";
import { fail } from "../../core/apiResponse.js";
import { auditService } from "../../platform/audit/audit.service.js";
import { ExceptionCaseService } from "../order/exceptionCase.service.js";
import { ALERT_CONDITION } from "../ops/alertException.contract.js";
import { buildSettlementKey } from "./partnerPayment.fields.js";
import { parsePartnerPaymentCsv } from "./partnerPayment.parse.js";

function money(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Number(value).toFixed(4);
}

/**
 * Boostiny Partner Payment upload + settlement.
 * Hard rules:
 * - Never create individual Order / Conversion rows from this CSV
 * - Exactly one client per Payment Source mapping
 * - Duplicate settlementKey is idempotent (skip)
 */
export class BoostinyPartnerPaymentService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.audit = deps.audit ?? auditService;
    this.exceptions = deps.exceptions ?? new ExceptionCaseService();
  }

  async listMappings({ sourceAccountLabel = "default" } = {}) {
    return this.db.boostinyPaymentSourceMapping.findMany({
      where: { sourceAccountLabel },
      include: { client: { select: { id: true, name: true, slug: true, status: true } } },
      orderBy: [{ paymentSource: "asc" }],
    });
  }

  async upsertMapping(input) {
    const paymentSource = String(input.paymentSource || "").trim();
    const sourceAccountLabel = String(input.sourceAccountLabel || "default").trim() || "default";
    const clientId = String(input.clientId || "").trim();
    if (!paymentSource) throw fail("paymentSource is required.", 400);
    if (!clientId) throw fail("clientId is required.", 400);

    const client = await this.db.client.findFirst({
      where: { id: clientId, deletedAt: null },
    });
    if (!client) throw fail("Client not found.", 404);

    // Isolation: one payment source → one client. Reject if another active mapping exists for same source.
    const existing = await this.db.boostinyPaymentSourceMapping.findUnique({
      where: {
        paymentSource_sourceAccountLabel: { paymentSource, sourceAccountLabel },
      },
    });
    if (existing && existing.clientId !== clientId && existing.isActive) {
      throw fail(
        "Payment source is already mapped to another client. Settlement isolation requires one client per Payment Source.",
        409,
      );
    }

    const row = await this.db.boostinyPaymentSourceMapping.upsert({
      where: {
        paymentSource_sourceAccountLabel: { paymentSource, sourceAccountLabel },
      },
      create: {
        paymentSource,
        sourceAccountLabel,
        clientId,
        clientAssignmentId: input.clientAssignmentId ?? null,
        notes: input.notes ?? null,
        isActive: input.isActive !== false,
      },
      update: {
        clientId,
        clientAssignmentId: input.clientAssignmentId ?? null,
        notes: input.notes ?? null,
        isActive: input.isActive !== false,
      },
    });

    await this.audit.record({
      aggregateType: "BoostinyPaymentSourceMapping",
      aggregateId: row.id,
      action: existing ? "boostiny.payment_source_mapping.update" : "boostiny.payment_source_mapping.create",
      after: {
        paymentSource,
        sourceAccountLabel,
        clientId,
        isActive: row.isActive,
      },
    });

    return row;
  }

  async listSettlements({ clientId, paymentSource, cycle, status, take = 50 } = {}) {
    const where = {};
    if (clientId) where.clientId = clientId;
    if (paymentSource) where.paymentSource = paymentSource;
    if (cycle) where.cycle = cycle;
    if (status) where.status = status;
    return this.db.boostinyPartnerPaymentSettlement.findMany({
      where,
      orderBy: [{ createdAt: "desc" }],
      take: Math.min(Number(take) || 50, 200),
      include: {
        client: { select: { id: true, name: true, slug: true } },
        mapping: true,
      },
    });
  }

  /**
   * @param {string} csvText
   * @param {{ sourceAccountLabel?: string, actorId?: string }} options
   */
  async uploadCsv(csvText, options = {}) {
    const sourceAccountLabel = String(options.sourceAccountLabel || "default").trim() || "default";
    const parsed = parsePartnerPaymentCsv(csvText);
    if (!parsed.ok) {
      try {
        await this.exceptions.report({
          type: "BOOSTINY_PARTNER_PAYMENT_INVALID",
          severity: "HIGH",
          supplier: "BOOSTINY",
          reason: parsed.error,
          metadata: parsed.details ?? null,
        });
      } catch {
        // ignore
      }
      const err = fail(parsed.error, 400);
      err.details = parsed.details ?? null;
      throw err;
    }

    const uploadBatchId = randomUUID();
    const summary = {
      uploadBatchId,
      totalRows: parsed.rows.length,
      created: 0,
      skippedDuplicate: 0,
      blockedMissingMapping: 0,
      errors: [],
    };

    for (const row of parsed.rows) {
      const settlementKey = buildSettlementKey({
        sourceAccountLabel,
        paymentSource: row.paymentSource,
        cycle: row.cycle,
      });

      const existing = await this.db.boostinyPartnerPaymentSettlement.findUnique({
        where: { settlementKey },
      });
      if (existing) {
        summary.skippedDuplicate += 1;
        try {
          await this.exceptions.report({
            condition: ALERT_CONDITION.DUPLICATE_PAYMENT_IMPORT,
            type: "DUPLICATE_FINANCIAL_RECOGNITION",
            supplier: "BOOSTINY",
            entityId: settlementKey,
            dedupeKey: `boostiny-dup:${settlementKey}`,
            reason: "Duplicate partner payment import blocked",
            metadata: { settlementKey, paymentSource: row.paymentSource, cycle: row.cycle },
          });
        } catch {
          // ignore
        }
        continue;
      }

      const mapping = await this.db.boostinyPaymentSourceMapping.findFirst({
        where: {
          paymentSource: row.paymentSource,
          sourceAccountLabel,
          isActive: true,
        },
      });

      if (!mapping) {
        summary.blockedMissingMapping += 1;
        await this.db.boostinyPartnerPaymentSettlement.create({
          data: {
            settlementKey,
            sourceAccountLabel,
            paymentSource: row.paymentSource,
            cycle: row.cycle,
            legalEntityName: row.legalEntityName,
            ordersCount: row.orders,
            revenue: money(row.revenue),
            salesAmountUsd: money(row.salesAmountUsd),
            extra: money(row.extra),
            deduction: money(row.deduction),
            delayed: money(row.delayed),
            currency: "USD",
            confirmationGranularity: "PAYMENT_SOURCE_CYCLE",
            status: "BLOCKED",
            clientId: null,
            mappingId: null,
            uploadBatchId,
            rawRow: row.raw,
            blockReason: "BOOSTINY_SOURCE_MAPPING_MISSING",
          },
        });
        try {
          await this.exceptions.report({
            type: "BOOSTINY_SOURCE_MAPPING_MISSING",
            severity: "HIGH",
            supplier: "BOOSTINY",
            reason: `No active Payment Source mapping for "${row.paymentSource}"`,
            metadata: {
              paymentSource: row.paymentSource,
              cycle: row.cycle,
              settlementKey,
              uploadBatchId,
            },
          });
        } catch {
          // ignore
        }
        continue;
      }

      await this.db.boostinyPartnerPaymentSettlement.create({
        data: {
          settlementKey,
          sourceAccountLabel,
          paymentSource: row.paymentSource,
          cycle: row.cycle,
          legalEntityName: row.legalEntityName,
          ordersCount: row.orders,
          revenue: money(row.revenue),
          salesAmountUsd: money(row.salesAmountUsd),
          extra: money(row.extra),
          deduction: money(row.deduction),
          delayed: money(row.delayed),
          currency: "USD",
          confirmationGranularity: "PAYMENT_SOURCE_CYCLE",
          status: "SETTLED",
          clientId: mapping.clientId,
          mappingId: mapping.id,
          uploadBatchId,
          rawRow: row.raw,
        },
      });
      summary.created += 1;
    }

    await this.audit.record({
      aggregateType: "BoostinyPartnerPaymentUpload",
      aggregateId: uploadBatchId,
      action: "boostiny.partner_payment.upload",
      actorId: options.actorId ?? null,
      after: summary,
      metadata: {
        sourceAccountLabel,
        // Explicit: this path never creates Order rows.
        createsIndividualOrders: false,
      },
    });

    return summary;
  }
}
