import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  inferMboTargetObject,
  MBO_CANONICAL_OBJECT,
  MBO_CANONICAL_OBJECT_LIST,
  mboCanonicalObjectLabel,
  normalizeMboCanonicalObject,
} from "../src/modules/mapping/mboCanonicalObjects.contract.js";

describe("MBO canonical objects (pointer 8)", () => {
  it("defines exactly 19 separate canonical objects", () => {
    assert.equal(MBO_CANONICAL_OBJECT_LIST.length, 19);
    assert.ok(MBO_CANONICAL_OBJECT_LIST.includes(MBO_CANONICAL_OBJECT.ORDER_CONVERSION));
    assert.ok(MBO_CANONICAL_OBJECT_LIST.includes(MBO_CANONICAL_OBJECT.NETWORK_CAMPAIGN));
    assert.ok(MBO_CANONICAL_OBJECT_LIST.includes(MBO_CANONICAL_OBJECT.EXCEPTION));
    assert.equal(MBO_CANONICAL_OBJECT_LIST.includes("Entity"), false);
    assert.equal(MBO_CANONICAL_OBJECT_LIST.includes("Assets"), false);
  });

  it("normalizes legacy informal labels", () => {
    assert.equal(normalizeMboCanonicalObject("Order"), MBO_CANONICAL_OBJECT.ORDER_CONVERSION);
    assert.equal(normalizeMboCanonicalObject("Commission"), MBO_CANONICAL_OBJECT.SUPPLIER_COMMISSION_RULE);
    assert.equal(normalizeMboCanonicalObject("Attribution"), MBO_CANONICAL_OBJECT.CLIENT_CAMPAIGN_ASSIGNMENT);
    assert.equal(normalizeMboCanonicalObject("Entity"), MBO_CANONICAL_OBJECT.EXCEPTION);
    assert.equal(normalizeMboCanonicalObject("Assets"), MBO_CANONICAL_OBJECT.EXCEPTION);
  });

  it("infers from canonical field paths", () => {
    assert.equal(
      inferMboTargetObject("conversions", "attribution.assignmentId"),
      MBO_CANONICAL_OBJECT.CLIENT_CAMPAIGN_ASSIGNMENT,
    );
    assert.equal(
      inferMboTargetObject("conversions", "supplierCommission"),
      MBO_CANONICAL_OBJECT.ORDER_CONVERSION,
    );
    assert.equal(
      inferMboTargetObject("campaigns", "defaultCommissionValue"),
      MBO_CANONICAL_OBJECT.SUPPLIER_COMMISSION_RULE,
    );
    assert.equal(
      inferMboTargetObject("campaigns", "campaignName"),
      MBO_CANONICAL_OBJECT.NETWORK_CAMPAIGN,
    );
    assert.equal(
      inferMboTargetObject("campaigns", "merchantNameRaw"),
      MBO_CANONICAL_OBJECT.BRAND,
    );
  });

  it("infers from source objects when field is absent", () => {
    assert.equal(
      inferMboTargetObject("conversions", null),
      MBO_CANONICAL_OBJECT.ORDER_CONVERSION,
    );
    assert.equal(
      inferMboTargetObject("campaigns", null),
      MBO_CANONICAL_OBJECT.NETWORK_CAMPAIGN,
    );
    assert.equal(
      inferMboTargetObject("products", null),
      MBO_CANONICAL_OBJECT.PRODUCT,
    );
    assert.equal(
      inferMboTargetObject("invoices", null),
      MBO_CANONICAL_OBJECT.NETWORK_INVOICE_BILLING,
    );
    assert.equal(
      inferMboTargetObject("link_reports", null),
      MBO_CANONICAL_OBJECT.TRACKING_LINK,
    );
  });

  it("respects declared object override on mapping fields", () => {
    assert.equal(
      inferMboTargetObject("unknown_thing", "someField", {
        declaredObject: "ClientPayable",
      }),
      MBO_CANONICAL_OBJECT.CLIENT_PAYABLE,
    );
  });

  it("falls back to Exception for unclassifiable source objects", () => {
    assert.equal(
      inferMboTargetObject("totally_unknown_xyz", null),
      MBO_CANONICAL_OBJECT.EXCEPTION,
    );
  });

  it("provides human labels for UI", () => {
    assert.equal(mboCanonicalObjectLabel("OrderConversion"), "Order / Conversion");
    assert.equal(mboCanonicalObjectLabel("NetworkInvoiceBilling"), "Network Invoice / Billing");
  });
});
