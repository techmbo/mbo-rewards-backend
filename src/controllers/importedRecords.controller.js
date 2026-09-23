import { ok, okPaged } from "../core/apiResponse.js";
import { PERMISSIONS, roleHasPermission } from "../auth/permissions.js";
import { ImportedRecordsService } from "../modules/ops/importedRecords.service.js";

const service = new ImportedRecordsService();

/**
 * Response boundary for GET /ops/imported-records (Network Operations → All Network Data).
 *
 * The page is an inventory of staged SOURCE records. The route-level campaigns:read gate is not
 * enough on its own: the record type is required, must be one of the types below, and is
 * authorized again against the permission for that type. Performance, conversion, payment,
 * product and every other staged type are not served here — they have their own gated pages.
 *
 * Every row leaves through an explicit allowlist applied here, after the service and its shared
 * cache, so the cache only ever holds the unprojected rows and nothing permission-specific. No
 * raw payload, source-only field, URL, click / order / conversion id, raw payload id, mapper
 * error text or money is returned — for any caller, whatever their permissions.
 */
export const IMPORTED_RECORD_TYPE_PERMISSIONS = Object.freeze({
  campaign: PERMISSIONS.CAMPAIGNS_READ,
  coupon: PERMISSIONS.COUPONS_READ,
  commission_rule: PERMISSIONS.COMMISSION_READ,
  commission_group: PERMISSIONS.COMMISSION_READ,
});

/** Fields a list row may carry, for every supported type. */
export const IMPORTED_RECORD_ROW_FIELDS = Object.freeze([
  // identity
  "id",
  "network",
  "networkSource",
  "networkAccount",
  "recordType",
  "entityType",
  "sourceRecordId",
  "supplierCampaignId",
  "supplierCampaignExtId",
  "networkCampaignId",
  "campaignSourceId",
  "canonicalCampaignId",
  "merchantId",
  // campaign / display
  "brand",
  "sourceAdvertiserName",
  "campaign",
  "category",
  "secondaryCategory",
  "country",
  "currency",
  "campaignType",
  "commercialType",
  "channelType",
  "campaignStatus",
  "relationshipStatus",
  // capability flags
  "mboReady",
  "isAssignable",
  "linkSupport",
  "couponSupport",
  "deeplinkSupport",
  "feedSupport",
  "linkSupportState",
  "couponSupportState",
  "deeplinkSupportState",
  "feedSupportState",
  "commissionRulesState",
  // related counts
  "couponCount",
  "commissionRuleCount",
  // sync / quality
  "sourceStatus",
  "mappingStatus",
  "certificationStatus",
  "issue",
  "issueCode",
  "importedAt",
  "lastUpdated",
  "lastSyncedAt",
]);

/** Extra fields on coupon rows only (coupon type already requires coupons:read). */
export const IMPORTED_RECORD_COUPON_FIELDS = Object.freeze(["couponCode", "couponStatus"]);

const COUNT_FIELDS = new Set(["couponCount", "commissionRuleCount"]);
const LIST_FIELDS = new Set(["country"]);
const LINKED_RECORD_KEYS = Object.freeze(["supplierCommissionRules", "couponVouchers", "trackingLinks", "offersPromotions", "productsFeeds"]);
const SUMMARY_COUNT_FIELDS = Object.freeze([
  "importedRecords",
  "normalizedCampaigns",
  "promotedSupplierCampaigns",
  "needsReview",
  "mappingErrors",
  "importedCampaigns",
  "linkedCampaigns",
  "unlinkedCampaigns",
]);

/** Anything that could resolve as a link, including the MBO /r/<slug>/<token> redirect path. */
function isUrlShaped(value) {
  const text = String(value).trim();
  if (!text) return false;
  return (
    /[a-z][a-z0-9+.-]*:\/\//i.test(text) ||
    /^\/\//.test(text) ||
    /^www\./i.test(text) ||
    /(^|\/)r\/[^/\s]+\/[^/\s]+/i.test(text)
  );
}

function safeText(value) {
  if (typeof value !== "string") return null;
  return isUrlShaped(value) ? null : value;
}

function safeScalar(key, value) {
  if (value == null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return COUNT_FIELDS.has(key) && Number.isFinite(value) ? value : null;
  if (typeof value === "string") return safeText(value);
  if (Array.isArray(value) && LIST_FIELDS.has(key)) {
    return value.map((v) => safeText(typeof v === "string" ? v : null)).filter((v) => v != null);
  }
  return null;
}

function projectRow(row) {
  if (!row || typeof row !== "object") return null;
  const out = {};
  for (const key of IMPORTED_RECORD_ROW_FIELDS) out[key] = safeScalar(key, row[key]);
  if (row.entityType === "coupon") {
    for (const key of IMPORTED_RECORD_COUPON_FIELDS) out[key] = safeScalar(key, row[key]);
  }
  // Only whether an issue exists — never the mapper error text, id or payload.
  out.hasMapperError = Boolean(row.openMapperErrorId || row.mapping?.mapperError);
  return out;
}

function projectDetail(detail) {
  const out = projectRow(detail);
  if (!out) return null;
  const linked = detail.linkedRecords && typeof detail.linkedRecords === "object" ? detail.linkedRecords : null;
  out.linkedRecords = linked
    ? Object.fromEntries(
        LINKED_RECORD_KEYS.filter((key) => linked[key]).map((key) => [
          key,
          {
            type: safeText(linked[key].type),
            syncedCount: Number.isFinite(Number(linked[key].syncedCount)) ? Number(linked[key].syncedCount) : 0,
            state: safeText(linked[key].state),
          },
        ]),
      )
    : null;
  out.pipeline = Array.isArray(detail.pipeline)
    ? detail.pipeline.map((stage) => ({
        key: safeText(stage?.key),
        label: safeText(stage?.label),
        state: safeText(stage?.state),
        detail: safeText(stage?.detail),
      }))
    : [];
  return out;
}

function sendError(res, status, message) {
  res.status(status).json({ ok: false, message });
}

function noStore(res) {
  res.set("Cache-Control", "no-store");
}

function canRead(req, permission) {
  return Boolean(req.user && permission && roleHasPermission(req.user.role, permission));
}

/** Same precedence as readFilters, so the type authorized is the type the query uses. */
function requestedRecordType(query = {}) {
  const raw = query.recordType || query.record_type || query.type || query.entityType;
  return raw ? String(raw).trim().toLowerCase() : "";
}

/**
 * Resolves and authorizes the requested record type. Sends the error response and returns null
 * when the request must stop.
 */
function authorizeRecordType(req, res) {
  const type = requestedRecordType(req.query);
  if (!type) {
    sendError(res, 400, "Query parameter 'recordType' is required.");
    return null;
  }
  if (!Object.hasOwn(IMPORTED_RECORD_TYPE_PERMISSIONS, type)) {
    sendError(res, 400, `Unsupported record type: ${type}`);
    return null;
  }
  if (!canRead(req, IMPORTED_RECORD_TYPE_PERMISSIONS[type])) {
    sendError(res, 403, "You do not have permission to view this data.");
    return null;
  }
  return type;
}

function permittedRecordTypes(req) {
  return Object.keys(IMPORTED_RECORD_TYPE_PERMISSIONS).filter((type) => canRead(req, IMPORTED_RECORD_TYPE_PERMISSIONS[type]));
}

function readFilters(query = {}) {
  return {
    page: query.page,
    pageSize: query.pageSize || query.page_size,
    networkSource: query.network || query.networkSource,
    recordType: query.recordType || query.record_type || query.type || query.entityType,
    mappingStatus: query.mappingStatus || query.mapping_status,
    sourceStatus: query.sourceStatus || query.source_status,
    brand: query.brand,
    campaign: query.campaign,
    issue: query.issue,
    search: query.search || query.q,
    preset: query.preset,
    fromDate: query.fromDate || query.from_date,
    toDate: query.toDate || query.to_date,
    country: query.country,
    campaignStatus: query.campaignStatus || query.campaign_status,
    relationshipStatus: query.relationshipStatus || query.relationship_status,
    mboReady: query.mboReady || query.mbo_ready,
    campaignType: query.campaignType || query.campaign_type,
    category: query.category,
    currency: query.currency,
    isAssignable: query.isAssignable || query.is_assignable,
    groupBy: query.groupBy || query.group_by,
  };
}

export async function listImportedRecordsHandler(req, res, next) {
  try {
    noStore(res);
    const recordType = authorizeRecordType(req, res);
    if (!recordType) return;
    const result = await service.list({ ...readFilters(req.query), recordType });
    // One type per response: anything else the query may have matched is dropped, never mixed in.
    const rows = (Array.isArray(result.rows) ? result.rows : [])
      .filter((row) => row && row.entityType === recordType)
      .map(projectRow);
    const totalPages = Math.max(1, Math.ceil(Number(result.total || 0) / Number(result.pageSize || 1)));
    res.json(
      okPaged({
        data: rows,
        pagination: {
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
          totalPages,
          hasMore: result.hasMore,
        },
      }),
    );
  } catch (error) {
    next(error);
  }
}

export async function getImportedRecordHandler(req, res, next) {
  try {
    noStore(res);
    const detail = await service.getById(req.params.id);
    const type = String(detail?.entityType || "").toLowerCase();
    // A type this endpoint does not serve is reported as not found, so ids of other staged
    // objects (payments, conversions, …) cannot be probed through it.
    if (!Object.hasOwn(IMPORTED_RECORD_TYPE_PERMISSIONS, type)) {
      sendError(res, 404, "Imported record not found.");
      return;
    }
    if (!canRead(req, IMPORTED_RECORD_TYPE_PERMISSIONS[type])) {
      sendError(res, 403, "You do not have permission to view this data.");
      return;
    }
    res.json(ok(projectDetail(detail)));
  } catch (error) {
    next(error);
  }
}

export async function importedRecordsSummaryHandler(req, res, next) {
  try {
    noStore(res);
    const recordType = authorizeRecordType(req, res);
    if (!recordType) return;
    const summary = await service.summary({ ...readFilters(req.query), recordType });
    const permitted = permittedRecordTypes(req);
    const out = {};
    for (const key of SUMMARY_COUNT_FIELDS) {
      const value = summary?.[key];
      out[key] = typeof value === "number" && Number.isFinite(value) ? value : null;
    }
    const counts = summary?.recordTypeCounts && typeof summary.recordTypeCounts === "object" ? summary.recordTypeCounts : {};
    out.recordTypeCounts = Object.fromEntries(permitted.map((type) => [type, Number.isFinite(Number(counts[type])) ? Number(counts[type]) : 0]));
    out.byNetwork = Array.isArray(summary?.byNetwork)
      ? summary.byNetwork.map((entry) =>
          Object.fromEntries(
            Object.entries(entry || {})
              .filter(([, v]) => typeof v === "number" || typeof v === "string" || typeof v === "boolean" || v == null)
              .map(([k, v]) => [k, typeof v === "string" ? safeText(v) : v]),
          ),
        )
      : [];
    out.supportedRecordTypes = permitted;
    res.json(ok(out));
  } catch (error) {
    next(error);
  }
}

export async function importedRecordsFacetsHandler(req, res, next) {
  try {
    const facets = await service.facets(readFilters(req.query));
    res.json(ok(facets));
  } catch (error) {
    next(error);
  }
}

export async function reprocessImportedRecordsHandler(req, res, next) {
  try {
    const body = req.body ?? {};
    const summary = await service.reprocess({
      entityIds: body.entityIds || body.entity_ids,
      networkSource: body.networkSource || body.network_source || body.network,
    });
    res.json(ok({ summary }));
  } catch (error) {
    next(error);
  }
}

export async function importedRecordsColumnsHandler(req, res, next) {
  try {
    noStore(res);
    const recordType = authorizeRecordType(req, res);
    if (!recordType) return;
    const catalog = service.getColumnCatalog(recordType);
    // Only columns this endpoint can actually return; raw / source-only columns are never offered.
    const allowed = new Set([
      ...IMPORTED_RECORD_ROW_FIELDS,
      ...(recordType === "coupon" ? IMPORTED_RECORD_COUPON_FIELDS : []),
      "hasMapperError",
    ]);
    const columns = (Array.isArray(catalog?.columns) ? catalog.columns : []).filter((c) => c && allowed.has(c.key) && !c.sourceOnly);
    const keep = (keys) => (Array.isArray(keys) ? keys.filter((k) => columns.some((c) => c.key === k)) : []);
    res.json(
      ok({
        contractPointer: catalog?.contractPointer ?? null,
        recordType,
        viewModes: Array.isArray(catalog?.viewModes) ? catalog.viewModes : [],
        columns,
        defaultKeys: keep(catalog?.defaultKeys),
        compactKeys: keep(catalog?.compactKeys),
        boundaryNote: "Staged SOURCE records only. Raw payloads, URLs, click / order ids and money are not served by this endpoint.",
      }),
    );
  } catch (error) {
    next(error);
  }
}
