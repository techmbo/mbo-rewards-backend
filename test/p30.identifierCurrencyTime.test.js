/**
 * Pointer 30 — Identifier, currency and time rules.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  CONTRACT_POINTER,
  CURRENCY_RULES,
  IDENTIFIER_CURRENCY_TIME_SUMMARY,
  IDENTIFIER_RULES,
  IdentifierCurrencyTimeError,
  TIME_RULES,
  applyIdentifierCurrencyTimeContract,
  assertCurrencyPreservation,
  assertIdentifierSeparation,
  assertTimestampPreservation,
  buildIdentifierCurrencyTimeGuide,
} from "../src/modules/networkOps/identifierCurrencyTime.contract.js";
import { AiIntegrationGuideService } from "../src/modules/networkOps/aiIntegrationGuide.service.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

describe("Pointer 30 — identifierCurrencyTime.contract", () => {
  it("declares contract pointer 30 and verbatim identifier/currency/time rules", () => {
    assert.equal(CONTRACT_POINTER, 30);
    assert.match(IDENTIFIER_CURRENCY_TIME_SUMMARY.identifierRule, /Never use a supplier campaign\/order\/conversion ID as the primary MBO ID/);
    assert.match(IDENTIFIER_CURRENCY_TIME_SUMMARY.currencyRule, /Never infer currency from country/);
    assert.match(IDENTIFIER_CURRENCY_TIME_SUMMARY.timeRule, /without overwriting the original source value/);
    assert.ok(IDENTIFIER_RULES.supplierIdFields.includes("supplierCampaignId"));
    assert.ok(CURRENCY_RULES.conversionFields.includes("exchangeRate"));
    assert.equal(TIME_RULES.preferredNormalizedTimezone, "UTC");
  });

  it("assertIdentifierSeparation rejects supplier IDs used as MBO primary id", () => {
    assert.throws(
      () =>
        assertIdentifierSeparation({
          mboId: "502",
          mboIdField: "id",
          supplierId: "502",
          supplierIdField: "supplierCampaignId",
        }),
      (err) => {
        assert.equal(err instanceof IdentifierCurrencyTimeError, true);
        assert.equal(err.code, "SUPPLIER_ID_USED_AS_MBO_PRIMARY");
        return true;
      },
    );
    assert.doesNotThrow(() =>
      assertIdentifierSeparation({
        mboId: "mbo-uuid-1",
        supplierId: "502",
        supplierIdField: "supplierCampaignId",
      }),
    );
  });

  it("assertCurrencyPreservation rejects country-based inference", () => {
    assert.throws(
      () =>
        assertCurrencyPreservation({
          sourceTransactionCurrency: "USD",
          inferredFrom: "country",
        }),
      (err) => {
        assert.equal(err.code, "CURRENCY_INFERRED_FROM_COUNTRY");
        return true;
      },
    );
  });

  it("assertCurrencyPreservation requires full conversion metadata", () => {
    assert.throws(
      () =>
        assertCurrencyPreservation({
          sourceTransactionCurrency: "EUR",
          conversion: { convertedAmount: 100, targetCurrency: "USD" },
        }),
      (err) => {
        assert.equal(err.code, "CURRENCY_CONVERSION_FIELDS_INCOMPLETE");
        return true;
      },
    );
    assert.doesNotThrow(() =>
      assertCurrencyPreservation({
        sourceTransactionCurrency: "EUR",
        sourceCommissionCurrency: "EUR",
        conversion: {
          convertedAmount: 100,
          targetCurrency: "USD",
          exchangeRate: 1.08,
          rateSource: "ECB",
          rateDate: "2026-08-01",
        },
      }),
    );
  });

  it("assertTimestampPreservation requires normalized timestamp without overwriting source", () => {
    assert.throws(
      () =>
        assertTimestampPreservation({
          sourceTimestamp: "2026-08-01T10:00:00+04:00",
          sourceTimezone: "Asia/Dubai",
        }),
      (err) => {
        assert.equal(err.code, "NORMALIZED_TIMESTAMP_MISSING");
        return true;
      },
    );
    assert.doesNotThrow(() =>
      assertTimestampPreservation({
        sourceTimestamp: "2026-08-01T10:00:00+04:00",
        sourceTimezone: "Asia/Dubai",
        normalizedTimestamp: "2026-08-01T06:00:00.000Z",
      }),
    );
  });

  it("buildIdentifierCurrencyTimeGuide includes scoped object refs", () => {
    const globalGuide = buildIdentifierCurrencyTimeGuide();
    assert.equal(globalGuide.contractPointer, 30);

    const objectGuide = buildIdentifierCurrencyTimeGuide({ network: "optimise", sourceObject: "campaigns" });
    assert.match(objectGuide.objectRefs.mappingRegistry, /optimise\/campaigns\.mapping\.json/);
  });

  it("applyIdentifierCurrencyTimeContract stamps response meta", () => {
    const wrapped = applyIdentifierCurrencyTimeContract(
      { ok: true, data: {} },
      { network: "optimise", sourceObject: "campaigns" },
    );
    assert.equal(wrapped.meta.identifierCurrencyTimePointer, 30);
    assert.equal(wrapped.meta.identifierCurrencyTimeNetwork, "optimise");
  });
});

describe("Pointer 30 — AI integration guide includes identifier/currency/time rules", () => {
  const guide = new AiIntegrationGuideService();

  it("global guide exposes identifierCurrencyTimeRules", () => {
    const payload = guide.getGlobalGuide();
    assert.equal(payload.identifierCurrencyTimePointer, 30);
    assert.equal(payload.identifierCurrencyTimeRules.contractPointer, 30);
    assert.ok(payload.identifierCurrencyTimeRules.currencyRules.conversionFields.length >= 5);
  });

  it("object guide includes scoped identifier/currency/time refs", () => {
    const payload = guide.getObjectGuide("optimise", "campaigns");
    assert.equal(payload.identifierCurrencyTimeRules.contractPointer, 30);
    assert.match(payload.identifierCurrencyTimeRules.objectRefs.orderIngestion, /orderIngestion/);
  });
});

describe("Pointer 30 — GET /ops/network/ai-integration-guide", () => {
  /** @type {{ baseUrl: string, close: () => Promise<void> } | null} */
  let server = null;

  before(async () => {
    server = await startTestServer();
  });

  after(async () => {
    if (server) await server.close();
  });

  it("returns 401 without auth for global guide", async () => {
    const { status } = await apiRequest(server.baseUrl, {
      path: "/ops/network/ai-integration-guide",
    });
    assert.equal(status, 401);
  });
});
