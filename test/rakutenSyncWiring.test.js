import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRakutenEventWindow,
  buildRakutenPaymentHistoryWindow,
} from "../src/jobs/rakutenSupplierSync.js";
import { listSourceObjectCatalog } from "../src/modules/networkOps/sourceObjects.catalog.js";
import { extractNetworkConversionId } from "../src/modules/order/orderConversionIngestion.contract.js";

describe("Rakuten sync wiring", () => {
  it("builds an overlapped incremental Events process-date window", () => {
    const window = buildRakutenEventWindow({
      lastSuccessfulSync: "2026-09-03T00:00:00Z",
      now: "2026-09-03T12:00:00Z",
      overlapDays: 2,
    });
    assert.equal(window.process_date_start, "2026-09-01 00:00:00");
    assert.equal(window.process_date_end, "2026-09-03 12:00:00");
  });

  it("clamps a stale lastSuccessfulSync to the Events 30-day process window", () => {
    const window = buildRakutenEventWindow({
      lastSuccessfulSync: "2026-01-01T00:00:00Z",
      now: "2026-09-03T12:00:00Z",
      overlapDays: 2,
    });
    assert.equal(window.process_date_start, "2026-08-04 12:00:00");
    assert.equal(window.process_date_end, "2026-09-03 12:00:00");
  });

  it("builds Advanced Reports payment history dates as YYYYMMDD", () => {
    const window = buildRakutenPaymentHistoryWindow({
      now: "2026-09-03T12:00:00Z",
      daysBack: 10,
    });
    assert.deepEqual(window, { bdate: "20260824", edate: "20260903" });
  });

  it("activates only the verified Rakuten JSON/CSV source objects", () => {
    const byKey = new Map(listSourceObjectCatalog("rakuten").map((item) => [item.sourceObject, item]));
    for (const key of [
      "advertisers",
      "partnerships",
      "offers",
      "commissioning_lists",
      "events",
      "advanced_reports",
    ]) {
      assert.equal(byKey.get(key)?.live, true, `${key} should be live`);
    }
    for (const key of ["coupons", "products", "links"]) {
      assert.equal(byKey.get(key)?.live, false, `${key} should remain gated`);
    }
  });

  it("uses Rakuten etransaction_id as component-level conversion identity", () => {
    assert.equal(
      extractNetworkConversionId({
        etransaction_id: "evt-123",
        order_id: "ORDER-55",
      }),
      "evt-123",
    );
  });
});
