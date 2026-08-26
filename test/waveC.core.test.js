import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  buildOrderPatch,
  mapConversionStatusToValidation,
  mapLegacyConversionStatus,
  mergeScalar,
  resolveSupplierOrderId,
} from "../src/modules/order/orderMerge.js";
import { ExceptionCaseService } from "../src/modules/order/exceptionCase.service.js";
import { ValidationService, VALIDATION_TRANSITIONS } from "../src/modules/order/validation.service.js";
import {
  PaymentStateService,
  CLIENT_PAYMENT_TRANSITIONS,
  SUPPLIER_PAYMENT_TRANSITIONS,
} from "../src/modules/order/paymentState.service.js";
import { OrderIngestionService } from "../src/modules/order/orderIngestion.service.js";
import { mapEntityToConversionIngest } from "../src/modules/reporting/services/conversionPromotion.service.js";

describe("Wave C — order merge / identity", () => {
  it("resolves supplier order id and falls back to conv: conversion id", () => {
    assert.equal(resolveSupplierOrderId({ supplierOrderId: "ORD-1" }), "ORD-1");
    assert.equal(
      resolveSupplierOrderId({ supplierConversionId: "C-9" }),
      "conv:C-9",
    );
    assert.equal(resolveSupplierOrderId({}), null);
  });

  it("does not overwrite existing values with null", () => {
    assert.equal(mergeScalar("USD", null), "USD");
    assert.equal(mergeScalar("USD", undefined), "USD");
    assert.equal(mergeScalar("USD", "INR"), "INR");
    const patch = buildOrderPatch(
      { orderValue: "100", currency: "USD", clientId: "c1" },
      { orderValue: null, currency: undefined, clientId: "c1", merchantId: "m1" },
    );
    assert.equal(patch.orderValue, undefined);
    assert.equal(patch.currency, undefined);
    assert.equal(patch.merchantId, "m1");
  });

  it("maps legacy conversion status to validation", () => {
    assert.equal(mapConversionStatusToValidation("APPROVED"), "VALIDATION_APPROVED");
    assert.equal(mapConversionStatusToValidation("REJECTED"), "VALIDATION_REJECTED");
    assert.equal(mapLegacyConversionStatus("VALIDATION_APPROVED"), "APPROVED");
  });
});

describe("Wave C — Order ingestion idempotency", () => {
  function mockDb(seed = null) {
    let order = seed;
    const items = new Map();
    return {
      order: {
        findUnique: async () =>
          order
            ? { ...order, items: [...items.values()], conversions: order.conversions || [] }
            : null,
        create: async ({ data }) => {
          if (order) {
            const err = new Error("unique");
            err.code = "P2002";
            throw err;
          }
          order = { id: "ord-1", ...data, conversions: [], items: [] };
          return { ...order, items: [], conversions: [] };
        },
        update: async ({ data }) => {
          order = { ...order, ...data };
          return { ...order, items: [...items.values()], conversions: order.conversions || [] };
        },
      },
      orderItem: {
        findUnique: async ({ where }) => items.get(where.orderId_lineKey.lineKey) || null,
        create: async ({ data }) => {
          const row = { id: `item-${items.size + 1}`, ...data };
          items.set(data.lineKey, row);
          return row;
        },
        update: async ({ where, data }) => {
          const existing = [...items.values()].find((r) => r.id === where.id);
          const next = { ...existing, ...data };
          items.set(next.lineKey, next);
          return next;
        },
      },
      exceptionCase: {
        findFirst: async () => null,
        create: async ({ data }) => ({ id: "ex-1", ...data }),
        update: async ({ data }) => ({ id: "ex-1", ...data }),
      },
      conversion: {
        update: async () => ({}),
      },
      _getOrder: () => order,
      _items: items,
    };
  }

  it("creates order uniquely and re-ingest updates without duplicate", async () => {
    const db = mockDb();
    const service = new OrderIngestionService({
      prisma: db,
      audit: { record: async () => ({}) },
      exceptions: new ExceptionCaseService({ prisma: db, audit: { record: async () => ({}) } }),
      validation: {
        transition: async (id, to) => {
          const order = await db.order.findUnique({ where: { id } });
          return db.order.update({ where: { id }, data: { validationStatus: to } });
        },
      },
    });

    const first = await service.upsertOrder({
      supplier: "OPTIMISE",
      sourceAccountLabel: "default",
      supplierOrderId: "O-1",
      orderValue: "50",
      currency: "USD",
      legacyConversionStatus: "PENDING",
    });
    const second = await service.upsertOrder({
      supplier: "OPTIMISE",
      sourceAccountLabel: "default",
      supplierOrderId: "O-1",
      orderValue: "75",
      currency: null,
      legacyConversionStatus: "APPROVED",
    });

    assert.equal(first.id, second.id);
    assert.equal(String(second.orderValue), "75");
    assert.equal(second.currency, "USD");
  });

  it("enriches partial order later and keeps items linked", async () => {
    const db = mockDb();
    const service = new OrderIngestionService({
      prisma: db,
      audit: { record: async () => ({}) },
      exceptions: new ExceptionCaseService({ prisma: db, audit: { record: async () => ({}) } }),
      validation: { transition: async (id, to) => db.order.update({ where: { id }, data: { validationStatus: to } }) },
    });

    await service.upsertOrder({
      supplier: "BOOSTINY",
      supplierConversionId: "CV-1",
      orderValue: "10",
    });
    const enriched = await service.upsertOrder({
      supplier: "BOOSTINY",
      supplierConversionId: "CV-1",
      items: [
        { supplierItemId: "L1", sku: "SKU-1", productName: "Shoe", quantity: 1 },
        { supplierItemId: "L2", sku: "SKU-2", productName: "Sock", quantity: 2 },
      ],
    });

    assert.equal(enriched.supplierOrderId, "conv:CV-1");
    assert.equal(enriched.items.length, 2);
    assert.equal(enriched.items[0].orderId, enriched.id);
  });

  it("handles concurrent duplicate create via unique recovery", async () => {
    const existing = {
      id: "ord-existing",
      supplier: "TRACKIER",
      sourceAccountLabel: "default",
      supplierOrderId: "T-1",
      orderValue: "1",
      currency: "USD",
      validationStatus: "VALIDATION_PENDING",
      supplierPaymentStatus: "PAYMENT_PENDING",
      clientPaymentStatus: "CLIENT_PAYMENT_NOT_READY",
      conversions: [],
      metadata: {},
    };
    let created = false;
    const db = {
      order: {
        findUnique: async () => (created ? existing : null),
        create: async () => {
          created = true;
          const err = new Error("unique");
          err.code = "P2002";
          throw err;
        },
        update: async ({ data }) => ({ ...existing, ...data, items: [], conversions: [] }),
      },
      orderItem: { findUnique: async () => null, create: async () => ({}), update: async () => ({}) },
      exceptionCase: {
        findFirst: async () => null,
        create: async ({ data }) => ({ id: "ex-dup", ...data }),
        update: async () => ({}),
      },
    };
    // After P2002, findUnique must return the raced row
    let calls = 0;
    db.order.findUnique = async () => {
      calls += 1;
      return calls === 1 ? null : existing;
    };

    const service = new OrderIngestionService({
      prisma: db,
      audit: { record: async () => ({}) },
      exceptions: new ExceptionCaseService({ prisma: db, audit: { record: async () => ({}) } }),
      validation: { transition: async () => existing },
    });

    const order = await service.upsertOrder({
      supplier: "TRACKIER",
      supplierOrderId: "T-1",
      orderValue: "2",
    });
    assert.equal(order.id, "ord-existing");
  });
});

describe("Wave C — validation state machine", () => {
  it("allows pending → approved/rejected/needs_review", () => {
    assert.deepEqual(
      VALIDATION_TRANSITIONS.VALIDATION_PENDING.sort(),
      ["VALIDATION_APPROVED", "VALIDATION_NEEDS_REVIEW", "VALIDATION_REJECTED"].sort(),
    );
  });

  it("rejects illegal transitions and late-rejection preserves commissions", async () => {
    const conversions = [
      {
        id: "cv1",
        clientCommission: "70",
        mboCommission: "30",
        supplierCommission: "100",
        approvedDate: new Date(),
        metadata: {},
      },
    ];
    let order = {
      id: "ord1",
      supplier: "OPTIMISE",
      clientId: "c1",
      validationStatus: "VALIDATION_APPROVED",
      supplierPaymentStatus: "PAYMENT_PENDING",
      clientPaymentStatus: "CLIENT_PAYMENT_NOT_READY",
      lastApprovedClientCommission: null,
      conversions,
    };
    const db = {
      order: {
        findUnique: async () => order,
        update: async ({ data }) => {
          order = { ...order, ...data };
          return order;
        },
      },
      conversion: {
        update: async ({ data }) => {
          Object.assign(conversions[0], data);
          return conversions[0];
        },
      },
      exceptionCase: {
        findFirst: async () => null,
        create: async ({ data }) => ({ id: "ex-late", ...data }),
        update: async () => ({}),
      },
    };
    const service = new ValidationService({
      prisma: db,
      audit: { record: async () => ({}) },
      exceptions: new ExceptionCaseService({ prisma: db, audit: { record: async () => ({}) } }),
      finance: {
        recognizeConversion: async () => ({ skipped: true }),
        reverseForLateRejection: async () => ({ skipped: true }),
      },
    });

    await assert.rejects(
      () => service.transition("ord1", "VALIDATION_PENDING"),
      (e) => e.statusCode === 409,
    );

    const rejected = await service.transition("ord1", "VALIDATION_REJECTED", {
      reason: "network reversed",
    });
    assert.equal(rejected.validationStatus, "VALIDATION_REJECTED");
    assert.equal(String(rejected.lastApprovedClientCommission), "70");
    assert.equal(conversions[0].clientCommission, null);
    assert.equal(conversions[0].metadata.preservedOnOrder, true);
  });
});

describe("Wave C — payment state machines", () => {
  it("keeps supplier and client payment independent", () => {
    assert.ok(SUPPLIER_PAYMENT_TRANSITIONS.PAYMENT_PENDING.includes("PAYMENT_RECEIVED"));
    assert.ok(CLIENT_PAYMENT_TRANSITIONS.CLIENT_PAYMENT_NOT_READY.includes("CLIENT_PAYMENT_PAYABLE"));
    assert.notEqual(
      SUPPLIER_PAYMENT_TRANSITIONS.PAYMENT_PENDING,
      CLIENT_PAYMENT_TRANSITIONS.CLIENT_PAYMENT_NOT_READY,
    );
  });

  it("blocks payable states on rejected validation", async () => {
    const order = {
      id: "ord1",
      supplier: "OPTIMISE",
      validationStatus: "VALIDATION_REJECTED",
      supplierPaymentStatus: "PAYMENT_PENDING",
      clientPaymentStatus: "CLIENT_PAYMENT_ON_HOLD",
    };
    const db = {
      order: {
        findUnique: async () => order,
        update: async ({ data }) => ({ ...order, ...data }),
      },
      exceptionCase: {
        findFirst: async () => null,
        create: async ({ data }) => ({ id: "ex1", ...data }),
        update: async () => ({}),
      },
    };
    const service = new PaymentStateService({
      prisma: db,
      audit: { record: async () => ({}) },
      exceptions: new ExceptionCaseService({ prisma: db, audit: { record: async () => ({}) } }),
    });

    await assert.rejects(
      () => service.transitionSupplierPayment("ord1", "PAYMENT_RECEIVED"),
      (e) => e.statusCode === 409,
    );
    await assert.rejects(
      () => service.transitionClientPayment("ord1", "CLIENT_PAYMENT_PAID"),
      (e) => e.statusCode === 409,
    );
  });

  it("requires supplier received before client payable when configured", async () => {
    const order = {
      id: "ord1",
      supplier: "OPTIMISE",
      validationStatus: "VALIDATION_APPROVED",
      supplierPaymentStatus: "PAYMENT_PENDING",
      clientPaymentStatus: "CLIENT_PAYMENT_NOT_READY",
    };
    const db = {
      order: {
        findUnique: async () => order,
        update: async ({ data }) => ({ ...order, ...data }),
      },
      exceptionCase: {
        findFirst: async () => null,
        create: async ({ data }) => ({ id: "ex1", ...data }),
        update: async () => ({}),
      },
    };
    const service = new PaymentStateService({
      prisma: db,
      audit: { record: async () => ({}) },
      exceptions: new ExceptionCaseService({ prisma: db, audit: { record: async () => ({}) } }),
    });

    await assert.rejects(
      () => service.transitionClientPayment("ord1", "CLIENT_PAYMENT_PAYABLE"),
      (e) => e.statusCode === 409,
    );

    order.supplierPaymentStatus = "PAYMENT_RECEIVED";
    const updated = await service.transitionClientPayment("ord1", "CLIENT_PAYMENT_PAYABLE");
    assert.equal(updated.clientPaymentStatus, "CLIENT_PAYMENT_PAYABLE");
  });
});

describe("Wave C — ExceptionCase idempotency", () => {
  it("reuses open exception on repeated detection", async () => {
    let stored = null;
    const db = {
      exceptionCase: {
        findFirst: async () => stored,
        create: async ({ data }) => {
          stored = { id: "ex-1", ...data, metadata: data.metadata };
          return stored;
        },
        update: async ({ data }) => {
          stored = { ...stored, ...data, metadata: data.metadata };
          return stored;
        },
      },
    };
    const service = new ExceptionCaseService({
      prisma: db,
      audit: { record: async () => ({}) },
    });

    const first = await service.report({
      type: "ATTRIBUTION_UNRESOLVED",
      supplier: "OPTIMISE",
      supplierConversionId: "X",
      reason: "orphan",
    });
    const second = await service.report({
      type: "ATTRIBUTION_UNRESOLVED",
      supplier: "OPTIMISE",
      supplierConversionId: "X",
      reason: "orphan again",
    });

    assert.equal(first.created, true);
    assert.equal(second.reused, true);
    assert.equal(first.record.id, second.record.id);
    assert.equal(second.record.metadata.detectCount, 2);
  });
});

describe("Wave C — promotion mapping creates order facts", () => {
  it("maps entity with order id and items", () => {
    const mapped = mapEntityToConversionIngest({
      id: "e1",
      networkSource: "optimise_sea",
      externalId: "optimise_sea-conversion-99",
      entityType: "conversion",
      commission: 12,
      rawData: {
        conversionId: 99,
        orderId: "ORD-99",
        commission: 12,
        status: "approved",
        currency: "USD",
        conversionDate: "2026-08-01T00:00:00.000Z",
        items: [{ id: "i1", sku: "A", name: "Item A", quantity: 1 }],
      },
      normalizedData: {},
    });
    assert.equal(mapped.ok, true);
    assert.equal(mapped.input._order.supplierOrderId, "ORD-99");
    assert.equal(mapped.input._order.items.length, 1);
  });
});

describe("Wave C — Conversion can reference Order without breaking legacy", () => {
  it("ingestConversion accepts orderId and preserves null-order historical path", async () => {
    const { AttributionService } = await import(
      "../src/modules/reporting/services/attribution.service.js"
    );
    const created = [];
    const service = new AttributionService({
      conversionRepo: {
        findBySupplierKey: async () => null,
        create: async (data) => {
          created.push(data);
          return { id: "cv-new", ...data, attributionStatus: "PENDING" };
        },
        update: async (id, data) => ({ id, ...data, attributionStatus: "ORPHAN" }),
        findById: async () => created[0] && { id: "cv-new", ...created[0], metadata: {} },
      },
      clickRepo: { findById: async () => null, findBySubId: async () => null },
      trackingRepo: { findById: async () => null, findPrimaryForAssignment: async () => null },
      assignmentRepo: { findById: async () => null },
      commissionRepo: { findEffectiveForAssignment: async () => null },
      exceptions: { report: async () => ({ created: true }) },
    });

    await service.ingestConversion(
      {
        supplier: "OPTIMISE",
        supplierConversionId: "1",
        supplierCommission: "1.0000",
        conversionDate: new Date(),
        orderId: "ord-1",
      },
      {},
    );
    assert.equal(created[0].orderId, "ord-1");

    created.length = 0;
    await service.ingestConversion(
      {
        supplier: "OPTIMISE",
        supplierConversionId: "2",
        supplierCommission: "1.0000",
        conversionDate: new Date(),
      },
      {},
    );
    assert.equal(created[0].orderId, undefined);
  });
});
