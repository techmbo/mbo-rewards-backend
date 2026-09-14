import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.PARTNERIZE_CERTIFICATION_MIN_INTERVAL_MS = "1";
process.env.LOG_LEVEL = "silent";

const { createPartnerizeAdapter } = await import("../src/adapters/partnerize.adapter.js");
const { NetworkCertificationService } = await import("../src/modules/ops/networkCertification.service.js");

const ADAPTER_SRC = readFileSync("src/adapters/partnerize.adapter.js", "utf8");
const SERVICE_SRC = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");

const CREDENTIALS = { applicationKey: "zzappkeyzz", userApiKey: "zzuserapikeyzz" };
const PUBLISHER_ID = "zzpub1234zz";
const CAMPAIGN_ID = "zzcamp5678zz";

/** Every value distinctive, so any of them in the output is a leak. */
const VOUCHER_ROW = {
  voucher_code: "zzcodezz",
  voucher_code_id: "zzcodeidzz",
  description: "zzdescriptionzz",
  campaign_id: "zzcampidzz",
  start_date_time: "2026-01-01T00:00:00Z",
  end_date_time: null,
  active: "y",
};

/** The real envelope shape, with distinctive values on the envelope keys too. */
function envelope(voucherCodes) {
  return {
    commission_fields: ["zzcommissionfieldzz"],
    count: 4321,
    execution_time: "zzexecutiontimezz",
    voucher_codes: voucherCodes,
  };
}

function spyHttp(response) {
  const calls = [];
  return {
    calls,
    client: {
      get: async (path, config = {}) => {
        calls.push({ path, params: config.params, timeout: config.timeout });
        if (response instanceof Error) throw response;
        return response;
      },
    },
  };
}

function adapterWith(response) {
  const spy = spyHttp(response);
  return {
    spy,
    adapter: createPartnerizeAdapter({
      ...CREDENTIALS,
      publisherId: PUBLISHER_ID,
      certificationCampaignId: CAMPAIGN_ID,
      httpClient: spy.client,
    }),
  };
}

function serviceWith(adapter) {
  return new NetworkCertificationService({
    prisma: {},
    adapterFactory: () => adapter,
    partnerizeCredentialResolver: async () => ({
      ...CREDENTIALS,
      publisherId: PUBLISHER_ID,
      certificationCampaignId: CAMPAIGN_ID,
    }),
  });
}

const certifyVouchers = async (response) => {
  const { adapter, spy } = adapterWith(response);
  const result = await serviceWith(adapter).certify("partnerize", { sourceObjects: ["vouchers"] });
  return { entry: result.results.find((r) => r.sourceObject === "vouchers"), spy, result };
};

describe("partnerize vouchers — the sample is a ROW, never the envelope", () => {
  it("1 — it descends into voucher_codes[] and reports the row's own field paths", async () => {
    const { entry } = await certifyVouchers({ data: envelope([VOUCHER_ROW]) });

    assert.equal(entry.statusCategory, "OK");
    assert.equal(entry.sampleCount, 1);
    assert.deepEqual(entry.fieldPaths.map((f) => f.path).sort(), [
      "active",
      "campaign_id",
      "description",
      "end_date_time",
      "start_date_time",
      "voucher_code",
      "voucher_code_id",
    ]);
    assert.equal(entry.fieldCount, 7);
  });

  it("2 — no envelope key survives into the dictionary", async () => {
    const { entry } = await certifyVouchers({ data: envelope([VOUCHER_ROW]) });
    const paths = entry.fieldPaths.map((f) => f.path);
    for (const envelopeKey of ["commission_fields", "count", "execution_time", "voucher_codes"]) {
      assert.ok(
        !paths.some((p) => p === envelopeKey || p.startsWith(`${envelopeKey}[`) || p.startsWith(`${envelopeKey}.`)),
        `${envelopeKey} was certified as a row field`,
      );
    }
  });

  it("3 — an EMPTY voucher_codes[] is zero rows: OK_NO_ROWS, schema still unknown", async () => {
    const { entry, spy } = await certifyVouchers({ data: envelope([]) });

    assert.equal(entry.ok, true, "the endpoint answered; it is not a failure");
    assert.equal(entry.statusCategory, "OK_NO_ROWS");
    assert.equal(entry.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.equal(entry.sampleCount, 0);
    assert.equal(entry.fieldCount, 0);
    assert.deepEqual(entry.fieldPaths, []);
    assert.equal(spy.calls.length, 1);
  });

  it("3b — OK_NO_ROWS is not plain OK: an operator can tell the two apart", async () => {
    const empty = await certifyVouchers({ data: envelope([]) });
    const sampled = await certifyVouchers({ data: envelope([VOUCHER_ROW]) });
    assert.notEqual(empty.entry.statusCategory, sampled.entry.statusCategory);
    assert.equal(sampled.entry.schema, undefined, "a real row sample is not marked unknown");
  });

  it("4 — an envelope with NO voucher_codes key is still zero rows, never one envelope row", async () => {
    const { entry } = await certifyVouchers({
      data: { commission_fields: ["zzcommissionfieldzz"], count: 0, execution_time: "zzexecutiontimezz" },
    });

    assert.equal(entry.statusCategory, "OK_NO_ROWS");
    assert.equal(entry.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.equal(entry.sampleCount, 0);
    assert.deepEqual(entry.fieldPaths, []);
    assert.ok(!JSON.stringify(entry).includes("commission_fields"));
  });

  it("4b — the envelope fallback is structurally unreachable for a spec that names its collection", () => {
    const start = ADAPTER_SRC.indexOf("async function sampleOnce");
    const body = ADAPTER_SRC.slice(start, ADAPTER_SRC.indexOf("\n  }", start));
    const guard = body.indexOf('if (typeof spec.rows === "function")');
    const fallback = body.indexOf("return [response.data];");
    assert.ok(guard > -1, "the spec-collection branch is gone");
    assert.ok(fallback > -1);
    assert.ok(guard < fallback, "the envelope fallback must be behind the named-collection branch");
  });

  it("5 — a { voucher_code: {...} } wrapper is unwrapped, exactly as production sync unwraps it", async () => {
    const { entry } = await certifyVouchers({ data: envelope([{ voucher_code: VOUCHER_ROW }]) });

    assert.equal(entry.sampleCount, 1);
    assert.deepEqual(entry.fieldPaths.map((f) => f.path).sort(), [
      "active",
      "campaign_id",
      "description",
      "end_date_time",
      "start_date_time",
      "voucher_code",
      "voucher_code_id",
    ]);
    // The same unwrap rule production uses, so the two cannot drift.
    assert.match(
      ADAPTER_SRC,
      /const vc = block\?\.voucher_code && typeof block\.voucher_code === "object" \? block\.voucher_code : block;/,
    );
  });

  it("5b — a string voucher_code is left alone, not mistaken for a wrapper", async () => {
    const { entry } = await certifyVouchers({ data: envelope([VOUCHER_ROW]) });
    const code = entry.fieldPaths.find((f) => f.path === "voucher_code");
    assert.equal(code.observedType, "STRING");
  });

  it("6 — one supplier request, one row held, no pagination", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ ...VOUCHER_ROW, voucher_code: `zzcodezz${i}` }));
    const { entry, spy } = await certifyVouchers({ data: envelope(many) });

    assert.equal(spy.calls.length, 1, "more than one request");
    assert.equal(entry.sampleCount, 1, "more than one row held");
    assert.deepEqual(spy.calls[0].params, {}, "a query parameter was invented");
    assert.equal(spy.calls[0].path, `/user/publisher/${PUBLISHER_ID}/campaign/${CAMPAIGN_ID}/voucher`);
  });

  it("7 — no voucher value, id, url or credential reaches the result", async () => {
    for (const payload of [envelope([VOUCHER_ROW]), envelope([{ voucher_code: VOUCHER_ROW }]), envelope([])]) {
      const { result } = await certifyVouchers({ data: payload });
      const serialised = JSON.stringify(result);
      for (const banned of [
        "zzcodezz",
        "zzcodeidzz",
        "zzdescriptionzz",
        "zzcampidzz",
        "zzcommissionfieldzz",
        "zzexecutiontimezz",
        "4321",
        PUBLISHER_ID,
        CAMPAIGN_ID,
        CREDENTIALS.applicationKey,
        CREDENTIALS.userApiKey,
      ]) {
        assert.ok(!serialised.includes(banned), `${banned} leaked`);
      }
    }
  });

  it("7b — every reported field is structure only: path, type, categories, counts", async () => {
    const { entry } = await certifyVouchers({ data: envelope([VOUCHER_ROW]) });
    for (const field of entry.fieldPaths) {
      assert.deepEqual(Object.keys(field).sort(), [
        "arrayObserved",
        "exampleCategory",
        "nullableObserved",
        "objectObserved",
        "observedType",
        "path",
        "presentCount",
        "sampleCount",
      ]);
      assert.equal(typeof field.observedType, "string");
    }
    // A null-valued field is reported as nullable, still without its value.
    const end = entry.fieldPaths.find((f) => f.path === "end_date_time");
    assert.equal(end.observedType, "NULL");
    assert.equal(end.nullableObserved, true);
  });

  it("8 — nothing is written, and no endpoint changed", () => {
    const start = SERVICE_SRC.indexOf("async certifyPartnerizeVouchers");
    const body = SERVICE_SRC.slice(start, SERVICE_SRC.indexOf("\n  }\n", start));
    assert.ok(!/this\.db\.|prisma\.|\.create\(|\.update\(|\.upsert\(/.test(body), "the voucher chain writes");
    assert.ok(!/for \(|while \(/.test(body), "the voucher chain loops");
    assert.equal(body.split("fetchCertification").length - 1, 1, "more than one sampler call");
    // The path literal is untouched, in both the probe spec and production sync.
    assert.equal(
      (ADAPTER_SRC.match(/campaign\/\$\{encodeURIComponent\((?:resolved\.campaignId|campaignId)\)\}\/voucher/g) || []).length,
      2,
    );
  });

  it("9 — the shared extractRows is untouched, so production pagination cannot change", () => {
    const start = ADAPTER_SRC.indexOf("function extractRows(data) {");
    const body = ADAPTER_SRC.slice(start, ADAPTER_SRC.indexOf("\n}", start));
    assert.ok(!body.includes("voucher"), "extractRows learned a voucher key");
    assert.deepEqual(
      [...body.matchAll(/Array\.isArray\(data\??\.?\??([A-Za-z_]+)\)/g)].map((m) => m[1]).filter(Boolean),
      ["data", "advertisers", "campaigns", "conversions", "payments", "publishers", "results"],
    );
  });

  it("9b — the other Partnerize specs still go through extractRows, not a spec collection", () => {
    const start = ADAPTER_SRC.indexOf("const PARTNERIZE_CERTIFICATION_SAMPLES");
    const block = ADAPTER_SRC.slice(start, ADAPTER_SRC.indexOf("\n});", start));
    assert.equal((block.match(/^\s{4}rows: \(data\) => \{$/gm) || []).length, 1, "only vouchers names a collection");
  });

  it("10 — a supplier failure is still a category, not a row sample", async () => {
    const failure = Object.assign(new Error("boom"), { response: { status: 500 } });
    const { entry, spy } = await certifyVouchers(failure);
    assert.equal(entry.ok, false);
    assert.ok(entry.statusCategory !== "OK" && entry.statusCategory !== "OK_NO_ROWS");
    assert.equal(entry.sampleCount, 0);
    assert.equal(spy.calls.length, 1, "the failure was retried");
  });
});
