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

  it("registers Admitad while keeping CJ and Rakuten gated", () => {
    const registered = new Set(listRegisteredSuppliers());
    assert.equal(registered.has("ADMITAD"), true);
    assert.equal(isSupplierRegistered("ADMITAD"), true);
    assert.equal(getSupplierCapabilities("ADMITAD").implementationStatus, "IMPLEMENTED");

    for (const key of ["CJ", "RAKUTEN"]) {
      assert.equal(registered.has(key), false);
      assert.equal(isSupplierRegistered(key), false);
      assert.throws(
        () => createSupplierAdapter(key),
        (error) => {
          assert.equal(error.code, "ADAPTER_NOT_IMPLEMENTED");
          assert.equal(error.supplierKey, key);
          return true;
        },
      );
    }
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
});
