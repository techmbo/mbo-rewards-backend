/**
 * Pointer 22 — All Network Data view contract tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  VIEW_MODE,
  normalizeRecordTypeForApi,
  normalizeRecordTypeForUi,
  getColumnCatalog,
  getDefaultColumnKeys,
  getCompactColumnKeys,
  resolveActiveColumnKeys,
  extractSourceOnlyFields,
  enrichAllNetworkDataRow,
  buildPerformanceRowFields,
  toColumnCatalogDto,
  buildSourceColumnDefs,
} from "../src/modules/ops/allNetworkData.contract.js";
import { toListRow } from "../src/modules/ops/importedRecords.service.js";

describe("Pointer 22 — allNetworkData.contract", () => {
  it("maps conversion UI type to performance API type", () => {
    assert.equal(normalizeRecordTypeForApi("conversion"), "performance");
    assert.equal(normalizeRecordTypeForUi("performance"), "conversion");
  });

  it("provides column catalogs for all data types", () => {
    for (const type of ["campaign", "coupon", "conversion", "product"]) {
      const catalog = getColumnCatalog(type);
      assert.ok(catalog.length > 0, `catalog empty for ${type}`);
      assert.ok(getDefaultColumnKeys(type).length > 0);
      assert.ok(getCompactColumnKeys(type).length > 0);
    }
  });

  it("resolves four view modes", () => {
    assert.deepEqual(
      resolveActiveColumnKeys({ viewMode: VIEW_MODE.MBO_DEFAULT, recordType: "campaign" }),
      getDefaultColumnKeys("campaign"),
    );
    assert.deepEqual(
      resolveActiveColumnKeys({ viewMode: VIEW_MODE.COMPACT, recordType: "campaign" }),
      getCompactColumnKeys("campaign"),
    );
    const all = resolveActiveColumnKeys({ viewMode: VIEW_MODE.ALL_COLUMNS, recordType: "campaign" });
    assert.equal(all.length, getColumnCatalog("campaign").length);
    const custom = resolveActiveColumnKeys({
      viewMode: VIEW_MODE.CUSTOM,
      recordType: "campaign",
      customKeys: ["network", "brand"],
    });
    assert.deepEqual(custom, ["network", "brand"]);
  });

  it("keeps extra raw fields as source-only, not canonical columns", () => {
    const entity = {
      entityType: "performance",
      rawData: {
        date: "2026-01-01",
        clicks: 5,
        network_proprietary_metric: 99,
        secret_api_key: "hidden",
      },
    };
    const sourceFields = extractSourceOnlyFields(entity, "conversion");
    assert.equal(sourceFields.secret_api_key, undefined);
    assert.equal(sourceFields.network_proprietary_metric, 99);
    assert.equal(sourceFields.date, undefined);
  });

  it("enriches performance rows with MBO fields", () => {
    const entity = {
      id: "e1",
      entityType: "performance",
      networkSource: "impact",
      externalId: "conv-1",
      advertiserName: "Acme",
      campaignName: "Summer",
      rawData: { clicks: 10, commission: 25.5, order_id: "O-1" },
      supplierCampaigns: [],
      supplierCoupons: [],
      mapperErrors: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const fields = buildPerformanceRowFields(entity);
    assert.equal(fields.brandName, "Acme");
    assert.equal(fields.networkClicks, 10);
    assert.equal(fields.grossCommission, 25.5);
    assert.equal(fields.networkOrderId, "O-1");

    const row = enrichAllNetworkDataRow({ id: "e1", network: "Impact" }, entity);
    assert.ok(row.sourceFields);
    assert.equal(row.contractPointer, 22);
  });

  it("builds source column defs with source: prefix", () => {
    const defs = buildSourceColumnDefs(["foo_bar", "baz"]);
    assert.equal(defs[0].key, "source:foo_bar");
    assert.equal(defs[0].sourceOnly, true);
    assert.match(defs[0].label, /Source:/);
  });

  it("column catalog DTO includes pointer 22 metadata", () => {
    const dto = toColumnCatalogDto("conversion");
    assert.equal(dto.contractPointer, 22);
    assert.equal(dto.apiRecordType, "performance");
    assert.ok(dto.viewModes.includes("ALL_COLUMNS"));
  });
});

describe("Pointer 22 — imported records list enrichment", () => {
  it("toListRow attaches sourceFields for performance entities", () => {
    const entity = {
      id: "perf-1",
      entityType: "performance",
      networkSource: "impact",
      externalId: "x1",
      advertiserName: "Brand X",
      rawData: { extra_network_field: "keep-me", clicks: 3 },
      supplierCampaigns: [],
      supplierCoupons: [],
      mapperErrors: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const row = toListRow(entity);
    assert.equal(row.contractPointer, 22);
    assert.equal(row.sourceFields.extra_network_field, "keep-me");
    assert.equal(row.networkClicks, 3);
  });
});
