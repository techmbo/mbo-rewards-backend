import test from "node:test";
import assert from "node:assert/strict";
import {
  mapPayload,
  mapWithDefinition,
  clearMappingCache,
  MappingReplayService,
  buildMappingReview,
} from "../src/modules/mapping/index.js";
import {
  createSupplierAdapter,
  listRegisteredSuppliers,
  isSupplierRegistered,
  getSupplierCapabilities,
  normalizeSupplierKey,
} from "../src/adapters/registry.js";
import { assertAdapterContract } from "../src/adapters/contract.js";
import { mapImpactCampaign } from "../src/modules/supplier/mappers/impact.mapper.js";
import { mapPartnerizeCampaign } from "../src/modules/supplier/mappers/partnerize.mapper.js";
import { mapEntityToConversionIngest, extractAttributionHints } from "../src/modules/reporting/services/conversionPromotion.service.js";
import { getTrackingParamRule, buildAttributionQueryParams } from "../src/modules/tracking/trackingParamRules.js";
import { hashPayload } from "../src/modules/raw/rawPayload.service.js";

test("Wave E — mapping engine", async (t) => {
  clearMappingCache();

  await t.test("maps simple + nested COALESCE fields", () => {
    const result = mapPayload({
      supplier: "PARTNERIZE",
      resourceKey: "campaigns",
      payload: {
        campaign_id: "pz-1",
        title: "Nike Run",
        advertiser_name: "Nike",
        tracking_link: "https://example.com/t",
        mystery_field: "keep-visible",
      },
    });
    assert.equal(result.success, true);
    assert.equal(result.normalizedData.supplierCampaignId, "pz-1");
    assert.equal(result.normalizedData.campaignName, "Nike Run");
    assert.ok(result.unmappedFields.includes("mystery_field"));
    assert.equal(result.mappingVersion, "2");
  });

  await t.test("applies transforms (NUMBER, CURRENCY, ENUM, DATE)", () => {
    const def = {
      supplier: "TEST",
      resourceKey: "x",
      mappingVersion: "9",
      fields: [
        { sourcePath: "amt", targetField: "amount", transform: "NUMBER", required: true },
        { sourcePath: "cur", targetField: "currency", transform: "CURRENCY" },
        {
          sourcePath: "st",
          targetField: "state",
          transform: "ENUM",
          enumMap: { APPROVED: "VALIDATION_APPROVED" },
        },
        { sourcePath: "when", targetField: "at", transform: "DATE" },
      ],
    };
    const result = mapWithDefinition(
      { amt: "12.5", cur: "inr", st: "APPROVED", when: "2024-01-02T00:00:00Z" },
      def,
    );
    assert.equal(result.success, true);
    assert.equal(result.normalizedData.amount, 12.5);
    assert.equal(result.normalizedData.currency, "INR");
    assert.equal(result.normalizedData.state, "VALIDATION_APPROVED");
    assert.ok(result.normalizedData.at.includes("2024"));
  });

  await t.test("handles optional fields and rejects missing required", () => {
    const ok = mapPayload({
      supplier: "IMPACT",
      resourceKey: "campaigns",
      payload: { CampaignId: "100", CampaignName: "Brand X" },
    });
    assert.equal(ok.success, true);

    const bad = mapPayload({
      supplier: "IMPACT",
      resourceKey: "campaigns",
      payload: { CampaignName: "Missing Id" },
    });
    assert.equal(bad.success, false);
    assert.ok(bad.errors.some((e) => e.code === "MAPPING_REQUIRED_FIELD_MISSING"));
  });

  await t.test("reports unmapped fields and preserves mapping version", () => {
    const result = mapPayload({
      supplier: "IMPACT",
      resourceKey: "conversions",
      payload: {
        Id: "act-1",
        Payout: "10",
        Currency: "USD",
        ExtraSupplierField: true,
      },
    });
    assert.equal(result.mappingVersion, "1");
    assert.ok(result.unmappedFields.includes("ExtraSupplierField"));
  });

  await t.test("does not mutate RawPayload-like source object", () => {
    const payload = { CampaignId: "1", CampaignName: "A", nested: { x: 1 } };
    const before = JSON.stringify(payload);
    mapPayload({ supplier: "IMPACT", resourceKey: "campaigns", payload });
    assert.equal(JSON.stringify(payload), before);
  });

  await t.test("invalid mapping config produces controlled error", () => {
    const result = mapPayload({
      supplier: "IMPACT",
      resourceKey: "does-not-exist",
      payload: { a: 1 },
    });
    assert.equal(result.success, false);
    assert.ok(result.errors.length);
  });

  await t.test("replay service maps without mutating stored hash identity", async () => {
    const payload = { CampaignId: "77", CampaignName: "Replay Brand" };
    const payloadHash = hashPayload(payload);
    const fakeDb = {
      rawPayload: {
        async findUnique() {
          return {
            id: "rp-1",
            supplier: "IMPACT",
            resourceKey: "campaigns",
            sourceAccountLabel: "default",
            payload,
            payloadHash,
            mapperVersion: "1",
          };
        },
      },
    };
    const svc = new MappingReplayService({
      db: fakeDb,
      exceptions: { report: async () => ({ created: false }) },
    });
    const out = await svc.replayRawPayload("rp-1");
    assert.equal(out.ok, true);
    assert.equal(out.payloadImmutable, true);
    assert.equal(out.result.normalizedData.supplierCampaignId, "77");
  });

  await t.test("buildMappingReview surfaces failed fields", () => {
    const mapResult = {
      success: false,
      errors: [
        {
          code: "MAPPING_REQUIRED_FIELD_MISSING",
          targetField: "supplierCampaignId",
          sourcePath: null,
          sourceValue: null,
          reason: "required",
        },
      ],
      warnings: [],
      unmappedFields: ["foo"],
      mappingVersion: "1",
    };
    const review = buildMappingReview({
      supplier: "IMPACT",
      resourceKey: "campaigns",
      mappingVersion: "1",
      recordId: "rp-1",
      mapResult,
    });
    assert.equal(review.failures.length, 1);
    assert.equal(review.failures[0].failedField, "supplierCampaignId");
  });
});

test("Wave E — supplier registry", async (t) => {
  await t.test("lists registered suppliers including Impact and Partnerize", () => {
    const list = listRegisteredSuppliers();
    for (const key of ["BOOSTINY", "OPTIMISE", "TRACKIER", "PARTNERIZE", "IMPACT"]) {
      assert.ok(list.includes(key), key);
      assert.equal(isSupplierRegistered(key), true);
    }
    assert.equal(normalizeSupplierKey("vcommission"), "TRACKIER");
  });

  await t.test("unknown supplier fails safely", () => {
    assert.throws(() => createSupplierAdapter("NOT_A_NETWORK"), /Unknown supplier/);
  });

  await t.test("Boostiny resolves correct adapter", () => {
    const a = createSupplierAdapter("BOOSTINY", { apiKey: "test-key" });
    assert.equal(a.supplierKey, "BOOSTINY");
    assertAdapterContract(a);
  });

  await t.test("Optimise resolves correct adapter", () => {
    const a = createSupplierAdapter("OPTIMISE", {
      apiKey: "k",
      agencyId: "1",
      contactId: "2",
    });
    assert.equal(a.supplierKey, "OPTIMISE");
  });

  await t.test("Trackier resolves correct adapter", () => {
    const a = createSupplierAdapter("TRACKIER", { apiKey: "k" });
    assert.equal(a.supplierKey, "TRACKIER");
  });

  await t.test("Partnerize resolves correct adapter", () => {
    const a = createSupplierAdapter("PARTNERIZE", {
      applicationKey: "app",
      userApiKey: "user",
    });
    assert.equal(a.supplierKey, "PARTNERIZE");
    assert.ok(a.getCapabilities().capabilities.includes("CAMPAIGNS"));
  });

  await t.test("Impact resolves correct adapter", () => {
    const a = createSupplierAdapter("IMPACT", {
      accountSid: "SID",
      authToken: "TOKEN",
    });
    assert.equal(a.supplierKey, "IMPACT");
    assert.ok(getSupplierCapabilities("IMPACT").capabilities.includes("CONVERSIONS"));
  });
});

test("Wave E — Impact / Partnerize normalization", async (t) => {
  await t.test("Impact campaign payload normalizes via mapper", () => {
    const mapped = mapImpactCampaign({
      entityType: "campaign",
      networkSource: "impact",
      externalId: "impact-campaign-55",
      rawData: {
        CampaignId: "55",
        CampaignName: "Impact Brand",
        AdvertiserName: "Acme",
        ContractStatus: "Active",
      },
    });
    assert.equal(String(mapped.supplierCampaignId), "55");
    assert.equal(mapped.campaignName, "Impact Brand");
    assert.equal(mapped.merchantNameRaw, "Acme");
  });

  await t.test("Partnerize campaign payload normalizes via mapper", () => {
    const mapped = mapPartnerizeCampaign({
      entityType: "campaign",
      networkSource: "partnerize",
      externalId: "partnerize-campaign-9",
      rawData: {
        campaign_id: "9",
        title: "PZ Offer",
        advertiser_name: "Brand",
        tracking_link: "https://pz.example/t",
      },
    });
    assert.equal(String(mapped.supplierCampaignId), "9");
    assert.equal(mapped.campaignName, "PZ Offer");
  });

  await t.test("Impact conversion maps into conversion ingest + attribution hints", () => {
    const hints = extractAttributionHints({
      SubId1: "client-a",
      SubId2: "assign-b",
      SubId3: "click-c",
    });
    assert.equal(hints.clientId, "client-a");
    assert.equal(hints.assignmentId, "assign-b");
    assert.equal(hints.clickId, "click-c");

    const ingest = mapEntityToConversionIngest({
      entityType: "conversion",
      networkSource: "impact",
      externalId: "impact-conversion-act-1",
      rawData: {
        Id: "act-1",
        CampaignId: "55",
        Payout: "25.00",
        Currency: "USD",
        State: "APPROVED",
        EventDate: "2026-08-01T00:00:00.000Z",
        SubId1: "client-a",
        SubId2: "assign-b",
        SubId3: "click-c",
        Oid: "order-9",
      },
    });
    assert.equal(ingest.ok, true);
    assert.equal(ingest.input.supplierConversionId, "act-1");
    assert.equal(Number(ingest.input.supplierCommission), 25);
    // Raw network state is preserved and stays UNKNOWN until a verified status mapping exists.
    assert.equal(ingest.input.status, "UNKNOWN");
    assert.equal(ingest.input._order.networkRawStatus, "APPROVED");
    assert.equal(ingest.input._order.statusMappingExceptionRequired, true);
  });

  await t.test("Partnerize conversion maps into conversion ingest", () => {
    const ingest = mapEntityToConversionIngest({
      entityType: "conversion",
      networkSource: "partnerize",
      externalId: "partnerize-conversion-c1",
      rawData: {
        conversion_id: "c1",
        campaign_id: "9",
        commission: "12",
        currency: "GBP",
        status: "pending",
        conversion_date: "2026-08-01T00:00:00.000Z",
      },
    });
    assert.equal(ingest.ok, true);
    assert.equal(ingest.input.supplierConversionId, "c1");
  });

  await t.test("Impact tracking params use subId1/2/3", () => {
    const rule = getTrackingParamRule("IMPACT");
    assert.equal(rule.confirmation, "CONFIRMED");
    const built = buildAttributionQueryParams({
      supplier: "IMPACT",
      clientId: "c1",
      assignmentId: "a1",
      mboClickId: "m1",
    });
    assert.equal(built.injected, true);
    assert.equal(built.params.subId1, "c1");
    assert.equal(built.params.subId2, "a1");
    assert.equal(built.params.subId3, "m1");
  });

  await t.test("Partnerize tracking injects adref/pubref/clickref per v15 12F", () => {
    const built = buildAttributionQueryParams({
      supplier: "PARTNERIZE",
      clientId: "c1",
      assignmentId: "a1",
      mboClickId: "m1",
    });
    assert.equal(built.injected, true);
    assert.equal(built.params.adref, "c1");
    assert.equal(built.params.pubref, "a1");
    assert.equal(built.params.clickref, "m1");
  });

  await t.test("Trackier p1/p2/p3 mapping config still works", () => {
    const result = mapPayload({
      supplier: "TRACKIER",
      resourceKey: "conversions",
      payload: { id: "t1", p1: "c", p2: "a", p3: "m", click_id: "m", commission: "1" },
    });
    assert.equal(result.success, true);
    assert.equal(result.normalizedData.attribution.clientId, "c");
    assert.equal(result.normalizedData.attribution.assignmentId, "a");
  });
});

test("Wave E — adapters do not create finance", async (t) => {
  await t.test("Impact adapter surface has no finance methods", () => {
    const a = createSupplierAdapter("IMPACT", { accountSid: "s", authToken: "t" });
    assert.equal(typeof a.recognizeConversion, "undefined");
    assert.equal(typeof a.createFinancialTransaction, "undefined");
    assert.equal(typeof a.fetchCampaigns, "function");
    assert.equal(typeof a.fetchConversions, "function");
  });

  await t.test("Partnerize adapter surface has no finance methods", () => {
    const a = createSupplierAdapter("PARTNERIZE", {
      applicationKey: "a",
      userApiKey: "u",
    });
    assert.equal(typeof a.createClientAssignment, "undefined");
    assert.equal(typeof a.fetchPayments, "function");
  });
});
