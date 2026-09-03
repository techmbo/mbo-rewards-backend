import { prisma } from "../../database/prisma.js";
import { parseSourceAccountLabel } from "../supplier/entityIdentity.js";
import { mapRakutenOfferCommissionCandidates } from "./rakutenOfferCommission.mapper.js";
import { SupplierCommissionRuleService } from "./services/supplierCommissionRule.service.js";

function text(value) {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

function validDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function resolveSourceEvidenceAt(entity = {}) {
  return validDate(
    entity?.lastSyncedData?.fetchedAt ??
      entity?.lastSyncedData?.receivedAt ??
      entity?.updatedAt ??
      entity?.createdAt ??
      null,
  );
}

function sourceAccountLabelFromEntity(entity = {}) {
  return parseSourceAccountLabel(entity.externalId).sourceAccountLabel || "default";
}

function advertiserIdFromOffer(raw = {}) {
  return raw?.advertiser?.id ?? raw?.advertiser_id ?? raw?.advertiserId ?? null;
}

function offerCurrency(raw = {}, supplierCampaign = null) {
  const value =
    raw?.currency ??
    raw?.currency_code ??
    raw?.currencyCode ??
    supplierCampaign?.currencyCode ??
    supplierCampaign?.commissionCurrency ??
    null;
  return value ? String(value).slice(0, 3).toUpperCase() : null;
}

/**
 * Persist Rakuten offer commission candidates only after the advertiser master has
 * been promoted to SupplierCampaign. Review-required candidates are persisted as
 * source evidence but remain finance-ineligible through their mappingStatus and
 * metadata.financeReady=false. This prevents source economics from being lost while
 * still keeping unverified dynamic/tier semantics out of payable calculations.
 */
export class RakutenCommissionPersistenceService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.ruleService = deps.ruleService ?? new SupplierCommissionRuleService({ prisma: this.db });
  }

  async persistOfferEntity(entity, client = null) {
    const db = client ?? this.db;
    if (!entity || entity.networkSource !== "rakuten" || entity.entityType !== "offer") {
      return { persisted: 0, skipped: true, reason: "not_rakuten_offer" };
    }

    const raw = entity.rawData ?? {};
    const sourceAdvertiserId = advertiserIdFromOffer(raw);
    if (sourceAdvertiserId === null || sourceAdvertiserId === undefined || sourceAdvertiserId === "") {
      return { persisted: 0, skipped: true, reason: "missing_advertiser_id" };
    }

    const sourceAccountLabel = sourceAccountLabelFromEntity(entity);
    const supplierCampaign = await db.supplierCampaign.findFirst({
      where: {
        supplier: "RAKUTEN",
        sourceAccountLabel,
        supplierCampaignId: String(sourceAdvertiserId),
        archivedAt: null,
      },
      include: {
        campaignSources: {
          where: { isActive: true },
          orderBy: [{ isPrimary: "desc" }, { priority: "asc" }, { createdAt: "asc" }],
          take: 1,
        },
      },
    });

    if (!supplierCampaign) {
      return {
        persisted: 0,
        skipped: true,
        reason: "supplier_campaign_not_promoted",
        sourceAdvertiserId: String(sourceAdvertiserId),
      };
    }

    const campaignSourceId = supplierCampaign.campaignSources?.[0]?.id ?? null;
    const candidates = mapRakutenOfferCommissionCandidates(raw, {
      sourceAccountLabel,
      campaignSourceId,
      supplierCampaignId: supplierCampaign.id,
      currency: offerCurrency(raw, supplierCampaign),
    });

    let persisted = 0;
    let financeReady = 0;
    let reviewRequired = 0;
    for (const candidate of candidates) {
      await this.ruleService.upsertNormalizedFact({
        ...candidate,
        supplierCampaignId: supplierCampaign.id,
        campaignSourceId,
        sourceAccountLabel,
        sourceEvidenceAt: resolveSourceEvidenceAt(entity),
        metadata: {
          ...(candidate.metadata ?? {}),
          sourceEntityId: entity.id ?? null,
          sourceAdvertiserId: String(sourceAdvertiserId),
          supplierCampaignDbId: supplierCampaign.id,
          campaignSourceId,
        },
      }, db);
      persisted += 1;
      if (candidate.metadata?.financeReady === true && candidate.mappingStatus === "VERIFIED") {
        financeReady += 1;
      } else {
        reviewRequired += 1;
      }
    }

    return {
      persisted,
      financeReady,
      reviewRequired,
      skipped: false,
      supplierCampaignId: supplierCampaign.id,
      sourceAdvertiserId: String(sourceAdvertiserId),
      campaignSourceId,
      offerId: text(raw.goid ?? raw.offer_number ?? raw.id),
    };
  }

  async persistStagedOffers({ sourceAccountLabel = null, limit = 500 } = {}) {
    const where = { networkSource: "rakuten", entityType: "offer" };
    if (sourceAccountLabel && sourceAccountLabel !== "default") {
      where.externalId = { startsWith: `${sourceAccountLabel}:` };
    } else if (sourceAccountLabel === "default") {
      where.NOT = { externalId: { contains: ":" } };
    }

    const entities = await this.db.entity.findMany({
      where,
      take: Math.max(1, Math.min(Number(limit) || 500, 5000)),
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    });

    const summary = {
      examined: entities.length,
      persisted: 0,
      financeReady: 0,
      reviewRequired: 0,
      skipped: 0,
      skipReasons: {},
    };

    for (const entity of entities) {
      // eslint-disable-next-line no-await-in-loop
      const result = await this.persistOfferEntity(entity);
      if (result.skipped) {
        summary.skipped += 1;
        const reason = result.reason || "unknown";
        summary.skipReasons[reason] = (summary.skipReasons[reason] || 0) + 1;
        continue;
      }
      summary.persisted += result.persisted || 0;
      summary.financeReady += result.financeReady || 0;
      summary.reviewRequired += result.reviewRequired || 0;
    }

    return summary;
  }
}

export async function persistRakutenCommissionOffers(options = {}) {
  const service = new RakutenCommissionPersistenceService();
  return service.persistStagedOffers(options);
}
