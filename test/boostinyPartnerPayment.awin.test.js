import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BOOSTINY_PARTNER_PAYMENT_FIELDS,
  validateExactHeaders,
  buildSettlementKey,
} from "../src/modules/boostiny/partnerPayment.fields.js";
import { parsePartnerPaymentCsv, parseCsvText } from "../src/modules/boostiny/partnerPayment.parse.js";
import { boostinyPerformanceGranularity } from "../src/modules/boostiny/boostinyRecords.js";
import { mapAwinTransaction } from "../src/modules/supplier/mappers/awin.mapper.js";
import { createAwinAdapter } from "../src/adapters/awin.adapter.js";
import { isSupplierRegistered, getSupplierCapabilities } from "../src/adapters/registry.js";

const VALID_CSV = `Payment source,Cycle,Legal entity name,Orders,Revenue,Sales amount USD,Extra,Deduction,Delayed
BrandX,2026-01,MBO LLC,10,100.5,90.0,1,2,0
BrandY,2026-01,MBO LLC,5,50,45,0,0,1
`;

describe("Boostiny Partner Payment CSV", () => {
  it("requires exact 9 headers", () => {
    const ok = validateExactHeaders([...BOOSTINY_PARTNER_PAYMENT_FIELDS]);
    assert.equal(ok.ok, true);

    const bad = validateExactHeaders(["Payment source", "Cycle"]);
    assert.equal(bad.ok, false);
    assert.ok(bad.missing.length >= 1);
  });

  it("rejects extra columns", () => {
    const headers = [...BOOSTINY_PARTNER_PAYMENT_FIELDS, "Bonus"];
    const bad = validateExactHeaders(headers);
    assert.equal(bad.ok, false);
    assert.ok(bad.unknown.includes("bonus"));
  });

  it("parses valid CSV rows", () => {
    const parsed = parsePartnerPaymentCsv(VALID_CSV);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.rows.length, 2);
    assert.equal(parsed.rows[0].paymentSource, "BrandX");
    assert.equal(parsed.rows[0].cycle, "2026-01");
    assert.equal(parsed.rows[0].orders, 10);
    assert.equal(parsed.rows[0].revenue, 100.5);
  });

  it("builds settlement key from payment source + cycle", () => {
    assert.equal(
      buildSettlementKey({ paymentSource: "BrandX", cycle: "2026-01" }),
      "BOOSTINY|default|BrandX|2026-01",
    );
  });

  it("parses quoted commas", () => {
    const rows = parseCsvText('a,b\n"x,y",z\n');
    assert.deepEqual(rows[1], ["x,y", "z"]);
  });
});

describe("Boostiny performance granularity", () => {
  it("order_id present → ORDER_LEVEL without inventing ids", () => {
    const g = boostinyPerformanceGranularity({ order_id: "abc-1" });
    assert.equal(g.granularity, "ORDER_LEVEL");
    assert.equal(g.orderId, "abc-1");
    assert.equal(g.inventOrderId, false);
  });

  it("order_id absent → AGGREGATE", () => {
    const g = boostinyPerformanceGranularity({ campaign_id: 9 });
    assert.equal(g.granularity, "AGGREGATE");
    assert.equal(g.orderId, null);
    assert.equal(g.inventOrderId, false);
  });
});

describe("Awin adapter foundation", () => {
  it("registers AWIN in supplier registry", () => {
    assert.equal(isSupplierRegistered("AWIN"), true);
    const caps = getSupplierCapabilities("AWIN");
    assert.ok(caps.capabilities.includes("CONVERSIONS"));
  });

  it("requires accessToken and publisherId", () => {
    assert.throws(() => createAwinAdapter({}), /accessToken/);
    assert.throws(() => createAwinAdapter({ accessToken: "t" }), /publisherId/);
  });

  it("rejects transaction windows over 31 days", async () => {
    const adapter = createAwinAdapter({ accessToken: "t", publisherId: "123" });
    await assert.rejects(
      () =>
        adapter.fetchConversions({
          startDate: "2026-01-01",
          endDate: "2026-03-01",
        }),
      /31 days/,
    );
  });

  it("maps Awin transaction with clickRefs", () => {
    const mapped = mapAwinTransaction({
      id: "tx-1",
      advertiserId: 99,
      commissionStatus: "approved",
      commissionAmount: { amount: 12.5, currency: "GBP" },
      saleAmount: { amount: 100, currency: "GBP" },
      transactionDate: "2026-01-15T00:00:00Z",
      clickRef: "client-a",
      clickRef2: "assign-b",
      clickRef3: "click-c",
    });
    assert.equal(mapped.supplier, "AWIN");
    assert.equal(mapped.supplierConversionId, "tx-1");
    assert.equal(mapped.status, "APPROVED");
    assert.equal(mapped.supplierCommission, 12.5);
    assert.equal(mapped.metadata.attributionHints.subId, "client-a");
    assert.equal(mapped.metadata.clickRefs.clickRef2, "assign-b");
  });
});
