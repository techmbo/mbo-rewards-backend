import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PromotionJob } from "../src/jobs/promotion.job.js";

describe("Rakuten commission promotion hook", () => {
  it("runs after campaign promotion and exposes the commission summary", async () => {
    let hookCalls = 0;
    const job = new PromotionJob({
      promotionService: { ensureSuppliersSeeded: async () => {} },
      entityRepo: { findManyForPromotion: async () => [] },
      rakutenCommissionPromotion: async () => {
        hookCalls += 1;
        return { examined: 2, persisted: 1, financeReady: 1, reviewRequired: 1, skipped: 0 };
      },
    });

    const result = await job.run({ networkSource: "rakuten", entityTypes: ["campaign"] });

    assert.equal(hookCalls, 1);
    assert.equal(result.rakutenCommissionPromotion.persisted, 1);
    assert.equal(result.rakutenCommissionPromotion.reviewRequired, 1);
  });

  it("does not run the Rakuten commission hook for another network", async () => {
    let hookCalls = 0;
    const job = new PromotionJob({
      promotionService: { ensureSuppliersSeeded: async () => {} },
      entityRepo: { findManyForPromotion: async () => [] },
      rakutenCommissionPromotion: async () => {
        hookCalls += 1;
        return {};
      },
    });

    await job.run({ networkSource: "awin", entityTypes: ["campaign"] });
    assert.equal(hookCalls, 0);
  });
});
