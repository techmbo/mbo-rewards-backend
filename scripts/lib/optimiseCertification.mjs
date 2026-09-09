/**
 * Optimise live certification core (READ-ONLY).
 *
 * Pure helpers for `scripts/certify-optimise-live.mjs`. This module deliberately
 * imports NOTHING that can write: no prisma, no persistence service, no sync job.
 * Its only production imports are the pure supplier mappers, so real supplier
 * payloads are certified through the exact code path production uses.
 *
 * Nothing here mutates supplier data or derives commission values of its own:
 * every canonical value in the artifacts comes from the production mappers.
 */

import { requestWithRetry } from "../../src/core/httpClient.js";
import {
  mapOptimiseCampaign,
  mapOptimiseCampaignLifecycle,
  mapOptimisePublisherRelationship,
} from "../../src/modules/supplier/mappers/optimise.mapper.js";
import { normalizeCampaignStatus } from "../../src/modules/supplier/mappers/status.js";
import { mapOptimiseCommissionGroupCandidates } from "../../src/modules/commercial/optimiseCommissionGroup.mapper.js";

/** Hard cap on certified campaigns — a certification is a sample, never a crawl. */
export const MAX_CERTIFIED_CAMPAIGNS = 5;

export const FIELD_STATUS = Object.freeze([
  "LIVE_VERIFIED",
  "MAPPED_NOT_IN_SAMPLE",
  "NOT_AVAILABLE_FROM_ENDPOINT",
  "VERIFY_LIVE",
  "REVIEW_REQUIRED",
  "MAPPING_GAP",
]);

export const AUTHORITY_CLASS = Object.freeze([
  "RULE_DEFINITION",
  "DIRECTIONAL_EVENT",
  "NETWORK_ACTUAL",
  "SUMMARY_ONLY",
  "FINAL_PAYMENT_EVIDENCE",
  "SUPPORTING",
]);

export const CONCEPT_KINDS = Object.freeze([
  "identity",
  "campaign metadata",
  "relationship",
  "commission",
  "condition",
  "tracking",
  "capability",
  "finance",
  "other",
]);

export const REGIONS = Object.freeze(["sea", "mena", "uk"]);

/* ------------------------------------------------------------------ *
 * Sanitization
 * ------------------------------------------------------------------ */

/**
 * Keys whose VALUES are credentials/authorization material. Ordinary campaign
 * evidence (ids, names, statuses, countries, currencies, dates, URLs, commission
 * values, group ids/names, bands, conditions) is never in this list and is
 * preserved verbatim — sanitizing it would destroy the evidence we are here for.
 */
const CREDENTIAL_KEY = /^(apikey|api_key|apikeys|x-api-key|xapikey|authorization|auth|bearer|token|tokens|secrets|access_token|accesstoken|refresh_token|refreshtoken|id_token|idtoken|password|passwd|pwd|secret|client_secret|clientsecret|private_key|privatekey|signature|hmac|salt|credential|credentials|connection_string|connectionstring|database_url|databaseurl|dsn|cookie|set-cookie|session|sessionid|session_id)$/i;

/** Personally identifying values that a campaign endpoint should never return. */
const PII_KEY = /^(email|emailaddress|email_address|contactemail|phone|phonenumber|phone_number|mobile|msisdn|firstname|first_name|lastname|last_name|fullname|full_name|dateofbirth|date_of_birth|dob|ssn|nationalid|national_id|taxid|tax_id|iban|bic|swift|accountnumber|account_number|cardnumber|card_number|addressline1|address_line_1|streetaddress|street_address)$/i;

/** Values that carry embedded credentials regardless of their key name. */
const SECRET_VALUE = [
  /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/i, // scheme://user:password@host
  /^bearer\s+\S+/i,
  /^basic\s+[a-z0-9+/=]{8,}$/i,
];

export const REDACTED = "[REDACTED]";

function redactionReasonFor(key, value) {
  if (CREDENTIAL_KEY.test(String(key))) return "credential_key";
  if (PII_KEY.test(String(key))) return "pii_key";
  if (typeof value === "string" && SECRET_VALUE.some((re) => re.test(value))) return "secret_value_pattern";
  return null;
}

/**
 * Deep-copy `value`, replacing only credential/PII-shaped leaves with [REDACTED].
 * Every redaction is reported by path so a reviewer can see what was withheld and
 * a mapping gap can never hide behind sanitization.
 *
 * @returns {{ value: unknown, redactions: Array<{path: string, reason: string}> }}
 */
export function sanitizeDeep(value, { path = "$" } = {}) {
  const redactions = [];

  function walk(node, nodePath) {
    // Primitives are inspected too. A secret can sit in a bare array element
    // ({ tokens: ["Bearer real-secret"] }) or be the whole value passed in,
    // where there is no property key to judge it by.
    if (node === null || typeof node !== "object") {
      if (typeof node === "string" && SECRET_VALUE.some((re) => re.test(node))) {
        redactions.push({ path: nodePath, reason: "secret_value_pattern" });
        return REDACTED;
      }
      return node;
    }
    if (node instanceof Date) return node.toISOString();
    if (Array.isArray(node)) return node.map((item, index) => walk(item, `${nodePath}[${index}]`));

    const out = {};
    for (const [key, child] of Object.entries(node)) {
      const childPath = `${nodePath}.${key}`;
      const reason = redactionReasonFor(key, child);
      if (reason) {
        out[key] = REDACTED;
        redactions.push({ path: childPath, reason });
        continue;
      }
      out[key] = walk(child, childPath);
    }
    return out;
  }

  return { value: walk(value, path), redactions };
}

/**
 * Scrub a supplier error message before it is stored anywhere.
 *
 * Upstream messages routinely echo the failing request, which can carry the api
 * key in a query string or an Authorization header.
 */
export function sanitizeErrorMessage(message, { maxLength = 300 } = {}) {
  const text = (typeof message === "string" ? message : String(message ?? ""))
    .replace(/\b(apikey|api_key|access_token|token|password|secret|signature|auth)=[^&\s"']+/gi, "$1=[REDACTED]")
    .replace(/\bbearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bbasic\s+[A-Za-z0-9+/=]{8,}/gi, "Basic [REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+):[^/\s:@]+@/gi, "$1:[REDACTED]@");
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * The only shape a failed supplier request is ever recorded in. Deliberately a
 * whitelist: no error.config, no error.request, no headers, no response body —
 * all of which carry the Authorization header on an Axios error.
 */
export function safeRequestFailure(campaignId, error) {
  const status = error?.response?.status;
  const code = error?.code;
  return {
    campaignId: String(campaignId),
    httpStatus: typeof status === "number" ? status : null,
    code: typeof code === "string" ? sanitizeErrorMessage(code, { maxLength: 60 }) : null,
    message: sanitizeErrorMessage(error?.message ?? error),
  };
}

/* ------------------------------------------------------------------ *
 * Raw path reading
 * ------------------------------------------------------------------ */

/** Read a dotted path, supporting `a.b[0].c` and `a[].b` (first non-empty array item). */
export function readPath(root, path) {
  const segments = String(path)
    .replace(/\[(\d+)\]/g, ".$1")
    .replace(/\[\]/g, ".[]")
    .split(".")
    .filter((segment) => segment !== "");

  let current = root;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (segment === "[]") {
      if (!Array.isArray(current)) return undefined;
      current = current[0];
      continue;
    }
    current = current[segment];
  }
  return current;
}

export function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed !== "" && trimmed.toUpperCase() !== "UNKNOWN";
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true; // numbers (0 included) and booleans (false included) are real values
}

/** First candidate path actually present in the payload. */
export function readFirstPath(root, paths = []) {
  for (const path of paths) {
    const value = readPath(root, path);
    if (value !== undefined && value !== null && value !== "") {
      return { path, present: true, value };
    }
  }
  return { path: null, present: false, value: undefined };
}

/* ------------------------------------------------------------------ *
 * Status derivation
 * ------------------------------------------------------------------ */

/**
 * Decide a field's certification status from real evidence.
 *
 * Deliberate asymmetry: supplier data present but canonical value absent is a
 * MAPPING_GAP (we lost real data), while a canonical value with no matching raw
 * path is VERIFY_LIVE (we produced something we cannot trace to this sample).
 */
export function deriveStatus({ rawPresent, normalizedValue, notAvailable = false, reviewReason = null }) {
  if (notAvailable) return "NOT_AVAILABLE_FROM_ENDPOINT";
  if (reviewReason) return "REVIEW_REQUIRED";
  const normalized = hasValue(normalizedValue);
  if (rawPresent && normalized) return "LIVE_VERIFIED";
  if (rawPresent && !normalized) return "MAPPING_GAP";
  if (!rawPresent && normalized) return "VERIFY_LIVE";
  return "MAPPED_NOT_IN_SAMPLE";
}

export function assertStatusEnum(entries = []) {
  for (const entry of entries) {
    if (!FIELD_STATUS.includes(entry.status)) {
      throw new Error(`Invalid certification status "${entry.status}" for field "${entry.mboField}"`);
    }
    if (!AUTHORITY_CLASS.includes(entry.sourceAuthorityClass)) {
      throw new Error(
        `Invalid sourceAuthorityClass "${entry.sourceAuthorityClass}" for field "${entry.mboField}"`,
      );
    }
  }
  return entries;
}

/* ------------------------------------------------------------------ *
 * Field specifications
 * ------------------------------------------------------------------ */

/**
 * Candidate raw paths mirror what the production mappers actually read
 * (src/modules/supplier/mappers/optimise.mapper.js and shared.js). The runner
 * records the first path present in the real payload, so `rawSourcePath` is
 * observed evidence rather than documentation.
 */
export const CAMPAIGN_FIELD_SPECS = Object.freeze([
  // Identity
  { mboField: "supplier", rawPaths: [], normalizedKey: "supplier", authority: "SUPPORTING", constant: true,
    notes: "Constant for this adapter; not supplier-provided." },
  { mboField: "supplierCampaignId", rawPaths: ["id", "campaignId", "productId", "legacyId", "campaign_id"],
    normalizedKey: "supplierCampaignId", authority: "SUPPORTING" },
  { mboField: "supplierMerchantId", rawPaths: ["advertiserId", "advertiserID", "advertiser.id", "companyId", "merchantId"],
    normalizedKey: "supplierMerchantId", authority: "SUPPORTING",
    notes: "The canonical campaign carries no supplier merchant id; merchant linkage currently relies on merchantNameRaw." },
  // Campaign
  { mboField: "campaignName", rawPaths: ["campaignName", "name", "title"], normalizedKey: "campaignName", authority: "SUPPORTING" },
  { mboField: "merchantName", rawPaths: ["advertiserName", "companyName", "advertiser.name", "brandName", "merchant.name"],
    normalizedKey: "merchantNameRaw", authority: "SUPPORTING" },
  { mboField: "campaignDescription", rawPaths: ["description"], normalizedKey: "campaignDescription", authority: "SUPPORTING" },
  { mboField: "campaignStatus", rawPaths: ["status", "campaignStatus", "subStatus"], normalizedKey: "campaignStatus",
    authority: "SUPPORTING", evidenceResolver: "campaignStatus",
    notes: "Production prefers advertiserCampaignStatus over top-level status; the traced path mirrors that." },
  { mboField: "relationshipStatus", rawPaths: ["publishers[].campaignSubStatus", "publisherEligibility", "status"],
    normalizedKey: "participationStatus", authority: "SUPPORTING", evidenceResolver: "relationship",
    notes: "Traced to the evidenceSource the production relationship mapper reports." },
  { mboField: "isJoined", rawPaths: ["publishers[].campaignSubStatus", "publisherEligibility", "status"],
    normalizedKey: "isJoined", authority: "SUPPORTING", evidenceResolver: "relationship",
    notes: "Traced to the evidenceSource the production relationship mapper reports." },
  { mboField: "primaryCategory", rawPaths: ["vertical.primary", "vertical.name", "vertical", "category"],
    normalizedKey: "categoryName", authority: "SUPPORTING" },
  { mboField: "secondaryCategory", rawPaths: ["vertical.secondary", "subCategory", "categories"],
    normalizedKey: "secondaryCategory", authority: "SUPPORTING" },
  { mboField: "countries", rawPaths: ["markets", "countryCodes", "countries", "targetCountries", "country"],
    normalizedKey: "countryCodes", authority: "SUPPORTING" },
  { mboField: "currency", rawPaths: ["currencyCode", "payout.currency", "currency"], normalizedKey: "currencyCode", authority: "SUPPORTING" },
  { mboField: "startDate", rawPaths: ["startDate", "liveDate", "appliedDate", "dateCreated", "activationDate"],
    normalizedKey: "campaignStartDate", authority: "SUPPORTING" },
  { mboField: "endDate", rawPaths: ["endDate", "expiryDate", "cancelledDate"], normalizedKey: "campaignEndDate", authority: "SUPPORTING" },
  { mboField: "destinationUrl", rawPaths: ["deepLinkURL", "destinationUrl", "landingPage.websiteUrl", "website"],
    normalizedKey: "destinationUrl", authority: "SUPPORTING" },
  { mboField: "supplierTrackingUrl", rawPaths: ["trackingURL", "deepLinkTrackingURL", "baseTrackingUrl"],
    normalizedKey: "trackingUrl", authority: "SUPPORTING" },
  { mboField: "deepLinkingEnabled", rawPaths: ["deepLinkEnabled", "deeplinkEnabled", "deepLinkURL", "deepLinkTrackingURL"],
    normalizedKey: "deepLinkingEnabled", authority: "SUPPORTING" },
  { mboField: "terms", rawPaths: ["terms", "termsAndConditions", "conditions"],
    normalizedKey: "normalizedPayload.termsAndConditions", authority: "SUPPORTING" },
  { mboField: "couponCapability", rawPaths: ["hasVouchers", "voucherCount", "couponsAvailable", "hasCoupons"],
    normalizedKey: null, authority: "SUPPORTING",
    notes: "Coupons are a separate Optimise endpoint; absence here is expected, not a gap." },
  { mboField: "productCapability", rawPaths: ["productFeed", "hasProductFeed", "productFeedUrl", "feeds"],
    normalizedKey: null, authority: "SUPPORTING",
    notes: "Product feeds are a separate Optimise endpoint; absence here is expected, not a gap." },
  // Campaign-level commission summary — never rule truth.
  { mboField: "campaignCommissionSummary", rawPaths: ["commissionCost", "payout.value", "payout.amount", "commission"],
    normalizedKey: "defaultCommissionValue", authority: "SUMMARY_ONLY",
    notes: "Campaign-level summary. Must never overwrite detailed commission-group rules." },
]);

/** Detailed commission-group rules are the authoritative rule definition. */
export const COMMISSION_FIELD_SPECS = Object.freeze([
  { mboField: "sourceGroupId", rawPaths: ["id", "groupId", "commissionGroupId"], normalizedKey: "sourceGroupId", authority: "RULE_DEFINITION" },
  { mboField: "sourceGroupName", rawPaths: ["name", "groupName", "commissionGroupName"], normalizedKey: "sourceGroupName", authority: "RULE_DEFINITION" },
  { mboField: "sourceRuleId", rawPaths: ["id", "groupId", "commissionGroupId"], normalizedKey: "sourceRuleId", authority: "RULE_DEFINITION" },
  { mboField: "sourceRuleName", rawPaths: ["name", "groupName", "commissionGroupName"], normalizedKey: "sourceRuleName", authority: "RULE_DEFINITION" },
  { mboField: "commissionType", rawPaths: ["commission", "commissionValue", "value", "rate", "amount"], normalizedKey: "commissionType", authority: "RULE_DEFINITION" },
  { mboField: "supplierRuleType", rawPaths: ["type", "commissionType", "bandType"], normalizedKey: "supplierRuleType", authority: "RULE_DEFINITION" },
  { mboField: "ratePercent", rawPaths: ["commission", "commissionValue", "value", "rate", "percentage"], normalizedKey: "ratePercent", authority: "RULE_DEFINITION" },
  { mboField: "fixedAmount", rawPaths: ["commission", "commissionValue", "value", "amount", "fixed"], normalizedKey: "fixedAmount", authority: "RULE_DEFINITION" },
  { mboField: "currency", rawPaths: ["currency", "currencyCode", "currency_code"], normalizedKey: "currency", authority: "RULE_DEFINITION" },
  { mboField: "basis", rawPaths: ["basis", "commissionBasis", "payoutBasis", "commission"], normalizedKey: "basis", authority: "RULE_DEFINITION" },
  { mboField: "conditions", rawPaths: ["conditions", "condition", "rules"], normalizedKey: "conditions", authority: "RULE_DEFINITION" },
  { mboField: "countryConditions", rawPaths: ["countries", "country", "markets", "geo"], normalizedKey: "country", authority: "RULE_DEFINITION" },
  { mboField: "categoryProductConditions", rawPaths: ["categories", "category", "productCategories", "products"],
    normalizedKey: "categoryProductGoal", authority: "RULE_DEFINITION" },
  { mboField: "customerType", rawPaths: ["customerType", "customer_type", "newCustomer", "customerSegment"],
    normalizedKey: "customerType", authority: "RULE_DEFINITION" },
  { mboField: "couponOrTier", rawPaths: ["voucher", "coupon", "tier", "bands", "band"], normalizedKey: "couponOrTier", authority: "RULE_DEFINITION" },
  { mboField: "bands", rawPaths: ["bands", "band", "tiers", "commissionBands"], normalizedKey: "commissionModel", authority: "RULE_DEFINITION" },
  { mboField: "effectiveFrom", rawPaths: ["effectiveFrom", "startDate", "validFrom", "start_date"], normalizedKey: "effectiveFrom", authority: "RULE_DEFINITION" },
  { mboField: "effectiveUntil", rawPaths: ["effectiveUntil", "endDate", "validTo", "end_date"], normalizedKey: "effectiveUntil", authority: "RULE_DEFINITION" },
  { mboField: "lineage", rawPaths: [], normalizedKey: "rawRuleReference", authority: "RULE_DEFINITION", constant: true,
    notes: "Raw supplier evidence retained on every canonical rule." },
]);

/** Raw campaign keys the production mapper is known to consume. */
const KNOWN_CAMPAIGN_KEYS = new Set(
  CAMPAIGN_FIELD_SPECS.flatMap((spec) => spec.rawPaths.map((path) => String(path).split(/[.[]/)[0])).concat([
    "campaign", "payout", "payouts", "publishers", "advertiser", "merchant", "vertical",
    "landingPage", "commissionGroups", "commission_groups", "commissionGroup",
    "pendingCommission", "campaignLogo", "advertiserLogoLocation", "rejectedDate",
    "isEligible", "acceptingApplications", "start_date", "end_date", "currency_code",
  ]),
);

const CONCEPT_HINTS = [
  [/commission|payout|rate|cpa|cps|cpl|revshare|earning/i, "commission"],
  [/invoice|payment|balance|billing|finance|tax/i, "finance"],
  [/country|geo|market|region|locale|condition|eligib|restrict/i, "condition"],
  [/track|click|deeplink|url|link|pixel/i, "tracking"],
  [/voucher|coupon|feed|product|creative|banner|capab/i, "capability"],
  [/publisher|relationship|applic|join|approval|contract/i, "relationship"],
  [/^id$|identifier|_id$|Id$|guid|uuid/i, "identity"],
  [/name|title|desc|status|date|category|vertical|logo/i, "campaign metadata"],
];

function classifyConcept(key) {
  for (const [pattern, kind] of CONCEPT_HINTS) {
    if (pattern.test(key)) return kind;
  }
  return "other";
}

/**
 * Top-level raw keys the mapper does not consume. These are candidate MBO
 * standard extensions — the point of a live certification is to find concepts
 * our universal model does not yet carry.
 */
export function discoverNewConcepts(raw = {}, { knownKeys = KNOWN_CAMPAIGN_KEYS, scope = "campaign" } = {}) {
  const found = [];
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (knownKeys.has(key)) continue;
    // Redact by this key first: a top-level scalar has no parent key for the
    // deep sanitizer to judge it by.
    const ownReason = redactionReasonFor(key, value);
    const safeValue = ownReason ? REDACTED : sanitizeDeep(value).value;
    found.push({
      scope,
      supplierJsonPath: `$.${key}`,
      sanitizedSampleValue: summarizeValue(safeValue),
      currentMboResult: "not carried by current normalization",
      proposedMboConcept: null,
      conceptKind: classifyConcept(key),
      valueShape: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
    });
  }
  return found;
}

function summarizeValue(value, maxLength = 400) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
  if (typeof value !== "object") return value;
  const json = JSON.stringify(value);
  if (json === undefined) return null;
  return json.length > maxLength ? `${json.slice(0, maxLength)}…` : JSON.parse(json);
}

/* ------------------------------------------------------------------ *
 * Certification-only capped read path
 * ------------------------------------------------------------------ */

/**
 * Total attempts for the single GET /campaigns page, retries included.
 * requestWithRetry counts attempts (not extra tries), and only re-issues on
 * 429/500/502/503/504.
 */
export const CAMPAIGN_LIST_MAX_ATTEMPTS = 3;

/** Strictly date-shaped strings: YYYY-MM-DD or YYYY/MM/DD, with an optional time. */
const DATE_LIKE = /^\d{4}[-/]\d{2}[-/]\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Do two real supplier values disagree in a way a human must adjudicate?
 *
 * Formatting differences are not conflicts: strings are trimmed, whitespace
 * collapsed and case-folded, and two parseable dates naming the same instant
 * agree. Anything left is a genuine disagreement between two responses.
 */
export function materiallyDiffer(listValue, detailValue) {
  const listMissing = listValue === undefined || listValue === null || listValue === "";
  const detailMissing = detailValue === undefined || detailValue === null || detailValue === "";
  if (listMissing || detailMissing) return false;

  // Date.parse is dangerously lenient — it reads "LIST-1" as 2001-01-01 — so the
  // date comparison is gated on an actual date shape. Without this guard two
  // genuinely different identifiers would be declared equal.
  if (
    typeof listValue === "string" &&
    typeof detailValue === "string" &&
    DATE_LIKE.test(listValue.trim()) &&
    DATE_LIKE.test(detailValue.trim())
  ) {
    const listTime = Date.parse(listValue);
    const detailTime = Date.parse(detailValue);
    if (!Number.isNaN(listTime) && !Number.isNaN(detailTime)) return listTime !== detailTime;
  }

  const canonical = (value) => {
    if (typeof value === "string") return value.trim().replace(/\s+/g, " ").toLowerCase();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };

  return canonical(listValue) !== canonical(detailValue);
}

/** Campaign-list envelopes accepted by the certification reader. */
const CAMPAIGN_ARRAY_KEYS = ["response", "data", "results", "items", "campaigns"];

/**
 * Rows of a SINGLE GET /campaigns page.
 *
 * Production's fetchOffsetPaginated() keeps requesting pages until a short page
 * arrives, so it cannot express "one request only". This reader is the
 * certification-only equivalent for exactly one page. Like the production
 * commission-group reader, it fails closed: an unrecognised non-empty envelope
 * throws rather than silently reporting zero campaigns.
 */
export function extractCampaignRows(responseData) {
  if (responseData == null || responseData === "") return { rows: [], envelopeKind: "empty" };
  if (Array.isArray(responseData)) return { rows: responseData, envelopeKind: "array" };
  if (typeof responseData !== "object") {
    const error = new Error("Optimise campaigns response is not JSON");
    error.code = "optimise_campaigns_unrecognised_envelope";
    throw error;
  }

  const containers = [responseData, responseData.payload, responseData.data].filter(
    (value) => value && typeof value === "object" && !Array.isArray(value),
  );
  for (const container of containers) {
    for (const key of CAMPAIGN_ARRAY_KEYS) {
      if (Array.isArray(container[key])) {
        return {
          rows: container[key],
          envelopeKind: container === responseData ? key : `nested.${key}`,
        };
      }
    }
  }

  const single = responseData.data && typeof responseData.data === "object" ? responseData.data : responseData;
  const keys = Object.keys(single ?? {});
  if (!keys.length) return { rows: [], envelopeKind: "empty_object" };
  if (keys.includes("id") || keys.includes("campaignId") || keys.includes("productId")) {
    return { rows: [single], envelopeKind: "single_object" };
  }

  const error = new Error(
    `Optimise campaigns response envelope not recognised (keys: ${keys.slice(0, 8).join(", ")})`,
  );
  error.code = "optimise_campaigns_unrecognised_envelope";
  throw error;
}

/**
 * Exactly ONE outbound GET /campaigns, returning at most `limit` rows.
 *
 * Query semantics are identical to production fetchCampaigns (agencyId,
 * contactId, extendedData, returnPublishersForCampaign) with offset pinned to 0
 * and no pagination loop. Campaign NORMALIZATION is not duplicated: rows are fed
 * to the production mapOptimiseCampaign unchanged.
 */
export async function fetchCampaignListPage({
  httpClient,
  agencyId,
  contactId,
  limit = MAX_CERTIFIED_CAMPAIGNS,
  retries = CAMPAIGN_LIST_MAX_ATTEMPTS,
  delayMs = 750,
}) {
  const cappedLimit = Math.max(1, Math.min(Number(limit) || MAX_CERTIFIED_CAMPAIGNS, MAX_CERTIFIED_CAMPAIGNS));
  let attempts = 0;

  // The production retry helper wraps ONE request. It re-issues the same
  // offset=0 page on 429/5xx only; it never advances an offset, so this stays a
  // single logical page no matter how many attempts it takes.
  const response = await requestWithRetry(
    () => {
      attempts += 1;
      return httpClient.get("/campaigns", {
        params: {
          agencyId,
          contactId,
          extendedData: true,
          returnPublishersForCampaign: true,
          offset: 0,
          limit: cappedLimit,
        },
      });
    },
    { retries, delayMs },
  );

  const { rows, envelopeKind } = extractCampaignRows(response?.data);
  // Defensive: a supplier that ignores `limit` must not widen the sample.
  const capped = rows.slice(0, cappedLimit);
  return {
    rows: capped,
    envelopeKind,
    httpStatus: response?.status ?? null,
    rowsReturnedBySupplier: rows.length,
    truncatedBySupplierOverrun: rows.length > cappedLimit,
    requestedLimit: cappedLimit,
    attempts,
    maxAttempts: retries,
  };
}

/** Unwrap GET /campaigns/{id}, which may return the object bare or enveloped. */
export function extractCampaignDetail(responseData) {
  if (responseData == null || responseData === "") return null;
  if (Array.isArray(responseData)) return responseData[0] ?? null;
  if (typeof responseData !== "object") return null;
  for (const key of ["data", "response", "payload", "campaign"]) {
    const nested = responseData[key];
    if (Array.isArray(nested)) return nested[0] ?? null;
    if (nested && typeof nested === "object") return nested;
  }
  return responseData;
}

/**
 * Merge the two REAL supplier payloads for one campaign.
 *
 * Detail fills fields the list omits; list values win on conflict, because the
 * list response is what the production campaign sync actually stores. Nothing is
 * invented, and every disagreement between the two responses is recorded.
 */
export function mergeListAndDetail(listRaw = {}, detailRaw = null) {
  if (!detailRaw || typeof detailRaw !== "object") {
    return { merged: { ...listRaw }, detailOnlyKeys: [], conflicts: [] };
  }

  const conflicts = [];

  const isPlainObject = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);

  /**
   * Deep merge of two REAL supplier payloads.
   *
   * Detail fills leaves the list omits, at any depth; the list leaf wins when
   * both carry one, because the list response is what the production sync
   * stores. A shallow merge would drop detail-only nested leaves entirely —
   * list.landingPage = { id } would erase detail.landingPage.websiteUrl —
   * turning real evidence into a phantom mapping gap.
   *
   * Arrays are whole supplier values and are never element-merged: inventing a
   * row-by-row union would fabricate a payload the supplier never sent.
   */
  function mergeNode(listNode, detailNode, pathPrefix) {
    if (listNode === undefined) return detailNode;
    if (detailNode === undefined) return listNode;

    if (isPlainObject(listNode) && isPlainObject(detailNode)) {
      const out = { ...detailNode };
      for (const [key, listChild] of Object.entries(listNode)) {
        const childPath = pathPrefix ? `${pathPrefix}.${key}` : key;
        out[key] = key in detailNode ? mergeNode(listChild, detailNode[key], childPath) : listChild;
      }
      return out;
    }

    // Leaf (or array) present on both sides.
    if (materiallyDiffer(listNode, detailNode)) {
      conflicts.push({
        key: pathPrefix,
        listValue: summarizeValue(sanitizeDeep(listNode).value, 200),
        detailValue: summarizeValue(sanitizeDeep(detailNode).value, 200),
      });
    }
    return listNode;
  }

  const merged = mergeNode(listRaw ?? {}, detailRaw, "");
  const detailOnlyKeys = Object.keys(detailRaw).filter((key) => !(key in (listRaw ?? {})));

  return { merged, detailOnlyKeys, conflicts };
}

/**
 * Locate a field in list evidence first, then detail, reporting which response
 * carried it. A field present only in detail is real evidence, never
 * NOT_AVAILABLE_FROM_ENDPOINT.
 */
export function readFirstPathAcrossSources({ listRaw, detailRaw, paths = [] }) {
  const fromList = readFirstPath(listRaw ?? {}, paths);
  if (fromList.present) return { ...fromList, origin: "list", qualifiedPath: `list:$.${fromList.path}` };
  const fromDetail = readFirstPath(detailRaw ?? {}, paths);
  if (fromDetail.present) return { ...fromDetail, origin: "detail", qualifiedPath: `detail:$.${fromDetail.path}` };
  return { path: null, present: false, value: undefined, origin: null, qualifiedPath: null };
}

/* ------------------------------------------------------------------ *
 * Production-aligned evidence resolvers
 * ------------------------------------------------------------------ */

/** Advertiser-status paths production consults before top-level status. */
const ADVERTISER_STATUS_PATHS = ["advertiserCampaignStatus", "advertiser_campaign_status", "advertiserCampaignStatuses"];

/**
 * Ordered candidate paths for campaignStatus, mirroring
 * mapOptimiseCampaignLifecycle: an advertiser status wins only when it actually
 * normalizes to something. Otherwise production falls through to `status`, and
 * so must the traced evidence — certifying against a field production ignored
 * would assert a verification we never performed.
 */
export function campaignStatusEvidencePaths(source = {}) {
  for (const path of ADVERTISER_STATUS_PATHS) {
    const value = readPath(source, path);
    if (value === undefined || value === null || value === "") continue;
    if (normalizeCampaignStatus(value) !== "UNKNOWN") return [path];
  }
  return ["status", "campaignStatus", "subStatus"];
}

/**
 * The raw path the production relationship mapper actually used, taken from its
 * own evidenceSource ("optimise.publishers[].campaignSubStatus" and friends)
 * rather than guessed independently.
 */
export function relationshipEvidencePaths(source = {}) {
  const relationship = mapOptimisePublisherRelationship(source ?? {});
  const evidenceSource = relationship?.evidenceSource ?? null;
  if (!evidenceSource) return ["publishers[].campaignSubStatus", "publisherEligibility", "status"];
  const path = String(evidenceSource).replace(/^optimise\./, "");
  return [path];
}

/**
 * Semantic comparison of the two responses for one field, run through the
 * PRODUCTION mappers independently against each payload.
 *
 * Raw-path comparison alone misses a real disagreement expressed through
 * different fields: list `status: "live"` and detail
 * `advertiserCampaignStatus: "paused"` share no path, yet production reads them
 * as ACTIVE and PAUSED. It also avoids the opposite error — two different raw
 * spellings that mean the same thing are not a conflict.
 *
 * @returns {{ comparable: boolean, listSemantic: unknown, detailSemantic: unknown, differs: boolean }}
 */
export function semanticComparison(spec, listRaw, detailRaw) {
  const none = { comparable: false, listSemantic: null, detailSemantic: null, differs: false };
  if (!spec.evidenceResolver || !listRaw || !detailRaw) return none;

  if (spec.evidenceResolver === "campaignStatus") {
    const listSemantic = mapOptimiseCampaignLifecycle(listRaw, "UNKNOWN");
    const detailSemantic = mapOptimiseCampaignLifecycle(detailRaw, "UNKNOWN");
    if (listSemantic === "UNKNOWN" || detailSemantic === "UNKNOWN") return none;
    return { comparable: true, listSemantic, detailSemantic, differs: listSemantic !== detailSemantic };
  }

  if (spec.evidenceResolver === "relationship") {
    const listRelationship = mapOptimisePublisherRelationship(listRaw);
    const detailRelationship = mapOptimisePublisherRelationship(detailRaw);
    // "Sufficient evidence" is the mapper reporting a source it actually used.
    if (!listRelationship?.evidenceSource || !detailRelationship?.evidenceSource) return none;

    const useJoined = spec.mboField === "isJoined";
    const listSemantic = useJoined ? listRelationship.isJoined : listRelationship.participationStatus;
    const detailSemantic = useJoined ? detailRelationship.isJoined : detailRelationship.participationStatus;
    return {
      comparable: true,
      listSemantic,
      detailSemantic,
      differs:
        listRelationship.participationStatus !== detailRelationship.participationStatus ||
        listRelationship.isJoined !== detailRelationship.isJoined,
    };
  }

  return none;
}

/** Resolve a spec's candidate paths, honouring production precedence. */
export function evidencePathsForSpec(spec, source = {}) {
  if (spec.evidenceResolver === "campaignStatus") return campaignStatusEvidencePaths(source);
  if (spec.evidenceResolver === "relationship") return relationshipEvidencePaths(source);
  return spec.rawPaths;
}

/* ------------------------------------------------------------------ *
 * Production wrappers
 * ------------------------------------------------------------------ */

export function networkSourceFor(region) {
  return `optimise_${String(region).toLowerCase()}`;
}

/**
 * Minimal staged-entity wrapper around a REAL raw campaign payload, matching the
 * shape the production sync stores and the mapper expects. No supplier value is
 * altered: `rawData` is the untouched response object.
 */
export function campaignEntityFor({ region, accountLabel = "default", campaignId, raw }) {
  const networkSource = networkSourceFor(region);
  return {
    networkSource,
    externalId: `${accountLabel}:${networkSource}-campaign-${campaignId}`,
    rawData: raw,
  };
}

/* ------------------------------------------------------------------ *
 * Commission presentation (display semantics only)
 * ------------------------------------------------------------------ */

/**
 * Commission 1..N presentation derived for DISPLAY only.
 *
 * The average is a display string; it is never a financial input and never
 * collapses distinct rules. Mixed units yield MIXED with no average at all.
 */
export function commissionPresentation(rules = []) {
  const outcomes = rules.map((rule, index) => ({
    label: `Commission ${index + 1}`,
    commissionType: rule.commissionType,
    ratePercent: rule.ratePercent,
    fixedAmount: rule.fixedAmount,
    currency: rule.currency,
    basis: rule.basis,
    sourceGroupId: rule.sourceGroupId,
    sourceGroupName: rule.sourceGroupName,
    couponOrTier: rule.couponOrTier,
    explicitZero: rule.ratePercent === 0 || rule.fixedAmount === 0,
    mappingStatus: rule.mappingStatus,
  }));

  const average = averageCommissionDisplay(outcomes);

  return {
    outcomeCount: outcomes.length,
    outcomes,
    mixed: average.mixed,
    mixedReason: average.mixedReason,
    averageDisplay: average.display,
    averageValue: average.value,
    averageCurrency: average.currency,
    averageBasis: average.basis,
    averageIsDisplayOnly: true,
    averageUsableAsFinancialInput: false,
    distinctRulesPreserved: outcomes.length === rules.length,
  };
}

/** Basis token → display suffix. Tokens come from production payoutBasisFrom. */
const BASIS_DISPLAY_SUFFIX = Object.freeze({
  FIXED_PER_ORDER: "/order",
  FIXED_PER_ITEM: "/item",
  FIXED_AMOUNT: "",
});

function basisSuffix(basis) {
  return basis in BASIS_DISPLAY_SUFFIX ? BASIS_DISPLAY_SUFFIX[basis] : ` ${basis}`;
}

function round4(value) {
  return Number(Number(value).toFixed(4));
}

/**
 * Average commission for DISPLAY only — never a payout input.
 *
 * Percentage-only: arithmetic mean, explicit zero included.
 * Fixed-only: averaged only when every outcome shares ONE currency and ONE
 * basis, and the result keeps both. Anything else is MIXED, because averaging
 * across currencies or bases would invent a number that means nothing.
 */
export function averageCommissionDisplay(outcomes = []) {
  const mixedResult = (reason) => ({
    mixed: true,
    mixedReason: reason,
    display: "MIXED",
    value: null,
    currency: null,
    basis: null,
  });

  if (outcomes.length === 0) return mixedResult("no_outcomes");

  const kinds = new Set(outcomes.map((outcome) => outcome.commissionType));
  if (kinds.size > 1) return mixedResult("mixed_commission_types");
  const [kind] = [...kinds];

  if (kind === "PERCENTAGE") {
    const values = outcomes.map((outcome) => outcome.ratePercent);
    if (values.some((value) => typeof value !== "number")) return mixedResult("non_numeric_percentage");
    const mean = round4(values.reduce((sum, value) => sum + value, 0) / values.length);
    return {
      mixed: false,
      mixedReason: null,
      display: `${mean}%`,
      value: mean,
      currency: null,
      basis: "PERCENT_OF_SALE",
    };
  }

  if (kind === "FIXED") {
    const values = outcomes.map((outcome) => outcome.fixedAmount);
    if (values.some((value) => typeof value !== "number")) return mixedResult("non_numeric_fixed");

    const currencies = new Set(outcomes.map((outcome) => outcome.currency ?? null));
    if (currencies.size > 1) return mixedResult("mixed_currencies");
    const [currency] = [...currencies];
    if (!currency) return mixedResult("fixed_currency_missing");

    const bases = new Set(outcomes.map((outcome) => outcome.basis ?? null));
    if (bases.size > 1) return mixedResult("mixed_bases");
    const [basis] = [...bases];
    if (!basis || basis === "UNKNOWN") return mixedResult("fixed_basis_unknown");

    const mean = round4(values.reduce((sum, value) => sum + value, 0) / values.length);
    return {
      mixed: false,
      mixedReason: null,
      display: `${currency} ${mean}${basisSuffix(basis)}`,
      value: mean,
      currency,
      basis,
    };
  }

  return mixedResult("unsupported_commission_type");
}

/**
 * The raw evidence a canonical rule actually came from.
 *
 * One commission group fans out into several rules (one per band, and one per
 * distinct fact), so array position is NOT lineage — rules[1] is routinely
 * still group A. The production mapper records its own lineage on every rule,
 * so that is the primary source; a sourceGroupId lookup is the only fallback,
 * and the array index is never used as commercial lineage.
 */
export function outcomeEvidenceFor(rule, groups = []) {
  const lineage = rule?.rawRuleReference ?? null;
  let group = lineage?.group && typeof lineage.group === "object" ? lineage.group : null;
  let resolvedBy = group ? "rawRuleReference.group" : null;

  if (!group) {
    const id = rule?.sourceGroupId;
    group =
      (id != null &&
        groups.find(
          (candidate) =>
            String(candidate?.id ?? candidate?.groupId ?? candidate?.commissionGroupId ?? "") === String(id),
        )) ||
      null;
    resolvedBy = group ? "sourceGroupId_fallback" : "unresolved";
  }

  const band = lineage?.band && typeof lineage.band === "object" ? lineage.band : null;
  return {
    group: group ?? {},
    band,
    bandIndex: lineage?.bandIndex ?? null,
    sourcePath: rule?.sourcePath ?? null,
    resolvedBy,
  };
}

/* ------------------------------------------------------------------ *
 * Certification
 * ------------------------------------------------------------------ */

function certifyCampaignFields({ listRaw, detailRaw, merged, detailFetchFailed = false, normalized, region, accountLabel }) {
  return CAMPAIGN_FIELD_SPECS.map((spec) => {
    // Paths are resolved against the merged payload production actually mapped,
    // so the traced evidence is the field production used, not a lookalike.
    const paths = evidencePathsForSpec(spec, merged ?? listRaw ?? {});
    const hasPaths = paths.length > 0;

    // Each response is also read through its OWN precedence, so the recorded
    // list/detail evidence names the field production would have used for that
    // payload even when the two responses express the field differently.
    const listPaths = hasPaths ? evidencePathsForSpec(spec, listRaw ?? {}) : [];
    const detailPaths = hasPaths ? evidencePathsForSpec(spec, detailRaw ?? {}) : [];
    const fromList = listPaths.length ? readFirstPath(listRaw ?? {}, listPaths) : { path: null, present: false, value: undefined };
    const fromDetail = detailPaths.length ? readFirstPath(detailRaw ?? {}, detailPaths) : { path: null, present: false, value: undefined };

    // Semantic comparison is authoritative where production defines the meaning;
    // otherwise fall back to comparing the raw values themselves.
    const semantic = semanticComparison(spec, listRaw, detailRaw);
    const conflicted = semantic.comparable
      ? semantic.differs
      : fromList.present && fromDetail.present && materiallyDiffer(fromList.value, fromDetail.value);

    const mergedHit = hasPaths ? readFirstPath(merged ?? listRaw ?? {}, paths) : { path: null, present: false };
    const hit = fromList.present
      ? { ...fromList, origin: "list", qualifiedPath: `list:$.${fromList.path}` }
      : fromDetail.present
        ? { ...fromDetail, origin: "detail", qualifiedPath: `detail:$.${fromDetail.path}` }
        : mergedHit.present
          ? { ...mergedHit, origin: "merged", qualifiedPath: `merged:$.${mergedHit.path}` }
          : { path: null, present: false, value: undefined, origin: null, qualifiedPath: null };

    const normalizedValue = spec.normalizedKey ? readPath(normalized, spec.normalizedKey) ?? null : null;

    // Detail is a potential source for every campaign field we certify, so when
    // that request failed we cannot claim the endpoints do not carry the field.
    const detailUnknown = detailFetchFailed && !hit.present && hasPaths;

    let status;
    let statusReason = null;
    if (spec.constant) {
      status = hasValue(normalizedValue) ? "LIVE_VERIFIED" : "MAPPED_NOT_IN_SAMPLE";
    } else if (conflicted) {
      // Production precedence is untouched; the canonical value stands. The
      // certification verdict, not the mapping, is what changes.
      status = "REVIEW_REQUIRED";
      statusReason = "supplier_list_detail_conflict";
    } else if (detailUnknown) {
      status = "VERIFY_LIVE";
      statusReason = "campaign_detail_request_failed";
    } else if (spec.normalizedKey === null) {
      // Capability probes: evidence in EITHER response counts. Only absence from
      // both successfully queried responses means the endpoints do not carry it.
      status = hit.present ? "VERIFY_LIVE" : "NOT_AVAILABLE_FROM_ENDPOINT";
    } else {
      status = deriveStatus({ rawPresent: hit.present, normalizedValue });
    }

    return {
      mboField: spec.mboField,
      scope: "campaign",
      rawSourcePath: hit.path,
      rawSourceOrigin: hit.origin,
      qualifiedRawSourcePath: hit.qualifiedPath,
      rawValuePresent: hit.present,
      listSourcePath: fromList.present ? `list:$.${fromList.path}` : null,
      listValue: fromList.present ? summarizeValue(sanitizeDeep(fromList.value).value, 200) : null,
      detailSourcePath: fromDetail.present ? `detail:$.${fromDetail.path}` : null,
      detailValue: fromDetail.present ? summarizeValue(sanitizeDeep(fromDetail.value).value, 200) : null,
      listDetailConflict: conflicted,
      listSemanticValue: semantic.comparable ? semantic.listSemantic : null,
      detailSemanticValue: semantic.comparable ? semantic.detailSemantic : null,
      conflictKind: conflicted ? (semantic.comparable ? "semantic" : "raw_value") : null,
      normalizedValue: summarizeValue(sanitizeDeep(normalizedValue).value),
      status,
      statusReason,
      notes: spec.notes ?? null,
      sourceAuthorityClass: spec.authority,
      supplierAccountScope: { region, accountLabel },
    };
  });
}

/**
 * Which MBO fields each production review reason makes economically unsafe.
 *
 * The production mapper fails closed on purpose: when it records a reason, the
 * rule is NOT commercially verified, however cleanly the raw value parsed. A
 * bare `8.5` yields ratePercent 8.5 AND commission_unit_not_explicit — calling
 * that LIVE_VERIFIED would assert a certainty the mapper explicitly withheld.
 */
export const REVIEW_REASON_FIELDS = Object.freeze({
  commission_unit_not_explicit: ["commissionType", "supplierRuleType", "ratePercent", "fixedAmount", "basis"],
  payout_basis_unknown: ["basis"],
  fixed_payout_currency_missing: ["currency", "fixedAmount"],
  unverified_condition_dimension: ["conditions", "countryConditions", "categoryProductConditions", "customerType"],
  optimise_condition_semantics_not_verified_live: [
    "conditions",
    "countryConditions",
    "categoryProductConditions",
    "customerType",
  ],
  band_selection_semantics_not_verified_live: ["bands", "couponOrTier", "ratePercent", "fixedAmount"],
  band_identity_insufficient: ["bands", "couponOrTier"],
  supplier_group_id_missing: ["sourceGroupId", "sourceGroupName", "sourceRuleId", "sourceRuleName"],
  anonymous_group_identity_insufficient: ["sourceGroupId", "sourceRuleId"],
});

/** The first production review reason that makes this field unsafe to verify. */
export function reviewReasonForField(mboField, reviewReasons = []) {
  for (const reason of reviewReasons) {
    const fields = REVIEW_REASON_FIELDS[reason];
    if (fields && fields.includes(mboField)) return reason;
  }
  return null;
}

function certifyCommissionFields({ group, band, bandIndex, sourcePath, rule }) {
  return COMMISSION_FIELD_SPECS.map((spec) => {
    // A band-derived rule is certified against ITS band first. A rate that lives
    // in bands[n] is real supplier evidence, not something to defer to a live check.
    const fromBand = band && spec.rawPaths.length ? readFirstPath(band, spec.rawPaths) : { path: null, present: false };
    const fromGroup = spec.rawPaths.length ? readFirstPath(group, spec.rawPaths) : { path: null, present: false };

    const hit = fromBand.present
      ? { ...fromBand, origin: "band" }
      : fromGroup.present
        ? { ...fromGroup, origin: "group" }
        : { path: null, present: false, origin: null };

    const qualifiedPath = hit.present
      ? hit.origin === "band"
        ? `${sourcePath ?? "commission-groups[?]"}.${hit.path}`
        : `${(sourcePath ?? "commission-groups[?]").replace(/\.bands\[\d+\]$/, "")}.${hit.path}`
      : null;

    const normalizedValue = spec.normalizedKey ? readPath(rule, spec.normalizedKey) ?? null : null;
    const reviewReasons = rule?.metadata?.reviewReasons ?? [];

    // The production mapper already fails closed on ambiguous economics; mirror
    // that verdict rather than inventing a friendlier one.
    const reviewReason = reviewReasonForField(spec.mboField, reviewReasons);

    let status;
    if (spec.constant) {
      status = hasValue(normalizedValue) ? "LIVE_VERIFIED" : "MAPPING_GAP";
    } else {
      status = deriveStatus({ rawPresent: hit.present, normalizedValue, reviewReason });
    }

    return {
      mboField: spec.mboField,
      scope: "commission",
      rawSourcePath: hit.path,
      rawSourceOrigin: hit.origin,
      qualifiedRawSourcePath: qualifiedPath,
      rawValuePresent: hit.present,
      normalizedValue: summarizeValue(sanitizeDeep(normalizedValue).value),
      status,
      statusReason: reviewReason,
      notes: spec.notes ?? (reviewReason ? `Production mapper review reason: ${reviewReason}` : null),
      sourceAuthorityClass: spec.authority,
      outcomeKey: rule?.outcomeKey ?? null,
      sourceGroupId: rule?.sourceGroupId ?? null,
      bandIndex: bandIndex ?? null,
      lineageSourcePath: sourcePath ?? null,
    };
  });
}

function mappingGapsFrom(entries, { raw, scope }) {
  return entries
    .filter((entry) => entry.status === "MAPPING_GAP")
    .map((entry) => ({
      supplierJsonPath: entry.qualifiedRawSourcePath ?? (entry.rawSourcePath ? `$.${entry.rawSourcePath}` : null),
      sourceResponse: entry.rawSourceOrigin ?? scope,
      sanitizedSampleValue: entry.rawSourcePath ? summarizeValue(sanitizeDeep(readPath(raw, entry.rawSourcePath)).value) : null,
      currentMboResult: entry.normalizedValue,
      proposedMboStandardField: entry.mboField,
      conceptKind: classifyConcept(entry.mboField),
      scope,
      whyRealGap: "Supplier returned a usable value on this path but the production normalization produced no canonical value.",
      proposedMinimalCorrection: `Review the ${scope} mapper for "${entry.mboField}"; do not change production mapping until this gap is accepted.`,
    }));
}

/**
 * Run a read-only certification against a live (or injected) Optimise adapter.
 *
 * Only adapter GET methods are used: fetchCampaigns and fetchCommissionGroups.
 * Nothing is persisted; this function has no database access of any kind.
 */
export async function runCertification({
  httpClient,
  adapter,
  region,
  accountLabel = "default",
  scope = "joined",
  maxCampaigns = MAX_CERTIFIED_CAMPAIGNS,
  selectCampaigns,
  now = () => new Date(),
  listRetryDelayMs = 750,
}) {
  if (!httpClient || typeof httpClient.get !== "function") {
    throw new Error("runCertification requires an httpClient exposing get()");
  }
  if (!adapter || typeof adapter.fetchCampaignDetail !== "function" || typeof adapter.fetchCommissionGroups !== "function") {
    throw new Error("runCertification requires an adapter exposing fetchCampaignDetail and fetchCommissionGroups");
  }
  const cap = Math.max(1, Math.min(Number(maxCampaigns) || MAX_CERTIFIED_CAMPAIGNS, MAX_CERTIFIED_CAMPAIGNS));
  const networkSource = networkSourceFor(region);
  const startedAt = now();

  // Exactly one outbound GET /campaigns. No pagination loop exists on this path.
  const page = await fetchCampaignListPage({
    httpClient,
    agencyId: adapter.agencyId ?? undefined,
    contactId: adapter.contactId ?? undefined,
    limit: cap,
    delayMs: listRetryDelayMs,
  });
  const rows = page.rows;

  let selection = selectCampaigns(rows, { scope, maxCampaigns: cap });
  let effectiveScope = scope;
  if (selection.campaigns.length === 0 && scope === "joined") {
    selection = selectCampaigns(rows, { scope: "all", maxCampaigns: cap });
    effectiveScope = "all-fallback";
  }
  const selected = selection.campaigns.slice(0, cap);

  const campaignsRaw = [];
  const campaignDetailsRaw = [];
  const campaignsNormalized = [];
  const groupsRaw = [];
  const rulesNormalized = [];
  const fieldEntries = [];
  const mappingGaps = [];
  const newConcepts = [];
  const detailRequestFailures = [];
  const commissionRequestFailures = [];
  const ruleLineage = [];
  const sourceConflicts = [];
  const redactions = [];
  const endpointsCalled = ["GET /campaigns (single page, offset=0)"];

  const rowById = new Map();
  for (const row of rows) {
    const id = row?.id ?? row?.campaignId ?? row?.productId ?? row?.legacyId ?? row?.campaign_id;
    if (id !== undefined && id !== null) rowById.set(String(id), row);
  }

  for (const { campaignId, currency } of selected) {
    const listRaw = rowById.get(String(campaignId)) ?? {};
    const sanitizedList = sanitizeDeep(listRaw, { path: `$.campaigns.${campaignId}` });
    redactions.push(...sanitizedList.redactions);
    campaignsRaw.push({ campaignId, raw: sanitizedList.value });

    // GET /campaigns/{id} — read-only detail evidence.
    let detailRaw = null;
    try {
      endpointsCalled.push(`GET /campaigns/${campaignId}`);
      // eslint-disable-next-line no-await-in-loop
      const detailResponse = await adapter.fetchCampaignDetail(campaignId);
      detailRaw = extractCampaignDetail(detailResponse);
    } catch (error) {
      detailRequestFailures.push(safeRequestFailure(campaignId, error));
    }

    const sanitizedDetail = sanitizeDeep(detailRaw, { path: `$.campaignDetails.${campaignId}` });
    redactions.push(...sanitizedDetail.redactions);
    campaignDetailsRaw.push({
      campaignId,
      fetched: detailRaw !== null,
      raw: sanitizedDetail.value,
    });

    const { merged, detailOnlyKeys, conflicts } = mergeListAndDetail(listRaw, detailRaw);
    if (conflicts.length) sourceConflicts.push({ campaignId, conflicts });

    const entity = campaignEntityFor({ region, accountLabel, campaignId, raw: merged });
    const normalized = mapOptimiseCampaign(entity);
    const sanitizedNormalized = sanitizeDeep(normalized, { path: `$.normalized.${campaignId}` });
    redactions.push(...sanitizedNormalized.redactions);
    campaignsNormalized.push({
      campaignId,
      detailOnlyKeys,
      // Written whole: truncating evidence to a summary string would defeat the
      // purpose of a certification artifact.
      normalized: sanitizedNormalized.value,
    });

    const detailFetchFailed = detailRequestFailures.some((entry) => String(entry.campaignId) === String(campaignId));
    const campaignEntries = certifyCampaignFields({
      listRaw,
      detailRaw,
      merged,
      detailFetchFailed,
      normalized,
      region,
      accountLabel,
    });
    fieldEntries.push(...campaignEntries.map((entry) => ({ ...entry, campaignId })));
    mappingGaps.push(
      ...campaignEntries
        .filter((entry) => entry.status === "MAPPING_GAP")
        .map((entry) => {
          const source = entry.rawSourceOrigin === "detail" ? detailRaw : listRaw;
          return {
            supplierJsonPath: entry.qualifiedRawSourcePath,
            sourceResponse: entry.rawSourceOrigin,
            sanitizedSampleValue: entry.rawSourcePath
              ? summarizeValue(sanitizeDeep(readPath(source ?? {}, entry.rawSourcePath)).value)
              : null,
            currentMboResult: entry.normalizedValue,
            proposedMboStandardField: entry.mboField,
            conceptKind: classifyConcept(entry.mboField),
            scope: "campaign",
            campaignId,
            whyRealGap:
              "Supplier returned a usable value on this path but the production normalization produced no canonical value.",
            proposedMinimalCorrection: `Review the campaign mapper for "${entry.mboField}"; do not change production mapping until this gap is accepted.`,
          };
        }),
    );

    newConcepts.push(...discoverNewConcepts(listRaw, { scope: "campaign-list" }).map((c) => ({ ...c, campaignId })));
    if (detailRaw) {
      newConcepts.push(...discoverNewConcepts(detailRaw, { scope: "campaign-detail" }).map((c) => ({ ...c, campaignId })));
    }

    let result;
    try {
      endpointsCalled.push(`GET /campaigns/${campaignId}/commission-groups`);
      // eslint-disable-next-line no-await-in-loop
      result = await adapter.fetchCommissionGroups(campaignId);
    } catch (error) {
      commissionRequestFailures.push(safeRequestFailure(campaignId, error));
      continue;
    }

    const groups = Array.isArray(result?.groups) ? result.groups : [];
    const sanitizedGroups = sanitizeDeep(groups, { path: `$.commissionGroups.${campaignId}` });
    redactions.push(...sanitizedGroups.redactions);
    groupsRaw.push({
      campaignId,
      envelopeKind: result?.envelopeKind ?? null,
      httpStatus: result?.httpStatus ?? null,
      groupCount: groups.length,
      groups: sanitizedGroups.value,
    });

    const rules = mapOptimiseCommissionGroupCandidates(groups, {
      sourceCampaignId: String(campaignId),
      networkSource,
      sourceAccountLabel: accountLabel,
      currency: currency ?? null,
      fetchedAt: result?.fetchedAt ?? null,
    });

    const sanitizedRules = sanitizeDeep(rules, { path: `$.rules.${campaignId}` });
    redactions.push(...sanitizedRules.redactions);
    rulesNormalized.push({
      campaignId,
      ruleCount: rules.length,
      rules: sanitizedRules.value,
      presentation: commissionPresentation(rules),
    });

    rules.forEach((rule) => {
      const evidence = outcomeEvidenceFor(rule, groups);
      const entries = certifyCommissionFields({
        group: evidence.group,
        band: evidence.band,
        bandIndex: evidence.bandIndex,
        sourcePath: evidence.sourcePath,
        rule,
      });
      ruleLineage.push({
        campaignId,
        outcomeKey: rule.outcomeKey,
        sourceGroupId: rule.sourceGroupId,
        sourceGroupName: rule.sourceGroupName,
        bandIndex: evidence.bandIndex,
        sourcePath: evidence.sourcePath,
        resolvedBy: evidence.resolvedBy,
      });
      fieldEntries.push(...entries.map((entry) => ({ ...entry, campaignId })));
      mappingGaps.push(
        ...entries
          .filter((entry) => entry.status === "MAPPING_GAP")
          .map((entry) => ({
            supplierJsonPath: entry.qualifiedRawSourcePath,
            sourceResponse: entry.rawSourceOrigin,
            sanitizedSampleValue: entry.rawSourcePath
              ? summarizeValue(
                  sanitizeDeep(readPath(entry.rawSourceOrigin === "band" ? evidence.band ?? {} : evidence.group, entry.rawSourcePath)).value,
                )
              : null,
            currentMboResult: entry.normalizedValue,
            proposedMboStandardField: entry.mboField,
            conceptKind: classifyConcept(entry.mboField),
            scope: "commission",
            campaignId,
            whyRealGap:
              "Supplier returned a usable value on this path but the production normalization produced no canonical value.",
            proposedMinimalCorrection: `Review the commission mapper for "${entry.mboField}"; do not change production mapping until this gap is accepted.`,
          })),
      );
    });

    groups.forEach((group, index) => {
      newConcepts.push(
        ...discoverNewConcepts(group, {
          scope: "commission-group",
          knownKeys: new Set([
            "id", "groupId", "commissionGroupId", "name", "groupName", "commissionGroupName",
            "commission", "commissionValue", "value", "rate", "amount", "currency", "currencyCode",
            "bands", "band", "tiers", "bandType", "conditions", "condition", "rules",
            "effectiveFrom", "effectiveUntil", "startDate", "endDate", "type", "commissionType",
          ]),
        }).map((concept) => ({ ...concept, campaignId, groupIndex: index })),
      );
    });
  }

  assertStatusEnum(fieldEntries);

  const statusCounts = Object.fromEntries(FIELD_STATUS.map((status) => [status, 0]));
  for (const entry of fieldEntries) statusCounts[entry.status] += 1;

  return {
    meta: {
      supplier: "OPTIMISE",
      region,
      accountLabel,
      networkSource,
      requestedScope: scope,
      effectiveScope,
      maxCampaigns: cap,
      startedAt: startedAt.toISOString(),
      finishedAt: now().toISOString(),
      endpointsCalled,
      // Pages are logical; requests are what actually left the machine. A page
      // retried twice is still one page but three outbound requests.
      campaignListPages: 1,
      campaignListRequests: page.attempts,
      campaignListPage: {
        requestedLimit: page.requestedLimit,
        rowsReturnedBySupplier: page.rowsReturnedBySupplier,
        rowsUsed: rows.length,
        truncatedBySupplierOverrun: page.truncatedBySupplierOverrun,
        envelopeKind: page.envelopeKind,
        httpStatus: page.httpStatus,
        attempts: page.attempts,
        maxAttempts: page.maxAttempts,
        paginationDisabled: true,
        note: "Exactly one GET /campaigns page is requested. Campaigns beyond this page are never fetched, so scope=joined selects only from these rows.",
      },
      campaignsCertified: campaignsRaw.length,
      campaignDetailsFetched: campaignDetailsRaw.filter((entry) => entry.fetched).length,
      campaignSelection: {
        campaignsInspected: selection.campaignsInspected,
        skippedNoId: selection.skippedNoId,
        skippedByScope: selection.skippedByScope,
        skippedDuplicate: selection.skippedDuplicate,
        skippedByCap: selection.skippedByCap,
      },
      commissionGroupsFetched: groupsRaw.reduce((sum, entry) => sum + entry.groupCount, 0),
      normalizedRuleCount: rulesNormalized.reduce((sum, entry) => sum + entry.ruleCount, 0),
      detailRequestFailures,
      commissionRequestFailures,
      listDetailConflicts: sourceConflicts,
      redactionCount: redactions.length,
      writesPerformed: 0,
      supplierMutations: 0,
    },
    campaignsRaw,
    campaignDetailsRaw,
    campaignsNormalized,
    groupsRaw,
    rulesNormalized,
    fieldReport: {
      statusCounts,
      authorityRule: {
        "GET /campaigns/{campaignId}/commission-groups": "RULE_DEFINITION",
        "campaign-level commissionCost / payout summary": "SUMMARY_ONLY",
        note: "Campaign-level summary commission never overwrites detailed commission-group truth.",
      },
      fields: fieldEntries,
      ruleLineage,
      fieldConflicts: fieldEntries
        .filter((entry) => entry.listDetailConflict)
        .map((entry) => ({
          campaignId: entry.campaignId,
          mboField: entry.mboField,
          listSourcePath: entry.listSourcePath,
          listValue: entry.listValue,
          detailSourcePath: entry.detailSourcePath,
          detailValue: entry.detailValue,
          listSemanticValue: entry.listSemanticValue,
          detailSemanticValue: entry.detailSemanticValue,
          conflictKind: entry.conflictKind,
          normalizedValue: entry.normalizedValue,
          status: entry.status,
          reason: entry.statusReason,
        })),
      mappingGaps,
      reviewRequired: fieldEntries.filter((entry) => entry.status === "REVIEW_REQUIRED"),
      newSupplierConcepts: newConcepts,
      listDetailConflicts: sourceConflicts,
      redactions,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Summary rendering
 * ------------------------------------------------------------------ */

export function renderSummaryMarkdown(report) {
  const { meta, fieldReport, rulesNormalized } = report;
  const counts = fieldReport.statusCounts;
  const lines = [];

  lines.push(`# Optimise live certification — ${meta.region.toUpperCase()} / ${meta.accountLabel}`);
  lines.push("");
  lines.push(`- Started: ${meta.startedAt}`);
  lines.push(`- Finished: ${meta.finishedAt}`);
  lines.push(`- Network source: ${meta.networkSource}`);
  lines.push(`- Scope requested: ${meta.requestedScope} (effective: ${meta.effectiveScope})`);
  lines.push(`- Campaign-list pages: ${meta.campaignListPages} (pagination disabled)`);
  lines.push(`- Outbound GET /campaigns requests, retries included: ${meta.campaignListRequests}`);
  lines.push(`- Campaign rows returned by that page: ${meta.campaignListPage.rowsReturnedBySupplier} (limit ${meta.campaignListPage.requestedLimit})`);
  lines.push(`- Campaigns certified: ${meta.campaignsCertified} (cap ${meta.maxCampaigns})`);
  lines.push(`- Campaign detail responses fetched: ${meta.campaignDetailsFetched} (failures: ${meta.detailRequestFailures.length})`);
  lines.push(`- Campaign list attempts used: ${meta.campaignListPage.attempts} of a maximum ${meta.campaignListPage.maxAttempts}`);
  lines.push(`- Commission groups fetched: ${meta.commissionGroupsFetched}`);
  lines.push(`- Normalized SupplierCommissionRule records: ${meta.normalizedRuleCount}`);
  lines.push(`- Database writes: ${meta.writesPerformed} · Supplier mutations: ${meta.supplierMutations}`);
  lines.push(`- Values redacted: ${meta.redactionCount}`);
  lines.push("");
  lines.push("## Endpoints called");
  lines.push("");
  for (const endpoint of meta.endpointsCalled) lines.push(`- \`${endpoint}\``);
  lines.push("");
  lines.push("## Field certification counts");
  lines.push("");
  lines.push("| Status | Count |");
  lines.push("| --- | ---: |");
  for (const status of FIELD_STATUS) lines.push(`| ${status} | ${counts[status]} |`);
  lines.push("");

  lines.push("## Mapping gaps");
  lines.push("");
  if (fieldReport.mappingGaps.length === 0) {
    lines.push("None detected in this sample.");
  } else {
    lines.push("Not fixed in this run, by design. Each needs review before production mapping changes.");
    lines.push("");
    for (const gap of fieldReport.mappingGaps) {
      lines.push(`- **${gap.proposedMboStandardField}** (${gap.conceptKind}, ${gap.scope}) — supplier path \`${gap.supplierJsonPath}\`, current MBO result: \`${JSON.stringify(gap.currentMboResult)}\``);
    }
  }
  lines.push("");

  lines.push("## New supplier concepts");
  lines.push("");
  if (fieldReport.newSupplierConcepts.length === 0) {
    lines.push("No unrecognized supplier fields in this sample.");
  } else {
    lines.push("Fields the current MBO standard does not carry. Review for possible standard extension.");
    lines.push("");
    for (const concept of fieldReport.newSupplierConcepts) {
      lines.push(`- \`${concept.supplierJsonPath}\` (${concept.conceptKind}, ${concept.valueShape}, ${concept.scope})`);
    }
  }
  lines.push("");

  lines.push("## List vs detail disagreements");
  lines.push("");
  if (fieldReport.fieldConflicts.length > 0) {
    lines.push("These MBO fields are REVIEW_REQUIRED because the two responses disagreed:");
    lines.push("");
    for (const conflict of fieldReport.fieldConflicts) {
      lines.push(
        `- Campaign ${conflict.campaignId} · **${conflict.mboField}** — ${conflict.listSourcePath} = \`${JSON.stringify(conflict.listValue)}\`, ${conflict.detailSourcePath} = \`${JSON.stringify(conflict.detailValue)}\`, canonical value kept: \`${JSON.stringify(conflict.normalizedValue)}\` (${conflict.reason})`,
      );
    }
    lines.push("");
  }
  if (meta.listDetailConflicts.length === 0) {
    lines.push("The list and detail responses agreed on every shared field.");
  } else {
    lines.push("Both values are real supplier evidence. The list value wins, matching what the production sync stores.");
    lines.push("");
    for (const entry of meta.listDetailConflicts) {
      for (const conflict of entry.conflicts) {
        lines.push(`- Campaign ${entry.campaignId} · \`${conflict.key}\` — list: \`${JSON.stringify(conflict.listValue)}\`, detail: \`${JSON.stringify(conflict.detailValue)}\``);
      }
    }
  }
  lines.push("");

  lines.push("## Commission presentation per campaign");
  lines.push("");
  for (const entry of rulesNormalized) {
    const presentation = entry.presentation;
    lines.push(`### Campaign ${entry.campaignId}`);
    lines.push("");
    lines.push(`- Distinct outcomes: ${presentation.outcomeCount} (Commission 1..${presentation.outcomeCount})`);
    lines.push(`- MIXED: ${presentation.mixed}`);
    lines.push(`- Average display: ${presentation.averageDisplay} (display only, never a financial input)`);
    lines.push(`- Distinct rules preserved (no flattening): ${presentation.distinctRulesPreserved}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}
