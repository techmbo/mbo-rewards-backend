import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRakutenEventParams,
  createRakutenAdapter,
  extractRakutenCollection,
  extractRakutenPagination,
  normalizeRakutenEventEvidence,
  parseCsv,
  parseRakutenAdvancedReport,
} from "../src/adapters/rakuten.adapter.js";

describe("Rakuten publisher adapter foundation", () => {
  it("extracts wrapped JSON collections and pagination metadata", () => {
    const payload = {
      advertisers: [{ id: 1 }, { id: 2 }],
      _metadata: {
        page: 2,
        limit: 100,
        total: 250,
        _links: { next: "/v2/advertisers?page=3" },
      },
    };
    assert.deepEqual(extractRakutenCollection(payload, ["advertisers"]), [{ id: 1 }, { id: 2 }]);
    assert.deepEqual(extractRakutenPagination(payload), {
      page: 2,
      limit: 100,
      total: 250,
      next: "/v2/advertisers?page=3",
    });
  });

  it("requires paired Rakuten Events date filters", () => {
    assert.deepEqual(
      buildRakutenEventParams({
        process_date_start: "2026-09-01 00:00:00",
        process_date_end: "2026-09-02 00:00:00",
      }),
      {
        process_date_start: "2026-09-01 00:00:00",
        process_date_end: "2026-09-02 00:00:00",
        limit: 100,
        page: 1,
      },
    );

    assert.throws(
      () => buildRakutenEventParams({ process_date_start: "2026-09-01 00:00:00" }),
      /must be supplied together/i,
    );
  });

  it("keeps Rakuten event component identity separate from advertiser order identity", () => {
    const row = normalizeRakutenEventEvidence({
      etransaction_id: "evt-101",
      order_id: "order-55",
      advertiser_id: 77,
      sid: 88,
      sku_number: "SKU-1",
      sale_amount: "49.95",
      quantity: 2,
      commissions: "5.00",
      u1: "mbo-click-1",
      currency: "USD",
      lock_status: "locked",
      is_event: true,
    });

    assert.equal(row.networkConversionComponentId, "evt-101");
    assert.equal(row.networkOrderReference, "order-55");
    assert.equal(row.attributionU1, "mbo-click-1");
    assert.equal(row.networkRawLockStatus, "locked");
    assert.equal(row.networkEventIndicator, true);
    assert.equal(Object.prototype.hasOwnProperty.call(row, "mboOrderStatus"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(row, "mboReceivedAt"), false);
  });

  it("parses quoted CSV fields without splitting embedded commas", () => {
    const rows = parseCsv('Payment ID,Payment Status,Note\n123,Paid,"hello, world"\n');
    assert.deepEqual(rows, [
      ["Payment ID", "Payment Status", "Note"],
      ["123", "Paid", "hello, world"],
    ]);
  });

  it("normalizes Advanced Report payment history without inventing MBO receipt", () => {
    const csv = [
      "Payment ID,Date,Payment Type,Check Number,Currency Code,Total Commission Amount Paid,Payment Status",
      "p-1,2026-09-01,ACH,ck-1,USD,120.50,Paid",
    ].join("\n");
    const [row] = parseRakutenAdvancedReport(csv, 1);
    assert.equal(row.payment_id, "p-1");
    assert.equal(row.payment_amount, "120.50");
    assert.equal(row.network_payment_status, "Paid");
    assert.equal(Object.prototype.hasOwnProperty.call(row, "mboReceivedAt"), false);
  });

  it("normalizes Advanced Report invoice and transaction detail evidence", () => {
    const invoiceCsv = [
      "Invoice Date,Advertiser ID,Advertiser,Invoice Number,Transaction Commissions,Bonus Amount,CPM & CPC Commissions,Held Commissions,Cancelled Commissions,Previously Held Commissions,VAT/GST,Payment Amount,Advertiser Payment Date",
      "2026-08-31,42,Brand A,INV-9,90,5,0,0,0,0,0,95,2026-09-01",
    ].join("\n");
    const [invoice] = parseRakutenAdvancedReport(invoiceCsv, 22);
    assert.equal(invoice.invoice_number, "INV-9");
    assert.equal(invoice.advertiser_payment_date, "2026-09-01");
    assert.equal(Object.prototype.hasOwnProperty.call(invoice, "mboReceivedAt"), false);

    const detailCsv = [
      "Date,Time,Advertiser ID,Advertiser,Order ID,SKU #,Product Name,Items,Sales,Baseline Commission,Adjusted Commission,Actual Commission,Transaction Payment Status,Reason,Advertiser Payment Memo,Advertiser Payment Date",
      "2026-08-30,12:00:00,42,Brand A,ORDER-1,SKU-1,Item,1,100,10,10,10,Paid,,memo,2026-09-01",
    ].join("\n");
    const [detail] = parseRakutenAdvancedReport(detailCsv, 23);
    assert.equal(detail.order_id, "ORDER-1");
    assert.equal(detail.actual_commission, "10");
    assert.equal(detail.transaction_payment_status, "Paid");
    assert.equal(Object.prototype.hasOwnProperty.call(detail, "mboOrderStatus"), false);
  });

  it("declares only the currently implemented Rakuten source surface", () => {
    const adapter = createRakutenAdapter({ accessToken: "test-token" });
    const caps = adapter.getCapabilities();
    assert.equal(adapter.supplierKey, "RAKUTEN");
    assert.equal(caps.capabilities.includes("CAMPAIGNS"), true);
    assert.equal(caps.capabilities.includes("CONVERSIONS"), true);
    assert.equal(caps.capabilities.includes("PAYMENTS"), true);
    assert.equal(caps.capabilities.includes("COUPONS"), false);
    assert.equal(caps.capabilities.includes("PRODUCTS"), false);
  });

  it("requires Bearer access token but only requires security token for Advanced Reports", async () => {
    assert.throws(() => createRakutenAdapter(), /requires accessToken/i);
    const adapter = createRakutenAdapter({ accessToken: "test-token" });
    await assert.rejects(
      () => adapter.fetchPaymentHistory({ bdate: "20260901", edate: "20260902" }),
      /require securityToken/i,
    );
  });
});
