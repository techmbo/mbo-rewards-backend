import { parseNetworkSource } from "../entityIdentity.js";
import { SUPPLIER_ENTITY_TYPES } from "../constants.js";
import {
  mapBoostinyCampaign,
  mapBoostinyCoupon,
} from "./boostiny.mapper.js";
import {
  mapOptimiseCampaign,
  mapOptimiseCoupon,
} from "./optimise.mapper.js";
import {
  mapPartnerizeCampaign,
  mapPartnerizeCoupon,
} from "./partnerize.mapper.js";
import {
  mapTrackierCampaign,
  mapTrackierCoupon,
} from "./trackier.mapper.js";
import {
  mapImpactCampaign,
  mapImpactCoupon,
} from "./impact.mapper.js";
import {
  mapAwinCampaign,
  mapAwinOffer,
} from "./awin.mapper.js";
import { mapRakutenCampaign } from "./rakuten.mapper.js";
import { mapCjCampaign, mapCjCoupon } from "./cj.mapper.js";
import { enrichCouponVoucherRecord } from "../../coupons/couponVoucher.contract.js";
import { buildCampaignBaseFromEntity, buildCouponBaseFromEntity } from "./shared.js";

const CAMPAIGN_MAPPERS = {
  BOOSTINY: mapBoostinyCampaign,
  OPTIMISE: mapOptimiseCampaign,
  TRACKIER: mapTrackierCampaign,
  PARTNERIZE: mapPartnerizeCampaign,
  IMPACT: mapImpactCampaign,
  AWIN: mapAwinCampaign,
  RAKUTEN: mapRakutenCampaign,
  CJ: mapCjCampaign,
};

const COUPON_MAPPERS = {
  BOOSTINY: mapBoostinyCoupon,
  OPTIMISE: mapOptimiseCoupon,
  TRACKIER: mapTrackierCoupon,
  PARTNERIZE: mapPartnerizeCoupon,
  IMPACT: mapImpactCoupon,
  AWIN: mapAwinOffer,
  CJ: mapCjCoupon,
};

const KNOWN_CONVERSION_SUPPLIERS = new Set([
  "BOOSTINY",
  "OPTIMISE",
  "TRACKIER",
  "PARTNERIZE",
  "IMPACT",
  "AWIN",
  "ADMITAD",
  "RAKUTEN",
]);

/** True when a JS mapper exists for this supplier + entity type (fallback if mapping JSON is absent). */
export function hasJsMapper(supplier, entityType) {
  const key = String(supplier || "").toUpperCase();
  const type = String(entityType || "").toLowerCase();
  if (type === "campaign") return Boolean(CAMPAIGN_MAPPERS[key]);
  if (type === "coupon") return Boolean(COUPON_MAPPERS[key]);
  if (type === "conversion" || type === "order" || type === "product") {
    return KNOWN_CONVERSION_SUPPLIERS.has(key);
  }
  return false;
}

export class MapperError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, { cause });
    this.name = "MapperError";
    this.code = code;
  }
}

export function mapEntityToSupplierCampaign(entity) {
  if (entity.entityType !== SUPPLIER_ENTITY_TYPES.CAMPAIGN) {
    throw new MapperError("UNSUPPORTED_ENTITY_TYPE", `Cannot map entityType=${entity.entityType} to SupplierCampaign`);
  }

  const { supplier } = parseNetworkSource(entity.networkSource);
  const mapper = CAMPAIGN_MAPPERS[supplier] ?? buildCampaignBaseFromEntity;
  const mapped = mapper === buildCampaignBaseFromEntity ? buildCampaignBaseFromEntity(entity) : mapper(entity);

  if (!mapped.supplierCampaignId) {
    throw new MapperError("MISSING_SUPPLIER_CAMPAIGN_ID", "supplierCampaignId could not be derived from Entity");
  }
  if (!mapped.campaignName) {
    throw new MapperError("MISSING_CAMPAIGN_NAME", "campaignName could not be derived from Entity");
  }

  return mapped;
}

/** Best-effort campaign mapping for display/projection — never throws. */
export function tryMapCampaignEntity(entity) {
  if (!entity) return null;
  try {
    const { supplier } = parseNetworkSource(entity.networkSource);
    const mapper = CAMPAIGN_MAPPERS[supplier] ?? buildCampaignBaseFromEntity;
    return mapper(entity);
  } catch {
    try {
      return buildCampaignBaseFromEntity(entity);
    } catch {
      return null;
    }
  }
}

export function mapEntityToSupplierCoupon(entity) {
  if (entity.entityType !== SUPPLIER_ENTITY_TYPES.COUPON) {
    throw new MapperError("UNSUPPORTED_ENTITY_TYPE", `Cannot map entityType=${entity.entityType} to SupplierCoupon`);
  }

  const { supplier } = parseNetworkSource(entity.networkSource);
  const mapper = COUPON_MAPPERS[supplier] ?? buildCouponBaseFromEntity;
  const mapped = mapper === buildCouponBaseFromEntity ? buildCouponBaseFromEntity(entity) : mapper(entity);
  const enriched = enrichCouponVoucherRecord(mapped, entity, {
    networkSource: entity.networkSource,
    sourceObject: entity.rawData?._mboSourceObject ?? entity.sourceObject,
    sourcePath: entity.rawData?._mboSourcePath,
    mappingVersion: mapped.mapperVersion,
  });

  // Boostiny (and similar) coupon payloads may only include campaign name — promotion
  // resolves the parent SupplierCampaign by name when parentSupplierCampaignId is absent.
  if (!enriched.parentSupplierCampaignId && !enriched.parentCampaignName) {
    throw new MapperError(
      "MISSING_PARENT_CAMPAIGN",
      "parentSupplierCampaignId could not be derived from coupon Entity",
    );
  }

  return enriched;
}
