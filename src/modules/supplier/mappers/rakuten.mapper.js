import { asOptionalString, buildCampaignBaseFromEntity } from "./shared.js";

function first(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

/**
 * Rakuten advertiser rows are the campaign/program master for MBO.
 *
 * The raw Entity external id uses `rakuten-advertiser-*`, so the generic
 * `*-campaign-*` identity parser cannot safely derive the network advertiser id.
 * Always take the advertiser identity from the source payload instead of storing
 * the staging external-id prefix as SupplierCampaign.supplierCampaignId.
 */
export function mapRakutenCampaign(entity = {}) {
  const base = buildCampaignBaseFromEntity(entity);
  const raw = entity.rawData ?? {};

  const sourceAdvertiserId = first(
    raw.id,
    raw.advertiser_id,
    raw.advertiserId,
    raw.campaign_id,
    raw.campaignId,
  );

  const sourceName = asOptionalString(
    first(
      raw.name,
      raw.advertiser_name,
      raw.advertiserName,
      raw.company_name,
      raw.companyName,
      entity.campaignName,
      entity.entityName,
    ),
  );

  return {
    ...base,
    supplierCampaignId:
      sourceAdvertiserId !== undefined && sourceAdvertiserId !== null && sourceAdvertiserId !== ""
        ? String(sourceAdvertiserId)
        : base.supplierCampaignId,
    campaignName: sourceName ?? base.campaignName,
    merchantNameRaw: sourceName ?? base.merchantNameRaw,
    mapperVersion: `${base.mapperVersion || "supplier-mapper"}:rakuten-advertiser-v1`,
  };
}
