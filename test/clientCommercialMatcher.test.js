import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildClientCommercialFacts,
  evaluateClientCommercialCondition,
  matchClientCommercialRule,
} from "../src/modules/commercial/clientCommercialMatcher.js";

describe("Client Commercial Matcher", () => {
  const at = new Date("2026-09-02T12:00:00.000Z");

  it("requires resolved attribution before selecting a client rule", () => {
    const result = matchClientCommercialRule({
      rules: [{ id: "default", status: "EFFECTIVE", effectiveFrom: "2026-01-01T00:00:00Z" }],
      attributionResolved: false,
      at,
    });
    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.equal(result.reason, "attribution_unresolved");
  });

  it("prefers a specific country rule over a default rule", () => {
    const result = matchClientCommercialRule({
      attributionResolved: true,
      assignmentId: "a1",
      at,
      facts: { country: "AE" },
      rules: [
        {
          id: "default",
          assignmentId: "a1",
          status: "EFFECTIVE",
          effectiveFrom: "2026-01-01T00:00:00Z",
          conditions: [{ conditionType: "DEFAULT" }],
        },
        {
          id: "ae",
          assignmentId: "a1",
          status: "EFFECTIVE",
          effectiveFrom: "2026-01-01T00:00:00Z",
          conditions: [{ conditionType: "COUNTRY", value: "AE" }],
        },
      ],
    });
    assert.equal(result.status, "MATCHED");
    assert.equal(result.matchedClientCommissionRuleId, "ae");
  });

  it("fails closed when a potentially winning specific rule lacks facts", () => {
    const result = matchClientCommercialRule({
      attributionResolved: true,
      at,
      facts: {},
      rules: [
        {
          id: "default",
          status: "EFFECTIVE",
          effectiveFrom: "2026-01-01T00:00:00Z",
          conditions: [{ conditionType: "DEFAULT" }],
        },
        {
          id: "country-specific",
          status: "EFFECTIVE",
          effectiveFrom: "2026-01-01T00:00:00Z",
          conditions: [{ conditionType: "COUNTRY", value: "AE" }],
        },
      ],
    });
    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.match(result.reviewReasons.join(" "), /missing_fact:COUNTRY/);
  });

  it("returns review required for equal-specificity ambiguous client rules", () => {
    const result = matchClientCommercialRule({
      attributionResolved: true,
      at,
      facts: { country: "AE" },
      rules: [
        {
          id: "r1",
          status: "EFFECTIVE",
          effectiveFrom: "2026-01-01T00:00:00Z",
          conditions: [{ conditionType: "COUNTRY", value: "AE" }],
        },
        {
          id: "r2",
          status: "EFFECTIVE",
          effectiveFrom: "2026-01-01T00:00:00Z",
          conditions: [{ conditionType: "COUNTRY", value: "AE" }],
        },
      ],
    });
    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.equal(result.reason, "ambiguous_client_commercial_rules");
  });

  it("uses explicit verified priority only when precedence is verified", () => {
    const result = matchClientCommercialRule({
      attributionResolved: true,
      at,
      facts: { country: "AE" },
      rules: [
        {
          id: "r1",
          status: "EFFECTIVE",
          effectiveFrom: "2026-01-01T00:00:00Z",
          priority: 1,
          metadata: { clientPrecedenceVerified: true, precedenceDirection: "LOWER_FIRST" },
          conditions: [{ conditionType: "COUNTRY", value: "AE" }],
        },
        {
          id: "r2",
          status: "EFFECTIVE",
          effectiveFrom: "2026-01-01T00:00:00Z",
          priority: 2,
          metadata: { clientPrecedenceVerified: true, precedenceDirection: "LOWER_FIRST" },
          conditions: [{ conditionType: "COUNTRY", value: "AE" }],
        },
      ],
    });
    assert.equal(result.status, "MATCHED");
    assert.equal(result.matchedClientCommissionRuleId, "r1");
  });

  it("filters future and expired rules by the transaction date", () => {
    const result = matchClientCommercialRule({
      attributionResolved: true,
      at,
      facts: { country: "AE" },
      rules: [
        {
          id: "expired",
          status: "EFFECTIVE",
          effectiveFrom: "2026-01-01T00:00:00Z",
          effectiveUntil: "2026-08-01T00:00:00Z",
          conditions: [{ conditionType: "COUNTRY", value: "AE" }],
        },
        {
          id: "current",
          status: "EFFECTIVE",
          effectiveFrom: "2026-08-01T00:00:00Z",
          effectiveUntil: "2026-10-01T00:00:00Z",
          conditions: [{ conditionType: "COUNTRY", value: "AE" }],
        },
        {
          id: "future",
          status: "EFFECTIVE",
          effectiveFrom: "2026-10-01T00:00:00Z",
          conditions: [{ conditionType: "COUNTRY", value: "AE" }],
        },
      ],
    });
    assert.equal(result.status, "MATCHED");
    assert.equal(result.matchedClientCommissionRuleId, "current");
  });

  it("blocks campaign summary fields as client earnings bases", () => {
    const result = matchClientCommercialRule({
      attributionResolved: true,
      at,
      facts: { country: "AE" },
      rules: [
        {
          id: "bad-basis",
          status: "EFFECTIVE",
          effectiveFrom: "2026-01-01T00:00:00Z",
          calculationBasis: "avg_commission",
          conditions: [{ conditionType: "COUNTRY", value: "AE" }],
        },
      ],
    });
    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.match(result.reviewReasons.join(" "), /forbidden_client_earnings_basis/);
  });

  it("evaluates numeric order-value conditions without string comparison", () => {
    assert.deepEqual(
      evaluateClientCommercialCondition(
        { conditionType: "ORDER_VALUE", operator: "GTE", value: 1000 },
        { orderValue: 1500 },
      ),
      { state: "MATCH" },
    );
  });

  it("builds evidenced facts without inventing missing values", () => {
    const facts = buildClientCommercialFacts({
      order: { orderValue: 1500, orderDate: "2026-09-02T10:00:00Z", metadata: { country: "AE" } },
      conversion: { metadata: { customerType: "NEW" } },
      assignment: { canonicalCampaignId: "camp-1" },
    });
    assert.equal(facts.country, "AE");
    assert.equal(facts.customerType, "NEW");
    assert.equal(facts.orderValue, 1500);
    assert.equal(facts.campaign, "camp-1");
    assert.equal(facts.product, undefined);
  });
});
