import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSupplierAdapter,
  getSupplierCapabilities,
  isSupplierKnown,
  isSupplierRegistered,
  listKnownSuppliers,
  listRegisteredSuppliers,
  normalizeSupplierKey,
} from "../src/adapters/registry.js";

const NINE_NETWORKS = [
  "IMPACT",
  "PARTNERIZE",
  "OPTIMISE",
  "TRACKIER",
  "BOOSTINY",
  "AWIN",
  "ADMITAD",
  "CJ",
  "RAKUTEN",
];

describe("MBO nine-network registry", () => {
  it("recognizes all nine canonical network keys", () => {
    assert.deepEqual(new Set(listKnownSuppliers()), new Set(NINE_NETWORKS));
    for (const key of NINE_NETWORKS) {
      assert.equal(normalizeSupplierKey(key), key);
      assert.equal(isSupplierKnown(key), true);
      assert.ok(getSupplierCapabilities(key));
    }
  });

  it("keeps vCommission as a Trackier profile alias", () => {
    assert.equal(normalizeSupplierKey("vCommission"), "TRACKIER");
    assert.equal(isSupplierKnown("vCommission"), true);
    assert.equal(isSupplierRegistered("vCommission"), true);
  });

  it("registers Admitad and the Rakuten foundation while keeping CJ gated", () => {
    const registered = new Set(listRegisteredSuppliers());

    assert.equal(registered.has("ADMITAD"), true);
    assert.equal(isSupplierRegistered("ADMITAD"), true);
    assert.equal(getSupplierCapabilities("ADMITAD").implementationStatus, "IMPLEMENTED");

    assert.equal(registered.has("RAKUTEN"), true);
    assert.equal(isSupplierRegistered("RAKUTEN"), true);
    assert.equal(
      getSupplierCapabilities("RAKUTEN").implementationStatus,
      "IMPLEMENTED_FOUNDATION",
    );
    assert.doesNotThrow(() => createSupplierAdapter("RAKUTEN", { accessToken: "test-token" }));

    assert.equal(registered.has("CJ"), false);
    assert.equal(isSupplierRegistered("CJ"), false);
    assert.throws(
      () => createSupplierAdapter("CJ"),
      (error) => {
        assert.equal(error.code, "ADAPTER_NOT_IMPLEMENTED");
        assert.equal(error.supplierKey, "CJ");
        return true;
      },
    );
  });

  it("keeps CJ conversion schema explicitly gated on live verification", () => {
    const cj = getSupplierCapabilities("CJ");
    assert.equal(cj.implementationStatus, "VERIFY_LIVE");
    assert.equal(cj.capabilities.includes("CONVERSIONS"), false);
    assert.match(cj.notes.join(" "), /live publisher GraphQL schema/i);
  });

  it("keeps payment evidence separate from order approval in Admitad notes", () => {
    const admitad = getSupplierCapabilities("ADMITAD");
    assert.match(admitad.notes.join(" "), /do not collapse payment evidence into order approval/i);
  });

  it("keeps Rakuten Events and Advanced Reports financially separated", () => {
    const rakuten = getSupplierCapabilities("RAKUTEN");
    assert.equal(rakuten.capabilities.includes("CONVERSIONS"), true);
    assert.equal(rakuten.capabilities.includes("PAYMENTS"), true);
    assert.equal(rakuten.capabilities.includes("COUPONS"), false);
    assert.equal(rakuten.capabilities.includes("PRODUCTS"), false);
    assert.match(rakuten.notes.join(" "), /Events are directional recent transaction components/i);
    assert.match(rakuten.notes.join(" "), /never automatic MBO receipt evidence/i);
    assert.match(rakuten.notes.join(" "), /XML ingestion remains gated/i);
  });
});
