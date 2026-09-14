import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

const { CAPABILITY_METHODS, SUPPLIER_CAPABILITIES } = await import("../src/adapters/contract.js");
const { SUPPLIER_CAPABILITY_CATALOG, createSupplierAdapter } = await import("../src/adapters/registry.js");
const { SOURCE_OBJECT_AVAILABILITY, getSourceObject } = await import(
  "../src/modules/networkOps/sourceObjects.catalog.js"
);

const ADAPTER_SRC = readFileSync("src/adapters/awin.adapter.js", "utf8");
/** Executable source only. The explanatory comments name fetchProducts precisely because it does
 *  not exist, so a comment-blind scan would find its own prose and report a fetcher. */
const ADAPTER_CODE = ADAPTER_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const CREDS = Object.freeze({ accessToken: "zztokenzz", publisherId: "12345" });

describe("awin — construction no longer fails the capability contract", () => {
  it("1 — createSupplierAdapter(\"AWIN\") constructs", () => {
    // It threw `AWIN: capability PRODUCTS requires fetchProducts()` before this fix, which meant
    // waveESupplierSync could not start an Awin run at all.
    const adapter = createSupplierAdapter("AWIN", { ...CREDS });
    assert.equal(adapter.supplierKey, "AWIN");
    assert.equal(typeof adapter.fetchCampaigns, "function");
  });

  it("1b — the contract assertion is what runs on construction, and it passes", async () => {
    const { assertAdapterContract } = await import("../src/adapters/contract.js");
    const adapter = createSupplierAdapter("AWIN", { ...CREDS });
    assert.equal(assertAdapterContract(adapter), true);
    // The assertion is genuinely reachable: re-adding the capability makes it throw again.
    const broken = { ...adapter, getCapabilities: () => ({ capabilities: ["PRODUCTS"] }) };
    assert.throws(() => assertAdapterContract(broken), /PRODUCTS requires fetchProducts/);
  });

  it("2 — every declared capability maps to a callable method", () => {
    const adapter = createSupplierAdapter("AWIN", { ...CREDS });
    const declared = [
      ...(adapter.getCapabilities()?.capabilities ?? []),
      ...(SUPPLIER_CAPABILITY_CATALOG.AWIN?.capabilities ?? []),
    ];
    assert.ok(declared.length > 0);
    for (const cap of declared) {
      const method = CAPABILITY_METHODS[cap];
      if (!method) continue;
      assert.equal(typeof adapter[method], "function", `${cap} requires ${method}()`);
    }
  });

  it("3 — adapter and registry now agree on AWIN's capabilities", () => {
    const adapter = createSupplierAdapter("AWIN", { ...CREDS });
    assert.deepEqual(
      [...(adapter.getCapabilities()?.capabilities ?? [])].sort(),
      [...(SUPPLIER_CAPABILITY_CATALOG.AWIN.capabilities ?? [])].sort(),
    );
  });
});

describe("awin — no false product capability remains", () => {
  it("4 — PRODUCTS is gone from the adapter and the registry", () => {
    const adapter = createSupplierAdapter("AWIN", { ...CREDS });
    assert.ok(!adapter.getCapabilities().capabilities.includes(SUPPLIER_CAPABILITIES.PRODUCTS));
    assert.ok(!SUPPLIER_CAPABILITY_CATALOG.AWIN.capabilities.includes(SUPPLIER_CAPABILITIES.PRODUCTS));
  });

  it("5 — the other AWIN capabilities are untouched", () => {
    assert.deepEqual(SUPPLIER_CAPABILITY_CATALOG.AWIN.capabilities, [
      "CAMPAIGNS",
      "COUPONS",
      "CONVERSIONS",
      "DEEP_LINK",
      "ORDER_ITEMS",
      "TRACKING_SUBID",
      "REPORTING",
    ]);
  });

  it("6 — ORDER_ITEMS survives: basket lines are not a product feed", () => {
    const adapter = createSupplierAdapter("AWIN", { ...CREDS });
    assert.ok(adapter.getCapabilities().capabilities.includes(SUPPLIER_CAPABILITIES.ORDER_ITEMS));
    // showBasketProducts is a TRANSACTIONS query flag, and stays one.
    const fetcher = ADAPTER_SRC.slice(
      ADAPTER_SRC.indexOf("async fetchConversions("),
      ADAPTER_SRC.indexOf("async fetchPayments("),
    );
    assert.match(fetcher, /showBasketProducts: params\.showBasketProducts !== false,/);
    assert.match(fetcher, /\/transactions\//);
  });

  it("7 — no product fetcher or product path was added", () => {
    assert.ok(!/fetchProducts/.test(ADAPTER_CODE), "a fetchProducts appeared");
    // And the word survives in the prose that explains its absence, which is the point.
    assert.match(ADAPTER_SRC, /does not have and never had/);
    const paths = [...ADAPTER_CODE.matchAll(/[`"'](\/[A-Za-z0-9_/{}$().:-]+)[`"']/g)].map((m) => m[1]);
    assert.deepEqual(
      paths.filter((p) => /product|feed|catalog|datafeed/i.test(p)),
      [],
      "a product path appeared",
    );
    // The evidenced paths, pinned by name rather than by count: the campaigns certification probe
    // later added a sixth, which is the SAME programmes path built from resolved values. A bare
    // count would have flagged that and would miss a product path added alongside it.
    assert.deepEqual([...new Set(paths)].sort(), [
      "/publisher/${pubId}/promotions",
      "/publisher/${resolved.publisherId}/promotions",
      "/publishers/${pubId}/accounts",
      "/publishers/${pubId}/commissiongroups",
      "/publishers/${pubId}/programmes",
      "/publishers/${pubId}/transactions/",
      "/publishers/${resolved.publisherId}/programmes",
      "/publishers/${resolved.publisherId}/transactions/",
    ]);
    // Each certification path is a resolved-value copy of one production already builds, so the
    // set can only grow by mirroring an existing path — never by introducing a new endpoint.
    for (const certPath of paths.filter((p) => p.includes("resolved.publisherId"))) {
      assert.ok(
        paths.includes(certPath.replace("${resolved.publisherId}", "${pubId}")),
        `${certPath} has no production counterpart`,
      );
    }
  });

  it("8 — the catalog records product feeds as having no endpoint at all", () => {
    const entry = getSourceObject("awin", "product_feeds");
    assert.equal(entry.live, false);
    assert.equal(entry.availability, "NO_ENDPOINT_IN_INTEGRATION");
    assert.equal(entry.availability, SOURCE_OBJECT_AVAILABILITY.NO_ENDPOINT);
    assert.notEqual(entry.availability, SOURCE_OBJECT_AVAILABILITY.UNAVAILABLE);
    assert.match(entry.notes, /no fetchProducts/);
    assert.match(entry.notes, /ORDER_ITEMS/);
  });

  it("9 — AWIN really has no mapping files, so this is weaker than MAPPING_ONLY", async () => {
    const { existsSync } = await import("node:fs");
    assert.ok(!existsSync("src/network-mappings/awin"), "an awin mapping directory appeared");
  });

  it("10 — AWIN is out of the drift quarantine, not exempted", () => {
    const guard = readFileSync("test/p9.supplierCapabilityMethodContract.test.js", "utf8");
    const start = guard.indexOf("const KNOWN_REGISTRY_DRIFT");
    const block = guard.slice(start, guard.indexOf("});", start));
    assert.ok(start > -1);
    assert.ok(!/^\s*AWIN:/m.test(block), "AWIN is still listed as known drift");
  });

  it("11 — unrelated suppliers are untouched", () => {
    assert.ok(SUPPLIER_CAPABILITY_CATALOG.IMPACT.capabilities.includes(SUPPLIER_CAPABILITIES.PRODUCTS));
    assert.ok(SUPPLIER_CAPABILITY_CATALOG.OPTIMISE.capabilities.includes(SUPPLIER_CAPABILITIES.PAYMENTS));
    // Boostiny was untouched by the AWIN change; its own PAYMENTS drift was fixed in the phase
    // after this one, so what is pinned here is that it never gained a payments API capability.
    assert.ok(!SUPPLIER_CAPABILITY_CATALOG.BOOSTINY.capabilities.includes(SUPPLIER_CAPABILITIES.PAYMENTS));
    assert.ok(SUPPLIER_CAPABILITY_CATALOG.BOOSTINY.capabilities.includes(SUPPLIER_CAPABILITIES.CAMPAIGNS));
  });
});
