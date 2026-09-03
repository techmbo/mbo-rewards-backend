import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listSourceObjectCatalog } from "../src/modules/networkOps/sourceObjects.catalog.js";
import { hasJsMapper } from "../src/modules/supplier/mappers/index.js";

describe("CJ sync wiring", () => {
  it("marks only verified publisher discovery sources live", () => {
    const byKey = new Map(listSourceObjectCatalog("cj").map((item) => [item.sourceObject, item]));

    assert.equal(byKey.get("advertisers")?.live, true);
    assert.equal(byKey.get("links")?.live, true);
    assert.equal(byKey.get("coupons")?.live, true);

    assert.equal(byKey.get("program_terms")?.live, false);
    assert.equal(byKey.get("commission_detail")?.live, false);
    assert.equal(byKey.get("products")?.live, false);
  });

  it("registers CJ campaign and coupon promotion mappers but not conversion promotion", () => {
    assert.equal(hasJsMapper("CJ", "campaign"), true);
    assert.equal(hasJsMapper("CJ", "coupon"), true);
    assert.equal(hasJsMapper("CJ", "conversion"), false);
  });

  it("keeps Program Terms transport declared until live endpoint verification", () => {
    const terms = listSourceObjectCatalog("cj").find((item) => item.sourceObject === "program_terms");
    assert.match(terms?.notes || "", /endpoint\/root query is verified/i);
  });

  it("keeps Commission Detail conversion ingestion gated on live publisher schema", () => {
    const detail = listSourceObjectCatalog("cj").find((item) => item.sourceObject === "commission_detail");
    assert.equal(detail?.live, false);
    assert.match(detail?.notes || "", /live publisher GraphQL schema/i);
  });
});
