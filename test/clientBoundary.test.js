/**
 * Pointer 23 — Client boundary contract tests.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  CONTRACT_POINTER,
  CLIENT_BOUNDARY_PIPELINE,
  NETWORK_PLUG_IN_LAYERS,
  FORBIDDEN_CLIENT_SOURCES,
  CLIENT_BOUNDARY_FORBIDDEN_KEYS,
  ClientBoundaryLeakError,
  assertClientBoundaryPayload,
  applyClientBoundaryContract,
  scanClientModuleImports,
  isForbiddenClientModuleImport,
} from "../src/modules/client/clientBoundary.contract.js";
import { clientBoundaryOk } from "../src/modules/client/clientBoundaryResponse.js";
import { toPartnerCampaignDto } from "../src/modules/client/dto/partnerCampaign.dto.js";
import { toClientOrderDto } from "../src/modules/client/dto/clientReporting.dto.js";
import { toClientPerformanceItemDto } from "../src/modules/client/dto/clientPerformance.dto.js";
import { ClientVisibilityService } from "../src/modules/client/services/visibility.service.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

const CLIENT_MODULE_ROOT = path.resolve("src/modules/client");

async function walkJsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkJsFiles(full)));
    } else if (entry.name.endsWith(".js")) {
      files.push(full);
    }
  }
  return files;
}

function baseAssignment() {
  return {
    id: "a1",
    clientId: "c1",
    status: "ACTIVE",
    published: true,
    channel: "WEB",
    startDate: new Date("2026-01-01"),
    endDate: null,
    createdAt: new Date(),
    commissionRules: [
      {
        status: "EFFECTIVE",
        clientSharePercent: 70,
        clientCommission: "70",
        grossCommission: "100",
        mboCommission: "30",
        currency: "USD",
        commissionType: "PERCENT",
      },
    ],
    couponAssignments: [],
    trackingLinks: [
      {
        isPrimary: true,
        status: "ACTIVE",
        slug: "a1",
        subId: "x",
        mboTrackingUrl: "https://go.mbo.example/r/a1/x",
        supplierTrackingUrl: "https://supplier.example/track",
      },
    ],
    canonicalCampaign: {
      id: "cc1",
      merchantId: "m1",
      displayName: "Brand",
      description: "Desc",
      status: "PUBLISHED",
      visibility: "ASSIGNABLE",
      deletedAt: null,
      category: "Retail",
      countries: ["AE"],
      defaultCurrency: "USD",
      merchant: {
        id: "m1",
        displayName: "Brand",
        logoUrl: "https://cdn.example/logo.png",
        website: "https://www.brand.example",
      },
    },
    campaignSource: {
      supportsLink: true,
      supportsCoupon: false,
      supplierCampaign: {
        campaignName: "Brand Raw",
        campaignDescription: "Desc",
        deepLinkingEnabled: false,
        campaignType: "CPS",
        pricingModel: "CPS",
        campaignStatus: "ACTIVE",
        campaignLogoUrl: null,
        destinationUrl: "https://www.brand.example",
        merchantNameRaw: "Brand",
        countryCodes: ["AE"],
      },
    },
  };
}

describe("Pointer 23 — clientBoundary.contract", () => {
  it("declares contract pointer 23 and six-stage pipeline", () => {
    assert.equal(CONTRACT_POINTER, 23);
    assert.deepEqual(CLIENT_BOUNDARY_PIPELINE, [
      "NETWORK_OPS",
      "MBO_CANONICAL",
      "CLIENT_CAMPAIGN_ASSIGNMENT",
      "CLIENT_COMMERCIAL_RULE",
      "CLIENT_SAFE_API",
      "CLIENT_PORTAL",
    ]);
  });

  it("documents network plug-in layers separate from client API", () => {
    const layers = NETWORK_PLUG_IN_LAYERS.map((l) => l.layer);
    assert.ok(layers.includes("network_adapter"));
    assert.ok(layers.includes("mapping_registry"));
    assert.ok(layers.includes("fixtures_tests"));
    assert.equal(
      layers.some((l) => l.includes("client_api")),
      false,
      "client API should not be a plug-in layer for new networks",
    );
  });

  it("lists forbidden client data sources", () => {
    assert.ok(FORBIDDEN_CLIENT_SOURCES.includes("RawPayload"));
    assert.ok(FORBIDDEN_CLIENT_SOURCES.includes("ImportedRecords"));
    assert.ok(CLIENT_BOUNDARY_FORBIDDEN_KEYS.includes("rawPayloadId"));
    assert.ok(CLIENT_BOUNDARY_FORBIDDEN_KEYS.includes("sourceFields"));
  });

  it("assertClientBoundaryPayload rejects network-ops leakage", () => {
    assert.throws(
      () =>
        assertClientBoundaryPayload(
          { campaignName: "X", rawPayload: { secret: 1 }, grossCommission: 10 },
          { surface: "campaigns" },
        ),
      (err) => {
        assert.equal(err instanceof ClientBoundaryLeakError, true);
        assert.equal(err.code, "CLIENT_BOUNDARY_LEAK");
        assert.ok(err.keys.includes("rawPayload"));
        return true;
      },
    );
  });

  it("applyClientBoundaryContract stamps meta without mutating payload", () => {
    const payload = { items: [{ id: "1" }] };
    const wrapped = applyClientBoundaryContract({ ok: true, data: payload }, { surface: "orders" });
    assert.equal(wrapped.meta.contractPointer, 23);
    assert.equal(wrapped.meta.clientBoundarySurface, "orders");
    assert.deepEqual(wrapped.data, payload);
  });

  it("classifies forbidden client module imports", () => {
    assert.equal(isForbiddenClientModuleImport("../../ops/importedRecords.service.js"), true);
    assert.equal(isForbiddenClientModuleImport("../../ops/raw.service.js"), true);
    assert.equal(isForbiddenClientModuleImport("../../ops/v15FieldContract.js"), false);
  });

  it("clientBoundaryOk allows apiKey on credential_rotate only", () => {
    const rotate = clientBoundaryOk(
      { id: "cred-1", apiKey: "mbo_live_secret_once", keyPrefix: "mbo_live_abc" },
      { surface: "credential_rotate" },
    );
    assert.equal(rotate.meta.contractPointer, 23);
    assert.equal(rotate.data.apiKey, "mbo_live_secret_once");

    assert.throws(
      () =>
        clientBoundaryOk(
          { id: "cred-1", apiKey: "mbo_live_secret_once" },
          { surface: "credentials_list" },
        ),
      ClientBoundaryLeakError,
    );
  });

  it("credentials_list rejects keyHash leakage", () => {
    assert.throws(
      () =>
        clientBoundaryOk([{ id: "1", keyHash: "abc", keyPrefix: "mbo_live_x" }], {
          surface: "credentials_list",
        }),
      ClientBoundaryLeakError,
    );
  });
});

describe("Pointer 23 — DTO boundary scans", () => {
  const visibility = new ClientVisibilityService();

  it("campaign DTOs contain no forbidden network-ops keys", () => {
    const dto = toPartnerCampaignDto(visibility.projectVisibleCampaign(baseAssignment()), {
      client: { status: "ACTIVE", currency: "USD" },
    });
    assertClientBoundaryPayload(dto, { surface: "campaigns" });
    const blob = JSON.stringify(dto);
    for (const key of ["supplierTrackingUrl", "grossCommission", "mboCommission", "rawPayload"]) {
      assert.equal(blob.includes(key), false, `campaign DTO leaked ${key}`);
    }
  });

  it("order and performance DTOs pass boundary assertion", () => {
    const order = toClientOrderDto(
      {
        id: "o1",
        validationStatus: "VALIDATION_APPROVED",
        clientPaymentStatus: "CLIENT_PAYMENT_PAYABLE",
        orderValue: 100,
        currency: "USD",
        orderDate: new Date("2026-01-15"),
        canonicalCampaign: { displayName: "Brand" },
        items: [],
        grossCommission: 10,
        mboCommission: 3,
        supplierReceivable: 10,
        rawPayloadId: "rp-1",
      },
      { clientCommission: 7, commissionSource: "rule" },
    );
    assertClientBoundaryPayload(order, { surface: "orders" });
    assert.equal(order.grossCommission, undefined);
    assert.equal(order.rawPayloadId, undefined);

    const perf = toClientPerformanceItemDto({
      id: "p1",
      conversionDate: new Date("2026-01-15"),
      orderValue: 50,
      currency: "USD",
      clientCommission: 5,
      grossCommission: 8,
      mboCommission: 3,
      campaignName: "Brand",
      brandName: "Brand",
      sourceFields: { clicks: 1 },
    });
    assertClientBoundaryPayload(perf, { surface: "performance" });
    assert.equal(perf.sourceFields, undefined);
  });
});

describe("Pointer 23 — client module import graph", () => {
  it("client modules do not import raw network-ops tables", async () => {
    const files = await walkJsFiles(CLIENT_MODULE_ROOT);
    const violations = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      const bad = scanClientModuleImports(source);
      if (bad.length) {
        violations.push({ file: path.relative(process.cwd(), file), imports: bad });
      }
    }
    assert.deepEqual(
      violations,
      [],
      `Forbidden ops imports in client modules: ${JSON.stringify(violations, null, 2)}`,
    );
  });
});

describe("Pointer 23 — partner token cannot reach ops imported-records", () => {
  /** @type {{ baseUrl: string, close: () => Promise<void> } | null} */
  let server = null;

  before(async () => {
    server = await startTestServer();
  });

  after(async () => {
    if (server) await server.close();
  });

  it("GET /ops/imported-records rejects partner API key (401)", async () => {
    const { status } = await apiRequest(server.baseUrl, {
      path: "/ops/imported-records?pageSize=5",
      token: "mbo_live_test_partner_key_not_admin",
    });
    assert.equal(status, 401);
  });

  it("GET /ops/imported-records without auth is 401", async () => {
    const { status } = await apiRequest(server.baseUrl, {
      path: "/ops/imported-records?pageSize=5",
    });
    assert.equal(status, 401);
  });
});
