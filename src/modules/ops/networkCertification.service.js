import { prisma } from "../../database/prisma.js";
import { fail } from "../../core/apiResponse.js";
import { createOptimiseAdapter } from "../../adapters/optimise.adapter.js";
import { createPartnerizeAdapter } from "../../adapters/partnerize.adapter.js";
import { createAwinAdapter } from "../../adapters/awin.adapter.js";
import { createCjAdapter } from "../../adapters/cj.adapter.js";
import { createAdmitadAdapter } from "../../adapters/admitad.adapter.js";
import { createRakutenAdapter } from "../../adapters/rakuten.adapter.js";
import { createBoostinyAdapter } from "../../adapters/boostiny.adapter.js";
import {
  createTrackierAdapter,
  TRACKIER_DEFAULT_REPORT_KPIS,
  TRACKIER_WINDOW_NOT_ONE_CHUNK,
} from "../../adapters/trackier.adapter.js";
import { resolveOptimiseCredentials } from "../integrations/optimiseCredentials.js";
import { resolvePartnerizeCertificationCredentials } from "../integrations/partnerizeCredentials.js";
import { resolveAwinCertificationCredentials } from "../integrations/awinCredentials.js";
import { resolveCjCertificationCredentials } from "../integrations/cjCredentials.js";
import { resolveAdmitadCertificationCredentials } from "../integrations/admitadCredentials.js";
import { resolveRakutenCertificationCredentials } from "../integrations/rakutenCredentials.js";
import { resolveTrackierCertificationCredentials } from "../integrations/trackierCredentials.js";
import { resolveBoostinyCertificationCredentials } from "../integrations/boostinyCredentials.js";
import { comparePathSets, summarisePayloads } from "./payloadShape.js";

/**
 * Live supplier certification probe.
 *
 * Answers one question: what does this supplier's API actually send? It samples the smallest
 * response each endpoint will give, reduces it to a field dictionary of paths and structural
 * categories, and compares that against the paths already present in stored RAW rows.
 *
 * Three properties hold by construction rather than by care:
 *
 *  - Read-only against the supplier. Every probe below is declared in a registry with an explicit
 *    method, and `runProbe` refuses to dispatch anything whose declared method is not GET or an
 *    allowlisted read-only POST. There is no generic "call this endpoint" path.
 *  - Read-only against our database. The service reads MarketplaceAccount (through the existing
 *    resolver) and RawPayload, and holds no repository or service that can write.
 *  - Credential-free output. Field dictionaries come from `summarisePayloads`, which builds its
 *    result from path names and categories and never copies a value. Credentials cannot appear in
 *    the output because no value can.
 */

/** Probes whose declared method the dispatcher will run. A POST must also carry a fixed body. */
const READ_ONLY_METHODS = new Set(["GET", "POST_READONLY"]);

/**
 * Wall-clock ceiling for one source object, covering the throttle wait and the request itself.
 * Well inside any serverless runtime limit, so the probe reports its own failure rather than
 * being killed mid-flight with nothing to show.
 */
const SOURCE_BUDGET_MS = Number(process.env.CERTIFICATION_SOURCE_BUDGET_MS || 20000);

/**
 * Certification never makes more than this many supplier requests for one source object.
 *
 * `products` is the one exception at 2, and only as a dependent chain: sample one feed, then sample
 * one item from THAT feed. The second request is derived entirely from the first response.
 */
export const MAX_SUPPLIER_REQUESTS_PER_SOURCE = 1;
export const MAX_SUPPLIER_REQUESTS_PRODUCTS = 2;

/**
 * Commission groups is the one source object allowed more than a couple of requests.
 *
 * A campaign with no commission groups is common and says nothing about the schema, so certifying
 * from a single campaign is a coin flip. The chain looks at up to five campaigns from ONE bounded
 * list request and stops at the first that returns a group: one list + at most five dependent
 * requests, six in total. This bound applies to commission_groups alone.
 */
export const COMMISSION_GROUP_CANDIDATE_LIMIT = 5;

/**
 * Partnerize campaigns is the one Partnerize source object allowed a second request, and only as
 * a dependent chain: discover a publisher id, then read one campaign. Production sync resolves the
 * id exactly this way, so certification mirrors it rather than demanding a configuration change
 * that only certification would need. Every other Partnerize probe stays at one.
 */
export const MAX_SUPPLIER_REQUESTS_PARTNERIZE_CAMPAIGNS = 2;
/** Vouchers has no discovery step: both identifiers are configured, so it is one request or none. */
export const MAX_SUPPLIER_REQUESTS_PARTNERIZE_VOUCHERS = 1;
/**
 * How many campaign rows of the ONE campaign response may be walked looking for commission
 * structure. A memory bound, not a request bound and not a page size: the supplier query still
 * asks for limit 1, so today exactly one row arrives and exactly one is inspected.
 */
export const COMMISSION_SCAN_ROW_LIMIT = 10;
export const MAX_SUPPLIER_REQUESTS_COMMISSION_GROUPS = 1 + COMMISSION_GROUP_CANDIDATE_LIMIT;

/**
 * Floor for one dependent attempt. With less than this left in the source budget the chain stops
 * and says so, rather than firing a request it knows cannot finish.
 */
const MIN_ATTEMPT_MS = 2500;

/**
 * Wall-clock ceiling for the whole run.
 *
 * Per-source budgets alone bound each request but not their sum: a sweep of every source object
 * could still add up towards the runtime limit and be killed with nothing to show. Once this budget
 * is spent the remaining source objects are REPORTED as unattempted rather than tried, so the route
 * always returns a result it chose to return.
 */
const RUN_BUDGET_MS = Number(process.env.CERTIFICATION_RUN_BUDGET_MS || 120000);

/**
 * Optimise probe registry.
 *
 * Each entry names a source object and the endpoint it samples; the call itself goes through the
 * adapter's `fetchCertificationSample`, which issues exactly one bounded request. Nothing here
 * reaches the sync fetchers, which paginate to exhaustion and retry for minutes.
 */
const OPTIMISE_PROBES = Object.freeze({
  campaigns: { method: "GET", endpointKey: "GET /campaigns" },
  voucher_codes: { method: "GET", endpointKey: "GET /vouchercodes" },
  conversions: { method: "GET", endpointKey: "GET /conversions" },
  payment_overview: { method: "GET", endpointKey: "GET /payments" },
  invoices: { method: "GET", endpointKey: "GET /invoices" },
  products: {
    method: "GET",
    endpointKey: "GET /product-feeds/",
    // Emits two result rows so feed metadata and item fields are never mixed into one dictionary.
    emits: ["product_feeds", "product_items"],
  },
  reporting: { method: "POST_READONLY", endpointKey: "POST /reporting/", unsupportedForSampling: true },
  invoiceReporting: { method: "POST_READONLY", endpointKey: "POST /reporting/ (invoiceDate)", unsupportedForSampling: true },
  commission_groups: {
    method: "GET",
    endpointKey: "GET /campaigns/{campaignId}/commission-groups",
    // Its own bounded chain: a campaign list, then up to five campaigns tried in turn.
    chain: "commissionGroups",
  },
  campaign_detail: {
    method: "GET",
    endpointKey: "GET /campaigns/{productId}",
    needs: "campaignDetailId",
    skipCategory: "SKIPPED_NO_CAMPAIGN_DETAIL_ID",
  },
  basket_items: {
    method: "GET",
    endpointKey: "GET /conversions (basket items)",
    unsupported: "Optimise exposes no basket-item endpoint; the catalog entry is marked live=false and no adapter call exists.",
  },
});

/**
 * Partnerize probe registry — the first three source objects whose bounded request contract is
 * already evidenced by production code. Everything else Partnerize exposes stays out of the
 * executable registry until its contract is confirmed, rather than being guessed at.
 *
 * Each of these is one request. None declares a chain, so none can make a second.
 */
const PARTNERIZE_PROBES = Object.freeze({
  authenticate: { method: "GET", endpointKey: "GET /user" },
  publishers: { method: "GET", endpointKey: "GET /user/publisher" },
  campaigns: {
    method: "GET",
    endpointKey: "GET /user/publisher/{publisherId}/campaign/a",
    // Its own chain: one request when a publisher id is configured, two when it must be
    // discovered. The only Partnerize probe allowed a second request.
    chain: "partnerizeCampaigns",
  },
  // Evidenced by fetchCoupons, which builds exactly this path and sends no query parameters.
  // One request or none: both identifiers come from configuration, neither is discovered.
  vouchers: {
    method: "GET",
    endpointKey: "GET /user/publisher/{publisherId}/campaign/{campaignId}/voucher",
    chain: "partnerizeVouchers",
  },
  // No endpoint of its own. Partnerize exposes no commission or rate endpoint — the adapter builds
  // six /user paths and none is commission-scoped — so the structure is read out of the campaign
  // response that is already certified. Same chain as `campaigns`, so selecting both still costs
  // one request; selecting either alone costs one.
  // Evidenced by fetchConversions, whose FIRST call builds exactly this publisher-scoped reporting
  // path with start_date/end_date. Its second path, /v3/partner/conversions, is a fetchPaginated
  // fallback — a pagination loop — and certification never reaches it: one request, no fallback.
  //
  // Its own chain, so selecting it costs one request and it cannot borrow another probe's.
  conversions: {
    method: "GET",
    endpointKey: "GET /reporting/report_publisher/publisher/{publisherId}/conversion.json",
    chain: "partnerizeConversions",
  },
  // No endpoint of any kind. Partnerize exposes no invoice path in this integration — the adapter
  // contains zero invoice references — so this is declared as absent rather than left unstated.
  // `unsupported` short-circuits before any supplier request, so naming it costs nothing.
  invoices: {
    method: "GET",
    endpointKey: "—",
    unsupported:
      "NO_ENDPOINT_IN_INTEGRATION: the Partnerize adapter contains no invoice endpoint. Not " +
      "unavailable for this account — absent from the integration entirely.",
  },
  // Evidenced by fetchPayments, which builds exactly this path; waveESupplierSync calls it with
  // start_date/end_date. There is no second payments path and no fetchPaginated in fetchPayments,
  // and the adapter has no invoice endpoint at all — invoices stay out of the registry.
  //
  // Its own chain: one request, never borrowed from another probe.
  payments: {
    method: "GET",
    endpointKey: "GET /reporting/report_publisher/publisher/{publisherId}/payment.json",
    chain: "partnerizePayments",
  },
  commission_structure: {
    method: "GET",
    endpointKey: "GET /user/publisher/{publisherId}/campaign/a (embedded commission subtree)",
    chain: "partnerizeCampaigns",
    derivedFrom: "campaigns",
  },
});

/**
 * The campaign fields that carry commission structure. Nothing outside this list is inspected.
 *
 * Partnerize states payout in three places at once: `commissions`, a plural collection of specific
 * outcomes, and two `default_*` scalars. They are not alternatives and they are not interchangeable.
 */
export const COMMISSION_STRUCTURE_KEYS = Object.freeze([
  "commissions",
  "default_commission_rate",
  "default_commission_value",
  "default_currency",
]);

/**
 * A structural view of one campaign's commission subtree.
 *
 * Reports SHAPE and CARDINALITY, never a rate, an amount or a currency. The cardinality is the
 * point: a field dictionary alone collapses `commissions[0]` and `commissions[1]` into one
 * `commissions[]` path, which is correct for paths and useless for the question that matters here —
 * how many distinct payout outcomes the supplier stated. Counting them is what makes "do not
 * average or collapse distinct outcomes" checkable rather than aspirational. A count is not a
 * value: it says there are three outcomes, never what any of them pays.
 *
 * `distinctOutcomeShapeCount` counts distinct KEY SETS among the elements. Two outcomes with the
 * same keys and different numbers still count as two outcomes; the shape count only says whether
 * they are described the same way, which is what a canonical mapping has to accommodate.
 */
/** Whether a row states any commission structure at all: a non-empty array, or an object with keys. */
export function hasCommissionStructure(row = {}) {
  const commissions = row?.commissions;
  if (Array.isArray(commissions)) return commissions.length > 0;
  if (commissions && typeof commissions === "object") return Object.keys(commissions).length > 0;
  return false;
}

/**
 * The first row in a bounded in-memory scan that states commission structure.
 *
 * Operates only on rows already returned by the single campaign request. It issues nothing, and
 * the cap is on rows walked, not on rows requested — the supplier query is untouched.
 *
 * Returns the chosen row and how many rows were actually inspected. "First" is the response's own
 * order: no sorting, no scoring, no preference for a row with more outcomes, because any of those
 * would be this code choosing which merchant's commercials to certify.
 */
export function chooseCommissionSampleRow(rows = [], limit = COMMISSION_SCAN_ROW_LIMIT) {
  const scanned = (Array.isArray(rows) ? rows : []).slice(0, limit);
  for (const [index, row] of scanned.entries()) {
    if (hasCommissionStructure(row)) {
      return { row, campaignsInspectedCount: index + 1, found: true };
    }
  }
  return {
    row: scanned[0] ?? null,
    campaignsInspectedCount: scanned.length,
    found: false,
  };
}

export function summariseCommissionStructure(row = {}) {
  const source = row && typeof row === "object" && !Array.isArray(row) ? row : {};
  const subtree = {};
  for (const key of COMMISSION_STRUCTURE_KEYS) {
    if (Object.hasOwn(source, key)) subtree[key] = source[key];
  }

  const commissions = subtree.commissions;
  const isArray = Array.isArray(commissions);
  const elements = isArray ? commissions : [];

  // Distinct key sets, computed from NAMES only. No element value is read, compared or hashed.
  const shapes = new Set(
    elements.map((element) =>
      element && typeof element === "object" && !Array.isArray(element)
        ? Object.keys(element).sort().join(",")
        : `__${Array.isArray(element) ? "array" : typeof element}__`,
    ),
  );

  return {
    commissionsPresent: Object.hasOwn(source, "commissions") && commissions != null,
    commissionsObservedType: !Object.hasOwn(source, "commissions")
      ? "ABSENT"
      : commissions === null
        ? "NULL"
        : isArray
          ? "ARRAY"
          : typeof commissions === "object"
            ? "OBJECT"
            : String(typeof commissions).toUpperCase(),
    // How many distinct payout outcomes the supplier stated. Null when it is not a collection.
    commissionOutcomeCount: isArray ? elements.length : null,
    distinctOutcomeShapeCount: isArray ? shapes.size : null,
    defaultCommissionRatePresent: source.default_commission_rate != null,
    defaultCommissionValuePresent: source.default_commission_value != null,
    defaultCurrencyPresent: source.default_currency != null,
    // Paths for the subtree only, through the same value-free summariser every probe uses.
    fieldPaths: summarisePayloads([subtree]),
  };
}

/**
 * Awin probe registry — campaigns only, and only because its request contract is already evidenced
 * by fetchCampaigns running in production. Everything else Awin exposes stays out of the
 * executable registry until its contract is confirmed, rather than being guessed at.
 *
 * One entry, one request. It declares its own chain so the generic branch is untouched: that
 * branch reports zero rows as plain OK, and campaigns must distinguish "no joined programmes" from
 * "certified". Changing the generic branch would change Optimise's results too.
 */
const AWIN_PROBES = Object.freeze({
  campaigns: {
    method: "GET",
    endpointKey: "GET /publishers/{publisherId}/programmes",
    chain: "awinCampaigns",
  },
  // Evidenced by fetchCoupons, which POSTs to exactly this path. A POST that reads: empty filters,
  // one row requested, no supplier state changed. `/publisher/` is singular here — Awin's own
  // inconsistency, copied rather than corrected.
  // Evidenced by fetchConversions: same path, same parameter names, same dateType default, and
  // showBasketProducts left on. Date-bounded by a frozen preset the service resolves; never a
  // caller's dates.
  conversions: {
    method: "GET",
    endpointKey: "GET /publishers/{publisherId}/transactions/",
    chain: "awinConversions",
  },
  // Campaign-scoped, so it needs an advertiser id. That id is taken from a bounded campaigns
  // sample this service reads itself — never from a caller — which is the one permitted second
  // request in a source chain.
  commission_groups: {
    method: "GET",
    endpointKey: "GET /publishers/{publisherId}/commissiongroups",
    chain: "awinCommissionGroups",
  },
  coupons: {
    // POST_READONLY, not POST: READ_ONLY_METHODS admits only GET and POST_READONLY, and that guard
    // stays exactly as it is. The endpointKey still shows the real HTTP verb an operator would
    // send, because that is what the supplier sees.
    method: "POST_READONLY",
    endpointKey: "POST /publisher/{publisherId}/promotions",
    chain: "awinCoupons",
  },
});

/**
 * CJ probe registry — advertisers only, and only because its request contract is already evidenced
 * by fetchCampaigns running in production. Everything else CJ exposes (program terms, commission
 * detail, products) is GraphQL-gated with no fetcher, and stays out of the executable registry.
 *
 * REST/XML, unlike every other certified network. The response is parsed with the same extractor
 * production uses, so a row is certified and never the XML envelope.
 */
const CJ_PROBES = Object.freeze({
  advertisers: {
    method: "GET",
    endpointKey: "GET /v2/advertiser-lookup (advertiser-ids=joined)",
    chain: "cjAdvertisers",
  },
  // The SAME endpoint, one parameter apart, and deliberately a separate source object.
  // advertisers is the publisher's approved relationships; available_advertisers is the network
  // catalogue it has not joined. Combining them would collapse the very distinction MBO needs to
  // model catalogue → relationship status → joined campaign → commission/coupon/link assets.
  available_advertisers: {
    method: "GET",
    endpointKey: "GET /v2/advertiser-lookup (advertiser-ids=notjoined)",
    chain: "cjAvailableAdvertisers",
  },
});

/**
 * Admitad probe registry — websites only.
 *
 * websites is the one Admitad object that is PUBLISHER-scoped rather than campaign-scoped: it
 * lists this publisher's own registered sites, so it returns rows on an account with no joined
 * programmes. That makes it the object that separates "the token works" from "this account has
 * joined nothing", which every campaign-scoped Admitad probe added later will need to have
 * already been settled.
 *
 * programs joins it now that websites has proved the credential path live. It uses the UNSCOPED
 * /advcampaigns/, which is exactly what the sync job runs: the job passes no websiteId, so
 * production never takes the /advcampaigns/website/{w_id}/ branch either.
 *
 * coupons joins on the same terms: fetchCoupons takes no campaign, programme or website scope, so
 * the certified request is production's whole request and not a narrowed version of it.
 *
 * Commission evidence observed on programme rows — actions[], actions[].payment_size, currency —
 * is certified as STRUCTURE only. Nothing here maps a rate, and nothing here treats a coupon's
 * programme association as commission truth.
 *
 * actions is the only DATED Admitad object. Its window comes from the service's frozen preset —
 * 7d by default — and is serialized by production's own admitadActionDateParam into the
 * status_updated_start/status_updated_end pair fetchConversions already sends. The sampler refuses
 * to build the request without a window rather than asking the supplier for all time.
 */
const ADMITAD_PROBES = Object.freeze({
  websites: {
    method: "GET",
    endpointKey: "GET /websites/v2/ (limit=1, offset=0)",
    chain: "admitadSample",
  },
  programs: {
    method: "GET",
    endpointKey: "GET /advcampaigns/ (limit=1, offset=0)",
    chain: "admitadSample",
  },
  coupons: {
    method: "GET",
    endpointKey: "GET /coupons/ (limit=1, offset=0)",
    chain: "admitadSample",
  },
  actions: {
    method: "GET",
    endpointKey: "GET /statistics/actions/ (status_updated window, limit=1, offset=0)",
    chain: "admitadSample",
  },
});

/**
 * Rakuten probe registry — advertisers only.
 *
 * Chosen first because its bounded request is ALREADY production's: authenticate() issues
 * GET /v2/advertisers with limit=1 and page=1, so nothing is invented. It needs the Bearer alone,
 * which separates "the access token works" from the separate web security token Advanced Reports
 * requires.
 *
 * Whether /v2/advertisers is catalogue-wide or relationship-scoped is NOT established by this
 * repo — the sync job calls it completely unscoped. That is why an empty result here reports
 * OK_NO_ROWS and names no blocker: claiming "no joined campaigns" would assert a scope the
 * integration has never proved.
 *
 * events and the Advanced Reports objects have live fetchers and catalog entries, and stay out of
 * this registry until certified in their own right. A probe registry entry is an executable claim,
 * not a restatement of the catalog.
 *
 * links is the exception to that ordering: it had NO fetcher at all until this phase, because
 * Link Locator was never implemented. Its catalog entry stays live:false — a read path that can
 * discover an asset is not a link capability, and network support is not implementation support.
 */
const RAKUTEN_PROBES = Object.freeze({
  advertisers: {
    method: "GET",
    endpointKey: "GET /v2/advertisers (limit=1, page=1)",
    chain: "rakutenSample",
  },
  // Added after the live advertisers probe returned a real row whose 25 fields carried no obvious
  // relationship or join-status field. If Rakuten exposes approval state to a publisher, this is
  // the endpoint that would carry it, and a field dictionary is the way to find out.
  //
  // With no joined campaigns on this account, an empty result is entirely expected and says
  // nothing about support: OK_NO_ROWS, no blocker, no defect claimed.
  partnerships: {
    method: "GET",
    endpointKey: "GET /v1/partnerships (limit=1, page=1)",
    chain: "rakutenSample",
  },
  // Rakuten's structured commission-rule source, certified for STRUCTURE only.
  //
  // What this probe is for is discovering whether a row carries an advertiser reference, a rule or
  // group id, an action/event type, percentage and fixed payout components, currency, category,
  // country and date conditions, a status, and — the field that matters most — whether ONE row can
  // carry MULTIPLE payout outcomes.
  //
  // Nothing here maps, averages or collapses any of it. Each distinct payout rule is later a
  // separate SupplierCommissionRule; a probe that merged outcomes now would destroy exactly the
  // distinction that mapping depends on.
  commissioning_lists: {
    method: "GET",
    endpointKey: "GET /v1/commissioninglists (limit=1, page=1)",
    chain: "rakutenSample",
  },
  // commissioning_lists came back OK_NO_ROWS on an account that has joined nothing, so the
  // commission-source question the audit raised is still open. offers is the other candidate, and
  // the one that can return catalogue-side rows without a relationship.
  //
  // ONE request, not production's three: the probe pins offer_status=available rather than walking
  // active, upcoming and available the way fetchOffers does.
  offers: {
    method: "GET",
    endpointKey: "GET /v1/offers (offer_status=available, limit=1, page=1)",
    chain: "rakutenSample",
  },
  // Link Locator, XML, at its documented defaults. The only Rakuten object whose bounds are all in
  // the path, and the only one that is not JSON.
  //
  // A DISCOVERED LINK ASSET IS NOT A USABLE TRACKING LINK. Rakuten exposes link assets before a
  // partnership is active and blocks their use until it is, so a returned row proves the asset
  // exists and nothing more. Certification reports the row's SHAPE; it never returns a clickURL,
  // landURL or showURL value, never promotes one to a tracking link, and persists nothing.
  //
  // EXPLICIT-DATE ISOLATION. Two shapes have been probed live and both answered HTTP 500 "Invalid
  // URL/Verb combination": the official slash path with BLANK date slots, and the same operation
  // moved after "?". Both carried blank dates, so the path form is not what separates them. This
  // probe changes exactly one variable — the dates become explicit MMDDYYYY values from the
  // service window — and holds every other segment at the default the failed probes used.
  //
  // dated is what makes the run report which window preset produced those dates; without it a
  // reader could not tell what a result was a result FOR.
  links: {
    method: "GET",
    endpointKey:
      "GET /linklocator/1.0/getTextLinks/-1/-1/{MMDDYYYY-start}/{MMDDYYYY-end}/-1/1 (explicit-date isolation)",
    chain: "rakutenSample",
    dated: true,
  },
  // The Coupon API: coupons and promotional links from partner-advertisers, XML, Bearer only.
  //
  // Its bounds are its own documented pair — resultsperpage and pagenumber — not the limit/page
  // the JSON objects share. resultsperpage=1 is the smallest page the contract can express.
  //
  // TWO THINGS A ROW IS NOT. A coupon asset is not a coupon CODE: couponcode appears only where
  // the advertiser requires one, so a row without it is complete, not truncated. And a coupon row
  // is not a usable TRACKING LINK: nothing promotes clickurl into a canonical TrackingLink here.
  // Certification reports the row's SHAPE and never a code, click URL, impression pixel,
  // advertiser id or name, offer description or image URL.
  //
  // ZERO ROWS IS NOT AN ACCOUNT-STATE FINDING. The docs say this API returns partner-advertiser
  // data, which makes "no joined campaigns" a plausible READING of an empty feed — but a plausible
  // reading is not evidence. An empty couponfeed reports OK_NO_ROWS like every other object, and
  // no accountStateBlocker is invented from it.
  coupons: {
    method: "GET",
    endpointKey: "GET /coupon/1.0 (resultsperpage=1, pagenumber=1)",
    chain: "rakutenSample",
  },
  // The Events API: recent transaction confirmations, JSON, Bearer only.
  //
  // Named "events" because that is what the Rakuten source-object catalog already calls this
  // object. Adding a second name for it — "conversions", as other networks spell their own —
  // would make the same endpoint answerable under two identifiers.
  //
  // AN EVENT TRANSACTION IS NOT A FINAL ORDER FINANCE RECORD. Rakuten retains roughly the previous
  // one to two weeks here and calls it recent, directional evidence; `commissions` on a row is a
  // supplier-observed event commission, not the final payable one, and not ClientPayable,
  // NetworkInvoice or NetworkPayment. Nothing here feeds it into commercial or payable logic.
  //
  // ONE ORDER CAN HAVE MANY ITEM ROWS. etransaction_id is the transaction identity and order_id is
  // the order grouping; they are different fields and neither implies the other. Certification
  // takes one row and reports its shape — it never groups, dedupes or aggregates by order_id, and
  // an adjustment row carrying a negative sale_amount or commissions is a valid row, not an error.
  //
  // Rows reach the dictionary EXACTLY as the supplier sends them. The production normaliser is not
  // applied, because certifying a renamed row would certify MBO's vocabulary rather than Rakuten's.
  events: {
    method: "GET",
    endpointKey:
      "GET /events/1.0/transactions (process_date window, limit=1, page=1)",
    chain: "rakutenSample",
    dated: true,
  },
  // Product Search: a SEARCH surface over partner-advertiser product data, XML, Bearer only.
  //
  // THREE BOUNDARIES. A row is not a canonical Product; its linkurl is not a usable tracking link;
  // and a search endpoint answering is not evidence that a bulk PRODUCT FEED exists for this
  // account. Certification reports the row's SHAPE and never a mid, merchant name, link id, SKU,
  // product name, description, keyword, price, UPC or URL.
  //
  // NO FILTER IS SENT — max=1 and pagenumber=1 alone. Whether Rakuten accepts an unfiltered search
  // is the one part of this contract the repo cannot establish: the documented capabilities list
  // keyword, exact, one, none, cat and mid without saying one is required. Inventing a keyword or
  // borrowing an advertiser mid from another endpoint's row would both be guesses; the bounds
  // alone are the shape that assumes nothing, and a REQUEST_REJECTED answer captures the missing
  // contract at a cost of one request.
  //
  // ZERO ROWS IS NOT AN ACCOUNT-STATE FINDING. Product Search searches PARTNER-advertisers, so an
  // account with no joined campaigns having no products is the expected state — not evidence of an
  // unsupported object, a missing partnership or a blocker.
  products: {
    method: "GET",
    endpointKey: "GET /productsearch/1.0 (max=1, pagenumber=1, no filter)",
    chain: "rakutenSample",
  },
  // Advanced Reports, report 1 — the PAYMENT HISTORY SUMMARY, and the only one of the repo's five
  // report ids a single bounded request can reach. Reports 22 and 23 are not date-scoped: 22 needs
  // a payid and 23 an invoiceid, so production walks report 1 -> payment_id -> report 22 ->
  // invoice_number -> report 23. Neither is touched here.
  //
  // UPSTREAM PAYMENT-SUMMARY EVIDENCE ONLY. Not individual transaction truth, not item-level
  // commission, and not ClientPayable, NetworkInvoice, NetworkPayment or an MBO receipt — those
  // remain separate downstream objects, and a report answering is not proof of settlement.
  //
  // The one CSV probe, so it has its own chain: a CSV carries a HEADER row as well as data rows,
  // and the difference between "headers but no data" and "nothing at all" is exactly what an
  // operator needs to tell a quiet window from a silent endpoint.
  advanced_reports: {
    method: "GET",
    endpointKey: "GET /advancedreports/1.0 (reportid=1, bdate/edate window)",
    reportId: 1,
    chain: "rakutenAdvancedReport",
    dated: true,
  },
});

/**
 * Trackier (vCommission is the same network under another name).
 *
 * profile is the publisher's own account metadata and the endpoint the sync job reads first, to
 * learn its own publisher id. It is the right first object to certify because it is the ONE
 * Trackier read that is scoped to nothing: no campaign, no date window, no page. If the API key
 * works, this answers; if it does not, nothing else will either.
 *
 * A PROFILE IS ONE OBJECT, NOT A COLLECTION. There is no list to bound, so there is no limit or
 * page to send — the whole request is the path.
 *
 * Certification reports the row's SHAPE. No publisher id, name, email, phone, address, API key or
 * raw supplier response can reach the result: summarisePayloads returns paths, types and
 * categories and never a value.
 */
const TRACKIER_PROBES = Object.freeze({
  profile: {
    method: "GET",
    endpointKey: "GET /v2/publishers/profile",
    chain: "trackierProfile",
  },
  // The campaigns list, at the smallest page the endpoint takes.
  //
  // Production PAGES this endpoint, and at limit=1 the pager's own stop condition would not fire:
  // a one-row page IS a full page, so rowsCount >= pageSize keeps it asking for page 2, 3, 4. The
  // probe therefore stops after the first response rather than trusting the loop to stop.
  //
  // TWO STATUSES, NOT ONE. A Trackier campaign row can carry both the supplier's campaign status
  // and this publisher's application/relationship status. CAMPAIGN_STATUS is not
  // PUBLISHER_APPLICATION_STATUS, and CAMPAIGN_AVAILABLE is not CAMPAIGN_JOINED — so this phase
  // reports the supplier's field NAMES as they arrive and invents no joined, approved, available
  // or rejected value that is not in the row. The row structure comes first; relationship mapping
  // comes after it is known.
  //
  // Certification reports the row's SHAPE and never a campaign id or name, advertiser or merchant
  // name, tracking, landing or logo URL, commission value or application identifier.
  campaigns: {
    method: "GET",
    endpointKey: "GET /v2/publisher/campaigns (limit=1, page=1)",
    chain: "trackierCampaigns",
  },
  // One campaign's detail, reached through a DISCOVERED id.
  //
  // The endpoint is campaign-scoped, so it needs an id, and that id is read out of one bounded
  // campaigns sample — never accepted from a caller. A caller-supplied campaign, app or advertiser
  // id would let the probe be pointed at a resource this publisher was never offered.
  //
  // TWO requests at most, and often one: with no campaign row, or a row carrying no usable id,
  // the chain reports SKIPPED_NO_CAMPAIGN_SCOPE and makes NO second request.
  //
  // WHY IT EXISTS. The live campaigns list showed 53 fields and none of them a relationship state
  // — no application_status, no applicationStatus, no status. Detail is where that evidence would
  // be if Trackier exposes it at all. CAMPAIGN_STATUS is not PUBLISHER_RELATIONSHIP_STATUS, and
  // app_id/app_name are neither, so nothing is classified joined, available, pending or rejected
  // without a supplier field saying so.
  campaign_detail: {
    method: "GET",
    endpointKey: "GET /v2/publisher/campaign/{discovered-id}",
    chain: "trackierCampaignDetail",
  },
  // The coupons list, one page and no page token.
  //
  // NO PAGE-SIZE PARAMETER IS SENT. Production reaches this endpoint through the page-TOKEN pager
  // and has never sent a limit here, and no documented page-size bound for it is evidenced in this
  // repo — so inventing one would be sending a parameter the endpoint may not publish. The hard
  // bound is the request count: one, with the page token never read, let alone followed.
  //
  // COUPON_ROW IS NOT COUPON_CODE_PRESENT. A promotional row is valid with no code at all — a code
  // appears only where the advertiser requires one, and it may sit nested under coupons[].code
  // rather than on the row. Certification reports the row's SHAPE and never a code, campaign id or
  // name, advertiser, URL or description.
  coupons: {
    method: "GET",
    endpointKey: "GET /v2/publishers/coupons (one page, no page token)",
    chain: "trackierCoupons",
  },
  // Deals, certified INDEPENDENTLY of coupons. The two share an endpoint family and a pager, and
  // they are still different objects — merging them here would certify a shape neither endpoint
  // actually returns.
  //
  // A DEAL ROW IS NOT A COUPON CODE. A deal may carry a code, a coupon or a deal_code field, or
  // none of them; whichever the supplier sends is reported under its own name, and a title or
  // description is never promoted into one. No URL becomes a tracking link in this phase.
  //
  // Same bounds as coupons, for the same reason: production reaches this endpoint through the
  // page-TOKEN pager and has never sent a page size here, and none is evidenced for it — so the
  // request count is the bound, and the cursor is never read, let alone followed.
  deals: {
    method: "GET",
    endpointKey: "GET /v2/publishers/deals (one page, no page token)",
    chain: "trackierDeals",
  },
  // Conversions, over the service's own window.
  //
  // The only DATED Trackier object. Production fetchConversions splits a wide range into date
  // chunks and pages each chunk; the probe forbids both. Its window is the service's frozen
  // preset, rendered in the YYYY-MM-DD the adapter already speaks — no date format is invented.
  //
  // A CONVERSION ROW IS SUPPLIER EVIDENCE, NOT FINANCE TRUTH. A conversion id is not an order id,
  // a click id is not a transaction id, a payout is not a final payable, and a sale amount is not
  // settled revenue. Certification reports the supplier's field names as they arrive and
  // canonicalises none of them.
  conversions: {
    method: "GET",
    endpointKey: "GET /v2/publishers/conversions (startDate/endDate window, limit=1, page=1)",
    chain: "trackierConversions",
    dated: true,
  },
  // Reports KPI METADATA: which KPIs the reports endpoint may be asked for.
  //
  // Metadata, not performance data: no window, no page, no parameter of any kind. Certified
  // BEFORE the reports data endpoint so its live KPI schema is known before that request is
  // shaped. KPI names are not interpreted and not mapped to canonical metrics; the supplier's
  // container shape (array of definitions, list of names, object map, scalar) is reported as
  // observed, with at most one entry sampled.
  reports_kpi: {
    method: "GET",
    endpointKey: "GET /v2/publishers/reports-kpi (no parameters)",
    chain: "trackierReportsKpi",
  },
  // Reports DATA, under the catalog's existing name for GET /v2/publishers/reports: tracking.
  //
  // Two requests at most. The first re-reads the KPI metadata so the KPI names sent are the
  // supplier's own — production's default names are PREFERRED, but only those literally present
  // in allowedKpi[] are sent, else the first name the supplier lists; none is invented or
  // normalised. Without any KPI name there is no reports request at all.
  //
  // The grouping is production's own default (campaign_name,created), which the sync job has sent
  // live on every run; nothing is guessed. limit is what production's pager sends on every call,
  // pinned to 1.
  //
  // A REPORT ROW IS AN AGGREGATE OVER THE GROUPING. It is not a conversion row and not a finance
  // record: clicks are not billable clicks, conversions are not payable conversions, payout is
  // not settled commission, saleAmount is not a final order value. Field names are reported as
  // they arrive and none is canonicalised.
  tracking: {
    method: "GET",
    endpointKey:
      "GET /v2/publishers/reports (startDate/endDate window, kpis from reports-kpi, grouping=campaign_name,created, limit=1, page=1)",
    chain: "trackierReports",
    dated: true,
  },
});

/**
 * Boostiny probes.
 *
 * ONE object per phase, and one request per object: Boostiny locks accounts out when requests
 * bunch up, so the shared six-second limiter stays in force and nothing here adds a second call.
 */
const BOOSTINY_PROBES = Object.freeze({
  // The campaigns list, bounded to the smallest page production's pager can ask for. page and
  // limit are the two parameters that pager already sends on every call; no other is added.
  //
  // A CAMPAIGN ROW IS A LISTING, NOT A RELATIONSHIP. Available is not joined, active is not
  // approved, a campaign id is not an advertiser id, and a payout field is not payable
  // commission truth. Certification reports the supplier's field names as they arrive and
  // canonicalises none of them.
  campaigns: {
    method: "GET",
    endpointKey: "GET /publisher/campaigns (limit=1, page=1)",
    chain: "boostinyCampaigns",
  },
  // The DEDICATED coupons listing, read on its own. Campaign rows carry an embedded coupons[]
  // too; this probe never reads a campaign row, so the two shapes can be compared later without
  // one having stood in for the other.
  //
  // A COUPON ROW IS A COUPON ASSET, NOT A COUPON CODE. The row may carry no code under any
  // spelling and still be a complete row; a country is not a currency; a coupon status says
  // nothing about the campaign relationship. Field names are reported as they arrive.
  coupons: {
    method: "GET",
    endpointKey: "GET /publisher/coupons (limit=1, page=1)",
    chain: "boostinyCoupons",
  },
  // Performance, under the catalog's existing name for GET /publisher/performance: api_reports.
  //
  // The only DATED Boostiny object. Production sends from/to (YYYY-MM-DD) on every performance
  // call, so the probe sends the service's own window under those two names and nothing else it
  // invents. It reads the RAW endpoint through fetchPerformance, never fetchPerformanceReport,
  // whose summary inspection and per-campaign fallback can add supplier calls.
  //
  // A PERFORMANCE ROW IS A REPORT ROW. It is not a conversion row and not a final settlement: a
  // payout column is not payable commission, and a summary row is not a campaign row. Field
  // names are reported as they arrive and none is canonicalised or conflated.
  api_reports: {
    method: "GET",
    endpointKey: "GET /publisher/performance (from/to window, limit=1, page=1)",
    chain: "boostinyPerformance",
    dated: true,
  },
  // Link performance, under the catalog's existing name for GET /publisher/link-performance:
  // link_reports. Dated exactly as performance is — production sends from/to on every call — and
  // read RAW through fetchLinkPerformance, never fetchAll.
  //
  // A LINK-PERFORMANCE ROW IS A REPORT ROW ABOUT A LINK. It is not a tracking-link asset, not a
  // conversion row and not a settlement: no TrackingLink is manufactured from it, no URL in it
  // is canonicalised, and the sync job's own report_type tag is not applied. Field names are
  // reported as they arrive.
  link_reports: {
    method: "GET",
    endpointKey: "GET /publisher/link-performance (from/to window, limit=1, page=1)",
    chain: "boostinyLinkPerformance",
    dated: true,
  },
});

const PROBE_REGISTRY = Object.freeze({
  optimise: OPTIMISE_PROBES,
  partnerize: PARTNERIZE_PROBES,
  awin: AWIN_PROBES,
  cj: CJ_PROBES,
  admitad: ADMITAD_PROBES,
  rakuten: RAKUTEN_PROBES,
  trackier: TRACKIER_PROBES,
  boostiny: BOOSTINY_PROBES,
});

/**
 * How a network's certification adapter is built. Adding a network means adding a builder here,
 * not loosening anything: the caller still selects a network by name from this frozen map.
 */
const ADAPTER_BUILDERS = Object.freeze({
  optimise: "buildOptimiseAdapter",
  partnerize: "buildPartnerizeAdapter",
  awin: "buildAwinAdapter",
  cj: "buildCjAdapter",
  admitad: "buildAdmitadAdapter",
  rakuten: "buildRakutenAdapter",
  trackier: "buildTrackierAdapter",
  boostiny: "buildBoostinyAdapter",
});

/** The networks with an executable probe registry. One source of truth, so a caller-facing
 *  catalog cannot list a different set than certify() will accept. */
export function listProbeNetworks() {
  return Object.keys(PROBE_REGISTRY);
}

export function listProbeSourceObjects(network) {
  const probes = PROBE_REGISTRY[String(network || "").toLowerCase()];
  return probes ? Object.keys(probes) : [];
}

/** HTTP status reduced to a category. The supplier's error body is never read or returned. */
export function statusCategory(error) {
  if (error?.certificationTimeout) return "SUPPLIER_TIMEOUT";
  if (error?.certificationThrottled) return "SUPPLIER_RATE_LIMITED";
  // axios reports its own timeout this way; it is the same condition seen from a lower layer.
  if (error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT") return "SUPPLIER_TIMEOUT";
  const status = Number(error?.response?.status ?? error?.status ?? 0);
  if (!status) return "NETWORK_ERROR";
  if (status === 401 || status === 403) return "AUTH_FAILED";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "UPSTREAM_ERROR";
  if (status >= 400) return "REQUEST_REJECTED";
  return "OK";
}

/**
 * The supplier's numeric HTTP status, when there was one.
 *
 * statusCategory collapses a range of statuses into one token — every 5xx becomes UPSTREAM_ERROR —
 * which is the right thing to act on but loses what an operator needs to diagnose: a 500 and a 503
 * call for different next steps, and neither was distinguishable from the other in a result.
 *
 * A NUMBER and nothing else. Never the response body, headers, URL, request payload or any
 * credential that may appear in them. A transport failure with no response (DNS, refused
 * connection, abort) has no status and yields null, which callers omit rather than report as 0 —
 * "no HTTP status" and "status zero" are different facts.
 */
export function supplierStatusCode(error) {
  const status = Number(error?.response?.status ?? error?.status ?? 0);
  return Number.isInteger(status) && status > 0 ? status : null;
}

/**
 * Where a supplier's own explanation is looked for, in order.
 *
 * An ALLOWLIST of keys read individually as strings. The body itself is never stringified, so a
 * field that is not on this list cannot reach the output however the supplier nests it, and an
 * object-valued `error` or `message` is skipped rather than serialised.
 */
const SUPPLIER_MESSAGE_KEYS = Object.freeze([
  "message",
  "error_description",
  "errorDescription",
  "description",
  "detail",
  "title",
  "reason",
  "error",
]);

/** Longest message returned, after redaction. A supplier's explanation, not its essay. */
export const SUPPLIER_MESSAGE_MAX_LENGTH = 200;

/**
 * Scrub anything that could identify an account, a person or a credential.
 *
 * Order matters. Exact configured values go first — a publisher id or token may be short enough or
 * oddly-shaped enough to slip past every pattern — then URLs (which swallow their own query
 * strings), then emails, then bearer/key-shaped runs, then long digit runs.
 *
 * The rules are deliberately over-eager. A message stripped down to "[REDACTED]" is a message the
 * caller omits entirely; a message that leaks a token is unrecoverable.
 */
function redactSupplierMessage(text, redactValues = []) {
  let out = String(text);

  for (const value of redactValues) {
    const literal = String(value ?? "").trim();
    // Two characters is not an identifier; substituting it would shred ordinary words.
    if (literal.length < 3) continue;
    out = out.split(literal).join("[REDACTED]");
  }

  // Control characters, including the newlines that would let a body span "one message".
  out = out.replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ");

  out = out.replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"']+/g, "[REDACTED_URL]");
  out = out.replace(/\b(?:www\.)[^\s"']+/gi, "[REDACTED_URL]");
  // Any path-like run, with or without a query string. An earlier version required a "?" and so
  // let "/user/publisher/<id>/campaign/<id>/voucher" through intact — the identifiers were the
  // path, not the query. Two or more segments is a path; a lone "/" is punctuation.
  out = out.replace(/\/[A-Za-z0-9_.~%+-]*(?:\/[A-Za-z0-9_.~%+-]*){1,}(?:\?[^\s"']*)?/g, "[REDACTED_URL]");
  out = out.replace(/\/[^\s"']*\?[^\s"']*/g, "[REDACTED_URL]");
  out = out.replace(/[^\s"'<>@]+@[^\s"'<>@]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]");
  out = out.replace(/\b(?:bearer|basic|token|apikey|api_key|key)\s+\S+/gi, "[REDACTED_CREDENTIAL]");
  // Long opaque runs: the shape of a token or an encoded id.
  out = out.replace(/\b[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_CREDENTIAL]");
  // Long numeric identifiers. Four digits stay, so a year or a day count survives.
  out = out.replace(/\b\d{5,}\b/g, "[REDACTED_ID]");

  return out.replace(/\s+/g, " ").trim();
}

/**
 * A short, redacted explanation from the supplier, when one can be had safely.
 *
 * Returns null rather than a placeholder when nothing useful survives: a message consisting only
 * of redaction markers tells an operator less than no message at all, and pretending otherwise
 * would invite someone to trust it.
 */
export function supplierMessage(error, { redactValues = [] } = {}) {
  const body = error?.response?.data;
  const candidates = [];

  if (typeof body === "string") candidates.push(body);
  if (body && typeof body === "object") {
    for (const key of SUPPLIER_MESSAGE_KEYS) {
      // Strings only. An object under `error` is a body, and bodies are never returned.
      if (typeof body[key] === "string") candidates.push(body[key]);
    }
  }
  if (typeof error?.response?.statusText === "string") candidates.push(error.response.statusText);

  // error.message is deliberately NOT a source. It carries our own internal text — axios' generic
  // "Request failed with status code N", throttle and timeout notices, and paths quoted without a
  // query string — none of which is the supplier's explanation, and all of which risk echoing
  // internals. A failure with no response body simply reports no message.

  for (const candidate of candidates) {
    const redacted = redactSupplierMessage(candidate, redactValues);
    // Placeholders alone are not information. Require something a human can read.
    const withoutPlaceholders = redacted.replace(/\[REDACTED[A-Z_]*\]/g, " ").trim();
    if (!/[A-Za-z]{3,}/.test(withoutPlaceholders)) continue;

    return redacted.length > SUPPLIER_MESSAGE_MAX_LENGTH
      ? `${redacted.slice(0, SUPPLIER_MESSAGE_MAX_LENGTH - 1)}\u2026`
      : redacted;
  }

  return null;
}

/**
 * Record the exact secrets this run was built with, so a supplier message quoting one can be
 * scrubbed. A token may be short, or oddly shaped, and slip past every pattern — the literal value
 * is the only reliable defence.
 *
 * NON-ENUMERABLE on purpose: the list must be reachable by redactionValuesFor and unreachable by
 * JSON.stringify, so attaching it can never itself become the leak.
 */
export function recordRedactionValues(adapter, values = []) {
  const cleaned = values
    .filter((v) => v !== undefined && v !== null && String(v).trim() !== "")
    .map(String);
  if (adapter && typeof adapter === "object") {
    Object.defineProperty(adapter, REDACTION_VALUES, {
      value: Object.freeze(cleaned),
      enumerable: false,
      configurable: true,
      writable: false,
    });
  }
  return adapter;
}

const REDACTION_VALUES = Symbol("certificationRedactionValues");

/** Values that must never survive into a message: this run's identifiers AND its credentials. */
export function redactionValuesFor(adapter) {
  return [...(adapter?.[REDACTION_VALUES] ?? []), adapter?.publisherId]
    .filter((v) => v !== undefined && v !== null && String(v).trim() !== "")
    .map(String);
}

/**
 * A failed certification result, built the same way everywhere.
 *
 * statusCategory is computed exactly as before — this adds a field, it changes none. The status is
 * omitted entirely when absent rather than set to null, so a NETWORK_ERROR result carries no
 * status key at all.
 */
export function certificationFailure(base, error, extra = {}, redactValues = []) {
  const status = supplierStatusCode(error);
  const message = supplierMessage(error, { redactValues });
  return {
    ...base,
    ok: false,
    statusCategory: statusCategory(error),
    ...(status === null ? {} : { supplierStatusCode: status }),
    // Omitted, not nulled, when nothing safe survives redaction.
    ...(message === null ? {} : { supplierMessage: message }),
    ...extra,
  };
}

/**
 * Lookback presets the caller may choose between.
 *
 * A preset, not a number of days and not a date pair. The caller picks a token; the service alone
 * turns it into dates. That keeps the request body free of anything resembling a date parameter, so
 * there is no path by which a caller could steer the supplier query — the reason the conversions
 * contract is pinned in the first place. Ninety days is the ceiling because a wider lookback is a
 * bigger ask of the supplier for no extra certification value: the probe reads one row either way.
 */
/** The Trackier campaigns bounds: the smallest page the endpoint takes. */
export const TRACKIER_CERTIFICATION_CAMPAIGN_PARAMS = Object.freeze({ limit: 1, page: 1 });

/** The Boostiny campaigns bounds: the two parameters production's pager already sends, at 1. */
export const BOOSTINY_CERTIFICATION_CAMPAIGN_PARAMS = Object.freeze({ page: 1, limit: 1 });

/** The Boostiny coupons bounds: the same two pager parameters, at 1. */
export const BOOSTINY_CERTIFICATION_COUPON_PARAMS = Object.freeze({ page: 1, limit: 1 });

/** The Boostiny performance bounds. The from/to pair is added from the service window at call time. */
export const BOOSTINY_CERTIFICATION_PERFORMANCE_PARAMS = Object.freeze({ page: 1, limit: 1 });

/** The Boostiny link-performance bounds. The from/to pair is added from the service window at call time. */
export const BOOSTINY_CERTIFICATION_LINK_PERFORMANCE_PARAMS = Object.freeze({ page: 1, limit: 1 });

/** The Trackier reports bounds. Dates and KPI names are added at call time. */
export const TRACKIER_CERTIFICATION_REPORT_PARAMS = Object.freeze({ limit: 1, page: 1 });

/**
 * The KPI names the reports certification sends, chosen from the supplier's own allowedKpi[].
 *
 * Production's default names are preferred, in production's order, but ONLY those literally
 * present in the supplier list are kept; if none is, the first name the supplier lists is used
 * alone. Only string entries count. Nothing is invented, trimmed, re-cased or aliased: a name
 * either appears in the supplier list exactly as it will be sent, or it is not sent.
 */
export function selectTrackierCertificationKpis(container) {
  const supplied = Array.isArray(container) ? container.filter((k) => typeof k === "string" && k !== "") : [];
  if (!supplied.length) return [];
  const preferred = TRACKIER_DEFAULT_REPORT_KPIS.filter((name) => supplied.includes(name));
  return preferred.length ? preferred : [supplied[0]];
}

/** Path segment standing in for a KPI-name key in a map-shaped reports-kpi container. */
export const KPI_MAP_KEY_PLACEHOLDER = "*";

/** The Trackier conversions bounds. The date pair is added from the service window at call time. */
export const TRACKIER_CERTIFICATION_CONVERSION_PARAMS = Object.freeze({ limit: 1, page: 1 });

export const WINDOW_PRESETS = Object.freeze({ "7d": 7, "30d": 30, "90d": 90 });
export const DEFAULT_WINDOW_PRESET = "7d";

/** Days for a preset token. Unknown tokens never reach here; the controller rejects them with 400. */
export function windowPresetDays(preset) {
  return WINDOW_PRESETS[preset] ?? WINDOW_PRESETS[DEFAULT_WINDOW_PRESET];
}

/**
 * A neutral date window in ISO YYYY-MM-DD.
 *
 * Deliberately NOT named after any endpoint's parameters. An earlier version returned
 * startDate/endDate/dateFrom/dateTo together and every dated sample spread all four, which sent
 * /conversions four parameters and none of the two it takes. Naming the window `from`/`to` makes
 * that impossible: each sample must map it onto its own endpoint's parameter names explicitly.
 */
function defaultDateWindow(days = 7) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

/**
 * Whether a probe failure was the item sampler reporting that no bounded sample exists.
 * A distinct outcome from a supplier error: nothing went wrong, the feed simply cannot be sampled
 * one record at a time within the byte window.
 */
const NOT_BOUNDED_NOTES = Object.freeze({
  NO_FEED_URL: "The sampled feed carries no feed URL, so there is nothing to take an item sample from.",
  DISALLOWED_HOST: "The sampled feed's URL is not on the allowed product-feed host, so it was not fetched.",
  NO_COMPLETE_RECORD_IN_WINDOW:
    "No complete product record fitted in the bounded byte window. Certification does not widen the window, because that would begin downloading the feed.",
  UNRECOGNISED_FEED_FORMAT: "The bounded window held no recognisable CSV or XML product record.",
  UNKNOWN: "A bounded single product-item sample could not be taken.",
});

function notBoundedReason(error) {
  return error?.productItemSampleNotBounded ? String(error.reason || "UNKNOWN") : null;
}

/**
 * The identifier each campaign-scoped endpoint requires, read off a sampled campaign row.
 *
 * Two namespaces, two selectors, no shared fallback. `id` is not consulted by either: it was the
 * fallback removed from commission-group selection once the identifier audit showed campaignId and
 * productId are separate namespaces on the same row, and reinstating it here would repeat that bug.
 * A row lacking the identifier an endpoint needs yields null, and the caller skips that endpoint
 * rather than dispatching a foreign identifier to it.
 */
function firstUsableId(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (!text) continue;
    // A value carrying path or query syntax would escape the path segment it is interpolated into.
    return /[\\/\s?#]/.test(text) ? null : text;
  }
  return null;
}

/**
 * The campaign id a Trackier campaign row carries, for the detail request.
 *
 * DELIBERATELY NOT app_id. app_id and app_name identify the ADVERTISER'S APP, not the campaign,
 * and they are not relationship state either — a row carrying them says nothing about whether this
 * publisher has joined anything. Reading one here would point the detail request at the wrong
 * resource and quietly dress it up as a campaign.
 *
 * firstUsableId also refuses any value carrying path or query syntax, which matters here because
 * the id is interpolated into a path segment.
 */
export function trackierCampaignIdOf(row = {}) {
  return firstUsableId(row, ["id", "_id", "campaignId", "campaign_id"]);
}

/**
 * The paths that would COUNT as direct supplier evidence of a publisher relationship state.
 *
 * A SEARCH LIST, never a mapping. Nothing here is renamed, aliased or turned into a canonical
 * joined/available/pending/rejected value; the list exists only so "the detail response contains
 * no relationship field" is a claim with a definition behind it rather than an impression. A match
 * reports PRESENT_NEEDS_MAPPING — that the evidence exists and has not been interpreted — and no
 * match reports UNKNOWN_FROM_CURRENT_API_SHAPE.
 *
 * app_id and app_name are deliberately absent: CAMPAIGN_STATUS is not
 * PUBLISHER_RELATIONSHIP_STATUS, and an app identifier is neither.
 */
export const TRACKIER_RELATIONSHIP_EVIDENCE_PATHS = Object.freeze([
  "application_status",
  "applicationStatus",
  "approval_status",
  "approvalStatus",
  "publisher_status",
  "publisherStatus",
  "publisherApproval",
  "approved",
  "isApproved",
  "joined",
  "status",
]);

/** GET /campaigns/{productId} — campaign detail. Never id, never campaignId. */
export function campaignDetailIdOf(row = {}) {
  return firstUsableId(row, ["productId", "product_id"]);
}

/** GET /campaigns/{campaignId}/commission-groups. Never id, never productId. */
export function commissionGroupCampaignIdOf(row = {}) {
  return firstUsableId(row, ["campaignId", "campaign_id"]);
}

/**
 * The advertiser id on an Awin PROGRAMME row, read only from evidenced fields.
 *
 * `advertiserId` first, which mapAwinTransaction already reads on the transaction shape. Then
 * `id`, which the canonical spec's programme field table defines as "network campaign/advertiser
 * programme ID" — the same identifier under the name the programmes endpoint returns it by.
 *
 * Nothing else is tried. Guessing a third field name would risk sending the supplier some other
 * entity's id, and firstUsableId additionally refuses any value carrying path or query syntax so
 * a value cannot escape the parameter it lands in.
 */
export function awinAdvertiserIdOf(row = {}) {
  return firstUsableId(row, ["advertiserId", "advertiser_id", "id"]);
}

function asRows(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.rows)) return result.rows;
  if (Array.isArray(result?.data)) return result.data;
  if (result && typeof result === "object") return [result];
  return [];
}

export class NetworkCertificationService {
  // Read-only by construction: a prisma client for RawPayload lookups and nothing else.
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.adapterFactory = deps.adapterFactory ?? null;
    this.credentialResolver = deps.credentialResolver ?? resolveOptimiseCredentials;
    this.partnerizeCredentialResolver = deps.partnerizeCredentialResolver ?? resolvePartnerizeCertificationCredentials;
    this.awinCredentialResolver = deps.awinCredentialResolver ?? resolveAwinCertificationCredentials;
    this.cjCredentialResolver = deps.cjCredentialResolver ?? resolveCjCertificationCredentials;
    this.admitadCredentialResolver =
      deps.admitadCredentialResolver ?? resolveAdmitadCertificationCredentials;
    this.rakutenCredentialResolver =
      deps.rakutenCredentialResolver ?? resolveRakutenCertificationCredentials;
    this.trackierCredentialResolver =
      deps.trackierCredentialResolver ?? resolveTrackierCertificationCredentials;
    this.boostinyCredentialResolver =
      deps.boostinyCredentialResolver ?? resolveBoostinyCertificationCredentials;
  }

  /**
   * Paths already present in stored RAW rows for this source object. Only keys are collected;
   * `summarisePayloads` is applied to the stored bodies exactly as it is to live ones, so no
   * stored value reaches the result either.
   */
  async rawPathsFor({ networkSource, sourceObject, limit = 5 }) {
    const rows = await this.db.rawPayload.findMany({
      where: { supplier: String(networkSource).toUpperCase(), resourceKey: sourceObject },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { payload: true },
    });
    const bodies = rows.flatMap((r) => asRows(r.payload));
    return summarisePayloads(bodies).map((f) => f.path);
  }

  async buildOptimiseAdapter({ region, accountLabel }) {
    const credentials = await this.credentialResolver(region, accountLabel);
    if (!credentials?.apiKey || !credentials?.agencyId || !credentials?.contactId) {
      // Nothing about the credential is reported beyond whether it resolved.
      throw fail("Optimise credentials are not configured for this region and account label.", 424);
    }
    const factory = this.adapterFactory ?? createOptimiseAdapter;
    return recordRedactionValues(
      factory({
        apiKey: credentials.apiKey,
        baseURL: credentials.baseURL,
        agencyId: credentials.agencyId,
        contactId: credentials.contactId,
      }),
      [credentials.apiKey, credentials.agencyId, credentials.contactId],
    );
  }

  /**
   * Partnerize certification adapter.
   *
   * The publisher id is resolved here, from credentials or environment, and handed to the adapter
   * at construction. Certification never discovers it with a request — that would be a second
   * supplier call — and never accepts it from a caller.
   */
  async buildPartnerizeAdapter({ accountLabel }) {
    const credentials = await this.partnerizeCredentialResolver(accountLabel);
    if (!credentials?.applicationKey || !credentials?.userApiKey) {
      // Only whether the credential resolved is reported; nothing about it.
      throw fail("Partnerize credentials are not configured for this account label.", 424);
    }
    const factory = this.adapterFactory ?? createPartnerizeAdapter;
    return recordRedactionValues(
      factory({
        applicationKey: credentials.applicationKey,
        userApiKey: credentials.userApiKey,
        publisherId: credentials.publisherId ?? null,
        certificationCampaignId: credentials.certificationCampaignId ?? null,
      }),
      [
        credentials.applicationKey,
        credentials.userApiKey,
        credentials.publisherId,
        credentials.certificationCampaignId,
      ],
    );
  }

  /**
   * Awin certification adapter.
   *
   * The publisher id is resolved here, from configuration, and handed to the adapter at
   * construction. Certification never discovers it with a request — that would be a second
   * supplier call — and never accepts it from a caller. The Awin token is user-level and may span
   * several publisher accounts, which is exactly why the id cannot be caller-supplied: it would
   * point the probe at another one.
   */
  async buildAwinAdapter({ accountLabel }) {
    const credentials = await this.awinCredentialResolver(accountLabel);
    if (!credentials?.accessToken || !credentials?.publisherId) {
      // Only whether the credential resolved is reported; nothing about it.
      throw fail("Awin credentials are not configured for this account label.", 424);
    }
    const factory = this.adapterFactory ?? createAwinAdapter;
    return recordRedactionValues(
      factory({
        accessToken: credentials.accessToken,
        publisherId: credentials.publisherId,
      }),
      [credentials.accessToken, credentials.publisherId],
    );
  }

  /**
   * One bounded Awin sample, shared by campaigns and coupons.
   *
   * Both are publisher-scoped list endpoints, both are exactly one request, and both must
   * distinguish "this account has none" from "certified". Writing the control flow once means the
   * two cannot drift apart; the verb, path and body differ, and those live in the adapter's own
   * spec, which is the only place that builds a request.
   *
   * Zero rows is reported as OK_NO_ROWS rather than OK. The distinction matters: OK with an empty
   * field list reads as "certified, no fields", when what happened is that this publisher has no
   * joined programmes, or no promotions, and the row schema is still unknown. An operator seeing
   * OK_NO_ROWS knows to check the account, not the integration.
   *
   * Only structural paths, types and counts leave this method. summarisePayloads never reports a
   * value, so no advertiser or programme id, promotion or voucher code, name, description, URL,
   * commission range, currency or date can reach the response.
   */
  async certifyAwinSample({ adapter, key, probe, budgetLeft, sourceObject }) {
    const base = {
      network: key,
      sourceObject,
      endpointKey: probe.endpointKey,
      httpMethod: probe.method,
      sampleCount: 0,
      fieldPaths: [],
    };

    const timeoutMs = Math.max(1000, Math.min(SOURCE_BUDGET_MS, budgetLeft()));

    try {
      // One row is all a field dictionary needs, and one row is all that is held. The adapter
      // already slices; this is the second, independent bound.
      const rows = asRows(
        await adapter.fetchCertificationSample(sourceObject, { timeoutMs }),
      ).slice(0, 1);

      if (!rows.length) {
        return {
          ...base,
          ok: true,
          statusCategory: "OK_NO_ROWS",
          fieldCount: 0,
          schema: "UNKNOWN_NEEDS_LIVE_DATA",
        };
      }

      const fieldPaths = summarisePayloads(rows);
      return {
        ...base,
        ok: true,
        statusCategory: "OK",
        sampleCount: rows.length,
        fieldCount: fieldPaths.length,
        fieldPaths,
      };
    } catch (error) {
      return certificationFailure(base, error, {}, redactionValuesFor(adapter));
    }
  }

  async certifyAwinCampaigns(args) {
    return this.certifyAwinSample({ ...args, sourceObject: "campaigns" });
  }

  async certifyAwinCoupons(args) {
    return this.certifyAwinSample({ ...args, sourceObject: "coupons" });
  }

  /**
   * The Awin conversions chain: one request, publisher-scoped, date-bounded by a frozen preset.
   *
   * It does not reuse certifyAwinSample because it reports one thing the list endpoints do not:
   * whether the transaction carried embedded basket lines, and what shape they have.
   *
   * ORDER ITEMS, NOT A PRODUCT FEED. basketProducts arrives INSIDE a transaction. Awin exposes no
   * product feed in this integration at all — its catalog entry says NO_ENDPOINT_IN_INTEGRATION —
   * and the two must never be read as evidence of each other. Reporting the basket shape here, on
   * the conversion, is what keeps that distinction recorded rather than assumed. The item paths are
   * summarised SEPARATELY from the transaction's own, because order-item fields and transaction
   * fields are different vocabularies and merging them makes the result unreadable as either.
   *
   * Only structure leaves this method. summarisePayloads reports paths, types and categories and
   * never a value, so no transaction or order id, click reference, voucher code, URL, customer
   * detail, commission amount, order value or currency can reach the response — which is what
   * makes certifying the most sensitive object on this integration safe at all.
   */
  async certifyAwinConversions({ adapter, key, probe, window, budgetLeft, sourceObject = "conversions" }) {
    const base = {
      network: key,
      sourceObject,
      endpointKey: probe.endpointKey,
      httpMethod: probe.method,
      sampleCount: 0,
      fieldPaths: [],
    };

    const timeoutMs = Math.max(1000, Math.min(SOURCE_BUDGET_MS, budgetLeft()));

    try {
      const rows = asRows(
        await adapter.fetchCertificationSample(sourceObject, { timeoutMs, window }),
      ).slice(0, 1);

      if (!rows.length) {
        return {
          ...base,
          ok: true,
          statusCategory: "OK_NO_ROWS",
          fieldCount: 0,
          schema: "UNKNOWN_NEEDS_LIVE_DATA",
          windowPreset: window?.preset ?? null,
          orderItems: {
            sourceObject: "order_items",
            present: false,
            observedType: null,
            itemSampleCount: 0,
            itemFieldPaths: [],
            note: "No transaction in this window, so basket presence is unknown — not absent.",
          },
        };
      }

      const fieldPaths = summarisePayloads(rows);
      const basket = rows[0]?.basketProducts;
      const items = Array.isArray(basket) ? basket.slice(0, 1) : [];

      return {
        ...base,
        ok: true,
        statusCategory: "OK",
        sampleCount: rows.length,
        fieldCount: fieldPaths.length,
        fieldPaths,
        windowPreset: window?.preset ?? null,
        orderItems: {
          sourceObject: "order_items",
          // Presence is reported as a boolean, never as a count of the customer's basket.
          present: basket !== undefined && basket !== null,
          observedType: Array.isArray(basket) ? "ARRAY" : basket === null ? "NULL" : typeof basket === "object" && basket !== undefined ? "OBJECT" : basket === undefined ? null : "SCALAR",
          itemSampleCount: items.length,
          itemFieldPaths: summarisePayloads(items),
          note: "Order items embedded in a transaction. Awin exposes no product feed in this integration; a basket line is not feed evidence.",
        },
      };
    } catch (error) {
      if (error?.awinWindowTooWide) {
        return {
          ...base,
          ok: false,
          statusCategory: "WINDOW_EXCEEDS_SUPPLIER_LIMIT",
          windowPreset: window?.preset ?? null,
          maxWindowDays: error.maxWindowDays,
          note: "Awin refuses a transaction window wider than its own limit; choose a narrower preset. No supplier request was made.",
        };
      }
      return certificationFailure(base, error, { windowPreset: window?.preset ?? null }, redactionValuesFor(adapter));
    }
  }

  /**
   * CJ certification adapter.
   *
   * The publisher CID and website id are resolved here, from configuration, and handed to the
   * adapter at construction. Certification never discovers them and never accepts them from a
   * caller: a caller-supplied CID would point the probe at another publisher's advertiser
   * relationships.
   */
  async buildCjAdapter({ accountLabel }) {
    const credentials = await this.cjCredentialResolver(accountLabel);
    if (!credentials?.accessToken || !credentials?.requestorCid || !credentials?.websiteId) {
      // Only whether the credential resolved is reported; nothing about it.
      throw fail("CJ credentials are not configured for this account label.", 424);
    }
    const factory = this.adapterFactory ?? createCjAdapter;
    return recordRedactionValues(
      factory({
        accessToken: credentials.accessToken,
        requestorCid: credentials.requestorCid,
        websiteId: credentials.websiteId,
      }),
      [credentials.accessToken, credentials.requestorCid, credentials.websiteId],
    );
  }

  /**
   * The CJ advertisers chain: exactly one request, publisher-scoped, no date window.
   *
   * Zero rows here is NOT reported as OK_NO_ROWS, and that distinction is the point. The
   * production query is explicitly scoped to advertiser-ids=joined, so an empty collection says
   * the account has no approved advertiser relationships — not that the endpoint returned nothing
   * of interest, and certainly not that it is unsupported. UNKNOWN_NEEDS_JOINED_CAMPAIGN with an
   * accountStateBlocker names the real blocker, which is an account approval rather than an
   * integration defect.
   *
   * Only structural paths, types and counts leave this method. summarisePayloads never reports a
   * value, so no advertiser or programme id, name, program URL, category, EPC or Program Term
   * commission can reach the response — which matters here because the catalog already records
   * that CJ's default Program Term commissions are discovery evidence and not payable truth.
   */
  async certifyCjAdvertisers({ adapter, key, probe, budgetLeft }) {
    const base = {
      network: key,
      sourceObject: "advertisers",
      endpointKey: probe.endpointKey,
      httpMethod: probe.method,
      sampleCount: 0,
      fieldPaths: [],
    };

    const timeoutMs = Math.max(1000, Math.min(SOURCE_BUDGET_MS, budgetLeft()));

    try {
      // One row is all a field dictionary needs. The adapter already slices; this is the second,
      // independent bound.
      const rows = asRows(
        await adapter.fetchCertificationAdvertiserSample({ timeoutMs }),
      ).slice(0, 1);

      if (!rows.length) {
        return {
          ...base,
          ok: false,
          statusCategory: "UNKNOWN_NEEDS_JOINED_CAMPAIGN",
          fieldCount: 0,
          schema: "UNKNOWN_NEEDS_LIVE_DATA",
          accountStateBlocker: "NO_JOINED_CAMPAIGNS",
          note:
            "The query is scoped to advertiser-ids=joined, so an empty result means this account " +
            "has no approved advertiser relationships. Not a supplier or integration failure.",
        };
      }

      const fieldPaths = summarisePayloads(rows);
      return {
        ...base,
        ok: true,
        statusCategory: "OK",
        sampleCount: rows.length,
        fieldCount: fieldPaths.length,
        fieldPaths,
      };
    } catch (error) {
      return certificationFailure(base, error, {}, redactionValuesFor(adapter));
    }
  }

  /**
   * The Boostiny certification adapter: production's own factory, production's own credential
   * resolution, production's own base-URL override. No endpoint override is applied, so the
   * probe certifies the documented path. There is no parameter through which a caller could
   * substitute a host, a path or a key.
   */
  async buildBoostinyAdapter({ accountLabel }) {
    const credentials = await this.boostinyCredentialResolver(accountLabel);
    if (!credentials?.apiKey) {
      // Only whether the credential resolved is reported; nothing about it.
      throw fail("Boostiny credentials are not configured for this account label.", 424);
    }
    const factory = this.adapterFactory ?? createBoostinyAdapter;
    return recordRedactionValues(
      factory({ apiKey: credentials.apiKey, ...(credentials.baseURL ? { baseURL: credentials.baseURL } : {}) }),
      [credentials.apiKey],
    );
  }

  /**
   * Admitad certification adapter.
   *
   * One secret, resolved here from configuration and handed to the adapter at construction.
   * Certification never accepts a token from a caller and never discovers one: a caller-supplied
   * bearer would let the probe be pointed at another publisher's account entirely.
   *
   * The base URL is the adapter's own default (or ADMITAD_BASE_URL), never a caller's — there is
   * no parameter here through which a host could be substituted.
   */
  async buildAdmitadAdapter({ accountLabel }) {
    const credentials = await this.admitadCredentialResolver(accountLabel);
    if (!credentials?.accessToken) {
      // Only whether the credential resolved is reported; nothing about it.
      throw fail("Admitad credentials are not configured for this account label.", 424);
    }
    const factory = this.adapterFactory ?? createAdmitadAdapter;
    return recordRedactionValues(
      factory({ accessToken: credentials.accessToken }),
      [credentials.accessToken],
    );
  }

  /**
   * Rakuten certification adapter.
   *
   * The Bearer is resolved here, from configuration, and handed to the adapter at construction.
   * Certification never discovers it and never accepts one from a caller.
   *
   * The web security token is resolved alongside it so the credential shape matches production
   * exactly, and is passed through — but the advertisers probe never reaches a path that uses it.
   * It is a query parameter on /advancedreports/1.0 alone, never Bearer auth, and a null one is
   * production's own normal state.
   *
   * The base URL is the adapter's own default (or RAKUTEN_BASE_URL), never a caller's.
   */
  async buildRakutenAdapter({ accountLabel }) {
    const credentials = await this.rakutenCredentialResolver(accountLabel);
    if (!credentials?.accessToken) {
      // Only whether the credential resolved is reported; nothing about it.
      throw fail("Rakuten credentials are not configured for this account label.", 424);
    }
    const factory = this.adapterFactory ?? createRakutenAdapter;
    return recordRedactionValues(
      factory({
        accessToken: credentials.accessToken,
        securityToken: credentials.securityToken ?? null,
      }),
      [credentials.accessToken, credentials.securityToken].filter(Boolean),
    );
  }

  /**
   * Trackier certification adapter.
   *
   * One secret, resolved here from configuration and handed to the adapter at construction.
   * Certification never accepts a key from a caller and never discovers one: a caller-supplied key
   * would let the probe be pointed at another publisher's account entirely.
   *
   * The base URL is the adapter's own default, never a caller's — there is no parameter here
   * through which a host could be substituted.
   */
  async buildTrackierAdapter({ accountLabel }) {
    const credentials = await this.trackierCredentialResolver(accountLabel);
    if (!credentials?.apiKey) {
      // Only whether the credential resolved is reported; nothing about it.
      throw fail("Trackier credentials are not configured for this account label.", 424);
    }
    const factory = this.adapterFactory ?? createTrackierAdapter;
    return recordRedactionValues(factory({ apiKey: credentials.apiKey }), [credentials.apiKey]);
  }

  /**
   * One bounded Admitad sample, shared by websites, programs, coupons and actions.
   *
   * All four are single-request list endpoints bounded to limit=1, offset=0, all four must
   * distinguish "this account has none" from "certified", and writing the control flow once means
   * they cannot drift apart. The path and parameters each uses live in the adapter's own frozen
   * spec table, which is the only place that builds a request.
   *
   * The window is passed to every object and used only by the one whose spec declares it needs
   * one. It is the SERVICE's window, computed from a frozen preset — never a caller's dates.
   *
   * ZERO ROWS IS OK_NO_ROWS FOR BOTH, and that is not the judgement made for CJ advertisers. CJ's
   * query is explicitly scoped to advertiser-ids=joined, so emptiness there reports an
   * account-approval blocker. Neither Admitad query carries such a scope: /websites/v2/ lists the
   * publisher's own registered sites, the UNSCOPED /advcampaigns/ may return catalogue-wide
   * programmes rather than only joined ones, and /coupons/ takes no scope at all. actions is
   * scoped only by a date window: an account with no joined programmes has no actions to report,
   * which is an ordinary account state and emphatically NOT an unsupported object — the endpoint
   * is live and answered. Reading "no joined campaigns" or "unsupported" out of an empty result
   * from any of them would be inventing a finding the query cannot support, so no
   * accountStateBlocker is reported, for any of them.
   *
   * The row schema is still unknown in that case, so schema stays UNKNOWN_NEEDS_LIVE_DATA: a
   * certified-looking OK with an empty field list would read as "this object has no fields".
   *
   * Only structural paths, types and counts leave this method. summarisePayloads never reports a
   * value, so no website, programme, coupon or ACTION id, order id, subid, coupon code, customer
   * data, name, description, site, tracking or goto URL, status, category, region, currency,
   * monetary amount, commission value, payment flag or date can reach the response.
   */
  async certifyAdmitadSample({ adapter, key, probe, budgetLeft, sourceObject, window = null }) {
    const base = {
      network: key,
      sourceObject,
      endpointKey: probe.endpointKey,
      httpMethod: probe.method,
      sampleCount: 0,
      fieldPaths: [],
    };

    const timeoutMs = Math.max(1000, Math.min(SOURCE_BUDGET_MS, budgetLeft()));

    try {
      // One row is all a field dictionary needs. The adapter already slices; this is the second,
      // independent bound.
      const rows = asRows(
        await adapter.fetchCertificationSample(sourceObject, { timeoutMs, window }),
      ).slice(0, 1);

      if (!rows.length) {
        return {
          ...base,
          ok: true,
          statusCategory: "OK_NO_ROWS",
          fieldCount: 0,
          schema: "UNKNOWN_NEEDS_LIVE_DATA",
        };
      }

      const fieldPaths = summarisePayloads(rows);
      return {
        ...base,
        ok: true,
        statusCategory: "OK",
        sampleCount: rows.length,
        fieldCount: fieldPaths.length,
        fieldPaths,
      };
    } catch (error) {
      return certificationFailure(base, error, {}, redactionValuesFor(adapter));
    }
  }

  /**
   * The CJ available-advertisers chain: exactly one request, publisher-scoped, no date window.
   *
   * ZERO ROWS IS OK_NO_ROWS HERE, AND THAT IS THE OPPOSITE JUDGEMENT FROM THE JOINED PROBE — on
   * the same endpoint, one parameter apart. advertiser-ids=joined asks about approvals, so
   * emptiness there reports NO_JOINED_CAMPAIGNS. advertiser-ids=notjoined asks what this publisher
   * has NOT joined, so emptiness says the catalogue offered nothing outstanding; it implies no
   * approval state at all and names no blocker.
   *
   * A CID AUTHORIZATION REJECTION IS NOT AN ACCOUNT STATE. CJ answers an unauthorized requestor-cid
   * with 400, which statusCategory already classifies as REQUEST_REJECTED and certificationFailure
   * already carries as a supplierStatusCode with a redacted supplierMessage. Nothing here rewrites
   * that into "no campaigns": a configuration failure and an empty catalogue are different
   * findings, and translating one into the other would hide a broken credential behind a plausible
   * business explanation.
   *
   * Only structural paths, types and counts leave this method. summarisePayloads never reports a
   * value, so no advertiser id, name, program URL, category, EPC, network rank or Program Term
   * commission can reach the response.
   */
  async certifyCjAvailableAdvertisers({ adapter, key, probe, budgetLeft }) {
    const base = {
      network: key,
      sourceObject: "available_advertisers",
      endpointKey: probe.endpointKey,
      httpMethod: probe.method,
      sampleCount: 0,
      fieldPaths: [],
    };

    const timeoutMs = Math.max(1000, Math.min(SOURCE_BUDGET_MS, budgetLeft()));

    try {
      // One row is all a field dictionary needs. The adapter already slices; this is the second,
      // independent bound.
      const rows = asRows(
        await adapter.fetchCertificationAvailableAdvertiserSample({ timeoutMs }),
      ).slice(0, 1);

      if (!rows.length) {
        return {
          ...base,
          ok: true,
          statusCategory: "OK_NO_ROWS",
          fieldCount: 0,
          schema: "UNKNOWN_NEEDS_LIVE_DATA",
        };
      }

      const fieldPaths = summarisePayloads(rows);
      return {
        ...base,
        ok: true,
        statusCategory: "OK",
        sampleCount: rows.length,
        fieldCount: fieldPaths.length,
        fieldPaths,
      };
    } catch (error) {
      return certificationFailure(base, error, {}, redactionValuesFor(adapter));
    }
  }

  /**
   * One bounded Rakuten sample, shared by advertisers, partnerships, commissioning_lists, offers
   * and links.
   *
   * All five are bounded to exactly ONE supplier request, all five must distinguish "this account
   * has none" from "certified", and writing the control flow once means they cannot drift apart.
   * The path, container keys, row extractor and any extra parameters each uses live in the
   * adapter's own frozen spec table, which is the only place that builds a request.
   *
   * Four are JSON bounded by limit=1, page=1. links is XML and bounded entirely by its path, since
   * Rakuten publishes no results-per-page parameter for Link Locator — so the probe takes one
   * request and keeps one row rather than sending a limit the supplier never documented.
   *
   * offers is the one object where production itself makes more than one call — fetchOffers walks
   * three offer_status values and deduplicates. The probe pins a single evidenced status instead,
   * so one source object stays one request.
   *
   * ZERO ROWS IS OK_NO_ROWS, AND DELIBERATELY NAMES NO BLOCKER — for both objects, for different
   * reasons, and in neither case is an API defect claimed.
   *
   * For advertisers: the sync job calls /v2/advertisers completely unscoped, and nothing in this
   * repo proves whether the endpoint returns the network catalogue or only the publisher's own
   * advertisers. Reporting an approval state would assert a scope never established.
   *
   * For partnerships, commissioning_lists, offers and links: this account has no joined campaigns,
   * so an empty result is the expected shape of an account with no relationships — not an
   * unsupported object and not a broken endpoint. Either claim would be inventing a finding from
   * an absence. offers is queried at offer_status=available precisely because that half of the
   * catalogue does not depend on a relationship, but an empty result there still proves nothing
   * about support.
   *
   * NO PARTNERSHIP BLOCKER IS INVENTED FROM AN EMPTY RESULT. Rakuten does block link USE until a
   * partnership is active, but which response proves that is not established by anything in this
   * repo — no status code, element or message has been observed. Emptiness is not that proof, so
   * links reports OK_NO_ROWS like everything else, and NEEDS_ACTIVE_PARTNERSHIP is not reported by
   * guesswork. When a live response shows the real signal, that is the evidence to build it on.
   *
   * In both cases the row schema is still unknown, which is exactly what OK_NO_ROWS and
   * UNKNOWN_NEEDS_LIVE_DATA say.
   *
   * An auth failure keeps its own category and its supplier status, through the shared failure
   * handler — a rejected Bearer and an empty account are different findings.
   *
   * Only structural paths, types and counts leave this method. summarisePayloads never reports a
   * value, so no advertiser, rule or LINK id, name, URL, category, contact, country, date,
   * currency, percentage rate, fixed amount, commission term or creative text can reach the
   * response. A commission rule is certified as SHAPE — including how many outcomes a row can
   * hold — and never as a number; a link asset is certified as SHAPE and never as a URL.
   */
  async certifyRakutenSample({ adapter, key, probe, budgetLeft, sourceObject, window = null }) {
    const base = {
      network: key,
      sourceObject,
      endpointKey: probe.endpointKey,
      httpMethod: probe.method,
      sampleCount: 0,
      fieldPaths: [],
      // Only a dated probe reports a preset. Stamping one onto advertisers or offers would claim a
      // window bounded a request that carries no dates at all.
      ...(probe.dated ? { windowPreset: window?.preset ?? null } : {}),
    };

    const timeoutMs = Math.max(1000, Math.min(SOURCE_BUDGET_MS, budgetLeft()));

    try {
      // One row is all a field dictionary needs. The adapter already slices; this is the second,
      // independent bound.
      //
      // The window is handed to every object and used only by the one whose spec declares it needs
      // one. It is the SERVICE's window, computed from a frozen preset — never a caller's dates.
      const rows = asRows(
        await adapter.fetchCertificationSample(sourceObject, { timeoutMs, window }),
      ).slice(0, 1);

      if (!rows.length) {
        return {
          ...base,
          ok: true,
          statusCategory: "OK_NO_ROWS",
          fieldCount: 0,
          schema: "UNKNOWN_NEEDS_LIVE_DATA",
        };
      }

      const fieldPaths = summarisePayloads(rows);
      return {
        ...base,
        ok: true,
        statusCategory: "OK",
        sampleCount: rows.length,
        fieldCount: fieldPaths.length,
        fieldPaths,
      };
    } catch (error) {
      return certificationFailure(base, error, {}, redactionValuesFor(adapter));
    }
  }

  /**
   * The Rakuten Advanced Reports chain: exactly ONE request, and sometimes none.
   *
   * CSV, so the header row is evidence in its own right. Three outcomes are distinguished rather
   * than collapsed into "no rows":
   *   - headers and a data row      -> OK, schema KNOWN_FROM_HEADERS
   *   - headers and no data row     -> OK_NO_ROWS, schema KNOWN_FROM_HEADERS. The columns ARE
   *                                    known; the window simply held no payment.
   *   - nothing at all              -> OK_NO_ROWS, schema UNKNOWN_NEEDS_LIVE_DATA
   * An empty report is a quiet window, never an account-state blocker: this account has no joined
   * campaigns, so having no payments is the expected state and not a finding about the endpoint.
   *
   * A missing web security token is reported as SKIPPED_NO_SECURITY_TOKEN and makes NO request.
   * Advanced Reports is the one Rakuten surface needing it, production gates its whole finance
   * chain on the same condition, and "not configured" is not a network failure.
   *
   * Only structure leaves this method. The field dictionary reports column names, types and
   * categories — never a payment id, check number, currency value or amount — and the CSV body is
   * never returned.
   */
  async certifyRakutenAdvancedReport({ adapter, key, probe, budgetLeft, sourceObject, window = null }) {
    const base = {
      network: key,
      sourceObject,
      endpointKey: probe.endpointKey,
      httpMethod: probe.method,
      reportId: probe.reportId,
      sampleCount: 0,
      fieldPaths: [],
      windowPreset: window?.preset ?? null,
    };

    const timeoutMs = Math.max(1000, Math.min(SOURCE_BUDGET_MS, budgetLeft()));

    try {
      const sample = await adapter.fetchCertificationCsvSample(sourceObject, { timeoutMs, window });
      const headers = Array.isArray(sample?.headers) ? sample.headers : [];
      // One row is all a field dictionary needs. The adapter already slices; this is the second,
      // independent bound.
      const rows = asRows(sample?.rows).slice(0, 1);

      if (!headers.length) {
        return {
          ...base,
          ok: true,
          statusCategory: "OK_NO_ROWS",
          fieldCount: 0,
          schema: "UNKNOWN_NEEDS_LIVE_DATA",
        };
      }

      // With no data row, the columns are summarised as present-but-unobserved rather than
      // discarded: every header is reported with presentCount 0. Dropping them would throw away
      // the schema the header row just proved.
      const fieldPaths = summarisePayloads(
        rows.length ? rows : [Object.fromEntries(headers.map((header) => [header, null]))],
      );

      return {
        ...base,
        ok: true,
        statusCategory: rows.length ? "OK" : "OK_NO_ROWS",
        sampleCount: rows.length,
        fieldCount: fieldPaths.length,
        fieldPaths,
        schema: "KNOWN_FROM_HEADERS",
      };
    } catch (error) {
      if (error?.rakutenSecurityTokenMissing) {
        return {
          ...base,
          ok: false,
          statusCategory: "SKIPPED_NO_SECURITY_TOKEN",
          fieldCount: 0,
          schema: "UNKNOWN_NEEDS_LIVE_DATA",
          note:
            "Advanced Reports needs the Rakuten web security token in addition to the Bearer, and " +
            "none is configured for this account label. No supplier request was made.",
        };
      }
      return certificationFailure(
        base,
        error,
        { windowPreset: window?.preset ?? null },
        redactionValuesFor(adapter),
      );
    }
  }

  /**
   * The Awin commission-group chain: at most TWO requests, and often one.
   *
   * The endpoint is advertiser-scoped, so it needs an id. That id is DISCOVERED — one bounded
   * campaigns sample, one row, and the advertiser id read out of it by awinAdvertiserIdOf. It is
   * never accepted from a caller: a caller-supplied id would let the probe be pointed at another
   * merchant's commission structure, which is exactly the kind of data this chain exists to
   * certify the shape of without reading.
   *
   * Awin campaigns currently return zero rows, so the no-id path is the likely one. That is a
   * configuration outcome, not a supplier failure: it reports SKIPPED_NO_ADVERTISER_ID and makes
   * NO second request.
   *
   * Only structure leaves this method. No advertiser or programme id, group or rule name,
   * commission rate, amount or currency can reach the response — summarisePayloads reports paths,
   * types and categories and never a value, and the discovered id is used and discarded.
   */
  async certifyAwinCommissionGroups({ adapter, key, probe, budgetLeft }) {
    const base = {
      network: key,
      sourceObject: "commission_groups",
      endpointKey: probe.endpointKey,
      httpMethod: probe.method,
      sampleCount: 0,
      fieldPaths: [],
      campaignsInspectedCount: 0,
      advertiserIdResolved: false,
    };

    const deadline = Date.now() + Math.max(0, Math.min(SOURCE_BUDGET_MS, budgetLeft()));
    const timeLeft = () => Math.max(MIN_ATTEMPT_MS, deadline - Date.now());

    // Request 1 of at most 2 — one campaign row, for its advertiser id alone.
    let campaignRows = [];
    try {
      campaignRows = asRows(
        await adapter.fetchCertificationSample("campaigns", { timeoutMs: timeLeft() }),
      ).slice(0, 1);
    } catch (error) {
      return certificationFailure(base, error, {}, redactionValuesFor(adapter));
    }

    const advertiserId = campaignRows.length ? awinAdvertiserIdOf(campaignRows[0]) : null;
    const discovery = { ...base, campaignsInspectedCount: campaignRows.length };

    if (!advertiserId) {
      return {
        ...discovery,
        ok: false,
        statusCategory: "SKIPPED_NO_ADVERTISER_ID",
        schema: "UNKNOWN_NEEDS_LIVE_DATA",
        note:
          "No advertiser id was available from a bounded campaigns sample, so no commission-group " +
          "request was made. Awin campaigns currently return no rows for this account.",
      };
    }

    // Request 2 of 2.
    try {
      const rows = asRows(
        await adapter.fetchCertificationCommissionGroupSample({
          advertiserId,
          timeoutMs: timeLeft(),
        }),
      ).slice(0, 1);

      if (!rows.length) {
        return {
          ...discovery,
          ok: true,
          statusCategory: "OK_NO_ROWS",
          fieldCount: 0,
          schema: "UNKNOWN_NEEDS_LIVE_DATA",
          advertiserIdResolved: true,
        };
      }

      const fieldPaths = summarisePayloads(rows);
      return {
        ...discovery,
        ok: true,
        statusCategory: "OK",
        sampleCount: rows.length,
        fieldCount: fieldPaths.length,
        fieldPaths,
        advertiserIdResolved: true,
      };
    } catch (error) {
      return certificationFailure(
        base,
        error,
        { campaignsInspectedCount: campaignRows.length, advertiserIdResolved: true },
        redactionValuesFor(adapter),
      );
    }
  }

  /**
   * The Partnerize campaigns chain.
   *
   * The adapter owns the resolution: it uses its configured publisher id when it has one, and
   * otherwise discovers one from the bounded publishers sample. Keeping that inside the adapter is
   * deliberate — a discovered identifier never crosses back through this service, so there is no
   * point at which it could be reported, persisted, or replaced by a caller's value.
   *
   * This service only classifies the outcome.
   */
  async certifyPartnerizeCampaigns({ adapter, key, probes, budgetLeft }) {
    // Two source objects, one response. `campaigns` reports the whole 46-field dictionary;
    // `commission_structure` reports only the commission subtree of the SAME row, so no second
    // supplier request exists for it to make.
    const rowFor = (sourceObject, extra) => ({
      network: key,
      sourceObject,
      endpointKey: probes[sourceObject].endpointKey,
      httpMethod: probes[sourceObject].method,
      sampleCount: 0,
      fieldPaths: [],
      ...extra,
    });
    const both = (extra) => ({
      campaigns: rowFor("campaigns", extra),
      commission_structure: rowFor("commission_structure", extra),
    });

    const timeoutMs = Math.max(1000, Math.min(SOURCE_BUDGET_MS, budgetLeft()));

    let allRows;
    try {
      // Up to COMMISSION_SCAN_ROW_LIMIT rows of the ONE response are kept. How many actually
      // arrive is the supplier's answer to a query that still asks for limit 1, unchanged here.
      allRows = asRows(await adapter.fetchCertificationCampaignSample({ timeoutMs })).slice(
        0,
        COMMISSION_SCAN_ROW_LIMIT,
      );
    } catch (error) {
      // "No publisher id" is a configuration outcome, not a supplier failure.
      if (error?.partnerizeNoPublisherId) {
        return both({ ok: false, statusCategory: "SKIPPED_NO_PUBLISHER_ID" });
      }
      // Anything else — discovery or campaign — is reported as its category and stops there.
      return both(certificationFailure({}, error, {}, redactionValuesFor(adapter)));
    }

    // The campaigns dictionary is unchanged: one row, exactly as before.
    const campaignRows = allRows.slice(0, 1);
    const fieldPaths = summarisePayloads(campaignRows);

    // The commission scan may walk further into the SAME response. It issues nothing.
    const chosen = chooseCommissionSampleRow(allRows, COMMISSION_SCAN_ROW_LIMIT);
    const commission = summariseCommissionStructure(chosen.row ?? {});

    return {
      campaigns: rowFor("campaigns", {
        ok: true,
        statusCategory: "OK",
        sampleCount: campaignRows.length,
        fieldCount: fieldPaths.length,
        fieldPaths,
      }),
      commission_structure: rowFor("commission_structure", {
        ok: true,
        // Not "the key exists" but "a row in the bounded scan states outcomes". A stated-but-empty
        // collection and a scan that found none are the same finding, and share one category.
        statusCategory: chosen.found ? "OK" : "OK_NO_COMMISSION_COLLECTION_IN_BOUNDED_SAMPLE",
        // How many campaign rows of the one response were walked. The query asks for limit 1, so
        // this is 1 today; it rises only if that query is widened, which is a separate decision.
        campaignsInspectedCount: chosen.campaignsInspectedCount,
        sampleCount: chosen.row ? 1 : 0,
        fieldCount: commission.fieldPaths.length,
        fieldPaths: commission.fieldPaths,
        commissionsObservedType: commission.commissionsObservedType,
        commissionOutcomeCount: commission.commissionOutcomeCount,
        distinctOutcomeShapeCount: commission.distinctOutcomeShapeCount,
        defaultCommissionRatePresent: commission.defaultCommissionRatePresent,
        defaultCommissionValuePresent: commission.defaultCommissionValuePresent,
        defaultCurrencyPresent: commission.defaultCurrencyPresent,
        note:
          "Outcomes are reported as a count, never merged. default_commission_rate is display and " +
          "default context only, not payout truth when commissions[] states more specific " +
          "outcomes; canonical target is SupplierCommissionRule, one row per outcome.",
      }),
    };
  }

  /**
   * The voucher chain: at most ONE supplier request, and none at all without both identifiers.
   *
   * The endpoint is campaign-scoped, so it needs a publisher id and a campaign id. Both come from
   * server-side configuration. Neither is discovered — that would be a second request — and neither
   * can be supplied by a caller, so this probe cannot be pointed at another publisher or another
   * merchant's vouchers. A missing identifier is its own outcome, distinct from a supplier failure,
   * and produces no traffic at all.
   */
  /**
   * The Partnerize conversions probe: exactly one request, publisher-scoped, date-bounded.
   *
   * Zero rows is reported as OK_NO_ROWS rather than OK. The distinction matters: OK with an empty
   * field list would read as "certified, no fields", when what actually happened is that the
   * window held no conversions and the row schema is still unknown. An operator widening the
   * window needs to see which of the two it was.
   *
   * Only structural paths and types leave this method. summarisePayloads reports paths, types and
   * categories and never a value, so no order id, customer detail, commission or order value can
   * reach the response — which is why the financial separation this source object exists to
   * protect is not at risk from certifying it.
   */
  /**
   * One bounded, date-windowed Partnerize sample, shared by conversions and payments.
   *
   * Both are publisher-scoped reporting endpoints taking the same two date parameters, both are
   * one request, and both must distinguish "no rows in this window" from "certified". Writing the
   * control flow once means the two cannot drift apart.
   *
   * Zero rows is reported as OK_NO_ROWS rather than OK. The distinction matters: OK with an empty
   * field list reads as "certified, no fields", when what happened is that the window held nothing
   * and the row schema is still unknown. An operator widening the window needs to see which.
   *
   * Only structural paths, types and counts leave this method. summarisePayloads never reports a
   * value, so no identifier, monetary amount, currency, account or customer detail can reach the
   * response — which is what keeps the payment/invoice/conversion/payable separation safe from
   * schema certification.
   */
  async certifyPartnerizeDatedSample({ adapter, key, probe, window, budgetLeft, sourceObject }) {
    const base = {
      network: key,
      sourceObject,
      endpointKey: probe.endpointKey,
      httpMethod: probe.method,
      sampleCount: 0,
      fieldPaths: [],
    };

    const timeoutMs = Math.max(1000, Math.min(SOURCE_BUDGET_MS, budgetLeft()));

    try {
      // One row is all a field dictionary needs, and one row is all that is held.
      const rows = asRows(
        await adapter.fetchCertificationSample(sourceObject, { timeoutMs, window }),
      ).slice(0, 1);

      if (!rows.length) {
        return {
          ...base,
          ok: true,
          statusCategory: "OK_NO_ROWS",
          fieldCount: 0,
          schema: "UNKNOWN_NEEDS_LIVE_DATA",
          windowPreset: window?.preset ?? null,
        };
      }

      const fieldPaths = summarisePayloads(rows);
      return {
        ...base,
        ok: true,
        statusCategory: "OK",
        sampleCount: rows.length,
        fieldCount: fieldPaths.length,
        fieldPaths,
        windowPreset: window?.preset ?? null,
      };
    } catch (error) {
      if (error?.partnerizeNoPublisherId) {
        return { ...base, ok: false, statusCategory: "SKIPPED_NO_PUBLISHER_ID" };
      }
      return certificationFailure(base, error, {}, redactionValuesFor(adapter));
    }
  }

  async certifyPartnerizeConversions(args) {
    return this.certifyPartnerizeDatedSample({ ...args, sourceObject: "conversions" });
  }

  async certifyPartnerizePayments(args) {
    return this.certifyPartnerizeDatedSample({ ...args, sourceObject: "payments" });
  }

  async certifyPartnerizeVouchers({ adapter, key, probe, budgetLeft }) {
    const base = {
      network: key,
      sourceObject: "vouchers",
      endpointKey: probe.endpointKey,
      httpMethod: probe.method,
      sampleCount: 0,
      fieldPaths: [],
    };

    const timeoutMs = Math.max(1000, Math.min(SOURCE_BUDGET_MS, budgetLeft()));

    try {
      // One row from voucher_codes[] is all a field dictionary needs, and one row is all that is
      // held. The sampler descends into the collection itself, so these are voucher rows — never
      // the { commission_fields, count, execution_time, voucher_codes } envelope around them.
      const rows = asRows(await adapter.fetchCertificationVoucherSample({ timeoutMs })).slice(0, 1);

      // An empty voucher_codes[] is zero rows, reported as OK_NO_ROWS rather than OK. The endpoint
      // is certified either way — it answered — but OK with an empty field list would read as
      // "certified, no fields", when what happened is that this campaign had no vouchers and the
      // ROW schema is still unknown. The envelope is never substituted to fill the gap.
      if (!rows.length) {
        return {
          ...base,
          ok: true,
          statusCategory: "OK_NO_ROWS",
          fieldCount: 0,
          schema: "UNKNOWN_NEEDS_LIVE_DATA",
        };
      }

      const fieldPaths = summarisePayloads(rows);
      return {
        ...base,
        ok: true,
        statusCategory: "OK",
        sampleCount: rows.length,
        fieldCount: fieldPaths.length,
        fieldPaths,
      };
    } catch (error) {
      // Two configuration outcomes, reported separately: which identifier is missing is what tells
      // an operator what to configure, and neither is a supplier failure.
      if (error?.partnerizeNoPublisherId) {
        return { ...base, ok: false, statusCategory: "SKIPPED_NO_PUBLISHER_ID" };
      }
      if (error?.partnerizeNoCampaignId) {
        return { ...base, ok: false, statusCategory: "SKIPPED_NO_CERTIFICATION_CAMPAIGN_ID" };
      }
      return certificationFailure(base, error, {}, redactionValuesFor(adapter));
    }
  }

  /**
   * The commission-group chain: one campaign list, then up to five campaigns tried in turn.
   *
   * Control flow, and the reasons for it:
   *
   *  - ONE bounded list request returns up to five campaign rows. Asking five times for one row
   *    each would cost five requests before a single commission-group call.
   *  - Each row yields an identifier through commissionGroupCampaignIdOf only — campaignId or
   *    campaign_id. Rows without one are skipped, never substituted from `id` or `productId`.
   *  - Campaigns are tried SEQUENTIALLY and the loop stops at the first non-empty response. A
   *    burst of five concurrent calls is the traffic that gets an affiliate account flagged.
   *  - Only a recognised EMPTY response continues to the next campaign. Any supplier failure ends
   *    the chain with its category: continuing past a 401 or a 429 would turn one rejection into
   *    five, and an unrecognised envelope is a parse failure, not evidence of zero groups.
   *  - Every attempt is timed against what remains of the source budget, so five attempts cannot
   *    add up to five full timeouts.
   */
  async certifyCommissionGroups({ adapter, key, probe, budgetLeft }) {
    const base = {
      network: key,
      sourceObject: "commission_groups",
      endpointKey: probe.endpointKey,
      httpMethod: probe.method,
      sampleCount: 0,
      fieldPaths: [],
    };

    // The source's own deadline, never longer than what the whole run has left.
    const deadline = Date.now() + Math.max(0, Math.min(SOURCE_BUDGET_MS, budgetLeft()));
    const timeLeft = () => deadline - Date.now();
    const attemptTimeout = () => Math.max(MIN_ATTEMPT_MS, Math.min(SOURCE_BUDGET_MS / 2, timeLeft()));

    let candidates;
    try {
      const rows = asRows(
        await adapter.fetchCertificationSample("campaign_candidates", { timeoutMs: attemptTimeout() }),
      ).slice(0, COMMISSION_GROUP_CANDIDATE_LIMIT);
      candidates = rows.map((row) => commissionGroupCampaignIdOf(row)).filter(Boolean);
    } catch (error) {
      return certificationFailure(base, error, {}, redactionValuesFor(adapter));
    }

    if (!candidates.length) {
      // No dependent request: not one sampled campaign carries the identifier this endpoint needs.
      return { ...base, ok: false, statusCategory: "SKIPPED_NO_COMMISSION_GROUP_CAMPAIGN_ID" };
    }

    let checked = 0;
    for (const campaignId of candidates) {
      if (timeLeft() < MIN_ATTEMPT_MS) {
        return { ...base, ok: false, statusCategory: "SOURCE_BUDGET_EXHAUSTED", campaignsChecked: checked };
      }

      let sample;
      try {
        sample = await adapter.fetchCertificationCommissionGroupSample(campaignId, {
          timeoutMs: attemptTimeout(),
        });
      } catch (error) {
        // Fail closed. A supplier failure is never a reason to try the next campaign.
        return certificationFailure(base, error, { campaignsChecked: checked }, redactionValuesFor(adapter));
      }

      checked += 1;
      const rows = asRows(sample?.rows).slice(0, 1);
      if (rows.length) {
        const fieldPaths = summarisePayloads(rows);
        // No campaign id, name or index is reported: which campaign happened to have groups is not
        // part of the schema, and naming it would leak a supplier value into a structural result.
        return {
          ...base,
          ok: true,
          statusCategory: "OK",
          sampleCount: rows.length,
          fieldCount: fieldPaths.length,
          fieldPaths,
        };
      }
    }

    // Every sampled campaign answered, and answered empty. That is a fact about these campaigns,
    // not about Optimise: campaignsChecked says how far the search got.
    return {
      ...base,
      ok: true,
      statusCategory: "OK",
      fieldCount: 0,
      campaignsChecked: checked,
      note: "No commission-group rows in the campaigns sampled; this does not mean the network has none.",
    };
  }

  /**
   * The products chain: one feed, then one item from that feed.
   *
   * Two supplier requests, no more. The second is built by the adapter from the first response and
   * a host allowlist, so nothing a caller sends can influence which URL is fetched — the request
   * body cannot name a feed, a feed URL or a path.
   *
   * The two are reported as SEPARATE rows. Feed metadata (feedId, itemCount, lastImportedDate) and
   * product item fields (sku, price, availability) are different vocabularies, and merging them
   * into one dictionary would make the result unreadable as certification of either.
   */
  async certifyProductChain({ adapter, key, probe, compareRaw, budgetLeft }) {
    const rows = [];
    const base = { network: key, httpMethod: "GET" };
    const timeoutFor = () => Math.max(1000, Math.min(SOURCE_BUDGET_MS / 2, budgetLeft()));

    // Request 1 of 2 — one feed row.
    let feedRow = null;
    try {
      const sample = asRows(
        await adapter.fetchCertificationSample("products", { timeoutMs: timeoutFor() }),
      ).slice(0, 1);
      feedRow = sample[0] ?? null;
      const fieldPaths = summarisePayloads(sample);
      const entry = {
        ...base,
        sourceObject: "product_feeds",
        endpointKey: probe.endpointKey,
        ok: true,
        statusCategory: "OK",
        sampleCount: sample.length,
        fieldCount: fieldPaths.length,
        fieldPaths,
      };
      if (compareRaw) {
        const rawPaths = await this.rawPathsFor({ networkSource: key, sourceObject: "products" }).catch(() => []);
        entry.rawComparison = comparePathSets(fieldPaths.map((f) => f.path), rawPaths);
      }
      rows.push(entry);
    } catch (error) {
      rows.push(
        certificationFailure(
          { ...base, sourceObject: "product_feeds", endpointKey: probe.endpointKey },
          error,
          { sampleCount: 0, fieldPaths: [] },
          redactionValuesFor(adapter),
        ),
      );
    }

    const itemBase = {
      ...base,
      sourceObject: "product_items",
      endpointKey: "GET {feedUrl} (bounded byte window)",
      sampleCount: 0,
      fieldPaths: [],
      ok: false,
    };

    if (!feedRow) {
      rows.push({ ...itemBase, statusCategory: "SKIPPED_NO_FEED_SAMPLE" });
      return rows;
    }
    if (budgetLeft() <= 0) {
      rows.push({ ...itemBase, statusCategory: "RUN_BUDGET_EXHAUSTED" });
      return rows;
    }

    // Request 2 of 2 — one item from that feed, bounded by bytes rather than by a row limit,
    // because Optimise exposes no product-item endpoint and the feed URL takes no limit parameter.
    try {
      const sample = await adapter.fetchCertificationFeedItemSample(feedRow, { timeoutMs: timeoutFor() });
      const itemRows = asRows(sample?.rows).slice(0, 1);
      const fieldPaths = summarisePayloads(itemRows);
      rows.push({
        ...itemBase,
        ok: true,
        statusCategory: "OK",
        feedFormat: sample?.feedFormat ?? null,
        sampleCount: itemRows.length,
        fieldCount: fieldPaths.length,
        fieldPaths,
        note: "One record parsed from a bounded byte window; the feed was never downloaded in full.",
      });
    } catch (error) {
      const reason = notBoundedReason(error);
      // A not-bounded outcome keeps its own category; only the supplier-status field is shared.
      rows.push(
        reason
          ? {
              ...itemBase,
              statusCategory: "PRODUCT_ITEM_SAMPLE_NOT_BOUNDED",
              reason,
              note: NOT_BOUNDED_NOTES[reason] ?? NOT_BOUNDED_NOTES.UNKNOWN,
            }
          : certificationFailure(itemBase, error, {}, redactionValuesFor(adapter)),
      );
    }

    return rows;
  }

  /**
   * The Trackier profile chain: exactly ONE request.
   *
   * It reuses production's own fetchProfile, pinned to a single attempt — production allows six —
   * so a bounded probe stays one supplier request. Nothing else about the request changes: the
   * X-Api-Key header, the shared rate limiter and the profile unwrapping are production's.
   *
   * A profile is ONE OBJECT, so "rows" here is at most one. An empty or absent profile reports
   * OK_NO_ROWS rather than an error: the endpoint answered, and the shape is simply still unknown.
   *
   * Only structure leaves this method. No publisher id, name, email, phone, address, API key or
   * raw response can reach the result.
   */
  async certifyTrackierProfile({ adapter, key, probe, budgetLeft, sourceObject }) {
    const base = {
      network: key,
      sourceObject,
      endpointKey: probe.endpointKey,
      httpMethod: probe.method,
      sampleCount: 0,
      fieldPaths: [],
    };

    const timeoutMs = Math.max(1000, Math.min(SOURCE_BUDGET_MS, budgetLeft()));

    try {
      // retries: 1 is "attempt once, never retry" — requestWithRetry counts attempts, not extra
      // tries, so 0 would run the loop zero times and throw nothing.
      const profile = await adapter.fetchProfile({ retries: 1, timeoutMs });
      const rows =
        profile && typeof profile === "object" && !Array.isArray(profile)
          ? [profile].filter((row) => Object.keys(row).length > 0)
          : asRows(profile).slice(0, 1);

      if (!rows.length) {
        return {
          ...base,
          ok: true,
          statusCategory: "OK_NO_ROWS",
          fieldCount: 0,
          schema: "UNKNOWN_NEEDS_LIVE_DATA",
        };
      }

      const fieldPaths = summarisePayloads(rows);
      return {
        ...base,
        ok: true,
        statusCategory: "OK",
        sampleCount: rows.length,
        fieldCount: fieldPaths.length,
        fieldPaths,
      };
    } catch (error) {
      return certificationFailure(base, error, {}, redactionValuesFor(adapter));
    }
  }

  /**
   * The Trackier campaigns chain: exactly ONE request.
   *
   * It reuses production's own fetchCampaigns — same client, same X-Api-Key header, same path,
   * same rate limiter, same row extraction — with three bounds that production does not set:
   * singlePage, so the pager cannot enter a second iteration; retries pinned to one attempt where
   * production allows six; and the probe's own timeout.
   *
   * singlePage is load-bearing rather than merely tidy. At limit=1 a one-row page is a FULL page,
   * so the pager's own heuristic would conclude there is more and ask for page 2 — a bounded probe
   * cannot rely on the loop choosing to stop.
   *
   * Zero campaigns reports OK_NO_ROWS. It is not evidence of an account-state blocker: this probe
   * asks for one row of whatever the endpoint lists, and an empty list is an empty list.
   *
   * Only structure leaves this method. summarisePayloads reports paths, types and categories and
   * never a value, so no campaign id or name, merchant name, URL, commission or application
   * identifier can reach the result.
   */
  async certifyTrackierCampaigns({ adapter, key, probe, budgetLeft, sourceObject }) {
    const base = {
      network: key,
      sourceObject,
      endpointKey: probe.endpointKey,
      httpMethod: probe.method,
      sampleCount: 0,
      fieldPaths: [],
    };

    const timeoutMs = Math.max(1000, Math.min(SOURCE_BUDGET_MS, budgetLeft()));

    try {
      // One row is all a field dictionary needs. The supplier bound is limit=1; this is the
      // second, independent bound, in case the supplier ignores it.
      const rows = asRows(
        await adapter.fetchCampaigns(
          { ...TRACKIER_CERTIFICATION_CAMPAIGN_PARAMS },
          { singlePage: true, retries: 1, timeoutMs },
        ),
      ).slice(0, 1);

      if (!rows.length) {
        return {
          ...base,
          ok: true,
          statusCategory: "OK_NO_ROWS",
          fieldCount: 0,
          schema: "UNKNOWN_NEEDS_LIVE_DATA",
        };
      }

      const fieldPaths = summarisePayloads(rows);
      return {
        ...base,
        ok: true,
        statusCategory: "OK",
        sampleCount: rows.length,
        fieldCount: fieldPaths.length,
        fieldPaths,
      };
    } catch (error) {
      return certificationFailure(base, error, {}, redactionValuesFor(adapter));
    }
  }

  /**
   * The Trackier campaign-detail chain: at most TWO requests, and often one.
   *
   * The endpoint is campaign-scoped, so it needs an id. That id is DISCOVERED — one bounded
   * campaigns sample, one row, and the id read out of it by trackierCampaignIdOf. It is never
   * accepted from a caller: a caller-supplied campaign, app or advertiser id would let the probe
   * be pointed at a resource this publisher was never offered, which is exactly what this chain
   * exists to certify the shape of without reading.
   *
   * No campaign row, or a row carrying no usable id, is a SCOPE outcome rather than a supplier
   * failure: it reports SKIPPED_NO_CAMPAIGN_SCOPE and makes NO second request.
   *
   * RELATIONSHIP STATE IS REPORTED, NEVER DECIDED. The observed paths are checked against
   * TRACKIER_RELATIONSHIP_EVIDENCE_PATHS — a search list, not a mapping — and the result is either
   * PRESENT_NEEDS_MAPPING or UNKNOWN_FROM_CURRENT_API_SHAPE. Nothing is classified joined,
   * available, pending or rejected here.
   *
   * Only structure leaves this method. The discovered id is used and discarded, and no campaign or
   * advertiser name, app id, tracking or landing URL, payout or commission value can reach the
   * result.
   */
  async certifyTrackierCampaignDetail({ adapter, key, probe, budgetLeft, sourceObject }) {
    const base = {
      network: key,
      sourceObject,
      endpointKey: probe.endpointKey,
      httpMethod: probe.method,
      sampleCount: 0,
      fieldPaths: [],
      discoveryRequestCount: 0,
      detailRequestCount: 0,
    };

    const timeoutMs = () => Math.max(1000, Math.min(SOURCE_BUDGET_MS, budgetLeft()));

    let campaignRows = [];
    try {
      campaignRows = asRows(
        await adapter.fetchCampaigns(
          { ...TRACKIER_CERTIFICATION_CAMPAIGN_PARAMS },
          { singlePage: true, retries: 1, timeoutMs: timeoutMs() },
        ),
      ).slice(0, 1);
    } catch (error) {
      return certificationFailure(
        { ...base, discoveryRequestCount: 1 },
        error,
        {},
        redactionValuesFor(adapter),
      );
    }

    const discovery = { ...base, discoveryRequestCount: 1 };
    const campaignId = campaignRows.length ? trackierCampaignIdOf(campaignRows[0]) : null;

    if (!campaignId) {
      return {
        ...discovery,
        ok: false,
        statusCategory: "SKIPPED_NO_CAMPAIGN_SCOPE",
        fieldCount: 0,
        schema: "UNKNOWN_NEEDS_LIVE_DATA",
        note: campaignRows.length
          ? "A campaign row was returned but carried no usable campaign id, so no detail request was made."
          : "The bounded campaigns sample returned no row, so there was no campaign to ask for detail about and no detail request was made.",
      };
    }

    try {
      const detail = await adapter.fetchCampaignDetail(campaignId, {
        retries: 1,
        timeoutMs: timeoutMs(),
      });
      const rows = asRows(detail).slice(0, 1);
      const withDetail = { ...discovery, detailRequestCount: 1 };

      if (!rows.length || !Object.keys(rows[0] ?? {}).length) {
        return {
          ...withDetail,
          ok: true,
          statusCategory: "OK_NO_ROWS",
          fieldCount: 0,
          schema: "UNKNOWN_NEEDS_LIVE_DATA",
          relationshipState: "UNKNOWN_FROM_CURRENT_API_SHAPE",
        };
      }

      const fieldPaths = summarisePayloads(rows);
      const observed = new Set(fieldPaths.map((field) => field.path));
      const relationshipEvidence = TRACKIER_RELATIONSHIP_EVIDENCE_PATHS.filter((path) =>
        observed.has(path),
      );

      return {
        ...withDetail,
        ok: true,
        statusCategory: "OK",
        sampleCount: rows.length,
        fieldCount: fieldPaths.length,
        fieldPaths,
        // Which of the searched-for paths appeared, and nothing about what they hold.
        relationshipEvidencePaths: relationshipEvidence,
        relationshipState: relationshipEvidence.length
          ? "PRESENT_NEEDS_MAPPING"
          : "UNKNOWN_FROM_CURRENT_API_SHAPE",
      };
    } catch (error) {
      return certificationFailure(
        { ...discovery, detailRequestCount: 1 },
        error,
        {},
        redactionValuesFor(adapter),
      );
    }
  }

  /**
   * The Trackier coupons chain: exactly ONE request.
   *
   * It reuses production's own fetchCoupons — same client, same X-Api-Key header, same path, same
   * rate limiter, same coupons row extraction — with three bounds production does not set:
   * singlePage, retries pinned to one attempt where production allows six, and the probe's own
   * timeout.
   *
   * singlePage breaks before the response is read for a next page token, so the cursor is never
   * extracted and cannot be followed. No page-size parameter is sent, because none is evidenced
   * for this endpoint; the request count is the bound.
   *
   * Zero coupons reports OK_NO_ROWS. It is not evidence of a relationship or account-state
   * blocker, and this phase does not revisit relationship state at all.
   *
   * Only structure leaves this method: no coupon code, campaign id or name, advertiser, URL or
   * description text can reach the result.
   */
  async certifyTrackierCoupons({ adapter, key, probe, budgetLeft, sourceObject }) {
    const base = {
      network: key,
      sourceObject,
      endpointKey: probe.endpointKey,
      httpMethod: probe.method,
      sampleCount: 0,
      fieldPaths: [],
    };

    const timeoutMs = Math.max(1000, Math.min(SOURCE_BUDGET_MS, budgetLeft()));

    try {
      // One row is all a field dictionary needs. No supplier-side limit is sent, so this local
      // bound is the only one — which is why it is applied to whatever the page returned.
      const rows = asRows(
        await adapter.fetchCoupons({}, { singlePage: true, retries: 1, timeoutMs }),
      ).slice(0, 1);

      if (!rows.length) {
        return {
          ...base,
          ok: true,
          statusCategory: "OK_NO_ROWS",
          fieldCount: 0,
          schema: "UNKNOWN_NEEDS_LIVE_DATA",
        };
      }

      const fieldPaths = summarisePayloads(rows);
      return {
        ...base,
        ok: true,
        statusCategory: "OK",
        sampleCount: rows.length,
        fieldCount: fieldPaths.length,
        fieldPaths,
      };
    } catch (error) {
      return certificationFailure(base, error, {}, redactionValuesFor(adapter));
    }
  }

  /**
   * The Trackier deals chain: exactly ONE request.
   *
   * Deliberately its own chain rather than a parameter on the coupons one. Deals and coupons are
   * separate supplier objects with separate row shapes, and a shared chain would invite exactly
   * the merge this phase is told not to make.
   *
   * It reuses production's own fetchDeals — same client, same X-Api-Key header, same path, same
   * rate limiter, same deals row extraction — with three bounds production does not set:
   * singlePage, retries pinned to one attempt where production allows six, and the probe's own
   * timeout. singlePage breaks before the response is read for a next page token, so the cursor is
   * never extracted and cannot be followed.
   *
   * Zero deals reports OK_NO_ROWS, and says nothing about joined or account state.
   *
   * Only structure leaves this method: no code, coupon or deal_code value, campaign id or name,
   * advertiser, title, description or URL can reach the result.
   */
  async certifyTrackierDeals({ adapter, key, probe, budgetLeft, sourceObject }) {
    const base = {
      network: key,
      sourceObject,
      endpointKey: probe.endpointKey,
      httpMethod: probe.method,
      sampleCount: 0,
      fieldPaths: [],
    };

    const timeoutMs = Math.max(1000, Math.min(SOURCE_BUDGET_MS, budgetLeft()));

    try {
      // No supplier-side page size is sent, so this local bound is the only one.
      const rows = asRows(
        await adapter.fetchDeals({}, { singlePage: true, retries: 1, timeoutMs }),
      ).slice(0, 1);

      if (!rows.length) {
        return {
          ...base,
          ok: true,
          statusCategory: "OK_NO_ROWS",
          fieldCount: 0,
          schema: "UNKNOWN_NEEDS_LIVE_DATA",
        };
      }

      const fieldPaths = summarisePayloads(rows);
      return {
        ...base,
        ok: true,
        statusCategory: "OK",
        sampleCount: rows.length,
        fieldCount: fieldPaths.length,
        fieldPaths,
      };
    } catch (error) {
      return certificationFailure(base, error, {}, redactionValuesFor(adapter));
    }
  }

  /**
   * The Trackier conversions chain: exactly ONE request.
   *
   * It reuses production's own fetchConversions — same client, same X-Api-Key header, same path,
   * same report rate limiter, same conversions row extraction, same YYYY-MM-DD date handling —
   * with four bounds production does not set: singleChunk, so a window needing more than one date
   * chunk is refused before any request; singlePage, so the one chunk is never paged; retries
   * pinned to one attempt where production allows six; and the probe's own timeout.
   *
   * The window is the SERVICE's, computed from a frozen preset — never a caller's dates. A missing
   * or half-open window is refused before any request.
   *
   * Zero rows reports OK_NO_ROWS: the window held no conversion. It is not evidence of an
   * unsupported object or an account-state blocker.
   *
   * Only structure leaves this method: no conversion, order, click or campaign identifier, payout,
   * sale amount, subid, customer datum or URL can reach the result.
   */
  async certifyTrackierConversions({ adapter, key, probe, budgetLeft, sourceObject, window = null }) {
    const base = {
      network: key,
      sourceObject,
      endpointKey: probe.endpointKey,
      httpMethod: probe.method,
      sampleCount: 0,
      fieldPaths: [],
      windowPreset: window?.preset ?? null,
    };

    if (!window?.from || !window?.to) {
      return {
        ...base,
        ok: false,
        statusCategory: "SKIPPED_NO_WINDOW",
        fieldCount: 0,
        schema: "UNKNOWN_NEEDS_LIVE_DATA",
        note: "Conversions is a dated object and no bounded window was supplied, so no supplier request was made.",
      };
    }

    const timeoutMs = Math.max(1000, Math.min(SOURCE_BUDGET_MS, budgetLeft()));

    try {
      const rows = asRows(
        await adapter.fetchConversions(
          { startDate: window.from, endDate: window.to, ...TRACKIER_CERTIFICATION_CONVERSION_PARAMS },
          { singleChunk: true, singlePage: true, retries: 1, timeoutMs },
        ),
      ).slice(0, 1);

      if (!rows.length) {
        return {
          ...base,
          ok: true,
          statusCategory: "OK_NO_ROWS",
          fieldCount: 0,
          schema: "UNKNOWN_NEEDS_LIVE_DATA",
        };
      }

      const fieldPaths = summarisePayloads(rows);
      return {
        ...base,
        ok: true,
        statusCategory: "OK",
        sampleCount: rows.length,
        fieldCount: fieldPaths.length,
        fieldPaths,
      };
    } catch (error) {
      // The adapter refused before sending anything: the preset spans more date chunks than the
      // one request this probe is allowed. Not a supplier failure, so not classified as one.
      if (error?.code === TRACKIER_WINDOW_NOT_ONE_CHUNK) {
        return {
          ...base,
          ok: false,
          statusCategory: "SKIPPED_WINDOW_NOT_ONE_CHUNK",
          fieldCount: 0,
          schema: "UNKNOWN_NEEDS_LIVE_DATA",
          note: "The window preset spans more than one supplier date chunk, so no supplier request was made.",
        };
      }
      return certificationFailure(
        base,
        error,
        { windowPreset: window?.preset ?? null },
        redactionValuesFor(adapter),
      );
    }
  }

  /**
   * The Trackier reports-kpi chain: exactly ONE request, no parameters.
   *
   * It reuses production's own fetchReportsKpi — same client, same X-Api-Key header, same path,
   * same report rate limiter, same container lookup — with retries pinned to one attempt, the
   * probe's own timeout, and preserveShape so the container arrives as the supplier sent it.
   *
   * What is reported is the SHAPE, sampled to one entry and wrapped back under the supplier's own
   * envelope key, so the field dictionary reads exactly as the payload does:
   *   array of definition objects  -> schema KPI_DEFINITION_ARRAY, paths <key>[], <key>[].<field>
   *   array of names/values        -> schema KPI_VALUE_ARRAY,      paths <key>, <key>[]
   *   object map                   -> schema KPI_OBJECT_MAP,       paths <key>.*, <key>.*.<field>
   *                                   (* stands for one KPI-name key, which is data, not schema)
   *   scalar                       -> schema KPI_SCALAR,           path <key>
   *   none of the known keys       -> schema KPI_CONTAINER_NOT_RECOGNISED, top-level envelope
   *                                   paths only, so the real shape is learned and not hidden
   * Nothing is fabricated: no object is built around a string, no name is mapped to a metric.
   *
   * Zero entries reports OK_NO_ROWS. Only structure leaves this method: no KPI value, account
   * identifier or configured value can reach the result.
   */
  async certifyTrackierReportsKpi({ adapter, key, probe, budgetLeft, sourceObject }) {
    const base = {
      network: key,
      sourceObject,
      endpointKey: probe.endpointKey,
      httpMethod: probe.method,
      sampleCount: 0,
      fieldPaths: [],
    };
    const noRows = {
      ...base,
      ok: true,
      statusCategory: "OK_NO_ROWS",
      fieldCount: 0,
      schema: "UNKNOWN_NEEDS_LIVE_DATA",
    };
    const certified = (sample, schema, extra = {}) => {
      const fieldPaths = summarisePayloads([sample], extra.summarise ?? {});
      return {
        ...base,
        ok: true,
        statusCategory: "OK",
        sampleCount: 1,
        fieldCount: fieldPaths.length,
        fieldPaths,
        schema,
        ...(extra.note ? { note: extra.note } : {}),
      };
    };

    const timeoutMs = Math.max(1000, Math.min(SOURCE_BUDGET_MS, budgetLeft()));

    try {
      const { containerKey, container, envelope } = await adapter.fetchReportsKpi({
        retries: 1,
        timeoutMs,
        preserveShape: true,
      });

      if (containerKey === null) {
        // A known key holding null is "200 + empty", not an unrecognised envelope.
        const envelopeKeys =
          envelope && typeof envelope === "object" && !Array.isArray(envelope)
            ? Object.keys(envelope).filter((k) => envelope[k] !== null && envelope[k] !== undefined)
            : [];
        if (!envelopeKeys.length) return noRows;
        // A payload that is not empty but holds none of the keys production reads. Reported at
        // the top level only, so the real envelope is learned without walking into its values.
        return certified(envelope, "KPI_CONTAINER_NOT_RECOGNISED", {
          summarise: { maxDepth: 1 },
          note: "The payload holds none of the KPI container keys production reads, so production's fetcher would read zero KPIs from it. Top-level envelope paths are reported so the live shape can be learned.",
        });
      }

      if (Array.isArray(container)) {
        if (!container.length) return noRows;
        const first = container[0];
        const isDefinition = first !== null && typeof first === "object" && !Array.isArray(first);
        return certified(
          { [containerKey]: [first] },
          isDefinition ? "KPI_DEFINITION_ARRAY" : "KPI_VALUE_ARRAY",
        );
      }

      if (container && typeof container === "object") {
        const entries = Object.entries(container);
        if (!entries.length) return noRows;
        // The map's keys ARE the KPI names. One entry's value is sampled under a placeholder
        // segment so the entry's structure is reported and the name is not.
        const [, entryValue] = entries[0];
        return certified({ [containerKey]: { [KPI_MAP_KEY_PLACEHOLDER]: entryValue } }, "KPI_OBJECT_MAP", {
          note: "The KPI container is an object map, which production's fetcher reads as zero KPIs.",
        });
      }

      if (container === "" || container === undefined) return noRows;
      return certified({ [containerKey]: container }, "KPI_SCALAR", {
        note: "The KPI container is a scalar, which production's fetcher reads as zero KPIs.",
      });
    } catch (error) {
      return certificationFailure(base, error, {}, redactionValuesFor(adapter));
    }
  }

  /**
   * The Trackier reports chain: KPI discovery, then ONE reports request.
   *
   * Both requests reuse production's own fetchers — fetchReportsKpi with preserveShape, one
   * attempt, the probe's timeout; then fetchReports with singleChunk, singlePage, one attempt,
   * the probe's timeout, limit=1, page=1, and only KPI names the supplier itself listed. The
   * window is the SERVICE's, from a frozen preset — never a caller's dates.
   *
   * No KPI name in the metadata means no reports request: SKIPPED_NO_KPI_SCOPE. Zero report rows
   * is OK_NO_ROWS — the window held no activity under this grouping — never an unsupported or
   * account-state claim.
   *
   * Only structure leaves this method. The names selected are not reported (they are supplier
   * configuration); the field paths of the ONE sampled row are, because that row's shape is what
   * this probe exists to learn. No campaign name, count, amount, date or identifier can reach the
   * result.
   */
  async certifyTrackierReports({ adapter, key, probe, budgetLeft, sourceObject, window = null }) {
    const base = {
      network: key,
      sourceObject,
      endpointKey: probe.endpointKey,
      httpMethod: probe.method,
      sampleCount: 0,
      fieldPaths: [],
      windowPreset: window?.preset ?? null,
      kpiDiscoveryRequestCount: 0,
      reportsRequestCount: 0,
    };

    if (!window?.from || !window?.to) {
      return {
        ...base,
        ok: false,
        statusCategory: "SKIPPED_NO_WINDOW",
        fieldCount: 0,
        schema: "UNKNOWN_NEEDS_LIVE_DATA",
        note: "Reports is a dated object and no bounded window was supplied, so no supplier request was made.",
      };
    }

    const timeoutMs = Math.max(1000, Math.min(SOURCE_BUDGET_MS, budgetLeft()));
    const counts = { kpiDiscoveryRequestCount: 0, reportsRequestCount: 0 };

    try {
      counts.kpiDiscoveryRequestCount = 1;
      const { container } = await adapter.fetchReportsKpi({ retries: 1, timeoutMs, preserveShape: true });
      const kpis = selectTrackierCertificationKpis(container);

      if (!kpis.length) {
        return {
          ...base,
          ...counts,
          ok: false,
          statusCategory: "SKIPPED_NO_KPI_SCOPE",
          fieldCount: 0,
          schema: "UNKNOWN_NEEDS_LIVE_DATA",
          note: "The reports-kpi metadata listed no KPI name, so no reports request was made.",
        };
      }

      counts.reportsRequestCount = 1;
      const rows = asRows(
        await adapter.fetchReports(
          { startDate: window.from, endDate: window.to, kpis, ...TRACKIER_CERTIFICATION_REPORT_PARAMS },
          { singleChunk: true, singlePage: true, retries: 1, timeoutMs },
        ),
      ).slice(0, 1);

      if (!rows.length) {
        return {
          ...base,
          ...counts,
          ok: true,
          statusCategory: "OK_NO_ROWS",
          fieldCount: 0,
          schema: "UNKNOWN_NEEDS_LIVE_DATA",
        };
      }

      const fieldPaths = summarisePayloads(rows);
      return {
        ...base,
        ...counts,
        ok: true,
        statusCategory: "OK",
        sampleCount: rows.length,
        fieldCount: fieldPaths.length,
        fieldPaths,
        schema: "KNOWN_FROM_LIVE_SAMPLE",
      };
    } catch (error) {
      if (error?.code === TRACKIER_WINDOW_NOT_ONE_CHUNK) {
        return {
          ...base,
          ...counts,
          reportsRequestCount: 0,
          ok: false,
          statusCategory: "SKIPPED_WINDOW_NOT_ONE_CHUNK",
          fieldCount: 0,
          schema: "UNKNOWN_NEEDS_LIVE_DATA",
          note: "The window preset spans more than one supplier date chunk, so no reports request was made.",
        };
      }
      return certificationFailure(
        base,
        error,
        { windowPreset: window?.preset ?? null, ...counts },
        redactionValuesFor(adapter),
      );
    }
  }

  /**
   * The Boostiny campaigns chain: exactly ONE request.
   *
   * It reuses production's own fetchCampaigns — same shared HTTP client and Authorization header,
   * same resolved path, same shared rate limiter slot, same row extraction — with three bounds
   * production does not set: singlePage, so the pager cannot continue on hasNext, has_next,
   * totalPages or the full-page heuristic; retries pinned to one attempt where production allows
   * two (a 429 is reported, never retried); and the probe's own timeout. page=1 and limit=1 are
   * the parameters the pager already sends, at their smallest.
   *
   * Zero rows reports OK_NO_ROWS: the account lists no campaign on page 1. It is not evidence of
   * an unsupported object or an account-state blocker.
   *
   * Only structure leaves this method: no campaign, advertiser, URL, payout, currency or account
   * value can reach the result.
   */
  async certifyBoostinyCampaigns({ adapter, key, probe, budgetLeft, sourceObject }) {
    const base = {
      network: key,
      sourceObject,
      endpointKey: probe.endpointKey,
      httpMethod: probe.method,
      sampleCount: 0,
      fieldPaths: [],
    };

    const timeoutMs = Math.max(1000, Math.min(SOURCE_BUDGET_MS, budgetLeft()));

    try {
      const rows = asRows(
        await adapter.fetchCampaigns({ ...BOOSTINY_CERTIFICATION_CAMPAIGN_PARAMS }, null, {
          singlePage: true,
          retries: 1,
          timeoutMs,
        }),
      ).slice(0, 1);

      if (!rows.length) {
        return {
          ...base,
          ok: true,
          statusCategory: "OK_NO_ROWS",
          fieldCount: 0,
          schema: "UNKNOWN_NEEDS_LIVE_DATA",
        };
      }

      const fieldPaths = summarisePayloads(rows);
      return {
        ...base,
        ok: true,
        statusCategory: "OK",
        sampleCount: rows.length,
        fieldCount: fieldPaths.length,
        fieldPaths,
        schema: "KNOWN_FROM_LIVE_SAMPLE",
      };
    } catch (error) {
      return certificationFailure(base, error, {}, redactionValuesFor(adapter));
    }
  }

  /**
   * The Boostiny coupons chain: exactly ONE request to the dedicated coupons endpoint.
   *
   * It reuses production's own fetchCoupons through the same bounded pager seam the campaigns
   * chain uses — singlePage, one attempt, the probe's timeout, page=1 and limit=1 — on the same
   * shared client, Authorization header and rate limiter slot. It never reads a campaign row, so
   * the embedded campaign coupons[] can never be what this probe certifies.
   *
   * Zero rows reports OK_NO_ROWS: the account lists no coupon on page 1. It is not evidence of an
   * unsupported object or an account-state blocker. Only structure leaves this method: no code,
   * campaign, advertiser, account-manager, country, date or URL value can reach the result.
   */
  async certifyBoostinyCoupons({ adapter, key, probe, budgetLeft, sourceObject }) {
    const base = {
      network: key,
      sourceObject,
      endpointKey: probe.endpointKey,
      httpMethod: probe.method,
      sampleCount: 0,
      fieldPaths: [],
    };

    const timeoutMs = Math.max(1000, Math.min(SOURCE_BUDGET_MS, budgetLeft()));

    try {
      const rows = asRows(
        await adapter.fetchCoupons({ ...BOOSTINY_CERTIFICATION_COUPON_PARAMS }, null, {
          singlePage: true,
          retries: 1,
          timeoutMs,
        }),
      ).slice(0, 1);

      if (!rows.length) {
        return {
          ...base,
          ok: true,
          statusCategory: "OK_NO_ROWS",
          fieldCount: 0,
          schema: "UNKNOWN_NEEDS_LIVE_DATA",
        };
      }

      const fieldPaths = summarisePayloads(rows);
      return {
        ...base,
        ok: true,
        statusCategory: "OK",
        sampleCount: rows.length,
        fieldCount: fieldPaths.length,
        fieldPaths,
        schema: "KNOWN_FROM_LIVE_SAMPLE",
      };
    } catch (error) {
      return certificationFailure(base, error, {}, redactionValuesFor(adapter));
    }
  }

  /**
   * The Boostiny performance chain: exactly ONE request to the raw performance endpoint.
   *
   * It reuses production's own fetchPerformance — the same shared client, Authorization header,
   * rate limiter slot and row extraction, with the same from/to names production sends — through
   * the same bounded pager seam as campaigns and coupons: singlePage, one attempt, the probe's
   * timeout, page=1, limit=1. The window is the SERVICE's, from a frozen preset — never a
   * caller's dates. It never calls fetchPerformanceReport, so no summary is inspected and no
   * per-campaign fallback can fan out.
   *
   * Zero rows reports OK_NO_ROWS: the window held no performance under this account. It is not
   * evidence of an unsupported object or an account-state blocker. Only structure leaves this
   * method: no campaign, count, amount, id, subid or date value can reach the result.
   */
  async certifyBoostinyPerformance({ adapter, key, probe, budgetLeft, sourceObject, window = null }) {
    const base = {
      network: key,
      sourceObject,
      endpointKey: probe.endpointKey,
      httpMethod: probe.method,
      sampleCount: 0,
      fieldPaths: [],
      windowPreset: window?.preset ?? null,
    };

    if (!window?.from || !window?.to) {
      return {
        ...base,
        ok: false,
        statusCategory: "SKIPPED_NO_WINDOW",
        fieldCount: 0,
        schema: "UNKNOWN_NEEDS_LIVE_DATA",
        note: "Performance is a dated object and no bounded window was supplied, so no supplier request was made.",
      };
    }

    const timeoutMs = Math.max(1000, Math.min(SOURCE_BUDGET_MS, budgetLeft()));

    try {
      const rows = asRows(
        await adapter.fetchPerformance(
          { from: window.from, to: window.to, ...BOOSTINY_CERTIFICATION_PERFORMANCE_PARAMS },
          null,
          { singlePage: true, retries: 1, timeoutMs },
        ),
      ).slice(0, 1);

      if (!rows.length) {
        return {
          ...base,
          ok: true,
          statusCategory: "OK_NO_ROWS",
          fieldCount: 0,
          schema: "UNKNOWN_NEEDS_LIVE_DATA",
        };
      }

      const fieldPaths = summarisePayloads(rows);
      return {
        ...base,
        ok: true,
        statusCategory: "OK",
        sampleCount: rows.length,
        fieldCount: fieldPaths.length,
        fieldPaths,
        schema: "KNOWN_FROM_LIVE_SAMPLE",
      };
    } catch (error) {
      return certificationFailure(
        base,
        error,
        { windowPreset: window?.preset ?? null },
        redactionValuesFor(adapter),
      );
    }
  }

  /**
   * The Boostiny link-performance chain: exactly ONE request to the raw link-performance endpoint.
   *
   * It reuses production's own fetchLinkPerformance — the same shared client, Authorization
   * header, rate limiter slot and row extraction, with the same from/to names production sends —
   * through the same bounded pager seam as the other Boostiny probes: singlePage, one attempt,
   * the probe's timeout, page=1, limit=1. The window is the SERVICE's, from a frozen preset —
   * never a caller's dates. It never calls fetchAll, so no other resource is read alongside it.
   *
   * Zero rows reports OK_NO_ROWS: the window held no link performance under this account. It is
   * not evidence of an unsupported object or an account-state blocker. Only structure leaves this
   * method: no URL, link id, campaign, count, amount, date or subid value can reach the result.
   */
  async certifyBoostinyLinkPerformance({ adapter, key, probe, budgetLeft, sourceObject, window = null }) {
    const base = {
      network: key,
      sourceObject,
      endpointKey: probe.endpointKey,
      httpMethod: probe.method,
      sampleCount: 0,
      fieldPaths: [],
      windowPreset: window?.preset ?? null,
    };

    if (!window?.from || !window?.to) {
      return {
        ...base,
        ok: false,
        statusCategory: "SKIPPED_NO_WINDOW",
        fieldCount: 0,
        schema: "UNKNOWN_NEEDS_LIVE_DATA",
        note: "Link performance is a dated object and no bounded window was supplied, so no supplier request was made.",
      };
    }

    const timeoutMs = Math.max(1000, Math.min(SOURCE_BUDGET_MS, budgetLeft()));

    try {
      const rows = asRows(
        await adapter.fetchLinkPerformance(
          { from: window.from, to: window.to, ...BOOSTINY_CERTIFICATION_LINK_PERFORMANCE_PARAMS },
          null,
          { singlePage: true, retries: 1, timeoutMs },
        ),
      ).slice(0, 1);

      if (!rows.length) {
        return {
          ...base,
          ok: true,
          statusCategory: "OK_NO_ROWS",
          fieldCount: 0,
          schema: "UNKNOWN_NEEDS_LIVE_DATA",
        };
      }

      const fieldPaths = summarisePayloads(rows);
      return {
        ...base,
        ok: true,
        statusCategory: "OK",
        sampleCount: rows.length,
        fieldCount: fieldPaths.length,
        fieldPaths,
        schema: "KNOWN_FROM_LIVE_SAMPLE",
      };
    } catch (error) {
      return certificationFailure(
        base,
        error,
        { windowPreset: window?.preset ?? null },
        redactionValuesFor(adapter),
      );
    }
  }

  /**
   * Certifies one network.
   *
   * Probes run in sequence, not in parallel: a burst of concurrent calls against a supplier's API
   * is exactly the kind of traffic that gets an affiliate account rate-limited or flagged.
   */
  async certify(
    network,
    {
      sourceObjects = null,
      region = "sea",
      accountLabel = "default",
      compareRaw = false,
      windowPreset = DEFAULT_WINDOW_PRESET,
    } = {},
  ) {
    const key = String(network || "").toLowerCase();
    const probes = PROBE_REGISTRY[key];
    if (!probes) throw fail(`No certification probe is defined for network "${key}".`, 404);

    const requested = sourceObjects?.length ? sourceObjects : Object.keys(probes);
    const unknown = requested.filter((s) => !probes[s]);
    if (unknown.length) throw fail(`Unknown source objects for ${key}: ${unknown.join(", ")}`, 400);

    const adapter = await this[ADAPTER_BUILDERS[key]]({ region, accountLabel });
    // Dates are computed here, from a preset token. Nothing the caller sends is used as a date.
    const resolvedWindowPreset = Object.hasOwn(WINDOW_PRESETS, windowPreset)
      ? windowPreset
      : DEFAULT_WINDOW_PRESET;
    const windowDays = windowPresetDays(windowPreset);
    const ctx = {
      window: defaultDateWindow(windowDays),
      // Separate namespaces, separate fields. None is ever supplied by the caller.
      campaignDetailId: null,
      commissionGroupCampaignId: null,
      // Partnerize's publisher id comes from the adapter's own credentials, resolved at
      // construction. Certification never discovers it with a request.
      publisherId: adapter.publisherId ?? null,
    };
    const results = [];
    const runDeadline = Date.now() + RUN_BUDGET_MS;
    const budgetLeft = () => runDeadline - Date.now();

    // Campaign-scoped probes need an id. Take it from a campaigns sample rather than the caller,
    // so the probe cannot be pointed at an arbitrary campaign. This is the one permitted second
    // call in a source chain: sample a campaign, then read that campaign's dependent endpoint.
    // Optimise only: the campaign-scoped probes there derive their identifiers from a sampled
    // campaign row. Other networks resolve what they need without a bootstrap request, so this
    // is keyed on the identifiers themselves rather than on "this probe needs something".
    const CAMPAIGN_BOOTSTRAP_NEEDS = new Set(["campaignDetailId", "commissionGroupCampaignId"]);
    if (requested.some((s) => CAMPAIGN_BOOTSTRAP_NEEDS.has(probes[s]?.needs))) {
      try {
        const sample = await adapter.fetchCertificationSample("campaigns", ctx);
        const first = asRows(sample)[0] || {};
        ctx.campaignDetailId = campaignDetailIdOf(first);
        ctx.commissionGroupCampaignId = commissionGroupCampaignIdOf(first);
      } catch {
        ctx.campaignDetailId = null;
        ctx.commissionGroupCampaignId = null;
      }
    }

    // Memo for the one chain whose single response serves two source objects.
    let partnerizeCampaignRows = null;

    for (const sourceObject of requested) {
      const probe = probes[sourceObject];

      if (probe.unsupported) {
        results.push({
          network: key,
          sourceObject,
          endpointKey: probe.endpointKey,
          httpMethod: probe.method,
          ok: false,
          statusCategory: "UNSUPPORTED",
          note: probe.unsupported,
          sampleCount: 0,
          fieldPaths: [],
        });
        continue;
      }

      if (!READ_ONLY_METHODS.has(probe.method)) {
        // Unreachable with the current registry; it exists so adding a probe with a mutating
        // method fails closed instead of being dispatched.
        results.push({
          network: key,
          sourceObject,
          endpointKey: probe.endpointKey,
          httpMethod: probe.method,
          ok: false,
          statusCategory: "BLOCKED_NOT_READ_ONLY",
          sampleCount: 0,
          fieldPaths: [],
        });
        continue;
      }

      if (probe.needs && !ctx[probe.needs]) {
        // No dependent supplier call is made: the identifier this endpoint needs is absent from the
        // sampled row, and another namespace's identifier is not a substitute for it.
        results.push({
          network: key,
          sourceObject,
          endpointKey: probe.endpointKey,
          httpMethod: probe.method,
          ok: false,
          statusCategory: probe.skipCategory ?? "SKIPPED_NO_CAMPAIGN_SAMPLE",
          sampleCount: 0,
          fieldPaths: [],
        });
        continue;
      }

      if (probe.unsupportedForSampling) {
        // The reporting endpoints are POST aggregate queries with no row-limit parameter, so there
        // is no bounded single-row sample to take. Reported rather than run unbounded.
        results.push({
          network: key,
          sourceObject,
          endpointKey: probe.endpointKey,
          httpMethod: probe.method,
          ok: false,
          statusCategory: "NO_BOUNDED_SAMPLE",
          note: "This endpoint has no row-limit parameter, so certification cannot take a bounded sample without requesting a full aggregate.",
          sampleCount: 0,
          fieldPaths: [],
        });
        continue;
      }

      if (budgetLeft() <= 0) {
        results.push({
          network: key,
          sourceObject,
          endpointKey: probe.endpointKey,
          httpMethod: probe.method,
          ok: false,
          statusCategory: "RUN_BUDGET_EXHAUSTED",
          note: "The run budget was spent before this source object was reached; probe it in a smaller batch.",
          sampleCount: 0,
          fieldPaths: [],
        });
        continue;
      }

      if (probe.chain === "awinCampaigns") {
        results.push(await this.certifyAwinCampaigns({ adapter, key, probe, budgetLeft }));
        continue;
      }

      if (probe.chain === "awinConversions") {
        results.push(
          await this.certifyAwinConversions({
            adapter,
            key,
            probe,
            sourceObject,
            // The service's own window, computed from the frozen preset. Never a caller's dates.
            window: { ...ctx.window, preset: resolvedWindowPreset },
            budgetLeft,
          }),
        );
        continue;
      }

      if (probe.chain === "cjAdvertisers") {
        results.push(await this.certifyCjAdvertisers({ adapter, key, probe, budgetLeft }));
        continue;
      }

      if (probe.chain === "cjAvailableAdvertisers") {
        results.push(await this.certifyCjAvailableAdvertisers({ adapter, key, probe, budgetLeft }));
        continue;
      }

      if (probe.chain === "rakutenSample") {
        results.push(
          await this.certifyRakutenSample({
            adapter,
            key,
            probe,
            budgetLeft,
            sourceObject,
            // The service's own window, computed from the frozen preset. Never a caller's dates.
            window: { ...ctx.window, preset: resolvedWindowPreset },
          }),
        );
        continue;
      }

      if (probe.chain === "rakutenAdvancedReport") {
        results.push(
          await this.certifyRakutenAdvancedReport({
            adapter,
            key,
            probe,
            budgetLeft,
            sourceObject,
            // The service's own window, computed from the frozen preset. Never a caller's dates.
            window: { ...ctx.window, preset: resolvedWindowPreset },
          }),
        );
        continue;
      }

      if (probe.chain === "trackierConversions") {
        results.push(
          await this.certifyTrackierConversions({
            adapter,
            key,
            probe,
            budgetLeft,
            sourceObject,
            // The service's own window, computed from the frozen preset. Never a caller's dates.
            window: { ...ctx.window, preset: resolvedWindowPreset },
          }),
        );
        continue;
      }

      if (probe.chain === "trackierDeals") {
        results.push(
          await this.certifyTrackierDeals({ adapter, key, probe, budgetLeft, sourceObject }),
        );
        continue;
      }

      if (probe.chain === "trackierReportsKpi") {
        results.push(
          await this.certifyTrackierReportsKpi({ adapter, key, probe, budgetLeft, sourceObject }),
        );
        continue;
      }

      if (probe.chain === "boostinyCampaigns") {
        results.push(
          await this.certifyBoostinyCampaigns({ adapter, key, probe, budgetLeft, sourceObject }),
        );
        continue;
      }

      if (probe.chain === "boostinyCoupons") {
        results.push(
          await this.certifyBoostinyCoupons({ adapter, key, probe, budgetLeft, sourceObject }),
        );
        continue;
      }

      if (probe.chain === "boostinyLinkPerformance") {
        results.push(
          await this.certifyBoostinyLinkPerformance({
            adapter,
            key,
            probe,
            budgetLeft,
            sourceObject,
            // The service's own window, computed from the frozen preset. Never a caller's dates.
            window: { ...ctx.window, preset: resolvedWindowPreset },
          }),
        );
        continue;
      }

      if (probe.chain === "boostinyPerformance") {
        results.push(
          await this.certifyBoostinyPerformance({
            adapter,
            key,
            probe,
            budgetLeft,
            sourceObject,
            // The service's own window, computed from the frozen preset. Never a caller's dates.
            window: { ...ctx.window, preset: resolvedWindowPreset },
          }),
        );
        continue;
      }

      if (probe.chain === "trackierReports") {
        results.push(
          await this.certifyTrackierReports({
            adapter,
            key,
            probe,
            budgetLeft,
            sourceObject,
            // The service's own window, computed from the frozen preset. Never a caller's dates.
            window: { ...ctx.window, preset: resolvedWindowPreset },
          }),
        );
        continue;
      }

      if (probe.chain === "trackierCoupons") {
        results.push(
          await this.certifyTrackierCoupons({ adapter, key, probe, budgetLeft, sourceObject }),
        );
        continue;
      }

      if (probe.chain === "trackierCampaignDetail") {
        results.push(
          await this.certifyTrackierCampaignDetail({
            adapter,
            key,
            probe,
            budgetLeft,
            sourceObject,
          }),
        );
        continue;
      }

      if (probe.chain === "trackierCampaigns") {
        results.push(
          await this.certifyTrackierCampaigns({ adapter, key, probe, budgetLeft, sourceObject }),
        );
        continue;
      }

      if (probe.chain === "trackierProfile") {
        results.push(
          await this.certifyTrackierProfile({ adapter, key, probe, budgetLeft, sourceObject }),
        );
        continue;
      }

      if (probe.chain === "admitadSample") {
        results.push(
          await this.certifyAdmitadSample({
            adapter,
            key,
            probe,
            budgetLeft,
            sourceObject,
            // The service's own window, computed from the frozen preset. Never a caller's dates.
            window: { ...ctx.window, preset: resolvedWindowPreset },
          }),
        );
        continue;
      }

      if (probe.chain === "awinCommissionGroups") {
        results.push(await this.certifyAwinCommissionGroups({ adapter, key, probe, budgetLeft }));
        continue;
      }

      if (probe.chain === "awinCoupons") {
        results.push(await this.certifyAwinCoupons({ adapter, key, probe, budgetLeft }));
        continue;
      }

      if (probe.chain === "partnerizeCampaigns") {
        // One fetch, two rows. `campaigns` and `commission_structure` read the same response, so
        // requesting both must not request the campaign twice — the memo is what guarantees it.
        if (!partnerizeCampaignRows) {
          partnerizeCampaignRows = await this.certifyPartnerizeCampaigns({
            adapter,
            key,
            probes,
            budgetLeft,
          });
        }
        results.push(partnerizeCampaignRows[sourceObject]);
        continue;
      }

      if (probe.chain === "partnerizeConversions") {
        results.push(
          await this.certifyPartnerizeConversions({
            adapter,
            key,
            probe,
            // The service's own window, computed from the frozen preset. Never a caller's dates.
            window: { ...ctx.window, preset: resolvedWindowPreset },
            budgetLeft,
          }),
        );
        continue;
      }

      if (probe.chain === "partnerizePayments") {
        results.push(
          await this.certifyPartnerizePayments({
            adapter,
            key,
            probe,
            window: { ...ctx.window, preset: resolvedWindowPreset },
            budgetLeft,
          }),
        );
        continue;
      }

      if (probe.chain === "partnerizeVouchers") {
        results.push(await this.certifyPartnerizeVouchers({ adapter, key, probe, budgetLeft }));
        continue;
      }

      if (probe.chain === "commissionGroups") {
        results.push(await this.certifyCommissionGroups({ adapter, key, probe, budgetLeft }));
        continue;
      }

      if (probe.emits) {
        // The one dependent chain: at most two requests, the second derived from the first.
        for (const row of await this.certifyProductChain({ adapter, key, probe, compareRaw, budgetLeft })) {
          results.push(row);
        }
        continue;
      }

      try {
        // Exactly one bounded supplier request. Never a sync fetcher.
        const timeoutMs = Math.max(1000, Math.min(SOURCE_BUDGET_MS / 2, budgetLeft()));
        const rows = asRows(
          await adapter.fetchCertificationSample(sourceObject, { ...ctx, timeoutMs }),
        ).slice(0, 1);
        const fieldPaths = summarisePayloads(rows);
        const entry = {
          network: key,
          sourceObject,
          endpointKey: probe.endpointKey,
          httpMethod: probe.method,
          ok: true,
          statusCategory: "OK",
          sampleCount: rows.length,
          fieldCount: fieldPaths.length,
          fieldPaths,
        };
        if (compareRaw) {
          const rawPaths = await this.rawPathsFor({ networkSource: key, sourceObject }).catch(() => []);
          entry.rawComparison = comparePathSets(fieldPaths.map((f) => f.path), rawPaths);
        }
        results.push(entry);
      } catch (error) {
        results.push(
          certificationFailure(
            { network: key, sourceObject, endpointKey: probe.endpointKey, httpMethod: probe.method },
            error,
            { sampleCount: 0, fieldPaths: [] },
            redactionValuesFor(adapter),
          ),
        );
      }
    }

    return {
      network: key,
      region,
      accountLabel,
      // The preset token alone describes the lookback. The day count it resolves to is used to
      // compute the dates and stays internal; reporting both would be two names for one state.
      windowPreset: Object.hasOwn(WINDOW_PRESETS, windowPreset) ? windowPreset : DEFAULT_WINDOW_PRESET,
      probedAt: new Date().toISOString(),
      readOnly: true,
      results,
    };
  }
}
