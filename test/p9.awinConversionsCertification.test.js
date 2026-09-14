import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.AWIN_MIN_INTERVAL_MS = "1";
process.env.LOG_LEVEL = "silent";

const {
  createAwinAdapter,
  listAwinCertificationSamples,
  AWIN_MAX_TRANSACTION_WINDOW_DAYS,
  AwinWindowTooWideError,
} = await import("../src/adapters/awin.adapter.js");
const { NetworkCertificationService, listProbeSourceObjects, WINDOW_PRESETS } = await import(
  "../src/modules/ops/networkCertification.service.js"
);

const ADAPTER_SRC = readFileSync("src/adapters/awin.adapter.js", "utf8");
const SERVICE_SRC = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");

const TOKEN = "zzaccesstokenzz";
const PUBLISHER_ID = "zzpub9876zz";

/** A basket line: every value distinctive, and several are order-value fields. */
const BASKET_ITEM = {
  productId: "zzskuzz",
  productName: "zzproductnamezz",
  quantity: 3,
  unitPrice: 41.99,
  skuCode: "zzskucodezz",
  commissionGroupCode: "zzgroupzz",
};

/** A realistic transaction: ids, click refs, voucher, money, currency, customer. */
const TRANSACTION_ROW = {
  id: 778899,
  advertiserId: 112233,
  publisherId: 445566,
  orderRef: "zzorderrefzz",
  commissionStatus: "pending",
  clickRefs: { clickRef: "zzclickrefzz", clickRef2: "zzclickref2zz" },
  voucherCode: "zzvouchercodezz",
  customerCountry: "GB",
  customerAcquisition: "NEW",
  clickDate: "2026-09-01T10:11:12",
  transactionDate: "2026-09-02T10:11:12",
  url: "https://zzmerchantzz.example/checkout",
  saleAmount: { amount: 125.99, currency: "GBP" },
  commissionAmount: { amount: 9.45, currency: "GBP" },
  transactionParts: [{ commissionGroupId: 9911, amount: 9.45, commissionAmount: 9.45 }],
  basketProducts: [BASKET_ITEM],
};

const envelope = (rows) => ({ data: { transactions: rows } });

function spyHttp(response) {
  const calls = [];
  const handler = async (method, path, a, b) => {
    const config = method === "post" ? b : a;
    calls.push({ method, path, body: method === "post" ? a : undefined, config: config ?? {}, params: config?.params });
    if (response instanceof Error) throw response;
    return response;
  };
  return {
    calls,
    client: {
      get: (path, config) => handler("get", path, config),
      post: (path, body, config) => handler("post", path, body, config),
    },
  };
}

function adapterWith(response, { publisherId = PUBLISHER_ID } = {}) {
  const spy = spyHttp(response);
  return { spy, adapter: createAwinAdapter({ accessToken: TOKEN, publisherId, httpClient: spy.client }) };
}

function serviceWith({ response, publisherId = PUBLISHER_ID } = {}) {
  const spy = spyHttp(response);
  return {
    spy,
    service: new NetworkCertificationService({
      prisma: {},
      adapterFactory: (config) => createAwinAdapter({ ...config, httpClient: spy.client }),
      awinCredentialResolver: async () => ({ accessToken: TOKEN, publisherId }),
    }),
  };
}

const certify = async (opts = {}, options = {}) => {
  const { service, spy } = serviceWith(opts);
  const result = await service.certify("awin", { sourceObjects: ["conversions"], ...options });
  return { result, spy, entry: result.results.find((r) => r.sourceObject === "conversions") };
};

/* ------------------------------------------------------- registration */

describe("awin conversions is registered", () => {
  it("1 — conversions is a probeable awin source object", () => {
    assert.ok(listProbeSourceObjects("awin").includes("conversions"));
    assert.ok(listAwinCertificationSamples().includes("conversions"));
    assert.deepEqual(
      [...listProbeSourceObjects("awin")].sort(),
      [...listAwinCertificationSamples()].sort(),
    );
  });

  it("1b — campaigns and coupons are untouched", () => {
    for (const kept of ["campaigns", "coupons"]) {
      assert.ok(listProbeSourceObjects("awin").includes(kept), kept);
    }
    assert.match(ADAPTER_SRC, /body: \(\) => \(\{ filters: \{\}, pagination: \{ page: 1, pageSize: 200 \} \}\)/);
  });

  it("1c — no commission-group or tracking-link certification came with it", () => {
    assert.ok(!listProbeSourceObjects("awin").includes("commission_groups"));
    for (const absent of ["awinCommissionGroups", "awinTrackingLinks"]) {
      assert.ok(!SERVICE_SRC.includes(absent), absent);
    }
  });
});

/* ------------------------------------------------------- endpoint pinning */

describe("awin conversions — production's request contract", () => {
  it("2 — the path is exactly the one fetchConversions builds, trailing slash included", async () => {
    const { spy } = await certify({ response: envelope([TRANSACTION_ROW]) });
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].method, "get");
    assert.equal(spy.calls[0].path, `/publishers/${PUBLISHER_ID}/transactions/`);
    assert.match(ADAPTER_SRC, /`\/publishers\/\$\{pubId\}\/transactions\/`/);
  });

  it("3 — showBasketProducts is ON, so order items can be observed", async () => {
    const { spy } = await certify({ response: envelope([TRANSACTION_ROW]) });
    assert.equal(spy.calls[0].params.showBasketProducts, true);
    // Production leaves it on by default too.
    assert.match(ADAPTER_SRC, /showBasketProducts: params\.showBasketProducts !== false,/);
    assert.match(ADAPTER_SRC, /showBasketProducts: true,/);
  });

  it("4 — dateType is production's default, and no narrowing filter is sent", async () => {
    const { spy } = await certify({ response: envelope([TRANSACTION_ROW]) });
    assert.equal(spy.calls[0].params.dateType, "transaction");
    assert.match(ADAPTER_SRC, /dateType: params\.dateType \?\? "transaction",/);
    // status and timezone are optional in production and deliberately omitted here.
    assert.deepEqual(Object.keys(spy.calls[0].params).sort(), [
      "dateType",
      "endDate",
      "showBasketProducts",
      "startDate",
    ]);
  });

  it("5 — no body is sent on this GET", async () => {
    const { spy } = await certify({ response: envelope([TRANSACTION_ROW]) });
    assert.equal(spy.calls[0].body, undefined);
    assert.deepEqual(Object.keys(spy.calls[0].config).sort(), ["params", "timeout"]);
  });

  it("6 — the collection keys are production's", () => {
    assert.match(ADAPTER_SRC, /extractCollection\(data, \["transactions", "data"\]\)/);
    const start = ADAPTER_SRC.indexOf("  conversions: {");
    const spec = ADAPTER_SRC.slice(start, ADAPTER_SRC.indexOf("\n  },", start));
    assert.match(spec, /collectionKeys: \["transactions", "data"\],/);
  });
});

/* ------------------------------------------------------- the window */

describe("awin conversions — the window is the service's, never a caller's", () => {
  it("7 — 7d is the default and resolves to a 7-day span", async () => {
    const { spy, entry } = await certify({ response: envelope([TRANSACTION_ROW]) });
    assert.equal(entry.windowPreset, "7d");
    const days =
      (Date.parse(spy.calls[0].params.endDate) - Date.parse(spy.calls[0].params.startDate)) / 86400000;
    assert.equal(Math.round(days), 7);
    assert.match(spy.calls[0].params.startDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(spy.calls[0].params.endDate, /^\d{4}-\d{2}-\d{2}$/);
  });

  it("8 — 30d widens the span; the preset token is echoed back", async () => {
    const { spy, entry } = await certify({ response: envelope([TRANSACTION_ROW]) }, { windowPreset: "30d" });
    assert.equal(entry.windowPreset, "30d");
    const days =
      (Date.parse(spy.calls[0].params.endDate) - Date.parse(spy.calls[0].params.startDate)) / 86400000;
    assert.equal(Math.round(days), 30);
  });

  it("9 — 90d exceeds Awin's own 31-day limit and costs NO supplier request", async () => {
    const { spy, entry } = await certify({ response: envelope([TRANSACTION_ROW]) }, { windowPreset: "90d" });
    assert.equal(spy.calls.length, 0, "a request the supplier would refuse was still sent");
    assert.equal(entry.ok, false);
    assert.equal(entry.statusCategory, "WINDOW_EXCEEDS_SUPPLIER_LIMIT");
    assert.equal(entry.maxWindowDays, 31);
    assert.equal(entry.windowPreset, "90d");
    // Not reported as a supplier failure: nothing reached the supplier.
    assert.ok(!("supplierStatusCode" in entry));
    assert.equal(AWIN_MAX_TRANSACTION_WINDOW_DAYS, 31);
  });

  it("9b — production enforces the same ceiling, so the two agree", () => {
    assert.match(ADAPTER_SRC, /Awin transaction window cannot exceed 31 days/);
    assert.match(ADAPTER_SRC, /if \(days > 31\.0001\)/);
  });

  it("10 — caller dates are ignored entirely", async () => {
    const { service, spy } = serviceWith({ response: envelope([TRANSACTION_ROW]) });
    await service.certify("awin", {
      sourceObjects: ["conversions"],
      startDate: "1999-01-01",
      endDate: "2030-01-01",
      window: { from: "1999-01-01", to: "2030-01-01" },
      dateType: "validation",
      status: "approved",
      publisherId: "zzattackerzz",
    });
    const params = spy.calls[0].params;
    assert.ok(!JSON.stringify(spy.calls).includes("1999-01-01"));
    assert.ok(!JSON.stringify(spy.calls).includes("zzattackerzz"));
    assert.equal(params.dateType, "transaction", "a caller changed the date basis");
    assert.equal(params.status, undefined, "a caller added a status filter");
    assert.equal(spy.calls[0].path, `/publishers/${PUBLISHER_ID}/transactions/`);
  });

  it("11 — the preset vocabulary is unchanged", () => {
    assert.deepEqual(Object.keys(WINDOW_PRESETS), ["7d", "30d", "90d"]);
  });
});

/* ------------------------------------------------------- bounds */

describe("awin conversions — one request, one row", () => {
  it("12 — a 500-row page yields one row and one request", async () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ ...TRANSACTION_ROW, id: 900000 + i }));
    const { entry, spy } = await certify({ response: envelope(many) });
    assert.equal(entry.sampleCount, 1);
    assert.equal(spy.calls.length, 1);
  });

  it("13 — the chain declares no loop and one sampler call", () => {
    const start = SERVICE_SRC.indexOf("async certifyAwinConversions(");
    const body = SERVICE_SRC.slice(start, SERVICE_SRC.indexOf("\n  }\n", start));
    assert.ok(start > -1);
    assert.equal(body.split("fetchCertification").length - 1, 1);
    assert.ok(!/for \(|while \(|hasMore|page\+\+/.test(body), "the chain loops");
    assert.ok(!/this\.db\.|prisma\.|\.create\(|\.update\(|\.upsert\(/.test(body), "the chain writes");
  });

  it("14 — no retry: one failing attempt stays one", async () => {
    const failure = Object.assign(new Error("boom"), { response: { status: 503 } });
    const { entry, spy } = await certify({ response: failure });
    assert.equal(spy.calls.length, 1);
    assert.equal(entry.statusCategory, "UPSTREAM_ERROR");
    assert.equal(entry.supplierStatusCode, 503);
  });
});

/* ------------------------------------------------------- order items */

describe("awin conversions — basket lines are ORDER ITEMS", () => {
  it("15 — basketProducts presence and type are reported", async () => {
    const { entry } = await certify({ response: envelope([TRANSACTION_ROW]) });
    assert.equal(entry.orderItems.sourceObject, "order_items");
    assert.equal(entry.orderItems.present, true);
    assert.equal(entry.orderItems.observedType, "ARRAY");
    assert.equal(entry.orderItems.itemSampleCount, 1);
  });

  it("16 — item field paths are summarised SEPARATELY from the transaction's", async () => {
    const { entry } = await certify({ response: envelope([TRANSACTION_ROW]) });
    const itemPaths = entry.orderItems.itemFieldPaths.map((f) => f.path).sort();
    assert.deepEqual(itemPaths, [
      "commissionGroupCode",
      "productId",
      "productName",
      "quantity",
      "skuCode",
      "unitPrice",
    ]);
    // The transaction dictionary keeps its own vocabulary and is not merged with the item one.
    const txPaths = entry.fieldPaths.map((f) => f.path);
    assert.ok(txPaths.includes("basketProducts[].unitPrice"));
    assert.ok(!txPaths.includes("unitPrice"), "item fields leaked into the transaction dictionary");
  });

  it("17 — an absent basket is reported as absent, not as an empty feed", async () => {
    const { basketProducts, ...noBasket } = TRANSACTION_ROW;
    const { entry } = await certify({ response: envelope([noBasket]) });
    assert.equal(entry.orderItems.present, false);
    assert.equal(entry.orderItems.observedType, null);
    assert.equal(entry.orderItems.itemSampleCount, 0);
    assert.deepEqual(entry.orderItems.itemFieldPaths, []);
  });

  it("18 — an empty basket array is present-but-empty, a third distinct state", async () => {
    const { entry } = await certify({ response: envelope([{ ...TRANSACTION_ROW, basketProducts: [] }]) });
    assert.equal(entry.orderItems.present, true);
    assert.equal(entry.orderItems.observedType, "ARRAY");
    assert.equal(entry.orderItems.itemSampleCount, 0);
    assert.deepEqual(entry.orderItems.itemFieldPaths, []);
  });

  it("19 — only ONE basket item is summarised, however many the order had", async () => {
    const basket = Array.from({ length: 40 }, (_, i) => ({ ...BASKET_ITEM, productId: `zzskuzz${i}` }));
    const { entry } = await certify({ response: envelope([{ ...TRANSACTION_ROW, basketProducts: basket }]) });
    assert.equal(entry.orderItems.itemSampleCount, 1, "the whole basket was summarised");
    assert.equal(entry.orderItems.itemFieldPaths[0].sampleCount, 1);
  });

  it("20 — order items are never described as a product feed", async () => {
    const { entry } = await certify({ response: envelope([TRANSACTION_ROW]) });
    assert.match(entry.orderItems.note, /no product feed/i);
    assert.ok(!/product_feeds/.test(JSON.stringify(entry)));
    // And the Awin catalog still says there is no feed endpoint at all.
    const { getSourceObject } = await import("../src/modules/networkOps/sourceObjects.catalog.js");
    assert.equal(getSourceObject("awin", "product_feeds").availability, "NO_ENDPOINT_IN_INTEGRATION");
  });
});

/* ------------------------------------------------------- outcomes */

describe("awin conversions — honest outcomes", () => {
  it("21 — zero rows is OK_NO_ROWS with the schema still unknown", async () => {
    const { entry, spy } = await certify({ response: envelope([]) });
    assert.equal(entry.ok, true);
    assert.equal(entry.statusCategory, "OK_NO_ROWS");
    assert.equal(entry.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.equal(entry.sampleCount, 0);
    assert.equal(entry.fieldCount, 0);
    assert.deepEqual(entry.fieldPaths, []);
    assert.equal(spy.calls.length, 1);
  });

  it("22 — with no transaction, basket presence is UNKNOWN rather than false-and-certain", async () => {
    const { entry } = await certify({ response: envelope([]) });
    assert.equal(entry.orderItems.present, false);
    assert.match(entry.orderItems.note, /unknown — not absent/i);
  });

  it("23 — a sampled row is not marked unknown", async () => {
    const { entry } = await certify({ response: envelope([TRANSACTION_ROW]) });
    assert.equal(entry.statusCategory, "OK");
    assert.equal(entry.schema, undefined);
    assert.equal(entry.endpointKey, "GET /publishers/{publisherId}/transactions/");
    assert.equal(entry.httpMethod, "GET");
  });
});

/* ------------------------------------------------------- leakage: the whole point */

describe("awin conversions — not one value escapes", () => {
  const BANNED = [
    "zzorderrefzz",
    "zzclickrefzz",
    "zzclickref2zz",
    "zzvouchercodezz",
    "zzmerchantzz",
    "zzproductnamezz",
    "zzskuzz",
    "zzskucodezz",
    "zzgroupzz",
    "778899",
    "112233",
    "445566",
    "9911",
    "125.99",
    "9.45",
    "41.99",
    "GBP",
    "2026-09-01",
    "2026-09-02",
    "https://",
    "NEW",
    TOKEN,
    PUBLISHER_ID,
  ];

  it("24 — no id, click ref, voucher, URL, customer field, money or currency appears", async () => {
    const { result } = await certify({ response: envelope([TRANSACTION_ROW]) });
    const serialised = JSON.stringify(result);
    for (const banned of BANNED) {
      assert.ok(!serialised.includes(banned), `${banned} leaked`);
    }
  });

  it("25 — the same holds for the basket item summary specifically", async () => {
    const { entry } = await certify({ response: envelope([TRANSACTION_ROW]) });
    const serialised = JSON.stringify(entry.orderItems);
    for (const banned of BANNED) {
      assert.ok(!serialised.includes(banned), `${banned} leaked via orderItems`);
    }
    // quantity 3 is a value too, and must not be reported.
    assert.ok(!/"quantity":\s*3/.test(serialised));
  });

  it("26 — every field entry is structure only, in both dictionaries", async () => {
    const { entry } = await certify({ response: envelope([TRANSACTION_ROW]) });
    const shape = [
      "arrayObserved",
      "exampleCategory",
      "nullableObserved",
      "objectObserved",
      "observedType",
      "path",
      "presentCount",
      "sampleCount",
    ];
    for (const field of [...entry.fieldPaths, ...entry.orderItems.itemFieldPaths]) {
      assert.deepEqual(Object.keys(field).sort(), shape, field.path);
    }
    assert.equal(entry.rows, undefined);
    assert.equal(entry.rawPayload, undefined);
    assert.equal(entry.orderItems.items, undefined);
  });

  it("27 — money fields are reported as typed PATHS, never as amounts", async () => {
    const { entry } = await certify({ response: envelope([TRANSACTION_ROW]) });
    const byPath = Object.fromEntries(entry.fieldPaths.map((f) => [f.path, f]));
    // Categories are fixed labels from a closed vocabulary, not the data: a currency is reported
    // as CURRENCY_CODE, not "GBP"; a URL as URL, not the address; a date as ISO_DATE.
    assert.equal(byPath["saleAmount.amount"].observedType, "NUMBER");
    assert.equal(byPath["commissionAmount.currency"].observedType, "CURRENCY_CODE");
    assert.equal(byPath["url"].observedType, "URL");
    assert.equal(byPath["transactionDate"].observedType, "ISO_DATE");
    assert.equal(byPath["voucherCode"].observedType, "STRING");
    assert.equal(byPath["clickRefs.clickRef"].observedType, "STRING");

    const VOCABULARY = new Set([
      "ARRAY", "BOOLEAN", "CURRENCY_CODE", "ID_LIKE", "ISO_DATE", "MIXED",
      "NULL", "NUMBER", "OBJECT", "REDACTED", "STRING", "URL",
    ]);
    for (const field of [...Object.values(byPath), ...entry.orderItems.itemFieldPaths]) {
      assert.ok(!("value" in field) && !("example" in field), field.path);
      assert.ok(VOCABULARY.has(field.observedType), `${field.path}: ${field.observedType}`);
      assert.ok(VOCABULARY.has(field.exampleCategory), `${field.path}: ${field.exampleCategory}`);
    }
  });

  it("28 — a supplier error quoting the token and a customer id is reduced to a category", async () => {
    const leaky = Object.assign(new Error(`500 for ${TOKEN}`), {
      response: { status: 500, data: { token: TOKEN, orderRef: "zzorderrefzz", amount: 125.99 } },
    });
    const { result } = await certify({ response: leaky });
    const serialised = JSON.stringify(result);
    for (const banned of [TOKEN, "zzorderrefzz", "125.99", PUBLISHER_ID]) {
      assert.ok(!serialised.includes(banned), `${banned} leaked`);
    }
    assert.equal(result.results[0].statusCategory, "UPSTREAM_ERROR");
    assert.equal(result.results[0].supplierStatusCode, 500);
  });
});

/* ------------------------------------------------------- adapter level */

describe("the adapter sampler itself", () => {
  it("29 — a missing window is refused before any request", async () => {
    const { adapter, spy } = adapterWith(envelope([TRANSACTION_ROW]));
    await assert.rejects(
      () => adapter.fetchCertificationSample("conversions", { timeoutMs: 3000 }),
      /requires window/,
    );
    assert.equal(spy.calls.length, 0);
  });

  it("30 — an over-wide window throws the typed error, with no request", async () => {
    const { adapter, spy } = adapterWith(envelope([TRANSACTION_ROW]));
    await assert.rejects(
      () =>
        adapter.fetchCertificationSample("conversions", {
          timeoutMs: 3000,
          window: { from: "2026-01-01", to: "2026-06-01" },
        }),
      (error) => {
        assert.ok(error instanceof AwinWindowTooWideError);
        assert.equal(error.awinWindowTooWide, true);
        assert.equal(error.maxWindowDays, 31);
        assert.ok(error.requestedDays > 31);
        // The error carries days only — no dates, path or credential.
        assert.ok(!`${error.message}${JSON.stringify({ ...error })}`.includes(PUBLISHER_ID));
        return true;
      },
    );
    assert.equal(spy.calls.length, 0);
  });

  it("30b — only `from` and `to` are read out of the window, nothing else", async () => {
    // Defence in depth. The service passes { from, to, preset }; if a window ever carried extra
    // date-shaped keys, they must not become the query. Anything but from/to is ignored.
    const { adapter, spy } = adapterWith(envelope([TRANSACTION_ROW]));
    await adapter.fetchCertificationSample("conversions", {
      timeoutMs: 3000,
      window: {
        from: "2026-02-01",
        to: "2026-02-10",
        startDate: "1999-01-01",
        endDate: "2030-01-01",
        dateType: "validation",
        status: "approved",
      },
    });
    assert.equal(spy.calls[0].params.startDate, "2026-02-01");
    assert.equal(spy.calls[0].params.endDate, "2026-02-10");
    assert.equal(spy.calls[0].params.dateType, "transaction");
    assert.equal(spy.calls[0].params.status, undefined);
    assert.ok(!JSON.stringify(spy.calls).includes("1999-01-01"));
    assert.ok(!JSON.stringify(spy.calls).includes("2030-01-01"));
    // And the spec reads the two canonical keys only.
    const start = ADAPTER_SRC.indexOf("  conversions: {");
    const spec = ADAPTER_SRC.slice(start, ADAPTER_SRC.indexOf("\n  },", start));
    assert.deepEqual(
      [...new Set([...spec.matchAll(/resolved\.window\.([A-Za-z_]+)/g)].map((m) => m[1]))].sort(),
      ["from", "to"],
    );
  });

  it("30c — the SERVICE bounds the row too, independently of the adapter", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ...TRANSACTION_ROW, id: 920000 + i }));
    const service = new NetworkCertificationService({
      prisma: {},
      adapterFactory: () => ({
        supplierKey: "AWIN",
        fetchCertificationSample: async () => many,
      }),
      awinCredentialResolver: async () => ({ accessToken: TOKEN, publisherId: PUBLISHER_ID }),
    });
    const result = await service.certify("awin", { sourceObjects: ["conversions"] });
    const entry = result.results[0];
    assert.equal(entry.sampleCount, 1, "the service kept more than one row");
    assert.equal(entry.fieldPaths[0].sampleCount, 1);
    // And the basket summary still comes from that single row only.
    assert.equal(entry.orderItems.itemSampleCount, 1);
  });

  it("31 — exactly 31 days is accepted", async () => {
    const { adapter, spy } = adapterWith(envelope([TRANSACTION_ROW]));
    const rows = await adapter.fetchCertificationSample("conversions", {
      timeoutMs: 3000,
      window: { from: "2026-01-01", to: "2026-02-01" },
    });
    assert.equal(rows.length, 1);
    assert.equal(spy.calls.length, 1);
  });

  it("32 — campaigns and coupons still need no window", async () => {
    const { adapter } = adapterWith({ data: { programmes: [{ id: 1 }] } });
    assert.equal((await adapter.fetchCertificationSample("campaigns")).length, 1);
    const { adapter: a2 } = adapterWith({ data: { data: [{ promotionId: 1 }] } });
    assert.equal((await a2.fetchCertificationSample("coupons")).length, 1);
  });

  it("33 — production fetchConversions is unchanged", () => {
    assert.match(ADAPTER_SRC, /async fetchConversions\(params = \{\}, stats = null\) \{/);
    assert.match(ADAPTER_SRC, /throw new Error\("Awin transactions require startDate and endDate \(<=31 days\)"\)/);
    const start = ADAPTER_SRC.indexOf("async fetchCertificationSample(");
    const body = ADAPTER_SRC.slice(start, ADAPTER_SRC.indexOf("\n    },", start));
    assert.ok(!body.includes("fetchConversions"), "certification reuses the sync fetcher");
  });
});
