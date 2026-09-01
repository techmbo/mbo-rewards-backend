import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLIENT_SAFE_FIELD_GUIDE,
  ClientOpsGuideService,
} from "../src/modules/client/clientOpsGuide.service.js";

describe("ClientOpsGuideService", () => {
  it("exposes v5 client-safe field guide mapped to 06C keys", () => {
    assert.ok(CLIENT_SAFE_FIELD_GUIDE.length >= 10);
    const brand = CLIENT_SAFE_FIELD_GUIDE.find((row) => row.label === "Brand Name");
    assert.equal(brand.contractKey, "brandName");
    assert.match(brand.description, /Canonical MBO brand/i);
  });

  it("getGuide returns boundary, fields, and navCounts shape", async () => {
    const service = new ClientOpsGuideService({
      prisma: {
        client: {
          count: async (args) => {
            if (args?.where?.status?.in) return 4;
            return 48;
          },
        },
        clientCampaignAssignment: {
          count: async () => 295,
        },
      },
    });
    const guide = await service.getGuide();
    assert.equal(guide.boundary.title, "Locked Client Operations boundary");
    assert.equal(guide.clientSafeFields.length, CLIENT_SAFE_FIELD_GUIDE.length);
    assert.equal(guide.navCounts.clients, 48);
    assert.equal(guide.navCounts.clientCampaigns, 295);
    assert.equal(guide.navCounts.activationReview, 4);
    assert.ok(Array.isArray(guide.contract.forbiddenKeys));
  });
});
