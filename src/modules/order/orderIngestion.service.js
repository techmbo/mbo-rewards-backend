import { createHash } from "node:crypto";
import { prisma } from "../../database/prisma.js";
import { isPrismaUniqueViolation } from "../../core/prismaErrors.js";
import { auditService } from "../../platform/audit/audit.service.js";
import {
  buildOrderPatch,
  isPresent,
  mapConversionStatusToSupplierPayment,
  mapConversionStatusToValidation,
  mergeMetadata,
  mergeScalar,
  resolveSupplierOrderId,
} from "./orderMerge.js";
import { ExceptionCaseService } from "./exceptionCase.service.js";
import { ValidationService } from "./validation.service.js";

function lineKeyForItem(item, index) {
  if (isPresent(item.lineKey)) return String(item.lineKey);
  if (isPresent(item.supplierItemId)) return `item:${item.supplierItemId}`;
  if (isPresent(item.sku) || isPresent(item.productId) || isPresent(item.productName)) {
    const raw = [item.sku || "", item.productId || "", item.productName || "", index].join("|");
    return `derived:${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
  }
  return `idx:${index}`;
}

function detectConflict(existing, incoming) {
  const conflicts = [];
  if (
    isPresent(existing.orderValue) &&
    isPresent(incoming.orderValue) &&
    Number(existing.orderValue) !== Number(incoming.orderValue)
  ) {
    // Value changes are allowed (enrichment) but flagged when both set and differ significantly.
    const a = Number(existing.orderValue);
    const b = Number(incoming.orderValue);
    if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) / Math.max(Math.abs(a), 1) > 0.5) {
      conflicts.push({ field: "orderValue", from: a, to: b });
    }
  }
  if (
    isPresent(existing.currency) &&
    isPresent(incoming.currency) &&
    String(existing.currency).toUpperCase() !== String(incoming.currency).toUpperCase()
  ) {
    conflicts.push({
      field: "currency",
      from: existing.currency,
      to: incoming.currency,
    });
  }
  return conflicts;
}

/**
 * Idempotent Order + OrderItem ingestion (Wave C).
 * Unique: (supplier, sourceAccountLabel, supplierOrderId)
 */
export class OrderIngestionService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.audit = deps.audit ?? auditService;
    this.exceptions = deps.exceptions ?? new ExceptionCaseService({ prisma: this.db, audit: this.audit });
    this.validation = deps.validation ?? new ValidationService({ prisma: this.db, audit: this.audit, exceptions: this.exceptions });
  }

  async findByBusinessKey({ supplier, sourceAccountLabel, supplierOrderId }, client = null) {
    const db = client ?? this.db;
    if (!db?.order?.findUnique) return null;
    return db.order.findUnique({
      where: {
        supplier_sourceAccountLabel_supplierOrderId: {
          supplier,
          sourceAccountLabel: sourceAccountLabel || "default",
          supplierOrderId,
        },
      },
      include: { items: true, conversions: true },
    });
  }

  /**
   * Upsert order from supplier transaction facts.
   * Does not create finance ledger entries.
   */
  async upsertOrder(input, client = null) {
    const db = client ?? this.db;
    const supplier = input.supplier;
    const sourceAccountLabel = input.sourceAccountLabel || "default";
    const supplierOrderId = resolveSupplierOrderId(input);

    if (!supplier || supplier === "UNKNOWN") {
      await this.exceptions.report(
        {
          type: "SUPPLIER_STATUS_UNKNOWN",
          severity: "HIGH",
          reason: "Cannot ingest order with unknown supplier",
          metadata: { inputKeys: Object.keys(input || {}) },
        },
        db,
      );
      throw new Error("Cannot ingest order with unknown supplier");
    }

    if (!supplierOrderId) {
      await this.exceptions.report(
        {
          type: "MISSING_SUPPLIER_ORDER_ID",
          severity: "HIGH",
          supplier,
          reason: "Missing supplier order id and conversion id",
          metadata: { sourceAccountLabel },
        },
        db,
      );
      throw new Error("Missing supplier order identity");
    }

    const usedSynthetic = !isPresent(input.supplierOrderId) && isPresent(input.supplierConversionId);

    let existing = await this.findByBusinessKey(
      { supplier, sourceAccountLabel, supplierOrderId },
      db,
    );

    const validationStatus =
      input.validationStatus ||
      (input.legacyConversionStatus
        ? mapConversionStatusToValidation(input.legacyConversionStatus)
        : null);
    const supplierPaymentStatus =
      input.supplierPaymentStatus ||
      (input.legacyConversionStatus
        ? mapConversionStatusToSupplierPayment(input.legacyConversionStatus)
        : null);

    const createData = {
      supplier,
      sourceAccountLabel,
      supplierOrderId,
      clientId: input.clientId ?? null,
      merchantId: input.merchantId ?? null,
      canonicalCampaignId: input.canonicalCampaignId ?? null,
      campaignSourceId: input.campaignSourceId ?? null,
      clientAssignmentId: input.clientAssignmentId ?? null,
      clickId: input.clickId ?? null,
      orderValue: isPresent(input.orderValue) ? String(input.orderValue) : null,
      currency: input.currency ? String(input.currency).slice(0, 3).toUpperCase() : null,
      orderDate: input.orderDate ?? null,
      receivedAt: input.receivedAt ?? new Date(),
      validationStatus: validationStatus || "VALIDATION_PENDING",
      supplierPaymentStatus: supplierPaymentStatus || "PAYMENT_PENDING",
      clientPaymentStatus: input.clientPaymentStatus || "CLIENT_PAYMENT_NOT_READY",
      // Stamp confirmation/rejection time when ingested already in a terminal validation state.
      validationChangedAt:
        validationStatus === "VALIDATION_APPROVED" || validationStatus === "VALIDATION_REJECTED"
          ? input.orderDate || input.receivedAt || new Date()
          : null,
      rawPayloadId: input.rawPayloadId ?? null,
      metadata: mergeMetadata(
        { syntheticOrderId: usedSynthetic },
        input.metadata,
      ),
    };

    if (!existing) {
      try {
        existing = await db.order.create({
          data: createData,
          include: { items: true, conversions: true },
        });
        try {
          await this.audit.record({
            aggregateType: "Order",
            aggregateId: existing.id,
            action: "order.created",
            after: {
              supplier,
              supplierOrderId,
              validationStatus: existing.validationStatus,
            },
          });
        } catch {
          // ignore
        }
      } catch (error) {
        if (!isPrismaUniqueViolation(error)) throw error;
        existing = await this.findByBusinessKey(
          { supplier, sourceAccountLabel, supplierOrderId },
          db,
        );
        if (!existing) throw error;
        await this.exceptions.report(
          {
            type: "DUPLICATE_ORDER",
            severity: "LOW",
            supplier,
            orderId: existing.id,
            reason: "Concurrent duplicate order ingest recovered via unique key",
            metadata: { supplierOrderId, sourceAccountLabel },
          },
          db,
        );
      }
    }

    // Update path — merge, no null overwrite
    const conflicts = detectConflict(existing, {
      orderValue: input.orderValue,
      currency: input.currency,
    });
    if (conflicts.length) {
      await this.exceptions.report(
        {
          type: "ORDER_DATA_CONFLICT",
          severity: "MEDIUM",
          supplier,
          orderId: existing.id,
          clientId: existing.clientId,
          reason: "Conflicting order field values on re-ingest",
          metadata: { conflicts },
        },
        db,
      );
    }

    const patch = buildOrderPatch(existing, {
      clientId: input.clientId,
      merchantId: input.merchantId,
      canonicalCampaignId: input.canonicalCampaignId,
      campaignSourceId: input.campaignSourceId,
      clientAssignmentId: input.clientAssignmentId,
      clickId: input.clickId,
      orderValue: isPresent(input.orderValue) ? String(input.orderValue) : undefined,
      currency: input.currency,
      orderDate: input.orderDate,
      rawPayloadId: input.rawPayloadId,
      metadata: mergeMetadata(input.metadata, {
        lastIngestAt: new Date().toISOString(),
        syntheticOrderId: usedSynthetic,
      }),
    });

    // Status enrichment: only move PENDING → richer states via ValidationService for validation;
    // for initial sync mapping, allow setting when still default and incoming is more specific.
    let order = existing;
    if (Object.keys(patch).length) {
      order = await db.order.update({
        where: { id: existing.id },
        data: patch,
        include: { items: true, conversions: true },
      });
      try {
        await this.audit.record({
          aggregateType: "Order",
          aggregateId: order.id,
          action: "order.updated",
          before: { id: existing.id },
          after: patch,
        });
      } catch {
        // ignore
      }
    }

    if (
      validationStatus &&
      validationStatus !== order.validationStatus &&
      order.validationStatus === "VALIDATION_PENDING"
    ) {
      order = await this.validation.transition(
        order.id,
        validationStatus,
        { reason: "supplier_sync_enrichment", syncLegacyConversion: false },
        db,
      );
    } else if (
      validationStatus === "VALIDATION_REJECTED" &&
      order.validationStatus === "VALIDATION_APPROVED"
    ) {
      order = await this.validation.transition(
        order.id,
        "VALIDATION_REJECTED",
        { reason: "supplier_late_rejection", syncLegacyConversion: true },
        db,
      );
    }

    if (
      supplierPaymentStatus &&
      supplierPaymentStatus !== order.supplierPaymentStatus &&
      order.validationStatus !== "VALIDATION_REJECTED"
    ) {
      // Direct set for sync enrichment when progressing from PENDING only (avoid illegal jumps via service).
      if (order.supplierPaymentStatus === "PAYMENT_PENDING") {
        order = await db.order.update({
          where: { id: order.id },
          data: {
            supplierPaymentStatus,
            supplierPaymentChangedAt: new Date(),
          },
          include: { items: true, conversions: true },
        });
      }
    }

    if (Array.isArray(input.items) && input.items.length) {
      await this.upsertItems(order.id, input.items, db);
      order = await db.order.findUnique({
        where: { id: order.id },
        include: { items: true, conversions: true },
      });
    }

    return order;
  }

  async upsertItems(orderId, items, client = null) {
    const db = client ?? this.db;
    const results = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i] || {};
      const lineKey = lineKeyForItem(item, i);
      const existing = await db.orderItem.findUnique({
        where: { orderId_lineKey: { orderId, lineKey } },
      });

      const data = {
        supplierItemId: mergeScalar(existing?.supplierItemId, item.supplierItemId),
        sku: mergeScalar(existing?.sku, item.sku),
        productId: mergeScalar(existing?.productId, item.productId),
        productName: mergeScalar(existing?.productName, item.productName),
        quantity: isPresent(item.quantity) ? String(item.quantity) : existing?.quantity ?? null,
        unitPrice: isPresent(item.unitPrice) ? String(item.unitPrice) : existing?.unitPrice ?? null,
        itemValue: isPresent(item.itemValue) ? String(item.itemValue) : existing?.itemValue ?? null,
        currency: item.currency
          ? String(item.currency).slice(0, 3).toUpperCase()
          : existing?.currency ?? null,
        category: mergeScalar(existing?.category, item.category),
        commission: isPresent(item.commission) ? String(item.commission) : existing?.commission ?? null,
        metadata: mergeMetadata(existing?.metadata, item.metadata),
      };

      if (existing) {
        results.push(
          await db.orderItem.update({
            where: { id: existing.id },
            data,
          }),
        );
      } else {
        try {
          results.push(
            await db.orderItem.create({
              data: { orderId, lineKey, ...data },
            }),
          );
        } catch (error) {
          if (!isPrismaUniqueViolation(error)) throw error;
          const raced = await db.orderItem.findUnique({
            where: { orderId_lineKey: { orderId, lineKey } },
          });
          if (raced) {
            results.push(await db.orderItem.update({ where: { id: raced.id }, data }));
          }
        }
      }
    }
    return results;
  }

  async linkConversion(orderId, conversionId, client = null) {
    const db = client ?? this.db;
    return db.conversion.update({
      where: { id: conversionId },
      data: { orderId },
    });
  }
}
