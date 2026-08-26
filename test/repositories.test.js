import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { SupplierCampaignRepository } from "../src/modules/supplier/repositories/supplierCampaign.repository.js";

describe("SupplierCampaignRepository", () => {
  it("passes supplier filter and excludes archived rows by default", async () => {
    const findMany = mock.fn(async ({ where }) => {
      assert.equal(where.supplier, "BOOSTINY");
      assert.equal(where.archivedAt, null);
      return [{ id: "1" }];
    });
    const count = mock.fn(async () => 1);

    const db = { supplierCampaign: { findMany, count } };
    const repo = new SupplierCampaignRepository();

    const { rows, total } = await repo.findMany({ supplier: "BOOSTINY" }, { skip: 0, take: 10 }, db);

    assert.equal(rows.length, 1);
    assert.equal(total, 1);
    assert.equal(findMany.mock.calls.length, 1);
  });
});
