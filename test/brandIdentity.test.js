import test from "node:test";
import assert from "node:assert/strict";
import {
  projectBrandIdentity,
  brandIdentityToAdminLinks,
  brandIdentityToClientLinks,
} from "../src/modules/merchant/brandIdentity.js";
import { mapOptimiseCampaign } from "../src/modules/supplier/mappers/optimise.mapper.js";

test("projectBrandIdentity prefers Merchant.logoUrl over SupplierCampaign.campaignLogoUrl", () => {
  const brand = projectBrandIdentity(
    {
      id: "m1",
      displayName: "Ubuy",
      logoUrl: "https://cdn.example/merchant.png",
      website: "https://www.ubuy.com",
    },
    {
      merchantNameRaw: "Ubuy RAW",
      campaignLogoUrl: "https://cdn.example/campaign.png",
      destinationUrl: "https://clk.example/x",
    },
  );

  assert.equal(brand.id, "m1");
  assert.equal(brand.name, "Ubuy");
  assert.equal(brand.logoUrl, "https://cdn.example/merchant.png");
  assert.equal(brand.websiteUrl, "https://www.ubuy.com");
});

test("projectBrandIdentity falls back to SupplierCampaign logo when merchant logo missing", () => {
  const brand = projectBrandIdentity(
    { id: "m1", displayName: "Klook", logoUrl: null, website: null },
    {
      merchantNameRaw: "Klook",
      campaignLogoUrl: "https://cdn.example/klook.png",
      destinationUrl: "https://www.klook.com",
    },
  );

  assert.equal(brand.logoUrl, "https://cdn.example/klook.png");
  // TSV 03E/03G: Brand Master first; landing/preview fallback when website missing.
  assert.equal(brand.websiteUrl, "https://www.klook.com");
});

test("projectBrandIdentity uses landing destinationUrl when Brand Master website missing", () => {
  const brand = projectBrandIdentity(
    { id: "m1", displayName: "Klook", logoUrl: null, website: null },
    {
      merchantNameRaw: "Klook",
      destinationUrl: "https://www.klook.com/activity/12345-deep",
    },
  );
  assert.equal(brand.websiteUrl, "https://www.klook.com/activity/12345-deep");
});

test("projectBrandIdentity never uses trackingUrl as brand website", () => {
  const brand = projectBrandIdentity(
    { id: "m1", displayName: "Klook", logoUrl: null, website: null },
    {
      merchantNameRaw: "Klook",
      destinationUrl: null,
      trackingUrl: "https://track.vcommission.com/click?campaign_id=1",
    },
  );
  assert.equal(brand.websiteUrl, null);
});

test("projectBrandIdentity derives brand label from landing host when advertiser name missing", () => {
  const brand = projectBrandIdentity(null, {
    merchantNameRaw: null,
    destinationUrl: "https://www.klook.com/",
    campaignLogoUrl: "https://cdn.example/k.png",
  });
  assert.equal(brand.name, "klook.com");
  assert.equal(brand.websiteUrl, "https://www.klook.com/");
  assert.equal(brand.logoUrl, "https://cdn.example/k.png");
});

test("projectBrandIdentity returns null logo when no real URL exists", () => {
  const brand = projectBrandIdentity(
    { id: "m1", displayName: "Acme", logoUrl: null },
    { merchantNameRaw: "Acme", campaignLogoUrl: null },
  );

  assert.equal(brand.logoUrl, null);
  assert.equal(brand.name, "Acme");
});

test("projectBrandIdentity rejects non-http logo URLs", () => {
  const brand = projectBrandIdentity(
    { displayName: "Bad", logoUrl: "javascript:alert(1)" },
    { campaignLogoUrl: "ftp://cdn.example/x.png" },
  );
  assert.equal(brand.logoUrl, null);
});

test("admin and client link helpers map brand projection without inventing fields", () => {
  const brand = {
    id: "m1",
    name: "Ubuy",
    logoUrl: "https://cdn.example/ubuy.png",
    websiteUrl: "https://www.ubuy.com",
  };
  assert.deepEqual(brandIdentityToAdminLinks(brand), {
    brandName: "Ubuy",
    brandLogoLink: "https://cdn.example/ubuy.png",
    brandWebsiteLink: "https://www.ubuy.com",
  });
  assert.deepEqual(brandIdentityToClientLinks(brand), {
    brandName: "Ubuy",
    brandLogoUrl: "https://cdn.example/ubuy.png",
    brandWebsiteUrl: "https://www.ubuy.com",
  });
});

test("Optimise mapper preserves campaignLogo / advertiserLogoLocation into campaignLogoUrl", () => {
  const mapped = mapOptimiseCampaign({
    id: "e1",
    networkSource: "optimise_sea",
    externalId: "1",
    campaignName: "Staycation",
    advertiserName: "Klook",
    rawData: {
      campaignId: "40640",
      campaignName: "Staycation",
      campaignLogo: "https://cdn.optimise/logo-a.png",
    },
    normalizedData: {},
  });
  assert.equal(mapped.campaignLogoUrl, "https://cdn.optimise/logo-a.png");

  const mappedAdvertiser = mapOptimiseCampaign({
    id: "e2",
    networkSource: "optimise_sea",
    externalId: "2",
    campaignName: "Hotel",
    advertiserName: "Klook",
    rawData: {
      campaignId: "40641",
      campaignName: "Hotel",
      advertiserLogoLocation: "https://cdn.optimise/logo-b.png",
    },
    normalizedData: {},
  });
  assert.equal(mappedAdvertiser.campaignLogoUrl, "https://cdn.optimise/logo-b.png");

  const mappedMissing = mapOptimiseCampaign({
    id: "e3",
    networkSource: "optimise_sea",
    externalId: "3",
    campaignName: "No Logo",
    advertiserName: "Klook",
    rawData: { campaignId: "40642", campaignName: "No Logo" },
    normalizedData: {},
  });
  assert.equal(mappedMissing.campaignLogoUrl ?? null, null);
});
