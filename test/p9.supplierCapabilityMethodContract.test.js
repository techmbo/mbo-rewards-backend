import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

const { CAPABILITY_METHODS, SUPPLIER_CAPABILITIES } = await import("../src/adapters/contract.js");
const { SUPPLIER_CAPABILITY_CATALOG, listRegisteredSuppliers } = await import("../src/adapters/registry.js");
const { SOURCE_OBJECT_AVAILABILITY, getSourceObject } = await import(
  "../src/modules/networkOps/sourceObjects.catalog.js"
);

/** Enough of every shape of credential that no adapter refuses to construct. */
const CONFIG = Object.freeze({
  apiKey: "zzkeyzz",
  accessToken: "zzkeyzz",
  agencyId: "1",
  contactId: "1",
  applicationKey: "zzkeyzz",
  userApiKey: "zzkeyzz",
  accountSid: "zzkeyzz",
  authToken: "zzkeyzz",
  publisherId: "1",
  siteId: "1",
  clientId: "zzkeyzz",
  clientSecret: "zzkeyzz",
  username: "u",
  password: "p",
  securityToken: "zztokenzz",
  token: "zztokenzz",
  sid: "1",
});

/**
 * Suppliers whose REGISTRY entry declares a capability their adapter cannot serve. Each is a real
 * defect, pre-dating this test and belonging to a supplier this change does not touch; they are
 * recorded here rather than silently corrected.
 *
 * This set is pinned by exact equality, so it can only be reduced by fixing a supplier — a NEW
 * drift fails the test, and fixing a listed one fails it too until the entry is removed. Adding a
 * name to this list is never the fix for new code.
 */
const KNOWN_REGISTRY_DRIFT = Object.freeze({
  // Registry declares PAYMENTS; the adapter has no fetchPayments and its own getCapabilities()
  // omits PAYMENTS. Its registry note already says "Final settlement = Partner Payment CSV
  // (MANUAL_UPLOAD)" — i.e. there is no payments API, which is what the declaration contradicts.
  BOOSTINY: ["PAYMENTS"],
  // Declared in the ADAPTER's own getCapabilities() with no fetchProducts, so assertAdapterContract
  // throws during construction: createSupplierAdapter("AWIN", …) fails today. Reported, not fixed
  // here — it is a live sync defect in a supplier outside this change.
  AWIN: ["PRODUCTS"],
});

function build(key) {
  return import("../src/adapters/registry.js").then(({ createSupplierAdapter }) =>
    createSupplierAdapter(key, { ...CONFIG }),
  );
}

describe("supplier capability → adapter method contract", () => {
  it("1 — every registry-declared capability with a method mapping has that method", async () => {
    const drift = {};
    for (const key of listRegisteredSuppliers()) {
      let adapter;
      try {
        adapter = await build(key);
      } catch (error) {
        // A constructor that refuses is itself drift if the refusal IS the contract assertion.
        if (/capability .* requires .*\(\)/.test(error.message)) {
          drift[key] = [error.message.match(/capability (\w+) requires/)[1]];
          continue;
        }
        throw new Error(`${key} could not be constructed with test credentials: ${error.message}`);
      }
      const declared = SUPPLIER_CAPABILITY_CATALOG[key]?.capabilities ?? [];
      const missing = declared.filter(
        (cap) => CAPABILITY_METHODS[cap] && typeof adapter[CAPABILITY_METHODS[cap]] !== "function",
      );
      if (missing.length) drift[key] = missing;
    }

    assert.deepEqual(
      drift,
      KNOWN_REGISTRY_DRIFT,
      "a supplier's declared capabilities drifted from its adapter methods — implement the " +
        "method or drop the capability; do not extend KNOWN_REGISTRY_DRIFT for new code",
    );
  });

  it("2 — the adapter's own getCapabilities() is held to the same rule", async () => {
    for (const key of listRegisteredSuppliers()) {
      if (key in KNOWN_REGISTRY_DRIFT) continue;
      const adapter = await build(key);
      for (const cap of adapter.getCapabilities()?.capabilities ?? []) {
        const method = CAPABILITY_METHODS[cap];
        if (!method) continue;
        assert.equal(typeof adapter[method], "function", `${key}: ${cap} requires ${method}()`);
      }
    }
  });

  it("3 — the rule has one definition, and the assertion uses it", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/adapters/contract.js", "utf8");
    const body = src.slice(src.indexOf("export function assertAdapterContract"));
    assert.ok(body.includes("CAPABILITY_METHODS[cap]"), "the assertion has its own copy of the map");
    assert.ok(!body.includes("fetchProducts"), "a second, private capability map exists");
    // Descriptive capabilities carry no method requirement, deliberately.
    for (const cap of ["DEEP_LINK", "TRACKING_SUBID", "MULTI_CURRENCY", "ORDER_ITEMS", "REPORTING"]) {
      assert.equal(CAPABILITY_METHODS[SUPPLIER_CAPABILITIES[cap]], undefined, cap);
    }
  });
});

describe("partnerize products — mapping only, and said so", () => {
  it("4 — the registry no longer declares PRODUCTS", () => {
    const entry = SUPPLIER_CAPABILITY_CATALOG.PARTNERIZE;
    assert.ok(!entry.capabilities.includes(SUPPLIER_CAPABILITIES.PRODUCTS));
    // The capabilities it does claim are untouched.
    assert.deepEqual(entry.capabilities, [
      "CAMPAIGNS",
      "COUPONS",
      "CONVERSIONS",
      "PAYMENTS",
      "TRACKING_SUBID",
      "REPORTING",
    ]);
  });

  it("5 — the false ProductFeed note is gone and says what is actually true", () => {
    const notes = SUPPLIER_CAPABILITY_CATALOG.PARTNERIZE.notes.join(" ");
    assert.ok(!/ProductFeed ingest supported/i.test(notes));
    assert.ok(!/product feed Yes\/High/i.test(notes));
    assert.match(notes, /MAPPING_ONLY/);
    assert.match(notes, /no product feed endpoint/i);
  });

  it("6 — the source-object catalog records products as having no endpoint at all", () => {
    const entry = getSourceObject("partnerize", "products");
    assert.ok(entry, "no Partnerize products entry exists");
    assert.equal(entry.live, false);
    assert.equal(entry.availability, "NO_ENDPOINT_IN_INTEGRATION");
    assert.equal(entry.availability, SOURCE_OBJECT_AVAILABILITY.NO_ENDPOINT);
    assert.match(entry.notes, /mapping file/i);
    assert.match(entry.notes, /products\.mapping\.json/);
  });

  it("7 — NO_ENDPOINT is distinct from payments' UNAVAILABLE: no path versus a refused path", () => {
    const products = getSourceObject("partnerize", "products");
    const payments = getSourceObject("partnerize", "payment_information");
    assert.notEqual(products.availability, payments.availability);
    assert.equal(payments.availability, SOURCE_OBJECT_AVAILABILITY.UNAVAILABLE);
    assert.notEqual(products.availability, SOURCE_OBJECT_AVAILABILITY.DECLARED);
    assert.notEqual(products.availability, SOURCE_OBJECT_AVAILABILITY.LIVE);
  });

  it("8 — no product endpoint, fetcher or probe was added", async () => {
    const { readFileSync } = await import("node:fs");
    const adapterSrc = readFileSync("src/adapters/partnerize.adapter.js", "utf8");
    assert.ok(!/fetchProducts/.test(adapterSrc), "a fetchProducts appeared");
    const paths = [...adapterSrc.matchAll(/[`"'](\/[A-Za-z0-9_/{}$().:-]+)[`"']/g)].map((m) => m[1]);
    assert.deepEqual(
      paths.filter((p) => /product|feed|catalog|item/i.test(p)),
      [],
      "a product path appeared in the adapter",
    );
    const { listProbeSourceObjects } = await import("../src/modules/ops/networkCertification.service.js");
    assert.ok(!listProbeSourceObjects("partnerize").includes("products"), "a products probe appeared");
  });

  it("9 — the mapping file itself is untouched and still not wired to a mapper", async () => {
    const { readFileSync } = await import("node:fs");
    const mapping = JSON.parse(readFileSync("src/network-mappings/partnerize/products.mapping.json", "utf8"));
    assert.equal(mapping.supplier, "PARTNERIZE");
    assert.equal(mapping.resourceKey, "products");
    assert.ok(Array.isArray(mapping.fields) && mapping.fields.length > 0);
    // Mapping ≠ capability: nothing registers a Partnerize product mapper.
    const mappers = readFileSync("src/modules/supplier/mappers/index.js", "utf8");
    assert.ok(!/mapPartnerizeProduct/.test(mappers));
  });
});
