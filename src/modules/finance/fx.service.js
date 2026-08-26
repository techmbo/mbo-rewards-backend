import { prisma } from "../../database/prisma.js";
import { ExceptionCaseService } from "../order/exceptionCase.service.js";

const SUPPORTED = new Set(["INR", "USD"]);

/**
 * Regional reporting currency policy (v15):
 * India / Indian region → INR; other known regions → USD; unknown → unresolved.
 */
export function resolveReportingCurrency({ country = null, region = null, clientCurrency = null } = {}) {
  const c = country ? String(country).toUpperCase() : null;
  const r = region ? String(region).toUpperCase() : null;

  if (c === "IN" || r === "INDIA" || r === "IN" || r === "INDIAN") {
    return { ok: true, currency: "INR", reason: "india_region" };
  }

  // Explicit non-India country codes → USD
  if (c && /^[A-Z]{2}$/.test(c) && c !== "IN") {
    return { ok: true, currency: "USD", reason: "non_india_country" };
  }

  if (r && ["SEA", "MENA", "UK", "GLOBAL", "EU", "US"].includes(r)) {
    return { ok: true, currency: "USD", reason: "known_non_india_region" };
  }

  if (clientCurrency && SUPPORTED.has(String(clientCurrency).toUpperCase())) {
    // Client currency alone is insufficient for regional rule — still unresolved if country unknown.
    return {
      ok: false,
      currency: null,
      reason: "unknown_country_region",
      hint: String(clientCurrency).toUpperCase(),
    };
  }

  return { ok: false, currency: null, reason: "unknown_country_region" };
}

export function convertAmount(amount, rate) {
  const a = Number(amount);
  const r = Number(rate);
  if (!Number.isFinite(a) || !Number.isFinite(r)) {
    return { ok: false, reason: "invalid_amount_or_rate" };
  }
  if (r <= 0) {
    return { ok: false, reason: "invalid_fx_rate" };
  }
  return { ok: true, amount: (a * r).toFixed(4) };
}

/**
 * FXService — persists applied rates; never silently invents providers.
 * Rates come from FxRateRecord or an injected rate table for tests.
 */
export class FxService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.exceptions = deps.exceptions ?? new ExceptionCaseService({ prisma: this.db });
    /** Optional in-memory rates for tests: Map "USD:INR:YYYY-MM-DD" -> rate */
    this.rateProvider = deps.rateProvider ?? null;
  }

  toDateKey(date) {
    const d = date instanceof Date ? date : new Date(date);
    return d.toISOString().slice(0, 10);
  }

  async upsertRate({ fromCurrency, toCurrency, rate, effectiveDate, source = "manual" }, client = null) {
    const from = String(fromCurrency).toUpperCase();
    const to = String(toCurrency).toUpperCase();
    const r = Number(rate);
    if (!SUPPORTED.has(from) || !SUPPORTED.has(to)) {
      throw Object.assign(new Error("Unsupported currency pair"), { statusCode: 400, code: "INVALID_CURRENCY" });
    }
    if (!Number.isFinite(r) || r <= 0) {
      throw Object.assign(new Error("Invalid FX rate"), { statusCode: 400, code: "INVALID_FX_RATE" });
    }
    if (from === to) {
      return { fromCurrency: from, toCurrency: to, rate: "1", effectiveDate, source: "identity" };
    }

    const db = client ?? this.db;
    if (!db?.fxRateRecord?.upsert) {
      return { fromCurrency: from, toCurrency: to, rate: String(r), effectiveDate, source };
    }

    const day = new Date(this.toDateKey(effectiveDate));
    return db.fxRateRecord.upsert({
      where: {
        fromCurrency_toCurrency_effectiveDate_source: {
          fromCurrency: from,
          toCurrency: to,
          effectiveDate: day,
          source,
        },
      },
      create: {
        fromCurrency: from,
        toCurrency: to,
        rate: String(r),
        effectiveDate: day,
        source,
      },
      update: { rate: String(r) },
    });
  }

  async getRate({ fromCurrency, toCurrency, effectiveDate }, client = null) {
    const from = String(fromCurrency || "").toUpperCase();
    const to = String(toCurrency || "").toUpperCase();
    if (!from || !to) {
      return { ok: false, reason: "missing_currency" };
    }
    if (!SUPPORTED.has(from) || !SUPPORTED.has(to)) {
      return { ok: false, reason: "unsupported_currency" };
    }
    if (from === to) {
      return { ok: true, rate: "1", source: "identity", effectiveDate };
    }

    const dayKey = this.toDateKey(effectiveDate || new Date());

    if (this.rateProvider) {
      const key = `${from}:${to}:${dayKey}`;
      const rate = this.rateProvider.get?.(key) ?? this.rateProvider[key];
      if (rate != null && Number(rate) > 0) {
        return { ok: true, rate: String(rate), source: "provider", effectiveDate: dayKey };
      }
      return { ok: false, reason: "missing_fx_rate" };
    }

    const db = client ?? this.db;
    if (!db?.fxRateRecord?.findFirst) {
      return { ok: false, reason: "missing_fx_rate" };
    }

    const day = new Date(dayKey);
    const row = await db.fxRateRecord.findFirst({
      where: {
        fromCurrency: from,
        toCurrency: to,
        effectiveDate: { lte: day },
      },
      orderBy: [{ effectiveDate: "desc" }, { createdAt: "desc" }],
    });

    if (!row || Number(row.rate) <= 0) {
      return { ok: false, reason: "missing_fx_rate" };
    }

    return {
      ok: true,
      rate: String(row.rate),
      source: row.source || "manual",
      effectiveDate: row.effectiveDate,
    };
  }

  async convert({ amount, fromCurrency, toCurrency, effectiveDate, persistedRate = null }, client = null) {
    const from = String(fromCurrency || "").toUpperCase();
    const to = String(toCurrency || "").toUpperCase();

    if (persistedRate != null) {
      const converted = convertAmount(amount, persistedRate);
      if (!converted.ok) return converted;
      return {
        ok: true,
        originalAmount: Number(amount).toFixed(4),
        originalCurrency: from,
        reportingAmount: converted.amount,
        reportingCurrency: to,
        fxRate: String(persistedRate),
        fxSource: "persisted",
        fxDate: effectiveDate || new Date(),
      };
    }

    const rateResult = await this.getRate({ fromCurrency: from, toCurrency: to, effectiveDate }, client);
    if (!rateResult.ok) return rateResult;

    const converted = convertAmount(amount, rateResult.rate);
    if (!converted.ok) return converted;

    return {
      ok: true,
      originalAmount: Number(amount).toFixed(4),
      originalCurrency: from,
      reportingAmount: converted.amount,
      reportingCurrency: to,
      fxRate: rateResult.rate,
      fxSource: rateResult.source,
      fxDate: rateResult.effectiveDate || effectiveDate || new Date(),
    };
  }
}
