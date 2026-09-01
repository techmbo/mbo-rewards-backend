import { prisma } from "../../../database/prisma.js";
import {
  AUTO_MATCH_CONFIDENCE,
  MATCH_METHODS,
  MATCH_OUTCOMES,
  REVIEW_CONFIDENCE,
} from "../constants.js";
import { normalizeMerchantName, tokenSimilarity } from "../normalizeName.js";
import { MerchantRepository } from "../repositories/merchant.repository.js";
import { MerchantAliasRepository } from "../repositories/merchantAlias.repository.js";
import { MerchantReviewRepository } from "../repositories/merchantReview.repository.js";
import { SupplierCampaignRepository } from "../../supplier/repositories/supplierCampaign.repository.js";
import { CatalogService } from "../../catalog/services/catalog.service.js";
import { logger } from "../../../platform/logging/logger.js";

export class MerchantMatchingService {
  constructor(deps = {}) {
    this.merchantRepo = deps.merchantRepo ?? new MerchantRepository();
    this.aliasRepo = deps.aliasRepo ?? new MerchantAliasRepository();
    this.reviewRepo = deps.reviewRepo ?? new MerchantReviewRepository();
    this.campaignRepo = deps.campaignRepo ?? new SupplierCampaignRepository();
    this.catalogService = deps.catalogService ?? new CatalogService();
  }

  async #linkCatalogWhenMerchantReady(supplierCampaignId, client = null) {
    try {
      return await this.catalogService.ensureFromSupplierCampaign(supplierCampaignId, client);
    } catch (error) {
      logger.warn(
        { err: error?.message || String(error), supplierCampaignId },
        "ensureFromSupplierCampaign after merchant link failed",
      );
      return null;
    }
  }

  scoreMatch({ method, similarity = 1 }) {
    switch (method) {
      case MATCH_METHODS.EXACT_NORMALIZED_NAME:
        return 1;
      case MATCH_METHODS.EXACT_ALIAS:
        return 0.98;
      case MATCH_METHODS.NORMALIZED_ALIAS:
        return 0.9;
      case MATCH_METHODS.FUZZY_NAME:
        return Math.max(REVIEW_CONFIDENCE, Math.min(0.94, similarity));
      default:
        return 0;
    }
  }

  async findMatchCandidate({ merchantNameRaw, supplier }, client = null) {
    const normalized = normalizeMerchantName(merchantNameRaw);
    if (!normalized) {
      return {
        merchantId: null,
        confidence: 0,
        matchMethod: MATCH_METHODS.NONE,
        outcome: MATCH_OUTCOMES.NO_MATCH,
      };
    }

    const exactMerchant = await this.merchantRepo.findByNormalizedName(normalized, client);
    if (exactMerchant) {
      return {
        merchantId: exactMerchant.id,
        confidence: this.scoreMatch({ method: MATCH_METHODS.EXACT_NORMALIZED_NAME }),
        matchMethod: MATCH_METHODS.EXACT_NORMALIZED_NAME,
        outcome: MATCH_OUTCOMES.MATCHED,
      };
    }

    const exactAlias = await this.aliasRepo.findBySupplierAlias(
      { supplier, aliasValue: merchantNameRaw.trim() },
      client,
    );
    if (exactAlias?.status === "CONFIRMED") {
      return {
        merchantId: exactAlias.merchantId,
        confidence: this.scoreMatch({ method: MATCH_METHODS.EXACT_ALIAS }),
        matchMethod: MATCH_METHODS.EXACT_ALIAS,
        outcome: MATCH_OUTCOMES.MATCHED,
      };
    }

    const normalizedAliases = await this.aliasRepo.findByNormalizedAlias(
      normalized,
      { supplier, status: "CONFIRMED" },
      client,
    );
    if (normalizedAliases.length) {
      return {
        merchantId: normalizedAliases[0].merchantId,
        confidence: this.scoreMatch({ method: MATCH_METHODS.NORMALIZED_ALIAS }),
        matchMethod: MATCH_METHODS.NORMALIZED_ALIAS,
        outcome: MATCH_OUTCOMES.MATCHED,
      };
    }

    const fuzzyCandidates = await this.merchantRepo.findByNormalizedNames([normalized], client);
    if (!fuzzyCandidates.length) {
      const allMerchants = await this.merchantRepo.findMany(
        { excludeMerged: true },
        { skip: 0, take: 200 },
        client,
      );

      let best = null;
      for (const merchant of allMerchants.rows) {
        const similarity = tokenSimilarity(merchantNameRaw, merchant.displayName);
        if (!best || similarity > best.similarity) {
          best = { merchant, similarity };
        }
      }

      if (best && best.similarity >= REVIEW_CONFIDENCE) {
        const confidence = this.scoreMatch({
          method: MATCH_METHODS.FUZZY_NAME,
          similarity: best.similarity,
        });
        return {
          merchantId: best.merchant.id,
          confidence,
          matchMethod: MATCH_METHODS.FUZZY_NAME,
          outcome: confidence >= AUTO_MATCH_CONFIDENCE ? MATCH_OUTCOMES.MATCHED : MATCH_OUTCOMES.NEEDS_REVIEW,
        };
      }
    }

    return {
      merchantId: null,
      confidence: 0,
      matchMethod: MATCH_METHODS.NONE,
      outcome: MATCH_OUTCOMES.NO_MATCH,
    };
  }

  resolveReviewStatus(match) {
    if (match.outcome === MATCH_OUTCOMES.MATCHED && match.confidence >= AUTO_MATCH_CONFIDENCE) {
      return "AUTO_MATCHED";
    }
    if (match.outcome === MATCH_OUTCOMES.NEEDS_REVIEW || match.merchantId) {
      return "PENDING_REVIEW";
    }
    return "PENDING_REVIEW";
  }

  async matchCampaign(campaign, { matchedBy = null } = {}, client = null) {
    if (!campaign?.merchantNameRaw) {
      return {
        supplierCampaignId: campaign.id,
        outcome: MATCH_OUTCOMES.NO_MATCH,
        merchantId: null,
        confidence: 0,
        matchMethod: MATCH_METHODS.NONE,
      };
    }

    if (campaign.merchantId) {
      return {
        supplierCampaignId: campaign.id,
        outcome: MATCH_OUTCOMES.MATCHED,
        merchantId: campaign.merchantId,
        confidence: campaign.matchConfidence?.toString?.() ?? null,
        matchMethod: MATCH_METHODS.MANUAL,
      };
    }

    const match = await this.findMatchCandidate(
      { merchantNameRaw: campaign.merchantNameRaw, supplier: campaign.supplier },
      client,
    );

    const reviewStatus = this.resolveReviewStatus(match);
    const shouldAutoLink = match.merchantId && match.confidence >= AUTO_MATCH_CONFIDENCE;

    const review = await this.reviewRepo.upsertBySupplierCampaignId(
      campaign.id,
      {
        merchantId: match.merchantId,
        merchantNameRaw: campaign.merchantNameRaw,
        supplier: campaign.supplier,
        status: reviewStatus,
        confidence: match.confidence,
        matchMethod: match.matchMethod,
      },
      {
        merchantId: match.merchantId,
        merchantNameRaw: campaign.merchantNameRaw,
        status: reviewStatus,
        confidence: match.confidence,
        matchMethod: match.matchMethod,
      },
      client,
    );

    let canonicalCampaignId = null;
    if (shouldAutoLink) {
      await this.campaignRepo.linkMerchant(
        campaign.id,
        {
          merchantId: match.merchantId,
          matchedAt: new Date(),
          matchedBy,
          matchConfidence: match.confidence,
        },
        client,
      );

      // Preserve supplier logo onto Merchant when master logo is empty (truthful, no invent).
      if (campaign.campaignLogoUrl) {
        try {
          const merchant = await this.merchantRepo.findById(match.merchantId, client);
          if (merchant && !merchant.logoUrl) {
            await this.merchantRepo.update(
              match.merchantId,
              { logoUrl: String(campaign.campaignLogoUrl).trim() },
              client,
            );
          }
        } catch {
          // best-effort brand enrichment
        }
      }

      await this.aliasRepo.upsertBySupplierAlias(
        { supplier: campaign.supplier, aliasValue: campaign.merchantNameRaw.trim() },
        {
          merchantId: match.merchantId,
          normalizedAlias: normalizeMerchantName(campaign.merchantNameRaw),
          confidence: match.confidence,
          source: "MATCHING",
          status: "CONFIRMED",
        },
        {
          merchantId: match.merchantId,
          normalizedAlias: normalizeMerchantName(campaign.merchantNameRaw),
          confidence: match.confidence,
          status: "CONFIRMED",
        },
        client,
      );

      canonicalCampaignId = await this.#linkCatalogWhenMerchantReady(campaign.id, client);
    }

    return {
      supplierCampaignId: campaign.id,
      outcome: shouldAutoLink ? MATCH_OUTCOMES.MATCHED : match.outcome === MATCH_OUTCOMES.MATCHED ? MATCH_OUTCOMES.NEEDS_REVIEW : match.outcome,
      merchantId: match.merchantId,
      confidence: match.confidence,
      matchMethod: match.matchMethod,
      reviewId: review.id,
      reviewStatus: review.status,
      canonicalCampaignId,
    };
  }

  async run({ supplierCampaignIds, batchSize = 100, supplier, matchedBy = null } = {}) {
    const campaigns = await this.campaignRepo.findUnmatchedForMatching(
      { supplierCampaignIds, batchSize, supplier },
    );

    const results = [];
    for (const campaign of campaigns) {
      const result = await this.matchCampaign(campaign, { matchedBy });
      results.push(result);
    }

    return {
      processed: results.length,
      matched: results.filter((r) => r.outcome === MATCH_OUTCOMES.MATCHED).length,
      needsReview: results.filter((r) => r.outcome === MATCH_OUTCOMES.NEEDS_REVIEW).length,
      noMatch: results.filter((r) => r.outcome === MATCH_OUTCOMES.NO_MATCH).length,
      results,
    };
  }

  async resolveReview(reviewId, { status, merchantId, notes, reviewedBy }, client = null) {
    const review = await this.reviewRepo.findById(reviewId, client);
    if (!review) return null;

    const run = async (tx) => {
      const campaign = await this.campaignRepo.findById(review.supplierCampaignId, tx);
      if (!campaign) return null;

      if (status === "MANUALLY_MATCHED") {
        if (!merchantId) throw new Error("merchantId is required for manual match.");
        const merchant = await this.merchantRepo.findById(merchantId, tx);
        if (!merchant) throw new Error("Merchant not found.");

        await this.campaignRepo.linkMerchant(
          campaign.id,
          {
            merchantId,
            matchedAt: new Date(),
            matchedBy: reviewedBy,
            matchConfidence: review.confidence ?? 1,
          },
          tx,
        );

        await this.aliasRepo.upsertBySupplierAlias(
          { supplier: campaign.supplier, aliasValue: campaign.merchantNameRaw.trim() },
          {
            merchantId,
            normalizedAlias: normalizeMerchantName(campaign.merchantNameRaw),
            confidence: review.confidence ?? 1,
            source: "MANUAL",
            status: "CONFIRMED",
          },
          {
            merchantId,
            normalizedAlias: normalizeMerchantName(campaign.merchantNameRaw),
            confidence: review.confidence ?? 1,
            status: "CONFIRMED",
            source: "MANUAL",
          },
          tx,
        );

        await this.#linkCatalogWhenMerchantReady(campaign.id, tx);
      }

      return this.reviewRepo.update(
        reviewId,
        {
          status,
          merchantId: status === "MANUALLY_MATCHED" ? merchantId : review.merchantId,
          notes: notes ?? review.notes,
          reviewedBy,
          reviewedAt: new Date(),
        },
        tx,
      );
    };

    if (client) return run(client);
    return prisma.$transaction(run);
  }
}
