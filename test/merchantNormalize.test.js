import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeMerchantName, slugifyMerchantName, tokenSimilarity } from "../src/modules/merchant/normalizeName.js";

describe("normalizeMerchantName", () => {
  it("lowercases, strips punctuation, and collapses whitespace", () => {
    assert.equal(normalizeMerchantName("  UBUY.COM  "), "ubuy com");
    assert.equal(normalizeMerchantName("Ubuy India"), "ubuy india");
    assert.equal(normalizeMerchantName("Boostiny"), "boostiny");
  });

  it("returns empty string for blank input", () => {
    assert.equal(normalizeMerchantName(""), "");
    assert.equal(normalizeMerchantName(null), "");
  });
});

describe("slugifyMerchantName", () => {
  it("creates URL-safe slugs", () => {
    assert.equal(slugifyMerchantName("UBUY.COM"), "ubuy-com");
    assert.equal(slugifyMerchantName("   "), "merchant");
  });
});

describe("tokenSimilarity", () => {
  it("scores overlapping tokens", () => {
    assert.ok(tokenSimilarity("Ubuy India", "UBUY India Store") >= 0.5);
    assert.equal(tokenSimilarity("Boostiny", "Boostiny"), 1);
  });
});
