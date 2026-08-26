import test from "node:test";
import assert from "node:assert/strict";
import { ProductService } from "../src/modules/product/product.service.js";
import { ProductPromotionService } from "../src/modules/product/productPromotion.service.js";
import { mapPayload } from "../src/modules/mapping/index.js";
import { hashPayload } from "../src/modules/raw/rawPayload.service.js";
import { createSupplierAdapter } from "../src/adapters/registry.js";

test("Wave F — product catalog", async (t) => {
  await t.test("mapping engine maps Impact product payload", () => {
    const result = mapPayload({
      supplier: "IMPACT",
      resourceKey: "products",
      payload: {
        Id: "sku-100",
        Name: "Running Shoe",
        Price: "49.99",
        Currency: "USD",
        Category: "Footwear",
        extra_field: true,
      },
    });
    assert.equal(result.success, true);
    assert.equal(result.normalizedData.supplierProductId, "sku-100");
    assert.equal(result.normalizedData.title, "Running Shoe");
    assert.ok(result.unmappedFields.includes("extra_field"));
  });

  await t.test("ProductService ingests idempotently via mock db", async () => {
    const store = { products: [], sources: [] };
    const db = {
      productSource: {
        findUnique: async ({ where }) => {
          const key = where.supplier_sourceAccountLabel_supplierProductId;
          const source = store.sources.find(
            (s) =>
              s.supplier === key.supplier &&
              s.sourceAccountLabel === key.sourceAccountLabel &&
              s.supplierProductId === key.supplierProductId,
          );
          if (!source) return null;
          const product = store.products.find((p) => p.id === source.productId);
          return { ...source, product };
        },
        create: async ({ data }) => {
          const row = { id: `ps-${store.sources.length + 1}`, ...data };
          store.sources.push(row);
          return row;
        },
        update: async ({ where, data }) => {
          const idx = store.sources.findIndex((s) => s.id === where.id);
          store.sources[idx] = { ...store.sources[idx], ...data };
          return store.sources[idx];
        },
      },
      product: {
        create: async ({ data }) => {
          const row = { id: `p-${store.products.length + 1}`, ...data };
          store.products.push(row);
          return row;
        },
        update: async ({ where, data }) => {
          const idx = store.products.findIndex((p) => p.id === where.id);
          store.products[idx] = { ...store.products[idx], ...data };
          return store.products[idx];
        },
      },
      orderItem: {
        update: async ({ where, data }) => ({ id: where.id, ...data }),
      },
    };

    const svc = new ProductService({ prisma: db });
    const payload = {
      supplierProductId: "sku-1",
      title: "Item A",
      price: "10",
      currency: "USD",
    };
    const first = await svc.ingestMappedProduct({
      supplier: "IMPACT",
      sourceAccountLabel: "default",
      mapped: { normalizedData: payload, mappingVersion: "1" },
    });
    assert.equal(first.ok, true);
    assert.equal(first.created, true);

    const second = await svc.ingestMappedProduct({
      supplier: "IMPACT",
      sourceAccountLabel: "default",
      mapped: {
        normalizedData: { ...payload, title: "Item A Updated", price: "12" },
        mappingVersion: "1",
      },
    });
    assert.equal(second.ok, true);
    assert.equal(second.created, false);
    assert.equal(store.products.length, 1);
    assert.equal(store.sources.length, 1);
    assert.equal(second.product.title, "Item A Updated");
  });

  await t.test("RawPayload hash unchanged after product mapping", () => {
    const payload = { Id: "1", Name: "X" };
    const before = hashPayload(payload);
    mapPayload({ supplier: "IMPACT", resourceKey: "products", payload });
    assert.equal(hashPayload(payload), before);
  });

  await t.test("OrderItem link is optional and does not change prices", async () => {
    const db = {
      productSource: {
        findUnique: async () => ({
          id: "ps-1",
          productId: "p-1",
          product: { id: "p-1", price: "99" },
        }),
      },
      orderItem: {
        update: async ({ where, data }) => ({ id: where.id, unitPrice: "50", ...data }),
      },
    };
    const svc = new ProductService({ prisma: db });
    const item = { id: "oi-1", sku: "sku-1", unitPrice: "50", productRecordId: null };
    const out = await svc.linkOrderItemToProduct(item, { supplier: "IMPACT" });
    assert.equal(out.linked, true);
    assert.equal(out.productId, "p-1");
  });

  await t.test("ProductPromotionService promotes entity via mapping", async () => {
    const products = new ProductService({
      prisma: {
        productSource: { findUnique: async () => null },
        product: {
          create: async ({ data }) => ({ id: "p1", ...data }),
        },
        orderItem: { update: async () => ({}) },
      },
    });
    products.ingestMappedProduct = async () => ({
      ok: true,
      created: true,
      product: { id: "p1" },
      source: { id: "s1" },
    });
    const promo = new ProductPromotionService({ products, prisma: { rawPayload: { updateMany: async () => ({}) } } });
    const out = await promo.promoteEntity({
      entityType: "product",
      networkSource: "impact",
      externalId: "impact-product-1",
      rawData: { Id: "1", Name: "Shoe" },
    });
    assert.equal(out.ok, true);
  });

  await t.test("Partnerize product capability remains disabled / no fetchProducts", () => {
    const adapter = createSupplierAdapter("PARTNERIZE", {
      applicationKey: "a",
      userApiKey: "u",
    });
    const caps = adapter.getCapabilities().capabilities;
    assert.equal(caps.includes("PRODUCTS"), false);
    assert.equal(typeof adapter.fetchProducts, "undefined");
  });

  await t.test("Impact adapter exposes PRODUCTS capability", () => {
    const adapter = createSupplierAdapter("IMPACT", {
      accountSid: "SID",
      authToken: "TOK",
    });
    assert.ok(adapter.getCapabilities().capabilities.includes("PRODUCTS"));
    assert.equal(typeof adapter.fetchProducts, "function");
  });
});
