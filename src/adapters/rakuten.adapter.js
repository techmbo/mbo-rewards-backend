import { createHttpClient, requestWithRetry } from "../core/httpClient.js";
import { decodeXml, tagBlocks, tagBlocksWithAttributes, tagText } from "../core/xml.js";
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

/** Certification-only ceiling. Shorter than the shared 30s client default so a probe reports its
 *  own timeout inside the source budget instead of being killed by the runtime. */
export const RAKUTEN_CERTIFICATION_TIMEOUT_MS = Number(
  process.env.RAKUTEN_CERTIFICATION_TIMEOUT_MS || 15000,
);

/** A field dictionary needs one row. The service bounds this again, independently. */
export const RAKUTEN_CERTIFICATION_MAX_ROWS = 1;

/**
 * Link Locator's documented text-links operation.
 *
 * GET /linklocator/1.0/getTextLinks/{advertiser-id}/{category-id}/{link-start-date}/{link-end-date}/{DEPRECATED-campaign-id}/{page}
 *
 * TWO SHAPES HAVE BEEN PROBED LIVE AND BOTH ANSWERED HTTP 500 "Invalid URL/Verb combination": the
 * official slash path with the two date slots left BLANK, and the same operation moved into the
 * query string after "?". Both carried blank dates, and both failed identically — so the path form
 * is not what separates them, and the variable never yet isolated is the DATES. An empty path
 * segment is exactly what a router may collapse before Rakuten's own dispatch ever sees it, and a
 * collapsed pair shifts every later segment into the wrong slot, presenting an operation Rakuten
 * cannot match.
 *
 * Kept as evidence so neither shape can be quietly reintroduced.
 */
export const RAKUTEN_TEXT_LINKS_REJECTED_PATHS = Object.freeze([
  "/linklocator/1.0/getTextLinks/-1/-1///-1/1",
  "/linklocator/1.0?getTextLinks/-1/-1///-1/1",
]);

/** The operation as the official OpenAPI definition places it: a path segment of the resource. */
export const RAKUTEN_TEXT_LINKS_RESOURCE = "/linklocator/1.0/getTextLinks";

/**
 * A Link Locator date in MMDDYYYY, the form Rakuten's own worked examples use.
 *
 * Read in UTC because the certification window is written in UTC: its from/to come from
 * toISOString().slice(0, 10), so re-reading them in local time could shift the day by one and
 * probe a window other than the one reported.
 *
 * Returns null for an unparseable value rather than a malformed string, so the path builder can
 * refuse instead of sending "null" into a date slot.
 */
export function rakutenLinkDateParam(value) {
  const date = value instanceof Date ? new Date(value) : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  return `${month}${day}${year}`;
}

/**
 * The explicit-date isolation path, built from the service's own bounded window.
 *
 * CERTIFICATION ISOLATION ONLY. Its single purpose is to answer whether blank date slots are what
 * Rakuten rejects. Nothing in production builds or sends this, and no general Link Locator
 * behaviour changes with it.
 *
 * Every segment except the two dates is held at the documented default the rejected probes already
 * used — advertiser-id -1, category-id -1, deprecated campaign id -1, page 1 — so the dates are the
 * ONLY variable between those failed requests and this one. That is the whole design: if this
 * succeeds, blank dates were the cause; if it returns the same 500, the dates are exonerated and
 * the path form becomes the next hypothesis. A probe that changed two things at once could not
 * settle either.
 *
 * The dates come from the window and never from a caller. Both must resolve: a window that cannot
 * produce two MMDDYYYY values yields no path at all rather than a request with "null" where a date
 * belongs.
 */
export function buildRakutenTextLinksIsolationPath(window = {}) {
  const start = rakutenLinkDateParam(window?.from);
  const end = rakutenLinkDateParam(window?.to);
  if (!start || !end) {
    throw new Error("Rakuten Link Locator isolation requires a bounded window with both dates");
  }
  return `${RAKUTEN_TEXT_LINKS_RESOURCE}/-1/-1/${start}/${end}/-1/1`;
}

/** The documented fields of one <return> element in a getTextLinksResponse. */
const RAKUTEN_TEXT_LINK_FIELDS = Object.freeze([
  "campaignID",
  "categoryID",
  "categoryName",
  "linkID",
  "linkName",
  "mid",
  "nid",
  "clickURL",
  "endDate",
  "landURL",
  "showURL",
  "startDate",
  "textDisplay",
]);

/**
 * Rows out of a getTextLinksResponse.
 *
 * <return> is the ROW element; <getTextLinksResponse> is the envelope around it. Reading the
 * envelope as a row would certify a single object carrying every row's fields flattened together,
 * so this only ever walks <return> blocks — and a response with none yields no rows rather than
 * one empty one.
 *
 * A row here is a DISCOVERED LINK ASSET. It is not evidence that the link is usable: Rakuten
 * exposes assets before a partnership is active and blocks their use until it is. Nothing in this
 * adapter promotes a clickURL to a tracking link, and certification never returns one.
 */
export function extractRakutenTextLinks(xml) {
  return tagBlocks(xml, "return").map((block) => {
    const row = {};
    for (const field of RAKUTEN_TEXT_LINK_FIELDS) row[field] = tagText(block, field);
    return row;
  });
}

/**
 * Rakuten's Coupon API — coupons and promotional links from partner-advertisers.
 *
 * GET /coupon/1.0, Bearer only, XML.
 *
 * Officially documented pagination, and the ONLY two parameters this integration sends:
 *   resultsperpage=<count>   maximum 500, default 500
 *   pagenumber=<page>        default 1
 *
 * No category, network, MID or promotion-type filter is sent. They exist in the supplier's
 * contract; sending one would scope the read to a slice nobody asked for, and a filter this
 * integration has never exercised is a request shape it has no evidence about.
 */
export const RAKUTEN_COUPON_PATH = "/coupon/1.0";
export const RAKUTEN_COUPON_MAX_RESULTS_PER_PAGE = 500;
export const RAKUTEN_COUPON_DEFAULT_RESULTS_PER_PAGE = 500;

/** The certification bounds: the smallest page the documented parameters can express. */
export const RAKUTEN_CERTIFICATION_COUPON_PARAMS = Object.freeze({
  resultsperpage: 1,
  pagenumber: 1,
});

/**
 * The two documented parameters, and nothing else.
 *
 * An ALLOWLIST rather than a passthrough: a caller cannot widen the request into a filtered one,
 * because a key this function does not name never reaches the supplier. resultsperpage is clamped
 * to the documented maximum of 500 rather than forwarded, so an over-large ask becomes the largest
 * legal page instead of a rejected request.
 */
export function buildRakutenCouponParams(params = {}) {
  const requestedPerPage = Number(params?.resultsperpage);
  const requestedPage = Number(params?.pagenumber);
  return {
    resultsperpage:
      Number.isFinite(requestedPerPage) && requestedPerPage > 0
        ? Math.min(Math.trunc(requestedPerPage), RAKUTEN_COUPON_MAX_RESULTS_PER_PAGE)
        : RAKUTEN_COUPON_DEFAULT_RESULTS_PER_PAGE,
    pagenumber:
      Number.isFinite(requestedPage) && requestedPage > 0 ? Math.trunc(requestedPage) : 1,
  };
}

/** Documented scalar fields of one coupon <link>. couponcode, couponrestriction and imageurl are
 *  OPTIONAL — present only when the advertiser supplies them — so a row without them is a complete
 *  row, not a truncated one. */
const RAKUTEN_COUPON_FIELDS = Object.freeze([
  "advertiserid",
  "advertisername",
  "network",
  "offerdescription",
  "offerstartdate",
  "offerenddate",
  "couponcode",
  "couponrestriction",
  "imageurl",
  "clickurl",
  "impressionpixel",
]);

/** The two documented REPEATING containers, as [container, item] pairs. Each holds zero or more
 *  items, so each is read as an array — reading <categories> as text would concatenate every
 *  category into one meaningless string. */
const RAKUTEN_COUPON_LIST_FIELDS = Object.freeze([
  Object.freeze(["categories", "category"]),
  Object.freeze(["promotiontypes", "promotiontype"]),
]);

/** Every value of a repeated element, decoded and trimmed, with empties and the literal "null"
 *  dropped — the same absence rule tagText applies to a single element. */
function repeatedTagText(xml, tag) {
  return tagBlocks(xml, tag)
    .map((block) => decodeXml(block).trim())
    .filter((value) => value !== "" && value.toLowerCase() !== "null");
}

/**
 * Rows out of a couponfeed response.
 *
 * <link> is the ROW element; <couponfeed> is the envelope around it, carrying TotalMatches,
 * TotalPages and PageNumberRequested. Reading the envelope as a row would certify a single object
 * holding page counters plus every row's fields flattened together — so rows are only ever read
 * from INSIDE <couponfeed>, and a response without that envelope yields no rows rather than one
 * wrong one.
 *
 * type is the row-kind attribute of the <link> element itself (TEXT or BANNER), not a child
 * element, which is why the attribute-aware primitive is used here.
 *
 * A row here is an AVAILABLE COUPON ASSET. Two things it is not:
 *   - COUPON_ASSET_AVAILABLE != COUPON_CODE_PRESENT. couponcode exists only where the advertiser
 *     requires a code; a row without one is still a valid promotional link.
 *   - COUPON_ROW_AVAILABLE != TRACKING_LINK_USABLE. Nothing here promotes clickurl to a tracking
 *     link, and certification never returns one.
 */
export function extractRakutenCouponLinks(xml) {
  const feed = tagBlocks(xml, "couponfeed")[0] ?? "";
  return tagBlocksWithAttributes(feed, "link").map(({ attributes, content }) => {
    const row = { type: attributes.type ?? null };
    for (const field of RAKUTEN_COUPON_FIELDS) row[field] = tagText(content, field);
    for (const [container, item] of RAKUTEN_COUPON_LIST_FIELDS) {
      row[container] = repeatedTagText(tagBlocks(content, container)[0] ?? "", item);
    }
    return row;
  });
}

/**
 * Rakuten's Events API — recent transaction confirmations.
 *
 * GET /events/1.0/transactions, Bearer only, JSON. Production already reads this path in
 * fetchConversions; nothing here duplicates it. What is added is the bounded CERTIFICATION shape.
 *
 * AN EVENT TRANSACTION IS NOT A FINAL ORDER FINANCE RECORD. Rakuten retains roughly the previous
 * one to two weeks here and describes it as recent, directional conversion evidence. `commissions`
 * on a row is a supplier-observed event commission — not the final payable commission, not
 * ClientPayable, not NetworkInvoice, not NetworkPayment. Expected and final reconciliation belongs
 * to the reporting surfaces (Signature Orders / Individual Item), not to this endpoint. Nothing in
 * this phase feeds an Events value into commercial or payable logic.
 */
export const RAKUTEN_EVENTS_PATH = "/events/1.0/transactions";

/** The row container. Production's fetchConversions reads the same key, so certification and the
 *  sync see a ROW and never the envelope around it. */
export const RAKUTEN_EVENTS_COLLECTION_KEYS = Object.freeze(["transactions"]);

/**
 * A UTC day boundary as a Date: the first instant of the day, or its last whole second.
 *
 * The certification window carries bare YYYY-MM-DD dates produced by toISOString().slice(0, 10),
 * so they are UTC calendar dates and are read back as such. Reading them in local time would shift
 * the day by one in any negative-offset zone and probe a window other than the one reported.
 *
 * The two ends are deliberately ASYMMETRIC. process_date_end is an inclusive upper bound on a
 * TIMESTAMP, and the window's `to` is today — so rendering it at 00:00:00 would ask for a window
 * that ends the instant today begins, discarding every transaction the supplier has recorded
 * today. On an API whose whole content is the last week or two, that is the half most likely to
 * hold a row.
 */
function rakutenUtcDayBoundary(value, { endOfDay = false } = {}) {
  const date = value instanceof Date ? new Date(value) : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0,
    ),
  );
}

/**
 * An Events date in the documented "YYYY-MM-DD HH:mm:ss", rendered from UTC components.
 *
 * URL encoding of the space is the HTTP client's job, not this function's: encoding here would
 * double-encode it into %2520.
 *
 * Returns null for an unparseable value rather than a malformed string, so the caller can refuse
 * instead of sending "null" where a date belongs.
 */
export function rakutenEventDateParam(value) {
  const date = value instanceof Date ? new Date(value) : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  const day = `${String(date.getUTCFullYear()).padStart(4, "0")}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  return `${day} ${time}`;
}

/**
 * The bounded Events request, built from the service's own window.
 *
 * The PROCESS date pair, not the transaction one. Rakuten takes either, and both members of a pair
 * must travel together — a half-open pair is a request the supplier rejects. Only one pair is ever
 * sent, so there is no ambiguity about which date the window bounded.
 *
 * The final assembly runs through buildRakutenEventParams, which is PRODUCTION'S OWN builder: the
 * allowlist, the together-or-not-at-all rule for each pair, and the limit/page normalisation are
 * production's rather than a second implementation of them. A key it does not name cannot reach
 * the supplier.
 */
export function buildRakutenCertificationEventParams(window = {}) {
  const processDateStart = rakutenEventDateParam(rakutenUtcDayBoundary(window?.from));
  const processDateEnd = rakutenEventDateParam(rakutenUtcDayBoundary(window?.to, { endOfDay: true }));
  if (!processDateStart || !processDateEnd) {
    throw new Error("Rakuten Events certification requires a bounded window with both dates");
  }
  return buildRakutenEventParams({
    process_date_start: processDateStart,
    process_date_end: processDateEnd,
    ...RAKUTEN_CERTIFICATION_PAGE_PARAMS,
  });
}

/**
 * Rakuten Advanced Reports — the reporting surface, reached as CSV.
 *
 * GET /advancedreports/1.0, scoped by reportid. The repo wires five report ids and this phase
 * certifies exactly one of them: report 1, the PAYMENT HISTORY SUMMARY, which fetchPaymentHistory
 * already requests.
 *
 * Report 1 is upstream payment-summary evidence and nothing more. It is not individual transaction
 * truth, not item-level commission, and it is not ClientPayable, NetworkInvoice, NetworkPayment or
 * an MBO receipt — those stay separate downstream objects. Report availability is not proof of
 * settlement.
 *
 * Reports 22 and 23 are deliberately untouched here. Neither is date-scoped: 22 needs a payid and
 * 23 needs an invoiceid, so production reaches them only by walking
 * report 1 -> payment_id -> report 22 -> invoice_number -> report 23. Report 1 is the only one a
 * single bounded request can reach.
 */
export const RAKUTEN_ADVANCED_REPORTS_PATH = "/advancedreports/1.0";
export const RAKUTEN_PAYMENT_HISTORY_REPORT_ID = 1;

/**
 * A bdate/edate value in the YYYYMMDD Rakuten requires here.
 *
 * PRODUCTION'S FORMAT, not a new one: buildRakutenPaymentHistoryWindow renders the same bound as
 * toISOString().slice(0, 10) with the dashes removed, which is this exact string for the same
 * instant. Read in UTC for the same reason every other Rakuten date is — the certification window
 * carries UTC calendar dates, and a local-time read would shift the day in any negative-offset
 * zone.
 *
 * Returns null for an unparseable value rather than a malformed string.
 */
export function rakutenAdvancedReportDateParam(value) {
  const date = value instanceof Date ? new Date(value) : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${String(date.getUTCFullYear()).padStart(4, "0")}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
}

/**
 * The bounded report 1 request, built from the service's own window.
 *
 * bdate and edate only. reportid is added by the sampler from the frozen spec, and the security
 * token by getCsv — so no caller-reachable key can widen or re-point this request.
 */
export function buildRakutenCertificationPaymentHistoryParams(window = {}) {
  const bdate = rakutenAdvancedReportDateParam(window?.from);
  const edate = rakutenAdvancedReportDateParam(window?.to);
  if (!bdate || !edate) {
    throw new Error("Rakuten Advanced Report 1 certification requires a bounded window with both dates");
  }
  return { bdate, edate };
}

/**
 * Bodies Rakuten returns INSTEAD of a report when the requested window holds nothing.
 *
 * Live evidence: report 1 answered 200 with the single line "No Results Found". A CSV reader has
 * no way to tell that apart from a one-column report whose header happens to read that way, so it
 * was certified as a schema — one field named "No Results Found", KNOWN_FROM_HEADERS. That is a
 * false statement about the endpoint: the columns are still unknown.
 *
 * Deliberately ONE entry, and recognised only when it is the WHOLE body — a single row of a single
 * cell. A real one-column report keeps its header, and a report that merely contains a column with
 * this name keeps every column. Casing and surrounding whitespace are normalised because those are
 * presentation; no other wording is guessed at, because no other wording has been observed.
 */
export const RAKUTEN_ADVANCED_REPORT_NO_RESULT_BODIES = Object.freeze(["no results found"]);

/** Whether a parsed table is a no-result sentinel rather than a report. */
function isRakutenNoResultBody(table) {
  if (table.length !== 1 || table[0].length !== 1) return false;
  const only = String(table[0][0] ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  return RAKUTEN_ADVANCED_REPORT_NO_RESULT_BODIES.includes(only);
}

/**
 * The exact supplier header row, and at most one data row keyed by those headers.
 *
 * Headers are used VERBATIM — not trimmed, not lower-cased, not mapped. Production's rowObject
 * trims them and normalizeRakutenAdvancedReportRow then renames them ("SKU #" becomes sku_number,
 * "Actual Commission" becomes actual_commission); certifying either would certify MBO's vocabulary
 * rather than the supplier's column names.
 *
 * parseCsv drops rows that are entirely blank, so a header-only report yields one row here — the
 * headers — and an empty body yields none. That difference is what lets the caller tell
 * "the columns are known, this window held nothing" from "nothing came back at all".
 */
export function extractRakutenCsvSample(text, { maxRows = RAKUTEN_CERTIFICATION_MAX_ROWS } = {}) {
  const table = parseCsv(text);
  // Nothing at all, and the supplier's own "nothing" sentinel, are the same outcome: no columns
  // were reported, so the schema stays unknown. parseCsv itself is untouched — this is Advanced
  // Reports' contract, not a rule about CSV.
  if (!table.length || isRakutenNoResultBody(table)) return { headers: [], rows: [] };
  const headers = table[0].map((header) => String(header ?? ""));
  const rows = table.slice(1, 1 + Math.max(0, maxRows)).map((values) => {
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    return row;
  });
  return { headers, rows };
}

/**
 * Rakuten's Product Search — a SEARCH surface over partner-advertiser product data.
 *
 * GET /productsearch/1.0, Bearer only, XML, returning a <result> envelope of <item> rows.
 *
 * Three boundaries this does not cross:
 *   - PRODUCT_SEARCH_ROW != CANONICAL_PRODUCT. Nothing here writes Product, ProductSource,
 *     ProductFeed or ProductFeedItem.
 *   - PRODUCT_LINK_DISCOVERABLE != TRACKING_LINK_USABLE. linkurl is discovered, never promoted.
 *   - PRODUCT_AVAILABLE != PRODUCT_FEED_AVAILABLE. A search endpoint answering is not evidence
 *     that a bulk product feed exists for this account.
 *
 * ONE PART OF THE CONTRACT IS NOT ESTABLISHED: whether Rakuten accepts a search with NO filter —
 * no keyword, exact, one, none, cat or mid — and only the bounds below. The documented query
 * capabilities list those filters without stating that one is required, and this repo has never
 * made the call. The probe therefore sends the bounds ALONE. That is the one shape that invents
 * nothing: a keyword would be a search term nobody asked for, and a mid would point the probe at a
 * particular advertiser taken from another endpoint's row. If Rakuten requires a filter, the
 * bounded probe answers REQUEST_REJECTED and the supplier's own message captures the contract at a
 * cost of one request.
 */
export const RAKUTEN_PRODUCT_SEARCH_PATH = "/productsearch/1.0";

/** The documented bounds, and the whole certification request. */
export const RAKUTEN_CERTIFICATION_PRODUCT_PARAMS = Object.freeze({ max: 1, pagenumber: 1 });

/**
 * The documented query capabilities, as an ALLOWLIST for the general read method.
 *
 * A caller cannot reach a parameter this list does not name. Certification never supplies any of
 * the filters — it sends max and pagenumber only.
 */
export const RAKUTEN_PRODUCT_SEARCH_PARAMS = Object.freeze([
  "keyword",
  "exact",
  "one",
  "none",
  "cat",
  "language",
  "max",
  "pagenumber",
  "mid",
  "sort",
  "sorttype",
]);

/** Documented scalar fields of one <item>. All optional: a row missing any of them is a row. */
const RAKUTEN_PRODUCT_FIELDS = Object.freeze([
  "mid",
  "merchantname",
  "linkid",
  "createdon",
  "sku",
  "productname",
  "upccode",
  "keywords",
  "linkurl",
  "imageurl",
]);

/** The documented NESTED containers, as [container, children]. Read as nested objects because
 *  that is their shape: flattening category into one string would lose which level a value came
 *  from, and reading the container as text would concatenate its children. */
const RAKUTEN_PRODUCT_NESTED_FIELDS = Object.freeze([
  Object.freeze(["category", Object.freeze(["primary", "secondary"])]),
  Object.freeze(["description", Object.freeze(["short", "long"])]),
]);

/** The documented ATTRIBUTE-CARRYING money elements: <price currency="USD">…</price>. The currency
 *  lives on the element, not beside it, so a reader seeing only inner content would report an
 *  amount with no idea what it is denominated in. */
const RAKUTEN_PRODUCT_MONEY_FIELDS = Object.freeze(["price", "saleprice"]);

/**
 * Rows out of a Product Search response.
 *
 * <item> is the ROW element; <result> is the envelope around it, carrying TotalMatches, TotalPages
 * and PageNumber. Reading the envelope as a row would certify page counters flattened together
 * with every row's fields — so rows are only ever read from INSIDE <result>, and a response
 * without that envelope yields no rows rather than one wrong one.
 *
 * A row here is a DISCOVERED PRODUCT RECORD and nothing more. It is not a canonical Product, its
 * linkurl is not a usable tracking link, and its existence says nothing about whether a bulk
 * product feed exists.
 */
export function extractRakutenProducts(xml) {
  const result = tagBlocks(xml, "result")[0] ?? "";
  return tagBlocks(result, "item").map((block) => {
    const row = {};
    for (const field of RAKUTEN_PRODUCT_FIELDS) row[field] = tagText(block, field);

    for (const [container, children] of RAKUTEN_PRODUCT_NESTED_FIELDS) {
      const inner = tagBlocks(block, container)[0];
      row[container] =
        inner === undefined
          ? null
          : Object.fromEntries(children.map((child) => [child, tagText(inner, child)]));
    }

    for (const field of RAKUTEN_PRODUCT_MONEY_FIELDS) {
      const [money] = tagBlocksWithAttributes(block, field);
      if (!money) {
        row[field] = null;
        continue;
      }
      const amount = decodeXml(money.content).trim();
      row[field] = {
        currency: money.attributes.currency ?? null,
        amount: amount === "" || amount.toLowerCase() === "null" ? null : amount,
      };
    }

    return row;
  });
}

/**
 * The two documented bounds, plus whatever documented filters a caller names — and nothing else.
 *
 * An ALLOWLIST rather than a passthrough: a key this list does not name never reaches the
 * supplier. max and pagenumber default to the certification bounds so an unqualified call stays
 * one small page rather than becoming an unbounded search.
 */
export function buildRakutenProductSearchParams(params = {}) {
  const out = {};
  for (const key of RAKUTEN_PRODUCT_SEARCH_PARAMS) {
    const value = params?.[key];
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  }
  out.max = finitePositive(out.max, RAKUTEN_CERTIFICATION_PRODUCT_PARAMS.max);
  out.pagenumber = finitePositive(out.pagenumber, RAKUTEN_CERTIFICATION_PRODUCT_PARAMS.pagenumber);
  return out;
}

/**
 * Every Rakuten source object certification can sample, and the one path each uses.
 *
 * A frozen registry rather than a path argument: there is no call shape through which a caller
 * could reach an endpoint this table does not name.
 *
 * advertisers is production's own: authenticate() already issues GET /v2/advertisers with exactly
 * limit=1 and page=1, so the certified request is not a smaller variant of what production sends,
 * it IS what production sends. collectionKeys are fetchAdvertisers' own, so the same extractor
 * reads the same container.
 *
 * Bearer only. Advanced Reports and the web security token are deliberately absent: this probe
 * must separate "the Bearer works" from a credential it does not need.
 */
export const RAKUTEN_CERTIFICATION_SPECS = Object.freeze({
  advertisers: Object.freeze({
    method: "GET",
    path: "/v2/advertisers",
    collectionKeys: Object.freeze(["advertisers", "advertiser"]),
  }),
  // Relationship state. The live advertiser row exposed no join/approval field, so partnerships is
  // where that state must live if Rakuten exposes it at all — which is exactly what a field
  // dictionary from this endpoint is for.
  //
  // One honest difference from advertisers: there, limit=1 page=1 is production's own request,
  // because authenticate() already issues it. Here only the PARAMETER VOCABULARY is evidenced —
  // fetchPagedJson sends limit and page on this path, bounded by maxLimit 200 — while production
  // itself asks for the default 100. So the bounds are inside what production's own pager would
  // send, but the exact pair is not a request production has been observed making.
  partnerships: Object.freeze({
    method: "GET",
    path: "/v1/partnerships",
    collectionKeys: Object.freeze(["partnerships", "partnership"]),
  }),
  // The structured commission-rule source. The catalog already types this entityType
  // "commission_rule" while offers are "offer", so the repo's own classification treats this as
  // the rule surface — but that is a catalog assertion, not evidence. A field dictionary is what
  // turns it into evidence.
  //
  // Same bounds caveat as partnerships: the parameter vocabulary is production's (fetchPagedJson
  // sends limit and page here under maxLimit 200), but limit=1 page=1 is not itself a request
  // production has been observed making — it asks for the default 100.
  commissioning_lists: Object.freeze({
    method: "GET",
    path: "/v1/commissioninglists",
    collectionKeys: Object.freeze(["commissioninglists", "commissioning_lists"]),
  }),
  // The ONLY spec that carries extra parameters, and the only object where production makes more
  // than one request per run.
  //
  // fetchOffers walks three statuses — active, upcoming, available — and deduplicates across them,
  // so a production offers fetch is up to THREE supplier calls. Certification takes exactly one,
  // by pinning a single status.
  //
  // "available" is not a guess: it is one of the three values production itself sends on this
  // path. It is the right one here because this account has joined nothing, so catalogue-side
  // evidence is what there is to find — active and upcoming are the relationship-dependent halves.
  offers: Object.freeze({
    method: "GET",
    path: "/v1/offers",
    collectionKeys: Object.freeze(["offers", "offer"]),
    params: Object.freeze({ offer_status: "available" }),
  }),
  // The one XML object, the one DATED object, and the one whose bounds live entirely in the path.
  //
  // The only spec with no static path: its path is built per-run from the window, because the
  // whole point of this probe is that the two date slots carry explicit values. needs ["window"]
  // is what refuses to build a request without one — and that window is the SERVICE's, computed
  // from a frozen preset, never a caller's dates.
  //
  // pathBounded suppresses the limit/page pair every JSON object sends. Rakuten publishes no
  // results-per-page parameter for Link Locator, so sending one would be inventing a parameter —
  // and sending a bound an endpoint never documented is exactly what the Awin coupons 500 punished.
  // Page 1 already sits in the path, which is where Link Locator puts it.
  links: Object.freeze({
    method: "GET",
    needs: Object.freeze(["window"]),
    buildPath: buildRakutenTextLinksIsolationPath,
    pathBounded: true,
    xml: true,
    extract: extractRakutenTextLinks,
  }),
  // The second XML object, and the only one with documented bounds of its OWN.
  //
  // ownBounds suppresses the limit/page pair the JSON objects share. /coupon/1.0 publishes
  // resultsperpage and pagenumber instead, and sending limit/page alongside them would be sending
  // an endpoint two parameters it never documented — exactly what the Awin coupons 500 punished.
  //
  // resultsperpage=1 is the smallest page the documented contract can express, so the probe asks
  // the supplier for one row rather than asking for 500 and throwing 499 away.
  coupons: Object.freeze({
    method: "GET",
    path: RAKUTEN_COUPON_PATH,
    ownBounds: true,
    params: RAKUTEN_CERTIFICATION_COUPON_PARAMS,
    xml: true,
    extract: extractRakutenCouponLinks,
  }),
  // The second DATED object, and the only one whose parameters are built by production's own
  // builder rather than declared as a literal.
  //
  // ownBounds because the limit/page pair arrives INSIDE buildRakutenCertificationEventParams,
  // which runs it through buildRakutenEventParams — production's allowlist and pairing rule. A
  // second spread of the shared pair would bypass that normalisation.
  //
  // Rows are returned EXACTLY as the supplier sends them. normalizeRakutenEventEvidence, which
  // production applies in fetchConversions, is deliberately not used: it renames etransaction_id
  // to networkConversionComponentId and commissions to baseCommissionCandidate, and certifying a
  // renamed row would certify MBO's vocabulary instead of the supplier's.
  events: Object.freeze({
    method: "GET",
    path: RAKUTEN_EVENTS_PATH,
    needs: Object.freeze(["window"]),
    ownBounds: true,
    buildParams: buildRakutenCertificationEventParams,
    collectionKeys: RAKUTEN_EVENTS_COLLECTION_KEYS,
  }),
  // The only CSV object, and the only one reached through getCsv rather than the JSON client.
  //
  // csv routes it to fetchCertificationCsvSample, which returns the supplier's header row
  // alongside the sampled data rows. The JSON sampler refuses it outright rather than reading a
  // CSV body as if it were a collection.
  //
  // reportid is carried by the SPEC, not by the parameter builder, so a caller cannot reach report
  // 22 or 23 — neither of which is date-scoped, and neither of which this phase touches.
  // The third XML object. Its bounds are its own documented pair (max, pagenumber), so ownBounds
  // suppresses the limit/page pair the JSON objects share — sending an endpoint two parameters it
  // never published is what the Awin coupons 500 punished.
  //
  // NO FILTER IS SENT. keyword, exact, one, none, cat and mid are all documented, and none is
  // invented here: a keyword would be a search term nobody asked for, and a mid would point the
  // probe at one advertiser taken from another endpoint's row.
  products: Object.freeze({
    method: "GET",
    path: RAKUTEN_PRODUCT_SEARCH_PATH,
    ownBounds: true,
    params: RAKUTEN_CERTIFICATION_PRODUCT_PARAMS,
    xml: true,
    extract: extractRakutenProducts,
  }),
  advanced_reports: Object.freeze({
    method: "GET",
    path: RAKUTEN_ADVANCED_REPORTS_PATH,
    reportId: RAKUTEN_PAYMENT_HISTORY_REPORT_ID,
    needs: Object.freeze(["window"]),
    csv: true,
    buildParams: buildRakutenCertificationPaymentHistoryParams,
  }),
});

/** The page every Rakuten certification probe asks for — authenticate()'s own bounds. */
export const RAKUTEN_CERTIFICATION_PAGE_PARAMS = Object.freeze({ limit: 1, page: 1 });

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
  // Same seam the Awin, CJ and Admitad adapters expose. Default unchanged, so no production call
  // site is affected; it exists so the certification probe can be exercised as itself.
  httpClient: injectedHttpClient = null,
} = {}) {
  if (!accessToken) throw new Error("Rakuten adapter requires accessToken");

  const root = String(baseURL).replace(/\/$/, "");
  const httpClient =
    injectedHttpClient ??
    createHttpClient({
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

  // retries defaults to production's 3. Certification passes 1 — attempt once, never retry — so
  // one bounded probe stays one supplier request instead of up to four. Everything else about the
  // request (the security token, the per-run call budget, the Accept header, the stats counters)
  // stays in this one place rather than being duplicated into a parallel client.
  async function getCsv(path, params = {}, stats = null, { retries = 3, timeout = null } = {}) {
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
        ...(timeout ? { timeout: Number(timeout) } : {}),
      }),
      { retries, delayMs: 1000 },
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

    // Exhausted NATURALLY (the supplier said there is no more) versus exhausted by OUR cap are
    // two different facts, and only the first means the snapshot is complete. The loop used to
    // return the same bare array either way, so a truncated catalog reported SUCCESS.
    let exhausted = false;
    for (let pageCount = 0; pageCount < maxPages; pageCount += 1) {
      // eslint-disable-next-line no-await-in-loop
      const payload = await getJson(path, { ...baseParams, page, limit }, stats);
      const rows = extractRakutenCollection(payload, keys);
      const meta = extractRakutenPagination(payload, { page, limit });
      out.push(...rows);
      if (!rows.length) { exhausted = true; break; }
      if (meta.total != null && meta.page * meta.limit >= meta.total) { exhausted = true; break; }
      if (!meta.next && rows.length < meta.limit) { exhausted = true; break; }
      page = meta.page + 1;
    }
    // Recorded on the stats side-channel the adapter is already handed, so the return type stays
    // an array for every existing caller. The live source handler reads it back.
    if (!exhausted && stats) {
      stats.pageCapReached = `${path} stopped at the ${maxPages}-page cap`;
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
          "Coupon API has a bounded XML read path (fetchCoupons, GET /coupon/1.0) but no ingestion: no canonical Coupon is written and no sync job calls it, so COUPONS is not declared as a capability.",
          "Product Search has a bounded XML read path (fetchProducts, GET /productsearch/1.0) but no ingestion: nothing is persisted from it and no sync job calls it, so PRODUCTS is not declared as a capability. A search surface is also not evidence that a bulk product feed exists for this account.",
          "Link Locator is an XML surface and remains gated until the XML ingestion layer is wired.",
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

    /**
     * One bounded certification request for any source object in RAKUTEN_CERTIFICATION_SPECS.
     *
     * GET /v2/advertisers with limit=1, page=1 — the exact request authenticate() already makes in
     * production, so certification asks the supplier for nothing new and nothing smaller. That is
     * the point the Awin coupons 500 made: asking for LESS than production ever asks for is still
     * asking for something unevidenced. Here the bounded form IS the evidenced form.
     *
     * fetchPagedJson is deliberately NOT used — it loops until a page comes back short. getJson is
     * also skipped, because it wraps requestWithRetry with three retries, and a probe that retries
     * turns one supplier rejection into three.
     *
     * The collection is read with extractRakutenCollection, production's own extractor, using each
     * object's own container keys, so what is sampled is a ROW and never the envelope.
     *
     * A spec may declare extra request parameters. Only offers does, and only to pin ONE
     * offer_status: production walks three of them per run and deduplicates, which would make a
     * probe three requests instead of one.
     */
    async fetchCertificationSample(sourceObject, { timeoutMs, window = null } = {}) {
      // Object.hasOwn, not a bare lookup: a plain property read would follow the prototype chain
      // and let a name like "constructor" resolve to something that is not a spec.
      const spec = Object.hasOwn(RAKUTEN_CERTIFICATION_SPECS, String(sourceObject))
        ? RAKUTEN_CERTIFICATION_SPECS[String(sourceObject)]
        : null;
      if (!spec) {
        throw new Error(`No Rakuten certification sample is defined for "${sourceObject}"`);
      }
      // A CSV report has a header row as well as data rows, so it has its own sampler. Reading one
      // here would hand a CSV body to the JSON collection reader and certify nothing.
      if (spec.csv) {
        throw new Error(
          `Rakuten certification sample "${sourceObject}" is CSV; use fetchCertificationCsvSample`,
        );
      }

      // Checked BEFORE the request: a dated object with no window costs no supplier call and is
      // reported as its own failure, never as an unbounded query the supplier happens to accept.
      const ctx = { window };
      for (const need of spec.needs ?? []) {
        if (!ctx[need]) {
          throw new Error(`Rakuten certification sample "${sourceObject}" requires ${need}`);
        }
      }

      // A built path is derived from the service's window and from nothing else; a static path
      // stays exactly what the frozen table names. Neither reads a caller argument.
      const path = spec.buildPath ? spec.buildPath(window) : spec.path;

      const response = await httpClient.get(path, {
        // Where each object's bounds come from. The JSON objects share authenticate()'s limit/page
        // pair and a spec cannot widen it — a spec names a filter, never a limit or a page. Where
        // the bounds live in the path, NO query parameter is sent at all. Where the endpoint
        // publishes its own pair (coupons), the shared one is suppressed rather than sent as well.
        params: spec.pathBounded
          ? {}
          : {
              ...(spec.ownBounds ? {} : RAKUTEN_CERTIFICATION_PAGE_PARAMS),
              // A built parameter set is derived from the service's window and from nothing else;
              // a declared one stays exactly what the frozen table names.
              ...(spec.buildParams ? spec.buildParams(window) : (spec.params ?? {})),
            },
        headers: { Accept: spec.xml ? "application/xml,text/xml" : "application/json" },
        ...(spec.xml ? { responseType: "text" } : {}),
        timeout: Number(timeoutMs || RAKUTEN_CERTIFICATION_TIMEOUT_MS),
      });

      // An XML object brings its own row extractor; JSON objects share the collection reader.
      const rows = spec.extract
        ? spec.extract(String(response?.data ?? ""))
        : extractRakutenCollection(response?.data, [...spec.collectionKeys]);

      return rows.slice(0, RAKUTEN_CERTIFICATION_MAX_ROWS);
    },

    /**
     * ONE bounded CSV certification sample: the supplier's header row, and at most one data row.
     *
     * Goes through getCsv — the SAME fetcher fetchAdvancedReport uses — with retries pinned to a
     * single attempt. Not a parallel client: the security-token requirement, the per-run call
     * budget and the request headers are production's, in production's one place.
     *
     * What it deliberately skips is parseRakutenAdvancedReport, whose
     * normalizeRakutenAdvancedReportRow renames the supplier's columns into MBO names. Certifying
     * those would certify our own vocabulary instead of Rakuten's.
     *
     * A missing security token is reported as its own condition BEFORE any supplier call, because
     * "Advanced Reports is not configured for this account" is not a network failure and must not
     * be read as one.
     */
    async fetchCertificationCsvSample(sourceObject, { timeoutMs, window = null } = {}) {
      // Object.hasOwn, not a bare lookup: a plain property read would follow the prototype chain
      // and let a name like "constructor" resolve to something that is not a spec.
      const spec = Object.hasOwn(RAKUTEN_CERTIFICATION_SPECS, String(sourceObject))
        ? RAKUTEN_CERTIFICATION_SPECS[String(sourceObject)]
        : null;
      if (!spec?.csv) {
        throw new Error(`No Rakuten CSV certification sample is defined for "${sourceObject}"`);
      }

      // Checked BEFORE the request: a dated object with no window costs no supplier call.
      const ctx = { window };
      for (const need of spec.needs ?? []) {
        if (!ctx[need]) {
          throw new Error(`Rakuten certification sample "${sourceObject}" requires ${need}`);
        }
      }

      if (!securityToken) {
        const error = new Error("Rakuten Advanced Reports require securityToken");
        error.rakutenSecurityTokenMissing = true;
        throw error;
      }

      const text = await getCsv(
        spec.path,
        // The report id comes from the frozen spec and the window from the service; between them
        // there is no key a caller could supply.
        { ...spec.buildParams(window), reportid: spec.reportId },
        null,
        { retries: 1, timeout: Number(timeoutMs || RAKUTEN_CERTIFICATION_TIMEOUT_MS) },
      );

      return extractRakutenCsvSample(text);
    },

    async fetchAdvertisers(params = {}, stats = null) {
      return fetchPagedJson("/v2/advertisers", params, ["advertisers", "advertiser"], stats, { maxLimit: 200 });
    },

    async fetchCampaigns(params = {}, stats = null) {
      return this.fetchAdvertisers(params, stats);
    },

    /**
     * ONE bounded read of the Coupon API.
     *
     * One supplier request, no retry, no pagination loop: this deliberately does not use getJson,
     * whose requestWithRetry would turn a single read into up to four. A caller that wants the
     * next page asks for it by pagenumber; nothing here walks pages on its own.
     *
     * Returns parsed rows and nothing more. No canonical Coupon is written, no clickurl becomes a
     * TrackingLink, and no sync job calls this — the Coupon API has a read path, not an ingestion
     * path.
     */
    async fetchCoupons(params = {}, stats = null) {
      if (stats) stats.requestCount = (stats.requestCount || 0) + 1;
      const response = await httpClient.get(RAKUTEN_COUPON_PATH, {
        params: buildRakutenCouponParams(params),
        headers: { Accept: "application/xml,text/xml" },
        responseType: "text",
      });
      return extractRakutenCouponLinks(String(response?.data ?? ""));
    },

    /**
     * ONE bounded Product Search read.
     *
     * One supplier request, no retry, no pagination loop: this deliberately does not use getJson,
     * whose requestWithRetry would turn a single read into up to four. A caller that wants the
     * next page asks for it by pagenumber; nothing here walks pages on its own.
     *
     * Returns parsed rows and nothing more. Nothing is persisted, no linkurl becomes a tracking
     * link, and no sync job calls this — Product Search has a read path, not an ingestion path,
     * and it is not a product feed.
     */
    async fetchProducts(params = {}, stats = null) {
      if (stats) stats.requestCount = (stats.requestCount || 0) + 1;
      const response = await httpClient.get(RAKUTEN_PRODUCT_SEARCH_PATH, {
        params: buildRakutenProductSearchParams(params),
        headers: { Accept: "application/xml,text/xml" },
        responseType: "text",
      });
      return extractRakutenProducts(String(response?.data ?? ""));
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
