import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PERMISSIONS } from "../src/auth/permissions.js";
import { applyCatalogDetailAccess } from "../src/auth/catalogDataAccess.js";

describe("catalogDataAccess", () => {
  it("masks grossCommission without COMMISSION_READ", () => {
    const record = {
      id: "cc1",
      merchantId: "m1",
      displayName: "Ubuy Catalog",
      status: "DRAFT",
      visibility: "INTERNAL",
      category: null,
      countries: [],
      defaultCurrency: "USD",
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      sources: [
        {
          id: "src1",
          canonicalCampaignId: "cc1",
          supplierCampaignId: "sc1",
          priority: 10,
          isPrimary: true,
          relationshipStatus: "JOINED",
          supportsLink: true,
          supportsCoupon: false,
          grossCommission: "8.5000",
          channelSupport: ["WEB"],
          isActive: true,
          status: "PREFERRED",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    };

    const selection = {
      primary: record.sources[0],
      secondary: [],
      inactive: [],
      recommendation: null,
    };

    const masked = applyCatalogDetailAccess(record, selection, []);
    assert.equal(masked.sources[0].grossCommission, undefined);
    assert.equal(masked.routing.primary.grossCommission, undefined);
  });

  it("shows grossCommission with COMMISSION_READ", () => {
    const source = {
      id: "src1",
      canonicalCampaignId: "cc1",
      supplierCampaignId: "sc1",
      priority: 10,
      isPrimary: true,
      relationshipStatus: "JOINED",
      supportsLink: true,
      supportsCoupon: false,
      grossCommission: "8.5000",
      channelSupport: ["WEB"],
      isActive: true,
      status: "PREFERRED",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const record = {
      id: "cc1",
      merchantId: "m1",
      displayName: "Ubuy Catalog",
      status: "DRAFT",
      visibility: "INTERNAL",
      category: null,
      countries: [],
      defaultCurrency: "USD",
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      sources: [source],
    };

    const detail = applyCatalogDetailAccess(
      record,
      { primary: source, secondary: [], inactive: [], recommendation: null },
      [PERMISSIONS.COMMISSION_READ],
    );

    assert.equal(detail.sources[0].grossCommission, "8.5000");
  });
});
