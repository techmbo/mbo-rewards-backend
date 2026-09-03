import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAdmitadActionParams,
  createAdmitadAdapter,
  extractAdmitadCollection,
  extractAdmitadMeta,
  normalizeAdmitadActionEvidence,
} from "../src/adapters/admitad.adapter.js";

describe("Admitad publisher adapter foundation", () => {
  it("extracts list payloads and limit-offset metadata", () => {
    const payload = {
      results: [{ id: 1 }, { id: 2 }],
      _meta: { count: 12, limit: 2, offset: 4 },
    };
    assert.deepEqual(extractAdmitadCollection(payload), [{ id: 1 }, { id: 2 }]);
    assert.deepEqual(extractAdmitadMeta(payload), { count: 12, limit: 2, offset: 4 });
  });

  it("only forwards verified action filters", () => {
    const params = buildAdmitadActionParams({
      status_updated_start: "2026-09-01T00:00:00Z",
      status_updated_end: "2026-09-02T00:00:00Z",
      campaign: 123,
      subid1: "mbo-click-1",
      paid: true,
      invented_field: "must-not-pass",
    });
    assert.equal(params.status_updated_start, "2026-09-01T00:00:00Z");
    assert.equal(params.status_updated_end, "2026-09-02T00:00:00Z");
    assert.equal(params.campaign, 123);
    assert.equal(params.subid1, "mbo-click-1");
    assert.equal(params.paid, true);
    assert.equal(params.order_by, "datetime");
    assert.equal(Object.prototype.hasOwnProperty.call(params, "invented_field"), false);
  });

  it("preserves status, processed and paid as separate source facts", () => {
    const row = normalizeAdmitadActionEvidence({
      action_id: "a-1",
      status: "approved",
      processed: 1,
      paid: 1,
      subid: "root",
      subid1: "click-1",
    });
    assert.equal(row.actionId, "a-1");
    assert.equal(row.networkRawStatus, "approved");
    assert.equal(row.networkProcessed, 1);
    assert.equal(row.networkPaid, 1);
    assert.equal(row.subid, "root");
    assert.equal(row.subid1, "click-1");
    assert.equal(Object.prototype.hasOwnProperty.call(row, "mboOrderStatus"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(row, "mboReceivedAt"), false);
  });

  it("declares only the implemented Admitad source surface", () => {
    const adapter = createAdmitadAdapter({ accessToken: "test-token" });
    const caps = adapter.getCapabilities();
    assert.equal(adapter.supplierKey, "ADMITAD");
    assert.equal(caps.pagination, "offset");
    assert.equal(caps.capabilities.includes("CAMPAIGNS"), true);
    assert.equal(caps.capabilities.includes("COUPONS"), true);
    assert.equal(caps.capabilities.includes("CONVERSIONS"), true);
    assert.equal(caps.capabilities.includes("PRODUCTS"), false);
    assert.equal(caps.capabilities.includes("PAYMENTS"), false);
  });

  it("requires an OAuth bearer access token", () => {
    assert.throws(() => createAdmitadAdapter(), /requires accessToken/i);
  });
});
