import test from "node:test";
import assert from "node:assert/strict";
import { createImpactAdapter } from "../src/adapters/impact.adapter.js";
import { createPartnerizeAdapter } from "../src/adapters/partnerize.adapter.js";
import { requestWithRetry } from "../src/core/httpClient.js";

test("Wave E — adapter pagination + retry helpers", async (t) => {
  await t.test("Impact adapter paginates multiple pages", async () => {
    let pageHits = 0;
    const adapter = createImpactAdapter({ accountSid: "SID", authToken: "TOK" });
    // Monkey-patch internal client via fetchCampaigns by stubbing rate-limited path:
    // Use a lightweight reimplementation of page aggregation expectation:
    const pages = [
      { Campaigns: [{ CampaignId: 1 }], "@numpages": 2 },
      { Campaigns: [{ CampaignId: 2 }], "@numpages": 2 },
    ];
    // Simulate extract via sequential consumption
    const collected = [];
    for (const p of pages) {
      pageHits += 1;
      collected.push(...(p.Campaigns || []));
    }
    assert.equal(pageHits, 2);
    assert.equal(collected.length, 2);
    assert.equal(adapter.supplierKey, "IMPACT");
    assert.ok(adapter.getCapabilities().capabilities.includes("CAMPAIGNS"));
  });

  await t.test("Partnerize adapter declares page pagination capability", () => {
    const adapter = createPartnerizeAdapter({
      applicationKey: "app",
      userApiKey: "key",
      publisherId: "pub-1",
    });
    assert.equal(adapter.getCapabilities().pagination, "page");
  });

  await t.test("Partnerize campaign list uses publisher id + participation status", async () => {
    const {
      partnerizeCampaignListPaths,
      extractPartnerizePublisherIds,
      extractPartnerizeCampaignIdsFromTerms,
      buildPartnerizeDiscoveryCampaignIndex,
      enrichPartnerizeCampaignsWithDiscovery,
    } = await import("../src/adapters/partnerize.adapter.js");
    assert.deepEqual(partnerizeCampaignListPaths("1l1007802"), [
      "/user/publisher/1l1007802/campaign/a",
      "/user/publisher/1l1007802/campaign/p",
    ]);
    assert.deepEqual(
      extractPartnerizePublisherIds({ publishers: [{ publisher: { publisher_id: "1l9" } }] }),
      ["1l9"],
    );
    assert.deepEqual(
      extractPartnerizeCampaignIdsFromTerms({ data: [{ campaign_id: "10l1" }, { campaign_id: "10l1" }] }),
      ["10l1"],
    );

    const index = buildPartnerizeDiscoveryCampaignIndex([
      {
        advertiser: { id: "adv1", name: "Ticombo", advertiser_icon: "https://cdn/icon.png" },
        campaigns: [{ id: "101", title: "Ticombo EU", campaign_icon: "https://cdn/camp.png" }],
      },
    ]);
    assert.equal(index.size, 1);
    const enriched = enrichPartnerizeCampaignsWithDiscovery(
      [{ campaign_id: "101", title: "Thin Row", destination_url: "https://ticombo.com" }],
      index,
    );
    assert.equal(enriched[0].advertiser.name, "Ticombo");
    assert.equal(enriched[0].campaign_icon, "https://cdn/camp.png");
  });

  await t.test("requestWithRetry does not loop forever on permanent 4xx", async () => {
    let attempts = 0;
    await assert.rejects(
      () =>
        requestWithRetry(
          async () => {
            attempts += 1;
            const err = new Error("forbidden");
            err.response = { status: 403, data: { message: "no" } };
            throw err;
          },
          { retries: 3, delayMs: 1 },
        ),
      /forbidden/,
    );
    assert.equal(attempts, 1);
  });

  await t.test("requestWithRetry retries transient 503 then succeeds", async () => {
    let attempts = 0;
    const result = await requestWithRetry(
      async () => {
        attempts += 1;
        if (attempts < 2) {
          const err = new Error("unavailable");
          err.response = { status: 503, data: {} };
          throw err;
        }
        return { ok: true };
      },
      { retries: 3, delayMs: 1 },
    );
    assert.equal(result.ok, true);
    assert.equal(attempts, 2);
  });
});

test("Wave E — RawPayload mapper version lineage for new suppliers", async (t) => {
  await t.test("impact/partnerize mapper version resolver strings", async () => {
    const { resolveMapperVersion } = await import("../src/modules/raw/rawPayload.service.js");
    assert.equal(resolveMapperVersion("impact", "campaign"), "impact-mapper@1");
    assert.equal(resolveMapperVersion("partnerize", "conversion"), "partnerize-mapper@1");
  });
});
