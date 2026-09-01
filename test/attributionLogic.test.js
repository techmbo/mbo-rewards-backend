/**
 * Pointer 15 — Attribution logic contract tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ATTRIBUTION_EVIDENCE,
  ATTRIBUTION_PRIORITY,
  ATTRIBUTION_REVIEW_REASON,
  attributionEvidenceLabel,
  attributionReviewReasonLabel,
  buildAttributedMetadata,
  buildAttributionReviewMetadata,
  classifyAttributionPriority,
  extractAttributionHints,
  extractCouponCodeHint,
  isClientIdOnlyAttributionHints,
  resolveDisplayClientFromConversion,
  shouldExposeClientFromConversion,
} from "../src/modules/reporting/attributionLogic.contract.js";

describe("Pointer 15 — attributionLogic.contract", () => {
  it("extractAttributionHints maps Partnerize-style SubIDs and coupon", () => {
    const hints = extractAttributionHints({
      clickref: "click-99",
      pubref: "assign-1",
      adref: "client-abc",
      voucher: "SAVE10",
    });
    assert.equal(hints.clickId, "click-99");
    assert.equal(hints.assignmentId, "assign-1");
    assert.equal(hints.clientId, "client-abc");
    assert.equal(hints.couponCode, "SAVE10");
  });

  it("isClientIdOnlyAttributionHints rejects client id without stronger token", () => {
    assert.equal(isClientIdOnlyAttributionHints({ clientId: "c1" }), true);
    assert.equal(isClientIdOnlyAttributionHints({ clientId: "c1", clickId: "x" }), false);
    assert.equal(isClientIdOnlyAttributionHints({ assignmentId: "a1" }), false);
  });

  it("classifyAttributionPriority orders evidence and review", () => {
    assert.equal(
      classifyAttributionPriority({ evidence: ATTRIBUTION_EVIDENCE.MBO_CLICK }),
      ATTRIBUTION_PRIORITY.MBO_CLICK_OR_TOKEN,
    );
    assert.equal(
      classifyAttributionPriority({ evidence: ATTRIBUTION_EVIDENCE.UNIQUE_COUPON }),
      ATTRIBUTION_PRIORITY.UNIQUE_COUPON,
    );
    assert.equal(
      classifyAttributionPriority({ reviewRequired: true }),
      ATTRIBUTION_PRIORITY.REVIEW_REQUIRED,
    );
    assert.equal(classifyAttributionPriority({}), ATTRIBUTION_PRIORITY.UNATTRIBUTED);
  });

  it("buildAttributionReviewMetadata captures shared coupon ambiguity", () => {
    const meta = buildAttributionReviewMetadata({
      reason: ATTRIBUTION_REVIEW_REASON.SHARED_COUPON,
      evidence: ATTRIBUTION_EVIDENCE.UNIQUE_COUPON,
      candidateAssignmentIds: ["a1", "a2"],
      couponCode: "SHARED",
    });
    assert.equal(meta.reason, ATTRIBUTION_REVIEW_REASON.SHARED_COUPON);
    assert.deepEqual(meta.candidateAssignmentIds, ["a1", "a2"]);
    assert.equal(meta.priority, ATTRIBUTION_PRIORITY.REVIEW_REQUIRED);
  });

  it("buildAttributedMetadata stores evidence on conversion metadata", () => {
    const meta = buildAttributedMetadata({}, { evidence: ATTRIBUTION_EVIDENCE.TRACKING_LINK });
    assert.equal(meta.attributionEvidence, ATTRIBUTION_EVIDENCE.TRACKING_LINK);
    assert.equal(meta.attributionPriority, ATTRIBUTION_PRIORITY.MBO_CLICK_OR_TOKEN);
    assert.equal(meta.mboCanonicalObject, "OrderConversion");
  });

  it("extractCouponCodeHint prefers attributionHints then metadata", () => {
    assert.equal(
      extractCouponCodeHint({ metadata: { attributionHints: { couponCode: "A" } } }),
      "A",
    );
    assert.equal(extractCouponCodeHint({ metadata: { couponCode: "B" } }), "B");
    assert.equal(extractCouponCodeHint({ metadata: {} }), null);
  });

  it("shouldExposeClientFromConversion only for ATTRIBUTED / REATTRIBUTED", () => {
    assert.equal(shouldExposeClientFromConversion({ attributionStatus: "ATTRIBUTED" }), true);
    assert.equal(shouldExposeClientFromConversion({ attributionStatus: "REATTRIBUTED" }), true);
    assert.equal(shouldExposeClientFromConversion({ attributionStatus: "ORPHAN" }), false);
    assert.equal(shouldExposeClientFromConversion({ attributionStatus: "REVIEW_REQUIRED" }), false);
  });

  it("resolveDisplayClientFromConversion never guesses client from non-attributed conversion", () => {
    const conv = {
      attributionStatus: "REVIEW_REQUIRED",
      clientAssignment: { clientId: "c1", client: { id: "c1", name: "Hidden Client" } },
    };
    assert.deepEqual(resolveDisplayClientFromConversion(conv, null), {
      clientId: null,
      clientName: null,
    });
  });

  it("resolveDisplayClientFromConversion uses order FK first", () => {
    const order = { clientId: "o1", client: { name: "Order Client" } };
    const conv = {
      attributionStatus: "ATTRIBUTED",
      clientAssignment: { client: { id: "c1", name: "Conv Client" } },
    };
    assert.deepEqual(resolveDisplayClientFromConversion(conv, order), {
      clientId: "o1",
      clientName: "Order Client",
    });
  });

  it("resolveDisplayClientFromConversion exposes assignment client when ATTRIBUTED", () => {
    const conv = {
      attributionStatus: "ATTRIBUTED",
      clientAssignment: { clientId: "c1", client: { id: "c1", name: "Acme" } },
    };
    assert.deepEqual(resolveDisplayClientFromConversion(conv, null), {
      clientId: "c1",
      clientName: "Acme",
    });
  });

  it("attributionEvidenceLabel and review reason labels are human-readable", () => {
    assert.equal(attributionEvidenceLabel(ATTRIBUTION_EVIDENCE.MBO_CLICK), "MBO Click");
    assert.equal(
      attributionReviewReasonLabel(ATTRIBUTION_REVIEW_REASON.SHARED_COUPON),
      "Shared coupon — multiple clients",
    );
  });
});
