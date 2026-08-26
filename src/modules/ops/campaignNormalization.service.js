import { CatalogService } from "../catalog/services/catalog.service.js";
import { MerchantMatchingService } from "../merchant/services/merchantMatching.service.js";
import { MerchantService } from "../merchant/services/merchant.service.js";
import { SupplierCampaignRepository } from "../supplier/repositories/supplierCampaign.repository.js";
import { MATCH_OUTCOMES } from "../merchant/constants.js";
import { logger } from "../../platform/logging/logger.js";

/**
 * After Entity → SupplierCampaign promotion:
 * 1) match or provision Merchant from network advertiser name
 * 2) create/refresh CanonicalCampaign + CampaignSource (network supplier source)
 *
 * CampaignSource is the SoT for isAssignable channel/relationship snapshots.
 */
export class CampaignNormalizationService {
  constructor(deps = {}) {
    this.merchantMatching = deps.merchantMatching ?? new MerchantMatchingService();
    this.merchantService = deps.merchantService ?? new MerchantService();
    this.catalogService = deps.catalogService ?? new CatalogService();
    this.campaignRepo = deps.campaignRepo ?? new SupplierCampaignRepository();
  }

  /**
   * @param {object} supplierCampaign
   * @param {{ matchedBy?: string|null }} [options]
   */
  async normalizeSupplierCampaign(supplierCampaign, { matchedBy = "promotion" } = {}) {
    if (!supplierCampaign?.id) {
      return {
        supplierCampaignId: null,
        matchOutcome: null,
        catalogLinked: false,
        canonicalCampaignId: null,
        blockedReason: "missing_supplier_campaign",
      };
    }

    let working = supplierCampaign;
    let match = null;
    if (!working.merchantId) {
      match = await this.merchantMatching.matchCampaign(working, { matchedBy });
    } else {
      match = {
        outcome: MATCH_OUTCOMES.MATCHED,
        merchantId: working.merchantId,
        reviewStatus: null,
        canonicalCampaignId: null,
      };
    }

    let merchantId = match?.merchantId ?? working.merchantId ?? null;
    let linked = Boolean(
      (merchantId && match?.outcome === MATCH_OUTCOMES.MATCHED) || working.merchantId,
    );

    // Network fetch path: provision Merchant from advertiser name so CampaignSource can exist.
    if (!linked) {
      const advertiser =
        working.merchantNameRaw ||
        working.campaignName ||
        null;
      if (advertiser) {
        try {
          const merchant = await this.merchantService.findOrCreateFromNetworkAdvertiser({
            displayName: advertiser,
            website: working.destinationUrl || null,
            logoUrl: working.campaignLogoUrl || null,
            country: Array.isArray(working.countryCodes) ? working.countryCodes[0] : null,
            networkSource: working.supplier || null,
            category: working.categoryName || working.merchantVertical || null,
          });
          working = await this.campaignRepo.update(working.id, {
            merchantId: merchant.id,
            matchedAt: new Date(),
            matchedBy: matchedBy || "network_provision",
            matchConfidence: 1,
          });
          merchantId = merchant.id;
          linked = true;
          match = {
            outcome: MATCH_OUTCOMES.MATCHED,
            merchantId,
            matchMethod: "network_provision",
            reviewStatus: null,
            canonicalCampaignId: null,
          };
        } catch (error) {
          logger.warn(
            {
              err: error?.message || String(error),
              supplierCampaignId: working.id,
              advertiser,
            },
            "network merchant provision failed",
          );
        }
      }
    }

    if (!linked) {
      let blockedReason = "merchant_needs_review";
      if (!working.merchantNameRaw && !match?.merchantId) {
        blockedReason = "missing_merchant_identifier";
      } else if (match?.outcome === MATCH_OUTCOMES.NO_MATCH) {
        blockedReason = "merchant_no_match";
      } else if (match?.outcome === MATCH_OUTCOMES.NEEDS_REVIEW) {
        blockedReason = "merchant_needs_review";
      }

      return {
        supplierCampaignId: working.id,
        matchOutcome: match?.outcome ?? null,
        matchMethod: match?.matchMethod ?? null,
        reviewStatus: match?.reviewStatus ?? null,
        merchantId,
        catalogLinked: false,
        canonicalCampaignId: null,
        blockedReason,
      };
    }

    if (match?.canonicalCampaignId) {
      return {
        supplierCampaignId: working.id,
        matchOutcome: MATCH_OUTCOMES.MATCHED,
        matchMethod: match?.matchMethod ?? null,
        reviewStatus: match?.reviewStatus ?? null,
        merchantId,
        catalogLinked: true,
        canonicalCampaignId: match.canonicalCampaignId,
        blockedReason: null,
      };
    }

    try {
      const canonicalCampaignId = await this.catalogService.ensureFromSupplierCampaign(working.id);
      return {
        supplierCampaignId: working.id,
        matchOutcome: MATCH_OUTCOMES.MATCHED,
        matchMethod: match?.matchMethod ?? null,
        reviewStatus: match?.reviewStatus ?? null,
        merchantId,
        catalogLinked: true,
        canonicalCampaignId,
        blockedReason: null,
      };
    } catch (error) {
      logger.warn(
        {
          err: error?.message || String(error),
          supplierCampaignId: working.id,
        },
        "catalog link after merchant match failed",
      );
      return {
        supplierCampaignId: working.id,
        matchOutcome: MATCH_OUTCOMES.MATCHED,
        matchMethod: match?.matchMethod ?? null,
        reviewStatus: match?.reviewStatus ?? null,
        merchantId,
        catalogLinked: false,
        canonicalCampaignId: null,
        blockedReason: "catalog_link_failed",
        error: error?.message || String(error),
      };
    }
  }
}
