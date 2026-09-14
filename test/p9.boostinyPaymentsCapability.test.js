import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

const { CAPABILITY_METHODS, SUPPLIER_CAPABILITIES, assertAdapterContract } = await import(
  "../src/adapters/contract.js"
);
const { SUPPLIER_CAPABILITY_CATALOG, createSupplierAdapter } = await import("../src/adapters/registry.js");
const { SOURCE_OBJECT_AVAILABILITY, getSourceObject } = await import(
  "../src/modules/networkOps/sourceObjects.catalog.js"
);

const ADAPTER_SRC = readFileSync("src/adapters/boostiny.adapter.js", "utf8");
/** Executable source only: the comments name fetchPayments precisely because it does not exist. */
const ADAPTER_CODE = ADAPTER_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const CREDS = Object.freeze({ apiKey: "zzkeyzz" });

describe("boostiny — constructs, and its capabilities are callable", () => {
  it("1 — createSupplierAdapter(\"BOOSTINY\") constructs", () => {
    const adapter = createSupplierAdapter("BOOSTINY", { ...CREDS });
    assert.equal(adapter.supplierKey, "BOOSTINY");
    assert.equal(assertAdapterContract(adapter), true);
  });

  it("2 — every declared capability maps to a callable method", () => {
    const adapter = createSupplierAdapter("BOOSTINY", { ...CREDS });
    const declared = [
      ...(adapter.getCapabilities()?.capabilities ?? []),
      ...(SUPPLIER_CAPABILITY_CATALOG.BOOSTINY?.capabilities ?? []),
    ];
    assert.ok(declared.length > 0);
    for (const cap of declared) {
      const method = CAPABILITY_METHODS[cap];
      if (!method) continue;
      assert.equal(typeof adapter[method], "function", `${cap} requires ${method}()`);
    }
  });

  it("3 — adapter and registry now agree", () => {
    const adapter = createSupplierAdapter("BOOSTINY", { ...CREDS });
    assert.deepEqual(
      [...(adapter.getCapabilities()?.capabilities ?? [])].sort(),
      [...SUPPLIER_CAPABILITY_CATALOG.BOOSTINY.capabilities].sort(),
    );
  });

  it("3b — the assertion would still catch this drift if it came back", () => {
    const adapter = createSupplierAdapter("BOOSTINY", { ...CREDS });
    const broken = { ...adapter, getCapabilities: () => ({ capabilities: ["PAYMENTS"] }) };
    assert.throws(() => assertAdapterContract(broken), /PAYMENTS requires fetchPayments/);
  });
});

describe("boostiny — no false payments API capability", () => {
  it("4 — PAYMENTS is gone from the registry, and was never in the adapter", () => {
    assert.ok(!SUPPLIER_CAPABILITY_CATALOG.BOOSTINY.capabilities.includes(SUPPLIER_CAPABILITIES.PAYMENTS));
    const adapter = createSupplierAdapter("BOOSTINY", { ...CREDS });
    assert.ok(!adapter.getCapabilities().capabilities.includes(SUPPLIER_CAPABILITIES.PAYMENTS));
    assert.deepEqual(SUPPLIER_CAPABILITY_CATALOG.BOOSTINY.capabilities, [
      "CAMPAIGNS",
      "COUPONS",
      "REPORTING",
    ]);
  });

  it("5 — no payment fetcher or payment-ish path exists or was added", () => {
    assert.ok(!/fetchPayments|fetchPayouts|fetchSettlements|fetchInvoices/.test(ADAPTER_CODE));
    const paths = [...ADAPTER_CODE.matchAll(/[`"'](\/[A-Za-z0-9_/{}$().:-]+)[`"']/g)].map((m) => m[1]);
    assert.deepEqual(
      paths.filter((p) => /pay|payout|settle|invoice|billing|finance/i.test(p)),
      [],
      "a payment path appeared",
    );
    // The four evidenced paths, unchanged.
    assert.deepEqual([...new Set(paths)].sort(), [
      "/publisher/campaigns",
      "/publisher/coupons",
      "/publisher/link-performance",
      "/publisher/performance",
    ]);
  });

  it("6 — the registry note says where settlement actually comes from", () => {
    const notes = SUPPLIER_CAPABILITY_CATALOG.BOOSTINY.notes.join(" ");
    assert.match(notes, /MANUAL_UPLOAD/);
    assert.match(notes, /PAYMENT_SOURCE_CYCLE/);
    assert.match(notes, /No payment\/payout\/settlement\/invoice API capability/);
    assert.match(notes, /uploadCsv/);
  });
});

describe("boostiny — manual settlement is preserved, not removed", () => {
  it("7 — the manual CSV service still exists with its upload entry point", () => {
    assert.ok(existsSync("src/modules/boostiny/partnerPayment.service.js"));
    const service = readFileSync("src/modules/boostiny/partnerPayment.service.js", "utf8");
    assert.match(service, /export class BoostinyPartnerPaymentService/);
    assert.match(service, /async uploadCsv\(/);
    assert.match(service, /async listSettlements\(/);
    // Aggregate granularity only — never fabricated per-order payments. Counted, not matched:
    // the service sets it in two places, so a single match leaves the other free to drift.
    const granularities = [...service.matchAll(/confirmationGranularity: "([A-Z_]+)"/g)].map((m) => m[1]);
    assert.equal(granularities.length, 2, "the settlement granularity sites changed");
    assert.deepEqual([...new Set(granularities)], ["PAYMENT_SOURCE_CYCLE"]);
  });

  it("8 — the catalog records settlement as MANUAL, not simply absent", () => {
    const entry = getSourceObject("boostiny", "settlement");
    assert.equal(entry.live, false);
    assert.equal(entry.availability, "MANUAL_ONLY_NO_ENDPOINT_IN_INTEGRATION");
    assert.equal(entry.availability, SOURCE_OBJECT_AVAILABILITY.MANUAL);
    assert.match(entry.notes, /uploadCsv/);
    assert.match(entry.notes, /PAYMENT_SOURCE_CYCLE/);
    // The original operational caveat survives the rewrite.
    assert.match(entry.notes, /Only sync when a settlement source is validated for the account/);
  });

  it("9 — MANUAL is distinct from every other availability state", () => {
    const settlement = getSourceObject("boostiny", "settlement");
    for (const other of ["LIVE", "DECLARED", "UNAVAILABLE", "NO_ENDPOINT"]) {
      assert.notEqual(settlement.availability, SOURCE_OBJECT_AVAILABILITY[other], other);
    }
    // NO_ENDPOINT alone would be true but would hide the implemented manual route.
    assert.notEqual(SOURCE_OBJECT_AVAILABILITY.MANUAL, SOURCE_OBJECT_AVAILABILITY.NO_ENDPOINT);
    assert.equal(getSourceObject("awin", "product_feeds").availability, SOURCE_OBJECT_AVAILABILITY.NO_ENDPOINT);
  });

  it("10 — Boostiny's live source objects are untouched", () => {
    for (const key of ["campaigns", "api_reports", "coupons", "link_reports"]) {
      assert.equal(getSourceObject("boostiny", key).live, true, key);
    }
  });
});

describe("the drift quarantine is now empty", () => {
  it("11 — BOOSTINY is fixed, not exempted, and no name remains", () => {
    const guard = readFileSync("test/p9.supplierCapabilityMethodContract.test.js", "utf8");
    const start = guard.indexOf("const KNOWN_REGISTRY_DRIFT");
    const block = guard.slice(start, guard.indexOf("});", start));
    assert.ok(start > -1);
    assert.ok(!/^\s*[A-Z_]+: \[/m.test(block), "a supplier is still quarantined");
  });

  it("12 — unrelated suppliers are unchanged", () => {
    assert.ok(SUPPLIER_CAPABILITY_CATALOG.IMPACT.capabilities.includes(SUPPLIER_CAPABILITIES.PRODUCTS));
    assert.ok(SUPPLIER_CAPABILITY_CATALOG.OPTIMISE.capabilities.includes(SUPPLIER_CAPABILITIES.PAYMENTS));
    assert.ok(SUPPLIER_CAPABILITY_CATALOG.RAKUTEN.capabilities.includes(SUPPLIER_CAPABILITIES.PAYMENTS));
    assert.ok(!SUPPLIER_CAPABILITY_CATALOG.AWIN.capabilities.includes(SUPPLIER_CAPABILITIES.PRODUCTS));
  });
});
