import { toDate, toNumber } from "../../../core/normalize.js";
import { MAPPER_VERSION } from "../constants.js";
import {
  extractSupplierCampaignId,
  extractSupplierCouponId,
  parseNetworkSource,
  parseSourceAccountLabel,
  resolveCampaignIdFromCouponRaw,
} from "../entityIdentity.js";
import {
  normalizeCampaignStatus,
  normalizeCommissionUnit,
  normalizeCouponStatus,
  normalizeParticipationStatus,
  normalizePricingModel,
} from "./status.js";
import { isCouponUrlValue, resolveCouponCode, resolveCouponLink } from "../../coupons/codeType.js";

function first(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

/** Country name → ISO-2 lookup for suppliers (e.g. Optimise markets[].name, Boostiny targetCountries[].name) that return full country names. */
const COUNTRY_NAME_TO_ISO2 = {
  "afghanistan":"AF","albania":"AL","algeria":"DZ","andorra":"AD","angola":"AO",
  "antigua and barbuda":"AG","argentina":"AR","armenia":"AM","australia":"AU","austria":"AT",
  "azerbaijan":"AZ","bahamas":"BS","bahrain":"BH","bangladesh":"BD","barbados":"BB",
  "belarus":"BY","belgium":"BE","belize":"BZ","benin":"BJ","bhutan":"BT","bolivia":"BO",
  "bosnia and herzegovina":"BA","botswana":"BW","brazil":"BR","brunei":"BN","bulgaria":"BG",
  "burkina faso":"BF","burundi":"BI","cambodia":"KH","cameroon":"CM","canada":"CA",
  "cape verde":"CV","chad":"TD","chile":"CL","china":"CN","colombia":"CO","comoros":"KM",
  "costa rica":"CR","croatia":"HR","cuba":"CU","cyprus":"CY","czechia":"CZ","czech republic":"CZ",
  "denmark":"DK","djibouti":"DJ","dominica":"DM","dominican republic":"DO","ecuador":"EC",
  "egypt":"EG","el salvador":"SV","eritrea":"ER","estonia":"EE","ethiopia":"ET","fiji":"FJ",
  "finland":"FI","france":"FR","gabon":"GA","gambia":"GM","georgia":"GE","germany":"DE",
  "ghana":"GH","greece":"GR","grenada":"GD","guatemala":"GT","guinea":"GN","guyana":"GY",
  "haiti":"HT","honduras":"HN","hong kong":"HK","hungary":"HU","iceland":"IS","india":"IN",
  "indonesia":"ID","iran":"IR","iraq":"IQ","ireland":"IE","israel":"IL","italy":"IT",
  "ivory coast":"CI","jamaica":"JM","japan":"JP","jordan":"JO","kazakhstan":"KZ",
  "kenya":"KE","kuwait":"KW","kyrgyzstan":"KG","laos":"LA","latvia":"LV","lebanon":"LB",
  "lesotho":"LS","liberia":"LR","libya":"LY","liechtenstein":"LI","lithuania":"LT",
  "luxembourg":"LU","macao":"MO","macau":"MO","madagascar":"MG","malawi":"MW",
  "malaysia":"MY","maldives":"MV","mali":"ML","malta":"MT","mauritania":"MR",
  "mauritius":"MU","mexico":"MX","moldova":"MD","monaco":"MC","mongolia":"MN",
  "montenegro":"ME","morocco":"MA","mozambique":"MZ","myanmar":"MM","namibia":"NA",
  "nepal":"NP","netherlands":"NL","new zealand":"NZ","nicaragua":"NI","niger":"NE",
  "nigeria":"NG","norway":"NO","oman":"OM","pakistan":"PK","palau":"PW","palestine":"PS",
  "panama":"PA","papua new guinea":"PG","paraguay":"PY","peru":"PE","philippines":"PH",
  "poland":"PL","portugal":"PT","qatar":"QA","romania":"RO","russia":"RU","rwanda":"RW",
  "saudi arabia":"SA","senegal":"SN","serbia":"RS","seychelles":"SC","sierra leone":"SL",
  "singapore":"SG","slovakia":"SK","slovenia":"SI","somalia":"SO","south africa":"ZA",
  "south korea":"KR","south sudan":"SS","spain":"ES","sri lanka":"LK","sudan":"SD",
  "suriname":"SR","swaziland":"SZ","sweden":"SE","switzerland":"CH","taiwan":"TW",
  "tajikistan":"TJ","tanzania":"TZ","thailand":"TH","timor-leste":"TL","east timor":"TL",
  "togo":"TG","tonga":"TO","trinidad and tobago":"TT","tunisia":"TN","turkey":"TR",
  "turkmenistan":"TM","tuvalu":"TV","uganda":"UG","ukraine":"UA",
  "united arab emirates":"AE","uae":"AE","united kingdom":"GB","uk":"GB",
  "united states":"US","usa":"US","uruguay":"UY","uzbekistan":"UZ","vanuatu":"VU",
  "venezuela":"VE","vietnam":"VN","western sahara":"EH","yemen":"YE","zambia":"ZM",
  "zimbabwe":"ZW","kosovo":"XK","north korea":"KP","syria":"SY","libya":"LY",
};

function countryNameToIso2(name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase();
  return COUNTRY_NAME_TO_ISO2[key] ?? null;
}

/** ISO-3 alpha-3 → ISO-2 for suppliers (e.g. Boostiny targetCountries[].code = "SAU") */
const ISO3_TO_ISO2 = {
  "AFG":"AF","ALB":"AL","DZA":"DZ","AND":"AD","AGO":"AO","ATG":"AG","ARG":"AR",
  "ARM":"AM","AUS":"AU","AUT":"AT","AZE":"AZ","BHS":"BS","BHR":"BH","BGD":"BD",
  "BRB":"BB","BLR":"BY","BEL":"BE","BLZ":"BZ","BEN":"BJ","BTN":"BT","BOL":"BO",
  "BIH":"BA","BWA":"BW","BRA":"BR","BRN":"BN","BGR":"BG","BFA":"BF","BDI":"BI",
  "KHM":"KH","CMR":"CM","CAN":"CA","CPV":"CV","TCD":"TD","CHL":"CL","CHN":"CN",
  "COL":"CO","COM":"KM","COD":"CD","COG":"CG","CRI":"CR","CIV":"CI","HRV":"HR",
  "CUB":"CU","CYP":"CY","CZE":"CZ","DNK":"DK","DJI":"DJ","DMA":"DM","DOM":"DO",
  "ECU":"EC","EGY":"EG","SLV":"SV","ERI":"ER","EST":"EE","ETH":"ET","FJI":"FJ",
  "FIN":"FI","FRA":"FR","GAB":"GA","GMB":"GM","GEO":"GE","DEU":"DE","GHA":"GH",
  "GRC":"GR","GRD":"GD","GTM":"GT","GIN":"GN","GUY":"GY","HTI":"HT","HND":"HN",
  "HKG":"HK","HUN":"HU","ISL":"IS","IND":"IN","IDN":"ID","IRN":"IR","IRQ":"IQ",
  "IRL":"IE","ISR":"IL","ITA":"IT","JAM":"JM","JPN":"JP","JOR":"JO","KAZ":"KZ",
  "KEN":"KE","KIR":"KI","PRK":"KP","KOR":"KR","KWT":"KW","KGZ":"KG","LAO":"LA",
  "LVA":"LV","LBN":"LB","LSO":"LS","LBR":"LR","LBY":"LY","LIE":"LI","LTU":"LT",
  "LUX":"LU","MAC":"MO","MDG":"MG","MWI":"MW","MYS":"MY","MDV":"MV","MLI":"ML",
  "MLT":"MT","MRT":"MR","MUS":"MU","MEX":"MX","MDA":"MD","MCO":"MC","MNG":"MN",
  "MNE":"ME","MAR":"MA","MOZ":"MZ","MMR":"MM","NAM":"NA","NPL":"NP","NLD":"NL",
  "NZL":"NZ","NIC":"NI","NER":"NE","NGA":"NG","NOR":"NO","OMN":"OM","PAK":"PK",
  "PLW":"PW","PSE":"PS","PAN":"PA","PNG":"PG","PRY":"PY","PER":"PE","PHL":"PH",
  "POL":"PL","PRT":"PT","QAT":"QA","ROU":"RO","RUS":"RU","RWA":"RW","SAU":"SA",
  "SEN":"SN","SRB":"RS","SYC":"SC","SLE":"SL","SGP":"SG","SVK":"SK","SVN":"SI",
  "SOM":"SO","ZAF":"ZA","SSD":"SS","ESP":"ES","LKA":"LK","SDN":"SD","SUR":"SR",
  "SWZ":"SZ","SWE":"SE","CHE":"CH","SYR":"SY","TWN":"TW","TJK":"TJ","TZA":"TZ",
  "THA":"TH","TLS":"TL","TGO":"TG","TON":"TO","TTO":"TT","TUN":"TN","TUR":"TR",
  "TKM":"TM","TUV":"TV","UGA":"UG","UKR":"UA","ARE":"AE","GBR":"GB","USA":"US",
  "URY":"UY","UZB":"UZ","VUT":"VU","VEN":"VE","VNM":"VN","YEM":"YE","ZMB":"ZM",
  "ZWE":"ZW","XKX":"XK","KSA":"SA","UAE":"AE",
};

function iso3ToIso2(code) {
  if (!code) return null;
  const key = String(code).trim().toUpperCase();
  return ISO3_TO_ISO2[key] ?? null;
}

/**
 * Coerce supplier payload values into Prisma String? columns.
 * Objects (e.g. Optimise vertical, Boostiny description blobs) are reduced to text — never written as Json.
 */
export function asOptionalString(value, { maxLength = 8000 } = {}) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object") {
    const nested = first(
      value.description,
      value.primary,
      value.name,
      value.title,
      value.text,
      value.label,
      value.secondary,
    );
    if (nested != null && typeof nested !== "object") {
      return asOptionalString(nested, { maxLength });
    }
    if (value.primary != null || value.secondary != null) {
      const parts = [value.primary, value.secondary].filter(
        (part) => part != null && String(part).trim() !== "",
      );
      if (parts.length) return asOptionalString(parts.join(" / "), { maxLength });
    }
    try {
      const serialized = JSON.stringify(value);
      if (!serialized || serialized === "{}" || serialized === "[]") return null;
      return serialized.length > maxLength ? serialized.slice(0, maxLength) : serialized;
    } catch {
      return null;
    }
  }
  return null;
}

export function toDecimalString(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "object") {
    return toDecimalString(value.amount ?? value.value ?? value.rate ?? value.performance_value);
  }
  const num = toNumber(value);
  if (num !== null) return String(num);
  const match = String(value).match(/-?\d+(?:\.\d+)?/);
  return match ? match[0] : null;
}

/** Partnerize-style y/n (and boolean) flags → boolean | null when absent. */
export function parseYnFlag(...candidates) {
  for (const raw of candidates) {
    if (raw === undefined || raw === null || raw === "") continue;
    if (typeof raw === "boolean") return raw;
    const value = String(raw).trim().toLowerCase();
    if (["y", "yes", "true", "1", "enabled", "on"].includes(value)) return true;
    if (["n", "no", "false", "0", "disabled", "off"].includes(value)) return false;
  }
  return null;
}

/**
 * Normalize campaign terms/conditions from any network shape to plain text.
 * Never returns "[object Object]" for nested locale/HTML payloads.
 */
export function normalizeTermsText(value, { maxLength = 4000 } = {}) {
  if (value === undefined || value === null || value === "") return null;

  if (typeof value === "string") {
    const text = value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!text || text === "[object Object]") return null;
    return text.slice(0, maxLength);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const text = normalizeTermsText(item, { maxLength });
      if (text) return text;
    }
    return null;
  }

  if (typeof value !== "object") return null;

  // Empty object / no usable keys
  if (!Object.keys(value).length) return null;

  // Optimise detail: { body: "..." } and common text containers
  for (const key of ["body", "terms", "html", "text", "content", "description", "value", "message"]) {
    if (value[key] != null) {
      const text = normalizeTermsText(value[key], { maxLength });
      if (text) return text;
    }
  }

  // Partnerize-style multilingual: { en_us: { terms: "..." }, fr: { terms: "..." } }
  const preferredLocales = ["en_us", "en-US", "en_gb", "en-GB", "en"];
  for (const loc of preferredLocales) {
    if (value[loc] != null) {
      const text = normalizeTermsText(value[loc], { maxLength });
      if (text) return text;
    }
  }

  for (const nested of Object.values(value)) {
    if (nested == null) continue;
    if (typeof nested === "string" || typeof nested === "object") {
      const text = normalizeTermsText(nested, { maxLength });
      if (text) return text;
    }
  }

  return null;
}

function flattenCountryTokens(candidate) {
  if (candidate == null || candidate === "") return [];
  if (Array.isArray(candidate)) return candidate.flatMap(flattenCountryTokens);
  if (typeof candidate === "string") {
    return candidate
      .split(/[,;|]/)
      .map((part) => {
        const trimmed = part.trim();
        if (!trimmed) return null;
        // If it looks like a full country name (longer than 3 chars), try name lookup first
        if (trimmed.length > 3) {
          const iso = countryNameToIso2(trimmed);
          if (iso) return iso;
        }
        // If it's a 3-letter code, try ISO-3 → ISO-2 conversion
        if (trimmed.length === 3) {
          const iso2 = iso3ToIso2(trimmed.toUpperCase());
          if (iso2) return iso2;
        }
        return trimmed;
      })
      .filter(Boolean);
  }
  if (typeof candidate === "object") {
    const code = first(
      candidate.iso,
      candidate.iso2,
      candidate.isoCode,
      candidate.ISO,
      candidate.countryCode,
      candidate.country_code,
      candidate.alpha2,
      candidate.alpha_2,
      candidate.code,
    );
    if (code != null && String(code).trim()) {
      const token = String(code).trim().toUpperCase();
      if (token.length === 2) return [token];
      if (token.length === 3) {
        const iso2 = iso3ToIso2(token);
        return iso2 ? [iso2] : [token];
      }
    }
    const name = first(
      candidate.name,
      candidate.country,
      candidate.countryName,
      candidate.country_name,
      candidate.market,
      candidate.label,
    );
    if (name != null && String(name).trim()) {
      const iso = countryNameToIso2(name);
      return iso ? [iso] : [String(name).trim()];
    }
  }
  return [];
}

/**
 * Country/geo targeting from every supplier payload shape we have evidence for.
 * Does not invent ISO codes from free-text names.
 */
export function extractCountryCodesFromRaw(rawData = {}) {
  const payoutCountries = Array.isArray(rawData?.payouts)
    ? rawData.payouts.map((p) => p?.country).filter((c) => c != null && c !== "")
    : [];
  const candidates = [
    rawData?.countryCodes,
    rawData?.country_codes,
    rawData?.countries,
    rawData?.Countries,
    rawData?.AllowedCountries,
    rawData?.allowedCountries,
    rawData?.allowed_countries,
    rawData?.targetCountries,
    rawData?.target_countries,
    rawData?.markets,
    rawData?.promotional_countries,
    rawData?.promotionalCountries,
    rawData?.ShippingRegions,
    rawData?.shippingRegions,
    rawData?.geos,
    rawData?.geo,
    rawData?.regions,
    rawData?.countryName,
    rawData?.country,
    rawData?.payout?.country,
    payoutCountries.length ? payoutCountries : null,
  ];

  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    for (const token of flattenCountryTokens(candidate)) {
      const key = token.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(token.length <= 3 ? token.toUpperCase() : token);
    }
  }
  return out;
}

/**
 * First numeric commission we can prove from the supplier payload.
 * Accepts "12.50%", nested payout/commission objects, and commission groups.
 */
export function extractCommissionValueFromRaw(raw = {}) {
  const groupCommission = first(
    Array.isArray(raw.commissionGroup) ? raw.commissionGroup[0]?.commission : null,
    Array.isArray(raw.commissionGroups) ? raw.commissionGroups[0]?.commission : null,
    Array.isArray(raw.commission_groups) ? raw.commission_groups[0]?.commission : null,
    Array.isArray(raw.commissions) ? raw.commissions[0]?.performance_value : null,
    Array.isArray(raw.active_commissions) ? raw.active_commissions[0]?.performance_value : null,
    Array.isArray(raw.payouts) ? raw.payouts[0]?.value : null,
  );
  return toDecimalString(
    first(
      raw.payout_value,
      typeof raw.payout === "object" ? raw.payout?.amount ?? raw.payout?.value : raw.payout,
      typeof raw.commission === "object"
        ? raw.commission?.amount ?? raw.commission?.value ?? raw.commission?.rate
        : raw.commission,
      raw.default_commission,
      raw.default_commission_rate,
      raw.commissionCost,
      raw.performance_value,
      raw.payouts?.[0]?.value,
      groupCommission,
    ),
  );
}

export function extractCommissionGroupsFromRaw(raw = {}) {
  return first(
    raw.commission_groups,
    raw.commissionGroups,
    raw.commissionGroup,
    raw.commissions,
    raw.active_commissions,
    Array.isArray(raw.payouts) && raw.payouts.length ? raw.payouts : null,
  );
}

function buildNormalizedPayload(entity, normalized) {
  const base = normalized ?? {};
  return {
    ...base,
    _mboLineage: {
      lastSyncedData: entity.lastSyncedData ?? null,
      isManual: Boolean(entity.isManual),
    },
  };
}

function buildAdminOverrides(entity) {
  if (!entity.isManual) return null;
  return entity.manualData ?? {};
}

/**
 * Resolve secondary category from supplier raw payload.
 * Optimise: vertical.secondary; Trackier/Boostiny: subcategory; Partnerize: sub-segment of vertical_name.
 */
export function extractSecondaryCategoryFromRaw(raw = {}, primaryCategory = null) {
  if (!raw || typeof raw !== "object") return null;

  const direct = asOptionalString(
    first(
      raw.sub_category,
      raw.subcategory,
      raw.subCategory,
      raw.secondary_category,
      raw.secondaryCategory,
      raw.vertical?.secondary,
      raw.category?.secondary,
      raw.category?.subcategory,
      raw.category?.sub_category,
      raw.campaign?.vertical?.secondary,
      raw.campaign?.vertical?.parent?.name,
      raw.advertiser?.vertical?.secondary,
      raw.advertiser?.vertical?.parent?.name,
    ),
  );
  if (direct) return direct;

  const verticalName = asOptionalString(
    first(raw.vertical_name, raw.vertical?.name, raw.vertical?.primary, primaryCategory),
  );
  if (verticalName?.includes("&")) {
    const parts = verticalName
      .split("&")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length >= 2) return parts[parts.length - 1];
  }
  if (verticalName?.includes(" - ")) {
    const parts = verticalName
      .split(" - ")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length >= 2) return parts[parts.length - 1];
  }

  return null;
}

export function extractTrackingUrlFromRaw(raw = {}) {
  if (!raw || typeof raw !== "object") return null;
  const nestedCampaign = raw.campaign && typeof raw.campaign === "object" ? raw.campaign : null;
  const trackingDetails =
    raw.tracking_link_details && typeof raw.tracking_link_details === "object"
      ? raw.tracking_link_details
      : null;
  const payoutLink = Array.isArray(raw.payouts) ? raw.payouts[0]?.links : null;
  return (
    first(
      raw.tracking_url,
      raw.trackingUrl,
      raw.tracking_link,
      raw.trackingURL,
      raw.baseTrackingUrl,
      raw.deepLinkTrackingURL,
      raw.click_url,
      raw.landingPage?.thirdPartyUrl,
      nestedCampaign?.tracking_link,
      nestedCampaign?.tracking_url,
      trackingDetails?.url,
      trackingDetails?.tracking_url,
      trackingDetails?.tracking_link,
      typeof payoutLink === "string" ? payoutLink : null,
    ) ?? null
  );
}

export function extractCampaignStartDateFromRaw(raw = {}, entity = null) {
  const payout = Array.isArray(raw.payouts) ? raw.payouts[0] : null;
  const nestedCampaign = raw.campaign && typeof raw.campaign === "object" ? raw.campaign : null;
  return toDate(
    first(
      entity?.eventDate,
      raw.startDate,
      raw.start_date,
      raw.start_date_time,
      raw.liveDate,
      raw.appliedDate,
      raw.dateCreated,
      raw.activationDate,
      raw.campaign_start_date,
      raw.campaignStartDate,
      payout?.start_date,
      nestedCampaign?.start_date,
      nestedCampaign?.live_date,
    ),
  );
}

export function extractCampaignEndDateFromRaw(raw = {}) {
  const payout = Array.isArray(raw.payouts) ? raw.payouts[0] : null;
  const nestedCampaign = raw.campaign && typeof raw.campaign === "object" ? raw.campaign : null;
  return toDate(
    first(
      raw.endDate,
      raw.end_date,
      raw.end_date_time,
      raw.expiryDate,
      raw.expiry_date,
      raw.cancelledDate,
      raw.campaign_end_date,
      raw.campaignEndDate,
      raw.valid_to,
      raw.expires_at,
      raw.expire_date,
      payout?.end_date,
      nestedCampaign?.end_date,
    ),
  );
}

export function buildCampaignBaseFromEntity(entity) {
  const { supplier, supplierRegion } = parseNetworkSource(entity.networkSource);
  const { sourceAccountLabel } = parseSourceAccountLabel(entity.externalId);
  const supplierCampaignId = extractSupplierCampaignId(entity.networkSource, entity.externalId);
  const raw = entity.rawData ?? {};
  const normalized = entity.normalizedData ?? {};

  const campaignName =
    first(
      entity.campaignName,
      entity.entityName,
      raw.title,
      raw.campaign_name,
      raw.offer_name,
      raw.name,
      normalized.name,
    ) || supplierCampaignId;

  const merchantNameRaw = first(
    entity.advertiserName,
    raw.advertiser_name,
    raw.advertiser?.name,
    raw.advertiser?.display_name,
    typeof raw.advertiser === "string" ? raw.advertiser : null,
    raw.advertiserName,
    raw.merchant_name,
    raw.brand_name,
    raw.brandName,
    raw.companyName,
    raw.AdvertiserName,
    typeof raw.merchant === "string" ? raw.merchant : raw.merchant?.name,
    raw.brand,
    normalized.advertiser,
  );

  const campaignStatus = normalizeCampaignStatus(
    entity.entityStatus,
    raw.status,
    raw.campaign_status,
    raw.campaignStatus,
    raw.CampaignStatus,
    raw.lifecycle_status,
    raw.campaign_lifecycle_status,
    raw.approval_status,
    raw.subStatus,
    raw.is_active === true ? "active" : raw.is_active === false ? "inactive" : null,
    raw.is_live === true ? "live" : raw.is_live === false ? "not live" : null,
  );

  const participationStatus = normalizeParticipationStatus(
    raw.application_status,
    raw.applicationStatus,
    raw.participation_status,
    raw.participationStatus,
    raw.ContractStatus,
    raw.contractStatus,
    raw.join_status,
    raw.publisher_status,
    raw.relationship_status,
    raw.is_joined,
    raw.joined,
  );

  const isJoined =
    participationStatus === "JOINED" ||
    raw.is_joined === true ||
    raw.joined === true ||
    String(raw.participation_status ?? "").toLowerCase() === "joined" ||
    String(raw.application_status ?? "").toLowerCase() === "approved" ||
    String(raw.application_status ?? "").toLowerCase() === "joined";

  return {
    supplier,
    supplierRegion,
    supplierCampaignId,
    sourceAccountLabel,
    campaignName: String(campaignName),
    campaignDescription: asOptionalString(
      first(raw.description, raw.campaign_description, raw.summary, raw.campaignDescription),
    ),
    campaignLogoUrl: asOptionalString(
      first(
        raw.logo,
        raw.thumbnail,
        raw.logo_url,
        raw.image,
        raw.image_url,
        raw.icon,
        raw.campaign_logo,
        raw.campaignLogo,
        raw.campaign_icon,
        raw.advertiserLogoLocation,
        raw.advertiser_logo,
        raw.advertiserLogo,
        raw.advertiser?.advertiser_icon,
      ),
    ),
    merchantNameRaw: merchantNameRaw ? String(merchantNameRaw).trim() || null : null,
    merchantVertical: asOptionalString(first(raw.vertical, raw.industry, raw.merchant_vertical, raw.subcategory)),
    categoryName: asOptionalString(
      first(
        raw.vertical?.primary,
        raw.category_name,
        raw.categoryName,
        raw.category?.name,
        raw.category,
        raw.vertical?.name,
        raw.vertical_name,
        raw.vertical,
        raw.Category,
      ),
    ),
    secondaryCategory: extractSecondaryCategoryFromRaw(
      raw,
      asOptionalString(
        first(
          raw.vertical?.primary,
          raw.category_name,
          raw.categoryName,
          raw.category?.name,
          raw.category,
          raw.vertical?.name,
          raw.vertical_name,
          raw.vertical,
          raw.Category,
        ),
      ),
    ),
    campaignType: asOptionalString(
      first(
        raw.conversion_flow,
        raw.offer_type,
        raw.campaign_type,
        raw.campaignType,
        raw.campaignTypeName,
        raw.conversion_type,
        raw.productTypeName,
        entity.entitySubType,
        // Prefer explicit campaign type fields over generic `type` (may be conversion type).
        raw.type,
        normalized.type,
      ),
    ),
    pricingModel: normalizePricingModel(
      raw.model,
      raw.payout_type,
      raw.payoutType,
      raw.payout?.type,
      raw.payouts?.[0]?.model,
      raw.pricing_model,
      raw.pricingModel,
      raw.commission_type,
      raw.performance_model,
      raw.campaignTypeName,
      raw.productTypeName,
      entity.entitySubType,
    ),
    defaultCommissionValue:
      toDecimalString(entity.commission) ?? extractCommissionValueFromRaw(raw),
    commissionUnit: normalizeCommissionUnit(
      raw.payout_type,
      raw.payoutType,
      raw.payout?.type,
      raw.payouts?.[0]?.model,
      raw.commission_unit,
      raw.commissionUnit,
      raw.commissionCost,
      raw.performance_model,
      typeof raw.commission === "string" ? raw.commission : raw.commission?.type,
    ),
    commissionCurrency:
      first(
        raw.currency?.iso,
        typeof raw.currency === "string" ? raw.currency : null,
        raw.currency_code,
        raw.currencyCode,
        raw.commission_currency,
        raw.payout?.currency,
        raw.payouts?.[0]?.currency,
      )?.toString()
        .slice(0, 3)
        .toUpperCase() ?? null,
    commissionGroups: extractCommissionGroupsFromRaw(raw),
    trackingUrl: extractTrackingUrlFromRaw(raw),
    destinationUrl:
      first(
        raw.destination_url,
        raw.destinationUrl,
        raw.default_destination,
        raw.landing_page,
        raw.landingPage?.websiteUrl,
        raw.preview_url,
        raw.offer_url,
        raw.website,
        raw.CampaignUrl,
        raw.WebsiteUrl,
        raw.url,
      ) ?? null,
    deepLinkingEnabled:
      parseYnFlag(
        raw.allow_deep_linking,
        raw.allowDeepLinking,
        raw.deep_linking_enabled,
        raw.deepLinkingEnabled,
        raw.deepLinkEnabled,
        raw.deeplinkEnabled,
        raw.deeplink_enabled,
      ) ?? (first(raw.deep_link, raw.deeplink, raw.deepLinkURL) ? true : null),
    cookieDurationDays:
      toNumber(first(raw.cookie_duration, raw.cookieDuration, raw.cookie_days)) ??
      (raw.cookie_period != null && Number(raw.cookie_period) > 0
        ? Math.round(Number(raw.cookie_period) / 86400)
        : null),
    campaignStatus,
    participationStatus,
    isJoined,
    countryCodes: extractCountryCodesFromRaw(raw),
    currencyCode:
      asOptionalString(
        first(
          raw.currency?.iso,
          typeof raw.currency === "string" ? raw.currency : null,
          raw.currency_code,
          raw.currencyCode,
          raw.default_currency,
          raw.payout?.currency,
          raw.payouts?.[0]?.currency,
        ),
      )?.slice(0, 3) ?? null,
    campaignStartDate: extractCampaignStartDateFromRaw(raw, entity),
    campaignEndDate: extractCampaignEndDateFromRaw(raw),
    entityId: entity.id,
    rawPayload: raw,
    normalizedPayload: {
      ...buildNormalizedPayload(entity, normalized),
      campaignEndDate: extractCampaignEndDateFromRaw(raw)?.toISOString?.() ?? null,
    },
    mapperVersion: MAPPER_VERSION,
    syncConflict: Boolean(entity.hasSyncConflict),
    fieldPolicies: entity.fieldPolicies ?? null,
    adminOverrides: buildAdminOverrides(entity),
    firstSeenAt: toDate(entity.createdAt) ?? new Date(),
    lastSyncedAt: entity.updatedAt ?? new Date(),
  };
}

export function buildCouponBaseFromEntity(entity, supplierCampaignIdHint = null) {
  const raw = entity.rawData ?? {};
  const normalized = entity.normalizedData ?? {};
  const supplierCouponId = extractSupplierCouponId(entity.networkSource, entity.externalId);
  const parentCampaignId =
    supplierCampaignIdHint ?? resolveCampaignIdFromCouponRaw(raw) ?? extractParentCampaignIdFromExternal(entity);
  const parentCampaignName =
    asOptionalString(
      first(
        entity.campaignName,
        raw.campaign_name,
        raw.campaignName,
        typeof raw.campaign === "string" ? raw.campaign : null,
        raw.campaign?.name,
      ),
    ) ?? null;

  const voucherNested =
    raw.voucher_code && typeof raw.voucher_code === "object" ? raw.voucher_code : null;
  const fromEntityCode =
    entity.code && !isCouponUrlValue(entity.code) ? String(entity.code).trim() : null;
  const code =
    resolveCouponCode(raw) ??
    fromEntityCode ??
    (voucherNested?.voucher_code && !isCouponUrlValue(voucherNested.voucher_code)
      ? String(voucherNested.voucher_code).trim()
      : null);
  const link =
    resolveCouponLink(raw) ??
    first(raw.deeplink, raw.deep_link, raw.link, raw.url, raw.tracking_url, raw.trackingUrl) ??
    (isCouponUrlValue(entity.code) ? String(entity.code).trim() : null);
  const couponType = code ? "CODE" : link ? "LINK" : "UNKNOWN";

  return {
    supplierCouponId:
      voucherNested?.voucher_code_id != null
        ? String(voucherNested.voucher_code_id)
        : supplierCouponId,
    parentSupplierCampaignId: parentCampaignId,
    parentCampaignName,
    couponType,
    couponCode: code != null && code !== "" ? String(code) : null,
    couponLink: link ? String(link) : null,
    couponDescription: asOptionalString(first(raw.description, raw.title, entity.entityName)),
    discountValue: asOptionalString(first(entity.discount, raw.discount, raw.discount_value)),
    couponStartDate: toDate(first(raw.start_date, raw.startDate, raw.valid_from, raw.activationDate)),
    couponEndDate: toDate(first(raw.end_date, raw.endDate, raw.valid_to, raw.expiry_date, raw.expiryDate)),
    couponStatus: normalizeCouponStatus(raw.status, raw.coupon_status, entity.entityStatus),
    couponIsExclusive: raw.is_exclusive ?? raw.exclusive ?? null,
    entityId: entity.id,
    rawPayload: raw,
    normalizedPayload: buildNormalizedPayload(entity, normalized),
    mapperVersion: MAPPER_VERSION,
    firstSeenAt: toDate(entity.createdAt) ?? new Date(),
    lastSyncedAt: entity.updatedAt ?? new Date(),
  };
}

function extractParentCampaignIdFromExternal(entity) {
  const raw = entity.rawData ?? {};
  const campaignId = resolveCampaignIdFromCouponRaw(raw);
  if (campaignId) return campaignId;

  const dealCampaign = raw.campaign_id ?? raw.campaignId;
  if (dealCampaign != null) return String(dealCampaign);

  return null;
}
