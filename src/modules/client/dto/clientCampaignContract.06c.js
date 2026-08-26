/**
 * 06C Client Response Contract — field matrix (authoritative: docs/v15_tsv_sheets/06C).
 * Workbook field → DB/service source → DTO key. Status reflects current implementation.
 *
 * | Workbook field        | Source                                              | DTO key              | Status   |
 * |-----------------------|-----------------------------------------------------|----------------------|----------|
 * | brandName             | Merchant.displayName / Brand Master                 | brandName            | CORRECT  |
 * | brandWebsiteUrl       | Merchant.website ONLY (never destinationUrl first)  | brandWebsiteUrl      | CORRECT  |
 * | brandLogoUrl          | Merchant.logoUrl / campaignLogoUrl                  | brandLogoUrl         | CORRECT* |
 * | primaryCategory       | CanonicalCampaign.category (MBO-normalized)         | primaryCategory      | CORRECT  |
 * | secondaryCategory     | CanonicalCampaign.secondaryCategory (normalized)    | secondaryCategory    | CORRECT  |
 * | campaignName          | assignment/canonical displayName                    | campaignName         | CORRECT  |
 * | campaignDescription   | assignment/supplier description (HTML stripped)     | campaignDescription  | CORRECT  |
 * | campaignType          | assignment.channel → else assigned assets           | campaignType         | CORRECT  |
 * | commercialModel       | supplier campaignType/pricingModel (CPS/CPA/…)      | commercialModel      | EXTENSION|
 * | assignmentStatus      | derived lifecycle from assignment facts             | assignmentStatus     | CORRECT  |
 * | termsAndConditions    | assignment.termsAndConditions                       | termsAndConditions   | PARTIAL  |
 * | couponCode            | ClientCouponAssignment.clientCouponCode             | couponCode           | CORRECT  |
 * | link                  | TrackingLink.mboTrackingUrl                         | link                 | CORRECT  |
 * | primaryCountry        | countries[0]                                        | primaryCountry       | CORRECT  |
 * | secondaryCountries    | countries.slice(1)                                  | secondaryCountries   | CORRECT  |
 * | discountPercent       | exact % only (incl. "10% off")                      | discountPercent      | CORRECT  |
 * | discountType          | mapped enum                                         | discountType         | CORRECT  |
 * | discountDisplay       | coupon/offer text only (never campaignName)         | discountDisplay      | CORRECT  |
 * | campaignValidity      | MAX/MIN assignment ∩ supplier/coupon                | campaignValidity     | CORRECT  |
 * | commission            | ClientCommissionRule (client share/display only)    | commission           | CORRECT  |
 * | currency              | 09J regional + client override                      | currency             | CORRECT  |
 * | campaignStatus        | mapped ACTIVE/PAUSED/EXPIRED                        | campaignStatus       | CORRECT  |
 *
 * Compatibility (kept): `status` = raw ClientCampaignAssignment.status;
 * `published` = boolean. Do not confuse with assignmentStatus or campaignStatus.
 *
 * * Logo is null when neither Merchant nor SupplierCampaign has a real URL (honest empty).
 *
 * Forbidden (must never appear): supplierReceivable, mboMargin, mboCommission,
 * supplierTrackingUrl, rawPayload, supplier campaign ids, other clients' data,
 * apiKey, keyHash.
 */
export const CLIENT_CAMPAIGN_06C_KEYS = [
  "brandName",
  "brandWebsiteUrl",
  "brandLogoUrl",
  "primaryCategory",
  "secondaryCategory",
  "campaignName",
  "campaignDescription",
  "campaignType",
  "termsAndConditions",
  "couponCode",
  "link",
  "primaryCountry",
  "secondaryCountries",
  "discountPercent",
  "discountType",
  "discountDisplay",
  "campaignValidity",
  "commission",
  "currency",
  "campaignStatus",
  "assignmentStatus",
];

export const CLIENT_CAMPAIGN_FORBIDDEN_KEYS = [
  "supplierReceivable",
  "mboMargin",
  "mboCommission",
  "supplierTrackingUrl",
  "rawPayload",
  "rawData",
  "supplierCampaignId",
  "apiKey",
  "keyHash",
];
