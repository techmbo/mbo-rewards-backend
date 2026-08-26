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
import { buildCampaignBaseFromEntity, buildCouponBaseFromEntity } from "./shared.js";

const CAMPAIGN_MAPPERS = {
  BOOSTINY: mapBoostinyCampaign,
  OPTIMISE: mapOptimiseCampaign,
  TRACKIER: mapTrackierCampaign,
  PARTNERIZE: mapPartnerizeCampaign,
  IMPACT: mapImpactCampaign,
  AWIN: mapAwinCampaign,
};

const COUPON_MAPPERS = {
  BOOSTINY: mapBoostinyCoupon,
  OPTIMISE: mapOptimiseCoupon,
  TRACKIER: mapTrackierCoupon,
  PARTNERIZE: mapPartnerizeCoupon,
  IMPACT: mapImpactCoupon,
  AWIN: mapAwinOffer,
};

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

  // Boostiny (and similar) coupon payloads may only include campaign name — promotion
  // resolves the parent SupplierCampaign by name when parentSupplierCampaignId is absent.
  if (!mapped.parentSupplierCampaignId && !mapped.parentCampaignName) {
    throw new MapperError(
      "MISSING_PARENT_CAMPAIGN",
      "parentSupplierCampaignId could not be derived from coupon Entity",
    );
  }

  return mapped;
}
