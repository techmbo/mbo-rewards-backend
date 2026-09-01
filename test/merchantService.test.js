import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { MerchantRepository } from "../src/modules/merchant/repositories/merchant.repository.js";
import { MerchantService } from "../src/modules/merchant/services/merchant.service.js";

describe("MerchantRepository", () => {
  it("excludes deleted merchants by default", async () => {
    const findMany = mock.fn(async ({ where }) => {
      assert.equal(where.deletedAt, null);
      return [];
    });
    const count = mock.fn(async () => 0);
    const db = { merchant: { findMany, count } };
    const repo = new MerchantRepository();

    await repo.findMany({}, { skip: 0, take: 10 }, db);
    assert.equal(findMany.mock.calls.length, 1);
  });
});

describe("MerchantService", () => {
  it("rejects duplicate normalized names on create", async () => {
    const merchantRepo = {
      findByNormalizedName: mock.fn(async () => ({ id: "existing" })),
      findBySlug: mock.fn(async () => null),
      create: mock.fn(async () => ({})),
    };

    const service = new MerchantService({ merchantRepo });

    await assert.rejects(
      () => service.create({ displayName: "Ubuy" }),
      (error) => error.statusCode === 409,
    );
  });

  it("creates merchant with normalized name and slug", async () => {
    const merchantRepo = {
      findByNormalizedName: mock.fn(async () => null),
      findBySlug: mock.fn(async () => null),
      create: mock.fn(async (data) => ({ id: "m1", ...data })),
      findById: mock.fn(async (id) => ({
        id,
        displayName: "UBUY.COM",
        normalizedName: "ubuy com",
        slug: "ubuy-com",
        aliases: [],
      })),
    };

    const service = new MerchantService({ merchantRepo });
    const created = await service.create({ displayName: "UBUY.COM" });

    assert.equal(created.displayName, "UBUY.COM");
    assert.equal(created.normalizedName, "ubuy com");
    assert.equal(created.slug, "ubuy-com");
  });

  it("creates a MANUAL alias when networkSource is provided", async () => {
    const merchantRepo = {
      findByNormalizedName: mock.fn(async () => null),
      findBySlug: mock.fn(async () => null),
      create: mock.fn(async (data) => ({ id: "m1", ...data })),
      findById: mock.fn(async () => ({
        id: "m1",
        displayName: "Nike",
        aliases: [{ supplier: "BOOSTINY", source: "MANUAL", status: "CONFIRMED" }],
      })),
    };
    const aliasRepo = {
      upsertBySupplierAlias: mock.fn(async () => ({ id: "a1" })),
    };

    const service = new MerchantService({ merchantRepo, aliasRepo });
    const created = await service.create({ displayName: "Nike", networkSource: "BOOSTINY" });

    assert.equal(aliasRepo.upsertBySupplierAlias.mock.calls.length, 1);
    assert.equal(created.aliases[0].supplier, "BOOSTINY");
  });
});
