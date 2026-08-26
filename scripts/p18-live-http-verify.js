/**
 * P1.8 live HTTP verification — temporary credential only (revoked after).
 * Does not print API secrets. Does not rotate the client's existing key.
 */
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../src/database/prisma.js";

const BASE = process.env.BACKEND_URL || "http://localhost:4001";
const API = `${BASE.replace(/\/+$/, "")}/api`;

function hashApiKey(raw) {
  return createHash("sha256").update(String(raw)).digest("hex");
}

async function req(path, { key = null, query = "" } = {}) {
  const headers = { Accept: "application/json" };
  if (key) headers["X-Api-Key"] = key;
  const url = `${API}${path}${query}`;
  const res = await fetch(url, { headers });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

function collectForbiddenKeyHits(obj, path = "", hits = []) {
  if (!obj || typeof obj !== "object") return hits;
  if (Array.isArray(obj)) {
    // Contract metadata lists forbidden names as strings — not payload fields.
    if (path.endsWith("forbiddenFields") || path.endsWith("forbidden")) return hits;
    obj.forEach((v, i) => collectForbiddenKeyHits(v, `${path}[${i}]`, hits));
    return hits;
  }
  const bad = new Set([
    "supplierReceivable",
    "mboMargin",
    "mboCommission",
    "rawPayload",
    "apiKey",
    "keyHash",
    "supplierTrackingUrl",
    "supplierProductTrackingUrl",
  ]);
  for (const k of Object.keys(obj)) {
    if (bad.has(k)) hits.push(`${path}.${k}`);
    collectForbiddenKeyHits(obj[k], `${path}.${k}`, hits);
  }
  return hits;
}

function forbiddenHit(obj) {
  return collectForbiddenKeyHits(obj);
}

async function main() {
  const hello = await prisma.client.findFirst({ where: { slug: "hello-1", deletedAt: null } });
  if (!hello) throw new Error("hello-1 not found");
  const other = await prisma.client.findFirst({
    where: { id: { not: hello.id }, status: "ACTIVE", deletedAt: null },
  });

  const rawKey = `mbo_live_${randomBytes(24).toString("hex")}`;
  const cred = await prisma.clientApiCredential.create({
    data: {
      clientId: hello.id,
      name: "P1.8 Live Verify (temp)",
      keyPrefix: rawKey.slice(0, 16),
      keyHash: hashApiKey(rawKey),
      keyEnc: null,
      createdBy: null,
    },
  });

  const results = { base: API, clientSlug: hello.slug, steps: [] };

  try {
    // Missing auth
    for (const path of [
      "/v1/client/campaigns",
      "/v1/client/performance",
      "/v1/client/payments",
      "/v1/client/products",
    ]) {
      const r = await req(path);
      results.steps.push({ path, case: "missing_auth", status: r.status, ok: r.status === 401 });
    }

    // Valid campaigns
    const camps = await req("/v1/client/campaigns", { key: rawKey });
    const campaignList = camps.body?.data?.campaigns || camps.body?.campaigns || [];
    const campHits = forbiddenHit(camps.body);
    results.steps.push({
      path: "/v1/client/campaigns",
      case: "hello1_auth",
      status: camps.status,
      count: campaignList.length,
      paginationTotal: camps.body?.data?.pagination?.total ?? camps.body?.pagination?.total ?? null,
      forbiddenHits: campHits,
      ok: camps.status === 200 && campaignList.length === 6 && campHits.length === 0,
    });

    // Cross-tenant
    if (other) {
      for (const path of [
        "/v1/client/campaigns",
        "/v1/client/performance",
        "/v1/client/payments",
        "/v1/client/products",
      ]) {
        const r = await req(path, { key: rawKey, query: `?clientId=${other.id}` });
        results.steps.push({
          path,
          case: "tenant_override",
          status: r.status,
          ok: r.status === 403,
        });
      }
    }

    // Performance / payments / products
    const perf = await req("/v1/client/performance", { key: rawKey });
    const perfData = perf.body?.data || perf.body || {};
    results.steps.push({
      path: "/v1/client/performance",
      case: "hello1_auth",
      status: perf.status,
      dataAvailable: perfData.dataAvailable,
      kpiCurrency: perfData.kpis?.currency ?? null,
      forbiddenHits: forbiddenHit(perf.body),
      ok: perf.status === 200 && forbiddenHit(perf.body).length === 0,
    });

    const pay = await req("/v1/client/payments", { key: rawKey });
    const payData = pay.body?.data || pay.body || {};
    results.steps.push({
      path: "/v1/client/payments",
      case: "hello1_auth",
      status: pay.status,
      dataAvailable: payData.dataAvailable,
      kpiCurrency: payData.kpis?.currency ?? null,
      payableTotal: payData.kpis?.payableCommissionTotal ?? null,
      forbiddenHits: forbiddenHit(pay.body),
      ok:
        pay.status === 200 &&
        payData.dataAvailable === false &&
        (payData.kpis?.payableCommissionTotal == null || payData.kpis?.payableCommissionTotal === null) &&
        forbiddenHit(pay.body).length === 0,
    });

    const prod = await req("/v1/client/products", { key: rawKey });
    const prodData = prod.body?.data || prod.body || {};
    const items = prodData.items || prodData.products || [];
    results.steps.push({
      path: "/v1/client/products",
      case: "hello1_auth",
      status: prod.status,
      dataAvailable: prodData.dataAvailable,
      itemCount: items.length,
      forbiddenHits: forbiddenHit(prod.body),
      ok:
        prod.status === 200 &&
        items.length === 0 &&
        prodData.dataAvailable === false &&
        forbiddenHit(prod.body).length === 0,
    });

    // Revoke temp key then expect 401
    await prisma.clientApiCredential.update({
      where: { id: cred.id },
      data: { revokedAt: new Date() },
    });
    const revoked = await req("/v1/client/campaigns", { key: rawKey });
    results.steps.push({
      path: "/v1/client/campaigns",
      case: "revoked_key",
      status: revoked.status,
      ok: revoked.status === 401,
    });
  } finally {
    await prisma.clientApiCredential.updateMany({
      where: { id: cred.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await prisma.$disconnect();
  }

  results.pass = results.steps.every((s) => s.ok === true);
  // Never include rawKey
  console.log(JSON.stringify(results, null, 2));
  process.exit(results.pass ? 0 : 1);
}

main().catch(async (err) => {
  console.error(String(err?.message || err));
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
