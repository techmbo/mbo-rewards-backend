import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SupplierCampaignQueryService } from "../src/modules/supplier/services/query/supplierCampaignQuery.service.js";
import { PERMISSIONS } from "../src/auth/permissions.js";

describe("SupplierCampaignQueryService", () => {
  it("returns standard envelope with masked DTOs", async () => {
    const service = new SupplierCampaignQueryService({
      campaignRepo: {
        findMany: async () => ({
          rows: [
            {
              id: "camp-1",
              supplier: "BOOSTINY",
              supplierRegion: "GLOBAL",
              supplierCampaignId: "9",
              sourceAccountLabel: "default",
              campaignName: "Sale",
              merchantNameRaw: "Brand",
              campaignStatus: "ACTIVE",
              participationStatus: null,
              isJoined: false,
              defaultCommissionValue: { toString: () => "10" },
              commissionCurrency: "USD",
              rawPayload: { token: "secret" },
              normalizedPayload: { name: "Sale" },
              entityId: "entity-1",
              mapperVersion: "1.1.0",
              syncConflict: false,
              countryCodes: [],
              firstSeenAt: new Date(),
              lastSyncedAt: new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          total: 1,
        }),
      },
    });

    const response = await service.list({ page: 1, pageSize: 20 }, [PERMISSIONS.CAMPAIGNS_READ]);

    assert.equal(response.ok, true);
    assert.equal(response.data.length, 1);
    assert.equal(response.data[0].rawPayload, undefined);
    assert.equal(response.data[0].defaultCommissionValue, undefined);
    assert.equal(response.pagination.total, 1);
  });
});
