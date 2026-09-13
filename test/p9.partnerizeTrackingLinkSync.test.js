import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mapPartnerizeCampaign } from "../src/modules/supplier/mappers/partnerize.mapper.js";
import {
  buildSupplierCampaignMboTracking,
} from "../src/modules/commercial/supplierCampaignTracking.js";
import { SUPPLIER_TRACKING_LINK_STATE } from "../src/modules/tracking/supplierTrackingLink.contract.js";

// MBO tracking-link generation requires a configured base URL (see commercial/trackingUrl.js).
process.env.TRACKING_BASE_URL = process.env.TRACKING_BASE_URL || "https://go.mbo.example";

const LINK = "https://prf.hn/click/camref:1101lAbCd";
const DESTINATION = "https://www.merchant-example.com/spring";

/* ------------------------------------------- mapper: A is never substituted for B */

function partnerizeEntity(raw) {
  return {
    id: "entity-1",
    externalId: "partnerize:5001",
    networkSource: "partnerize",
    entityType: "campaign",
    campaignName: "Example Campaign",
    rawData: raw,
    normalizedData: {},
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
  };
}

test("REQUIRED 1: a Partnerize campaign carrying only destination_url maps trackingUrl to null", () => {
  const mapped = mapPartnerizeCampaign(
    partnerizeEntity({
      campaign_id: "5001",
      title: "Example Campaign",
      destination_url: DESTINATION,
      default_destination: DESTINATION,
      campaign_lifecycle_status: "live",
    }),
  );
  assert.equal(mapped.trackingUrl, null, "destination_url must never become the tracking link");
  assert.equal(mapped.destinationUrl, DESTINATION);
});

test("REQUIRED 2: a joined/approved Partnerize campaign with no link is a valid mapping", () => {
  const mapped = mapPartnerizeCampaign(
    partnerizeEntity({
      campaign_id: "5001",
      title: "Example Campaign",
      destination_url: DESTINATION,
      campaign_lifecycle_status: "live",
      status: "approved",
    }),
  );
  // Mapping succeeds and campaign identity is intact despite the absent tracking link.
  assert.equal(mapped.supplierCampaignId, "5001");
  assert.equal(mapped.campaignName, "Example Campaign");
  assert.equal(mapped.trackingUrl, null);
});

test("a genuine Partnerize tracking link still maps through", () => {
  const mapped = mapPartnerizeCampaign(
    partnerizeEntity({ campaign_id: "5001", title: "X", tracking_link: LINK, destination_url: DESTINATION }),
  );
  assert.equal(mapped.trackingUrl, LINK);
  assert.equal(mapped.destinationUrl, DESTINATION);
});

/* --------------------------------- REQUIRED 8/9: MBO link activation is blocked */

test("REQUIRED 8+9: no MBO client link is minted for a Partnerize campaign without a supplier link", () => {
  const result = buildSupplierCampaignMboTracking({
    supplier: "PARTNERIZE",
    trackingUrl: null,
    destinationUrl: DESTINATION,
    campaignName: "Example Campaign",
  });
  assert.equal(result.mboTrackingUrl, null);
  assert.equal(result.mboTrackingSlug, null);
  assert.equal(result.mboTrackingToken, null);
});

test("an MBO client link IS minted once a Partnerize supplier link exists", () => {
  const result = buildSupplierCampaignMboTracking({
    supplier: "PARTNERIZE",
    trackingUrl: LINK,
    destinationUrl: DESTINATION,
    campaignName: "Example Campaign",
  });
  assert.ok(result.mboTrackingUrl, "a real supplier link must unblock MBO link minting");
  assert.ok(result.mboTrackingToken);
});

test("REQUIRED 15: other suppliers keep their existing destinationUrl behaviour", () => {
  const optimise = buildSupplierCampaignMboTracking({
    supplier: "OPTIMISE",
    trackingUrl: null,
    destinationUrl: DESTINATION,
    campaignName: "Example Campaign",
  });
  assert.ok(optimise.mboTrackingUrl, "Optimise behaviour must be unchanged");
});

/* ------------------------------- REQUIRED 6/7: the sync write path is protected */

const PROMOTION_SOURCE = readFileSync(
  new URL("../src/modules/supplier/services/supplierCampaignPromotion.service.js", import.meta.url),
  "utf8",
);

test("REQUIRED 6+7: the campaign write path routes trackingUrl through the merge rule", () => {
  // A direct unconditional assignment would silently null a manual link on every sync.
  assert.ok(
    !/\n\s*trackingUrl:\s*asOptionalString\(mapped\.trackingUrl\)/.test(PROMOTION_SOURCE),
    "trackingUrl must not be written unconditionally from the supplier payload",
  );
  assert.ok(PROMOTION_SOURCE.includes("mergeSupplierTrackingLinkOnSync"));
  assert.ok(PROMOTION_SOURCE.includes("data.trackingUrl = trackingMerge.trackingUrl"));
  assert.ok(PROMOTION_SOURCE.includes("data.supplierTrackingLinkState = trackingMerge.state"));
});

test("REQUIRED 7: the write path never assigns destinationUrl into trackingUrl", () => {
  assert.ok(!/trackingUrl:\s*[^\n]*destinationUrl/.test(PROMOTION_SOURCE));
  assert.ok(!/data\.trackingUrl\s*=\s*[^\n]*destinationUrl/.test(PROMOTION_SOURCE));
});

test("a retained manual link keeps its provenance stamp untouched by sync", () => {
  assert.ok(
    PROMOTION_SOURCE.includes("delete data.supplierTrackingLinkProvenance"),
    "a retained manual link must not have its provenance rewritten by the sync writer",
  );
});

/* ---------------------------------- REQUIRED 16: existing behaviour unchanged */

const ADAPTER_SOURCE = readFileSync(
  new URL("../src/adapters/partnerize.adapter.js", import.meta.url),
  "utf8",
);

test("REQUIRED 16: no Partnerize tracking-link endpoint was invented", () => {
  for (const invented of ["/trackinglink", "/tracking-link", "/tracking_link", "/deeplink", "/createlink"]) {
    assert.ok(!ADAPTER_SOURCE.toLowerCase().includes(invented), invented);
  }
  // The adapter remains GET-only for Partnerize.
  assert.ok(!/\.post\(/.test(ADAPTER_SOURCE), "no POST may be introduced to the Partnerize adapter");
});

test("REQUIRED 16: the shared extractTrackingUrlFromRaw helper is untouched by this task", () => {
  const shared = readFileSync(
    new URL("../src/modules/supplier/mappers/shared.js", import.meta.url),
    "utf8",
  );
  // Still present, still without destination fields in its candidate list.
  const body = shared.slice(
    shared.indexOf("export function extractTrackingUrlFromRaw"),
    shared.indexOf("export function extractCampaignStartDateFromRaw"),
  );
  assert.ok(body.length > 0);
  assert.ok(!body.includes("destination_url"));
  assert.ok(!body.includes("default_destination"));
  // The known Optimise landing-page risk is deliberately left in place for a separate task.
  assert.ok(body.includes("landingPage?.thirdPartyUrl"));
});

/* ------------------- admin registry DTO must not present destination as a link */

test("REQUIRED 1: the admin registry never shows a Partnerize destination as the supplier link", async () => {
  const { toAdminTrackingLinkDto } = await import("../src/modules/ops/trackingLinksOps.service.js");
  const row = {
    id: "row-1",
    supplier: "PARTNERIZE",
    supplierCampaignId: "5001",
    campaignName: "Example Campaign",
    merchantNameRaw: "Example",
    trackingUrl: null,
    destinationUrl: DESTINATION,
    mboTrackingUrl: null,
    deepLinkingEnabled: false,
  };
  const dto = toAdminTrackingLinkDto(row);
  assert.notEqual(dto.supplierTrackingLink, DESTINATION);
  assert.ok(!dto.supplierTrackingLink, "no supplier link exists until one is generated");
  // The destination is still surfaced, under its own name.
  assert.equal(dto.landingPageUrl, DESTINATION);
});

test("REQUIRED 15: the admin registry keeps the destination fallback for other suppliers", async () => {
  const { toAdminTrackingLinkDto } = await import("../src/modules/ops/trackingLinksOps.service.js");
  const dto = toAdminTrackingLinkDto({
    id: "row-2",
    supplier: "OPTIMISE",
    supplierCampaignId: "9001",
    campaignName: "Other Campaign",
    trackingUrl: null,
    destinationUrl: DESTINATION,
    mboTrackingUrl: null,
    deepLinkingEnabled: false,
  });
  assert.equal(dto.supplierTrackingLink, DESTINATION, "Optimise behaviour must be unchanged");
});

test("a real Partnerize link is shown as the supplier link", async () => {
  const { toAdminTrackingLinkDto } = await import("../src/modules/ops/trackingLinksOps.service.js");
  const dto = toAdminTrackingLinkDto({
    id: "row-3",
    supplier: "PARTNERIZE",
    supplierCampaignId: "5001",
    campaignName: "Example Campaign",
    trackingUrl: LINK,
    destinationUrl: DESTINATION,
    mboTrackingUrl: null,
    deepLinkingEnabled: false,
  });
  assert.equal(dto.supplierTrackingLink, LINK);
  assert.equal(dto.landingPageUrl, DESTINATION);
});
