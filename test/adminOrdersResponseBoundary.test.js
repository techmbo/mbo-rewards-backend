/**
 * GET /ops/admin/orders — response boundary.
 *
 * The order row never carries raw attribution evidence (supplier / MBO tracking URLs, network and
 * MBO click ids, sub ids, raw payload id) or a supplier coupon URL, for any caller; coupon fields
 * carry the voucher code only. MBO receipt values (amount, bank / received date-time) follow the
 * same financial gate as the commission split: finance_ops:read or commission:read. Query, paging,
 * filters and status mapping are unchanged.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { AdminContractService } from "../src/modules/ops/adminContract.service.js";
import { toAdminOrderDto } from "../src/modules/ops/adminContract.dto.js";
import { PERMISSIONS } from "../src/auth/permissions.js";

const TOKEN = "tok_DECOY_ORDERS_7";
const COUPON_URL = "https://coupon.example.test/deal?aff=aff-DECOY";
const DECOYS = [
  TOKEN,
  "track.example.test",
  "coupon.example.test",
  "go.example.test",
  "aff-DECOY",
  "://",
  "nclick-DECOY",
  "mclick-DECOY",
  "sub1-DECOY",
  "sub2-DECOY",
  "sub3-DECOY",
  "raw-DECOY",
];
const RAW_FIELDS = [
  "networkTrackingLink",
  "mboTrackingLink",
  "networkClickId",
  "mboClickId",
  "subId1",
  "subId2",
  "subId3",
  "rawPayloadId",
];
const RECEIPT_FIELDS = ["mboReceivedAmount", "bankReceivedAt", "mboReceivedDateTime"];
const COMMISSION_FIELDS = [
  "supplierActualCommission",
  "clientCommission",
  "mboCommissionMargin",
  "clientSharePercent",
  "mboSharePercent",
];

const ANALYST = [PERMISSIONS.CONVERSIONS_READ];
const FINANCE = [PERMISSIONS.CONVERSIONS_READ, PERMISSIONS.FINANCE_OPS_READ];
const COMMISSION = [PERMISSIONS.CONVERSIONS_READ, PERMISSIONS.COMMISSION_READ];

// An order row as Prisma returns it, with every raw attribution source planted.
function orderRow() {
  return {
    id: "ord-1",
    supplier: "OPTIMISE",
    sourceAccountLabel: "default",
    supplierOrderId: "SO-100",
    clientId: "cl-1",
    client: { id: "cl-1", name: "Client One", clientSharePercent: 70 },
    merchant: { id: "m-1", displayName: "Brand One" },
    canonicalCampaign: { id: "cc-1", displayName: "Campaign One", merchant: { id: "m-1", displayName: "Brand One" } },
    canonicalCampaignId: "cc-1",
    orderValue: "250.00",
    currency: "AED",
    orderDate: new Date("2026-09-10T08:00:00.000Z"),
    validationStatus: "VALIDATION_PENDING",
    supplierPaymentStatus: "PAYMENT_PENDING",
    clientPaymentStatus: "UNPAID",
    rawPayloadId: "raw-DECOY",
    updatedAt: new Date("2026-09-11T00:00:00.000Z"),
    metadata: {
      couponCode: "SAVE10",
      networkTrackingLink: `https://track.example.test/c?token=${TOKEN}`,
      networkClickId: "nclick-DECOY",
      subId2: "sub2-DECOY",
      subId3: "sub3-DECOY",
      // MBO bank receipt evidence on the order itself (read without any ledger rows).
      mboReceivedDateTime: "2026-09-15T10:30:00.000Z",
      mboReceiptSource: "BANK_RECONCILIATION",
      mboReceivedAmount: 17.25,
    },
    campaignSource: { supplierCampaign: { supplier: "OPTIMISE", supplierCampaignId: "OPT-9", trackingUrl: `https://track.example.test/c?token=${TOKEN}` } },
    click: {
      id: "mclick-DECOY",
      subId: "sub1-DECOY",
      trackingLinkId: "tl-1",
      trackingLink: { id: "tl-1", mboTrackingUrl: `https://go.example.test/r/brand/${TOKEN}` },
    },
    conversions: [
      {
        id: "cv-1",
        supplierConversionId: "SC-1",
        status: "PENDING",
        currency: "AED",
        clickId: "mclick-DECOY",
        subId: "sub1-DECOY",
        supplierCommission: "20.00",
        clientCommission: "14.00",
        mboCommission: "6.00",
        attributionStatus: "ATTRIBUTED",
        metadata: { attributionEvidence: "MBO_CLICK" },
      },
    ],
    financialTransactions: [],
    _count: { exceptionCases: 0 },
  };
}

function fakeDb(calls, rows = [orderRow()], total = 1) {
  return {
    order: {
      findMany: async (args) => {
        calls.push({ op: "order.findMany", args });
        return rows;
      },
      count: async (args) => {
        calls.push({ op: "order.count", args });
        return total;
      },
    },
    entity: { findMany: async () => [] },
    // Catalogue row for the order's coupon code, carrying a supplier coupon URL.
    supplierCoupon: {
      findMany: async () => [{ id: "sc-coupon-1", couponCode: "SAVE10", couponLink: COUPON_URL, couponType: "CODE", supplierCampaign: null }],
    },
    supplierCampaign: { findMany: async () => [] },
  };
}

async function listOrders(permissions, query = {}) {
  const calls = [];
  const svc = new AdminContractService({ prisma: fakeDb(calls) });
  const result = await svc.listOrders({ skip: 0, take: 25, ...query }, permissions);
  return { result, calls };
}

describe("admin orders response boundary", () => {
  it("conversions:read only: safe fields present, raw attribution and receipts absent, commission gated", async () => {
    const { result } = await listOrders(ANALYST);
    assert.equal(result.includeFinancial, false);
    const [row] = result.items;

    assert.equal(row.orderId, "ord-1");
    assert.equal(row.supplierOrderId, "SO-100");
    assert.equal(row.network, "OPTIMISE");
    assert.equal(row.clientId, "cl-1");
    assert.equal(row.clientName, "Client One");
    assert.equal(row.brandName, "Brand One");
    assert.equal(row.campaignName, "Campaign One");
    assert.equal(row.orderValue, 250);
    assert.equal(row.currency, "AED");
    assert.equal(row.orderDate, "2026-09-10T08:00:00.000Z");
    assert.equal(row.validationStatus, "VALIDATION_PENDING");
    assert.equal(row.supplierPaymentStatus, "PAYMENT_PENDING");
    assert.equal(row.trackingLinkId, "tl-1");

    for (const key of RAW_FIELDS) assert.equal(key in row, false, `${key} returned`);
    for (const key of RECEIPT_FIELDS) assert.equal(row[key], null, `${key} not redacted`);
    assert.equal(row.mboReceived, null);
    for (const key of COMMISSION_FIELDS) assert.equal(key in row, false, `${key} returned`);
    assert.deepEqual(row.financial, { state: "REDACTED", reason: "insufficient_permission" });
  });

  for (const [label, perms] of [
    ["finance_ops:read", FINANCE],
    ["commission:read", COMMISSION],
  ]) {
    it(`${label}: commission split and receipts returned, raw attribution still absent`, async () => {
      const { result } = await listOrders(perms);
      assert.equal(result.includeFinancial, true);
      const [row] = result.items;

      // No ledger rows: 07E falls back to the conversion values, as before.
      assert.equal(row.supplierActualCommission, 20);
      assert.equal(row.clientCommission, 14);
      assert.equal(row.mboCommissionMargin, 6);
      assert.equal(row.financial.source, "conversion");

      assert.equal(row.mboReceivedAmount, 17.25);
      assert.equal(row.bankReceivedAt, "2026-09-15T10:30:00.000Z");
      assert.equal(row.mboReceivedDateTime, "2026-09-15 10:30");
      assert.equal(row.mboReceived, 17.25);

      for (const key of RAW_FIELDS) assert.equal(key in row, false, `${key} returned`);
    });
  }

  it("planted token, click and sub-id values never appear in the serialized response", async () => {
    for (const perms of [ANALYST, FINANCE, COMMISSION]) {
      const { result } = await listOrders(perms);
      const body = JSON.stringify(result);
      for (const decoy of DECOYS) assert.ok(!body.includes(decoy), `${decoy} leaked`);
    }
  });

  it("coupon fields carry the voucher code only, never a supplier or tracking URL", async () => {
    for (const perms of [ANALYST, FINANCE]) {
      const [row] = (await listOrders(perms)).result.items;
      assert.equal(row.couponCode, "SAVE10");
      assert.equal(row.couponType, "CODE");
      assert.equal(row.couponLink, null);
      assert.equal(row.couponCodeOrLink, "SAVE10");
    }
    // Explicit coupon link plus tracking links on the context: none of them is returned.
    const withLinks = toAdminOrderDto(
      {
        id: "o2",
        networkContext: {
          couponCode: "C1",
          couponLink: COUPON_URL,
          mboTrackingLink: `https://go.example.test/r/x/${TOKEN}`,
          networkTrackingLink: `https://track.example.test/c?token=${TOKEN}`,
        },
      },
      { includeFinancial: true },
    );
    assert.equal(withLinks.couponCode, "C1");
    assert.equal(withLinks.couponLink, null);
    assert.equal(withLinks.couponCodeOrLink, "C1");
    // Link-only coupon: nothing to show rather than the URL.
    const linkOnly = toAdminOrderDto({ id: "o3", networkContext: { couponLink: COUPON_URL, couponType: "LINK" } });
    assert.equal(linkOnly.couponCode, null);
    assert.equal(linkOnly.couponCodeOrLink, null);
    assert.equal(linkOnly.couponType, "LINK");
    // A URL stored in the code field is not a code.
    for (const value of [COUPON_URL, "www.coupon.example.test/x", "tracker://coupon.example.test/x"]) {
      const dto = toAdminOrderDto({ id: "o4", networkContext: { couponCode: value } });
      assert.equal(dto.couponCode, null, value);
      assert.equal(dto.couponCodeOrLink, null, value);
    }
    for (const dto of [withLinks, linkOnly]) {
      const body = JSON.stringify(dto);
      for (const decoy of DECOYS) assert.ok(!body.includes(decoy), `${decoy} leaked`);
    }
  });

  it("DTO drops raw fields even when the caller hands them in directly", () => {
    const nc = {
      network: "AWIN",
      networkTrackingLink: `https://track.example.test/c?token=${TOKEN}`,
      mboTrackingLink: `https://go.example.test/r/x/${TOKEN}`,
      networkClickId: "nclick-DECOY",
      mboClickId: "mclick-DECOY",
      subId1: "sub1-DECOY",
      subId2: "sub2-DECOY",
      subId3: "sub3-DECOY",
      rawPayloadId: "raw-DECOY",
      bankReceivedAt: "2026-09-15T10:30:00.000Z",
      mboReceivedDateTime: "2026-09-15 10:30",
      mboReceivedAmount: 9,
    };
    const order = { id: "o3", rawPayloadId: "raw-DECOY", networkContext: nc };
    const redacted = toAdminOrderDto(order, { includeFinancial: false });
    const full = toAdminOrderDto(order, { includeFinancial: true });
    for (const dto of [redacted, full]) {
      for (const key of RAW_FIELDS) assert.equal(key in dto, false, key);
      const body = JSON.stringify(dto);
      for (const decoy of DECOYS) assert.ok(!body.includes(decoy), `${decoy} leaked`);
    }
    for (const key of RECEIPT_FIELDS) assert.equal(redacted[key], null, key);
    assert.equal(full.bankReceivedAt, "2026-09-15T10:30:00.000Z");
    assert.equal(full.mboReceivedDateTime, "2026-09-15 10:30");
    assert.equal(full.mboReceivedAmount, 9);
  });

  it("redacted row is the authorized row minus commission and receipt values", async () => {
    const full = (await listOrders(FINANCE)).result.items[0];
    const redacted = (await listOrders(ANALYST)).result.items[0];
    const strip = (row) => {
      const clone = JSON.parse(JSON.stringify(row));
      for (const key of [...COMMISSION_FIELDS, ...RECEIPT_FIELDS, "mboReceived", "financial", "items"]) delete clone[key];
      return clone;
    };
    assert.deepEqual(strip(redacted), strip(full));
  });

  it("query, paging, sort and filters are identical for every caller", async () => {
    const query = {
      clientId: "cl-1",
      network: "optimise",
      q: "SO-1",
      supplierPaymentStatus: "payment_pending",
      validationStatus: "validation_pending",
      from: "2026-09-01",
      to: "2026-09-30",
      skip: 25,
      take: 25,
    };
    const a = await listOrders(ANALYST, query);
    const b = await listOrders(FINANCE, query);
    const findA = a.calls.find((c) => c.op === "order.findMany").args;
    const findB = b.calls.find((c) => c.op === "order.findMany").args;
    assert.deepEqual(findA.where, findB.where);
    assert.deepEqual(findA.orderBy, { orderDate: "desc" });
    assert.equal(findA.skip, 25);
    assert.equal(findA.take, 25);
    assert.equal(findA.where.clientId, "cl-1");
    assert.equal(findA.where.supplier, "OPTIMISE");
    assert.equal(findA.where.validationStatus, "VALIDATION_PENDING");
    assert.equal(findA.where.supplierPaymentStatus, "PAYMENT_PENDING");
    assert.equal(findA.where.AND.length, 2);
    assert.deepEqual(
      a.calls.find((c) => c.op === "order.count").args,
      b.calls.find((c) => c.op === "order.count").args,
    );
    // Ledger rows are still only loaded for financial callers (unchanged).
    assert.equal(findA.include.financialTransactions, false);
    assert.ok(findB.include.financialTransactions.select);

    for (const { result } of [a, b]) {
      assert.equal(result.total, 1);
      assert.equal(result.contract, "v15-07E-admin-orders");
    }
    const confirmed = await listOrders(ANALYST, { confirmedOnly: true, paidOnly: true });
    const where = confirmed.calls.find((c) => c.op === "order.findMany").args.where;
    assert.equal(where.validationStatus, "VALIDATION_APPROVED");
    assert.deepEqual(where.supplierPaymentStatus, { in: ["PAYMENT_PAYABLE", "PAYMENT_RECEIVED", "PAYMENT_INVOICED"] });
  });

  it("status fields keep their existing mapping", async () => {
    const [row] = (await listOrders(ANALYST)).result.items;
    assert.equal(row.orderStatus, "PENDING");
    assert.equal(row.mboStatus, "PENDING");
    assert.equal(row.rawStatus, "PENDING");
    assert.equal(row.attributionStatus, "ATTRIBUTED");
    assert.equal(row.attributionEvidence, "MBO_CLICK");
    const approved = toAdminOrderDto({ id: "o4", validationStatus: "VALIDATION_APPROVED", supplierPaymentStatus: "PAYMENT_RECEIVED", networkContext: {} });
    assert.equal(approved.orderStatus, "CONFIRMED");
    assert.equal(approved.mboStatus, "PAID");
  });

  it("route gate unchanged; controller still passes caller permissions", () => {
    const routes = fs.readFileSync(new URL("../src/routes/index.js", import.meta.url), "utf8");
    assert.ok(
      routes.includes(
        'router.get("/ops/admin/orders", authenticate, requirePermission(PERMISSIONS.CONVERSIONS_READ), adminListOrdersHandler);',
      ),
    );
    const controller = fs.readFileSync(new URL("../src/controllers/adminContract.controller.js", import.meta.url), "utf8");
    const handler = controller.slice(controller.indexOf("export async function adminListOrdersHandler"));
    assert.ok(handler.slice(0, 1500).includes("req.permissions || []"));
  });
});
