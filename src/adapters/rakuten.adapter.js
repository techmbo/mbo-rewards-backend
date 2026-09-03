import { createHttpClient, requestWithRetry } from "../core/httpClient.js";
import { SUPPLIER_CAPABILITIES } from "./contract.js";

const DEFAULT_PAGE_LIMIT = 100;
const MAX_OFFER_LIMIT = 200;
const DEFAULT_ADVANCED_REPORT_CALL_BUDGET = 80;

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function finitePositive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function extractRakutenCollection(payload, keys = []) {
  if (Array.isArray(payload)) return payload;
  const body = asObject(payload);
  for (const key of keys) {
    if (Array.isArray(body[key])) return body[key];
    if (body[key] && typeof body[key] === "object") return [body[key]];
  }
  for (const key of ["advertisers", "partnerships", "offers", "results", "items", "data"]) {
    if (Array.isArray(body[key])) return body[key];
    if (body[key] && typeof body[key] === "object" && !Array.isArray(body[key])) return [body[key]];
  }
  return [];
}

export function extractRakutenPagination(payload, fallback = {}) {
  const body = asObject(payload);
  const metadata = asObject(body._metadata ?? body.metadata);
  const page = Number(metadata.page ?? fallback.page ?? 1);
  const limit = Number(metadata.limit ?? fallback.limit ?? DEFAULT_PAGE_LIMIT);
  const total = Number(metadata.total);
  const links = asObject(metadata._links ?? metadata.links);
  return {
    page: Number.isFinite(page) && page > 0 ? page : 1,
    limit: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_PAGE_LIMIT,
    total: Number.isFinite(total) && total >= 0 ? total : null,
    next: links.next ?? null,
  };
}

export function buildRakutenEventParams(params = {}) {
  const allowed = [
    "process_date_start",
    "process_date_end",
    "transaction_date_start",
    "transaction_date_end",
    "limit",
    "page",
    "currency",
    "type",
  ];
  const out = {};
  for (const key of allowed) {
    if (params[key] !== undefined && params[key] !== null && params[key] !== "") out[key] = params[key];
  }

  const hasProcessStart = Boolean(out.process_date_start);
  const hasProcessEnd = Boolean(out.process_date_end);
  if (hasProcessStart !== hasProcessEnd) {
    throw new Error("Rakuten Events process_date_start and process_date_end must be supplied together");
  }

  const hasTransactionStart = Boolean(out.transaction_date_start);
  const hasTransactionEnd = Boolean(out.transaction_date_end);
  if (hasTransactionStart !== hasTransactionEnd) {
    throw new Error("Rakuten Events transaction_date_start and transaction_date_end must be supplied together");
  }

  out.limit = finitePositive(out.limit, DEFAULT_PAGE_LIMIT);
  out.page = finitePositive(out.page, 1);
  return out;
}

/**
 * Rakuten Events are recent directional components. Keep the network component
 * identifier separate from the advertiser order reference; a later transaction
 * ID may be an adjustment/cancellation for the same order/SKU.
 */
export function normalizeRakutenEventEvidence(row = {}) {
  const input = asObject(row);
  return {
    ...input,
    networkConversionComponentId: input.etransaction_id ?? null,
    networkOrderReference: input.order_id ?? null,
    advertiserId: input.advertiser_id ?? null,
    publisherId: input.sid ?? null,
    sku: input.sku_number ?? null,
    itemValue: input.sale_amount ?? null,
    quantity: input.quantity ?? null,
    baseCommissionCandidate: input.commissions ?? null,
    attributionU1: input.u1 ?? null,
    networkCurrency: input.currency ?? null,
    networkRawLockStatus: input.lock_status ?? null,
    networkEventIndicator: input.is_event ?? null,
  };
}

export function parseCsv(text) {
  const source = String(text ?? "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }

  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }

  return rows.filter((r) => r.some((value) => String(value).trim() !== ""));
}

function rowObject(headers, values) {
  const out = {};
  headers.forEach((header, index) => {
    out[String(header).trim()] = values[index] ?? "";
  });
  return out;
}

function value(row, ...headers) {
  for (const header of headers) {
    if (row[header] !== undefined && row[header] !== null && row[header] !== "") return row[header];
  }
  return null;
}

export function normalizeRakutenAdvancedReportRow(row = {}, reportId) {
  const report = Number(reportId);
  const base = { ...row, report_id: report, record_source: `rakuten_advanced_report_${report}` };

  if (report === 1) {
    return {
      ...base,
      payment_id: value(row, "Payment ID"),
      payment_date: value(row, "Date"),
      payment_type: value(row, "Payment Type"),
      check_number: value(row, "Check Number"),
      currency: value(row, "Currency Code"),
      payment_amount: value(row, "Total Commission Amount Paid"),
      network_payment_status: value(row, "Payment Status"),
    };
  }

  if (report === 2 || report === 22) {
    return {
      ...base,
      invoice_date: value(row, "Invoice Date"),
      advertiser_id: value(row, "Advertiser ID"),
      advertiser_name: value(row, "Advertiser"),
      invoice_number: value(row, "Invoice Number"),
      transaction_commissions: value(row, "Transaction Commissions"),
      bonus_amount: value(row, "Bonus Amount"),
      cpm_cpc_commissions: value(row, "CPM & CPC Commissions"),
      held_commissions: value(row, "Held Commissions"),
      cancelled_commissions: value(row, "Cancelled Commissions"),
      previously_held_commissions: value(row, "Previously Held Commissions"),
      vat_gst: value(row, "VAT/GST"),
      payment_amount: value(row, "Payment Amount"),
      advertiser_payment_date: value(row, "Advertiser Payment Date"),
    };
  }

  if (report === 3 || report === 23) {
    return {
      ...base,
      transaction_date: value(row, "Date"),
      transaction_time: value(row, "Time"),
      advertiser_id: value(row, "Advertiser ID"),
      advertiser_name: value(row, "Advertiser"),
      order_id: value(row, "Order ID"),
      sku_number: value(row, "SKU #"),
      product_name: value(row, "Product Name"),
      items: value(row, "Items"),
      sales: value(row, "Sales"),
      baseline_commission: value(row, "Baseline Commission"),
      adjusted_commission: value(row, "Adjusted Commission"),
      actual_commission: value(row, "Actual Commission"),
      transaction_payment_status: value(row, "Transaction Payment Status"),
      reason: value(row, "Reason"),
      advertiser_payment_memo: value(row, "Advertiser Payment Memo"),
      advertiser_payment_date: value(row, "Advertiser Payment Date"),
    };
  }

  return base;
}

export function parseRakutenAdvancedReport(text, reportId) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1).map((values) => normalizeRakutenAdvancedReportRow(rowObject(headers, values), reportId));
}

export function createRakutenAdapter({
  accessToken,
  securityToken = null,
  baseURL = process.env.RAKUTEN_BASE_URL || "https://api.linksynergy.com",
  advancedReportCallBudget = Number(process.env.RAKUTEN_ADVANCED_REPORT_MAX_CALLS_PER_RUN) || DEFAULT_ADVANCED_REPORT_CALL_BUDGET,
} = {}) {
  if (!accessToken) throw new Error("Rakuten adapter requires accessToken");

  const root = String(baseURL).replace(/\/$/, "");
  const httpClient = createHttpClient({
    baseURL: root,
    apiKey: `Bearer ${accessToken}`,
    headers: { Accept: "application/json" },
  });

  let advancedReportCalls = 0;

  async function getJson(path, params = {}, stats = null) {
    if (stats) stats.requestCount = (stats.requestCount || 0) + 1;
    const response = await requestWithRetry(
      () => httpClient.get(path, { params, headers: { Accept: "application/json" } }),
      { retries: 3, delayMs: 1000 },
    );
    return response?.data;
  }

  async function getCsv(path, params = {}, stats = null) {
    if (!securityToken) throw new Error("Rakuten Advanced Reports require securityToken");
    if (advancedReportCalls >= advancedReportCallBudget) {
      const error = new Error("Rakuten Advanced Reports per-run call budget exhausted");
      error.code = "RAKUTEN_ADVANCED_REPORT_BUDGET_EXHAUSTED";
      throw error;
    }
    advancedReportCalls += 1;
    if (stats) {
      stats.requestCount = (stats.requestCount || 0) + 1;
      stats.advancedReportRequestCount = (stats.advancedReportRequestCount || 0) + 1;
    }
    const response = await requestWithRetry(
      () => httpClient.get(path, {
        params: { ...params, token: securityToken },
        responseType: "text",
        headers: { Accept: "text/csv,text/plain,*/*" },
      }),
      { retries: 3, delayMs: 1000 },
    );
    return String(response?.data ?? "");
  }

  async function fetchPagedJson(path, params, keys, stats = null, { maxLimit = null } = {}) {
    const requestedLimit = finitePositive(params?.limit, DEFAULT_PAGE_LIMIT);
    const limit = maxLimit ? Math.min(requestedLimit, maxLimit) : requestedLimit;
    let page = finitePositive(params?.page, 1);
    const baseParams = { ...(params || {}) };
    delete baseParams.page;
    delete baseParams.limit;
    const out = [];
    const maxPages = finitePositive(params?.maxPages, 1000);
    delete baseParams.maxPages;

    for (let pageCount = 0; pageCount < maxPages; pageCount += 1) {
      // eslint-disable-next-line no-await-in-loop
      const payload = await getJson(path, { ...baseParams, page, limit }, stats);
      const rows = extractRakutenCollection(payload, keys);
      const meta = extractRakutenPagination(payload, { page, limit });
      out.push(...rows);
      if (!rows.length) break;
      if (meta.total != null && meta.page * meta.limit >= meta.total) break;
      if (!meta.next && rows.length < meta.limit) break;
      page = meta.page + 1;
    }
    return out;
  }

  return {
    supplierKey: "RAKUTEN",

    getCapabilities() {
      return {
        capabilities: [
          SUPPLIER_CAPABILITIES.CAMPAIGNS,
          SUPPLIER_CAPABILITIES.CONVERSIONS,
          SUPPLIER_CAPABILITIES.PAYMENTS,
          SUPPLIER_CAPABILITIES.TRACKING_SUBID,
          SUPPLIER_CAPABILITIES.ORDER_ITEMS,
          SUPPLIER_CAPABILITIES.REPORTING,
        ],
        pagination: "source_specific",
        notes: [
          "Bearer token is required for publisher APIs; Advanced Reports also require a separate web security token.",
          "Events are recent directional transaction-component evidence, not the historical/expected-commission ledger.",
          "Advanced Reports payment history is network payment evidence only; Advertiser Payment Date is not MBO receipt evidence.",
          "Coupon, Product Search and Link Locator are XML surfaces and remain gated until the XML ingestion layer is wired.",
        ],
      };
    },

    async authenticate(stats = null) {
      try {
        await getJson("/v2/advertisers", { limit: 1, page: 1 }, stats);
        return { ok: true };
      } catch (error) {
        return { ok: false, detail: error?.message || "Rakuten auth failed" };
      }
    },

    async healthCheck(stats = null) {
      return this.authenticate(stats);
    },

    async fetchAdvertisers(params = {}, stats = null) {
      return fetchPagedJson("/v2/advertisers", params, ["advertisers", "advertiser"], stats, { maxLimit: 200 });
    },

    async fetchCampaigns(params = {}, stats = null) {
      return this.fetchAdvertisers(params, stats);
    },

    async fetchPartnerships(params = {}, stats = null) {
      return fetchPagedJson("/v1/partnerships", params, ["partnerships", "partnership"], stats, { maxLimit: 200 });
    },

    async fetchOffers(params = {}, stats = null) {
      const requestedStatus = params.offer_status ?? params.offerStatus ?? null;
      const statuses = requestedStatus ? [String(requestedStatus)] : ["active", "upcoming", "available"];
      const seen = new Set();
      const rows = [];
      for (const status of statuses) {
        const request = { ...params, offer_status: status };
        delete request.offerStatus;
        // eslint-disable-next-line no-await-in-loop
        const part = await fetchPagedJson("/v1/offers", request, ["offers", "offer"], stats, { maxLimit: MAX_OFFER_LIMIT });
        for (const row of part) {
          const advertiserId = row?.advertiser?.id ?? "";
          const key = `${advertiserId}|${row?.goid ?? ""}|${row?.offer_number ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push({ ...row, _mboOfferStatusQuery: status });
        }
      }
      return rows;
    },

    async fetchCommissioningLists(params = {}, stats = null) {
      return fetchPagedJson("/v1/commissioninglists", params, ["commissioninglists", "commissioning_lists"], stats, { maxLimit: 200 });
    },

    async fetchConversions(params = {}, stats = null) {
      const first = buildRakutenEventParams(params);
      const base = { ...first };
      const limit = base.limit;
      let page = base.page;
      delete base.page;
      delete base.limit;
      const maxPages = finitePositive(params.maxPages, 1000);
      const rows = [];

      for (let pageCount = 0; pageCount < maxPages; pageCount += 1) {
        // eslint-disable-next-line no-await-in-loop
        const payload = await getJson("/events/1.0/transactions", { ...base, limit, page }, stats);
        const pageRows = extractRakutenCollection(payload, ["transactions"]);
        rows.push(...pageRows.map(normalizeRakutenEventEvidence));
        if (!pageRows.length || pageRows.length < limit) break;
        page += 1;
      }
      return rows;
    },

    async fetchAdvancedReport(reportId, params = {}, stats = null) {
      const report = Number(reportId);
      if (![1, 2, 3, 22, 23].includes(report)) throw new Error(`Unsupported Rakuten Advanced Report ID: ${reportId}`);
      const request = { ...params, reportid: report };
      if (report === 1 && (!request.bdate || !request.edate)) {
        throw new Error("Rakuten payment history summary requires bdate and edate");
      }
      if ((report === 2 || report === 22) && !request.payid) {
        throw new Error(`Rakuten report ${report} requires payid`);
      }
      if ((report === 3 || report === 23) && !request.invoiceid) {
        throw new Error(`Rakuten report ${report} requires invoiceid`);
      }
      const text = await getCsv("/advancedreports/1.0", request, stats);
      return parseRakutenAdvancedReport(text, report);
    },

    async fetchPaymentHistory(params = {}, stats = null) {
      return this.fetchAdvancedReport(1, params, stats);
    },

    async fetchAdvertiserPaymentHistory(params = {}, stats = null) {
      return this.fetchAdvancedReport(params.reportId ?? 22, params, stats);
    },

    async fetchPaymentDetails(params = {}, stats = null) {
      return this.fetchAdvancedReport(params.reportId ?? 23, params, stats);
    },

    async fetchPayments(params = {}, stats = null) {
      const reportId = Number(params.reportId ?? params.reportid ?? 1);
      return this.fetchAdvancedReport(reportId, params, stats);
    },

    async fetchAll(options = {}) {
      const stats = { requestCount: 0, advancedReportRequestCount: 0 };
      const campaigns = options.skipCampaigns ? [] : await this.fetchAdvertisers(options.advertisers ?? {}, stats);
      const partnerships = options.skipPartnerships ? [] : await this.fetchPartnerships(options.partnerships ?? {}, stats);
      const offers = options.skipOffers ? [] : await this.fetchOffers(options.offers ?? {}, stats);
      const conversions = options.skipConversions ? [] : await this.fetchConversions(options.events ?? {}, stats);
      const payments = options.paymentHistory ? await this.fetchPaymentHistory(options.paymentHistory, stats) : [];
      return { campaigns, partnerships, offers, conversions, payments, stats };
    },
  };
}
