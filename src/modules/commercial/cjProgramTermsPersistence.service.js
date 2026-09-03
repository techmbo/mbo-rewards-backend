import { prisma } from "../../database/prisma.js";
import { mapCjProgramTermsCommissionCandidates } from "./cjProgramTerms.mapper.js";
import { SupplierCommissionRuleService } from "./services/supplierCommissionRule.service.js";

function text(value) {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

function validDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Persists verified CJ Program Terms contracts into the generic SupplierCommissionRule
 * history model. Transport is deliberately separate: callers must supply contracts
 * obtained from a verified CJ Publisher Program Terms response/fixture.
 */
export class CjProgramTermsPersistenceService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.ruleService = deps.ruleService ?? new SupplierCommissionRuleService({ prisma: this.db });
  }

  async persistContract(contract, context = {}, client = null) {
    const db = client ?? this.db;
    const advertiserId = contract?.advertiserId ?? context.advertiserId ?? null;
    if (advertiserId === null || advertiserId === undefined || advertiserId === "") {
      return { persisted: 0, skipped: true, reason: "missing_advertiser_id" };
    }

    const sourceAccountLabel = context.sourceAccountLabel ?? "default";
    const supplierCampaign = await db.supplierCampaign.findFirst({
      where: {
        supplier: "CJ",
        sourceAccountLabel,
        supplierCampaignId: String(advertiserId),
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
        advertiserId: String(advertiserId),
      };
    }

    const campaignSourceId = supplierCampaign.campaignSources?.[0]?.id ?? null;
    const candidates = mapCjProgramTermsCommissionCandidates(contract, {
      sourceAccountLabel,
      campaignSourceId,
      advertiserId: String(advertiserId),
    });

    const sourceEvidenceAt =
      validDate(context.sourceEvidenceAt) ??
      validDate(context.fetchedAt) ??
      validDate(contract?.updatedAt) ??
      validDate(contract?.startTime) ??
      null;

    let persisted = 0;
    let financeReady = 0;
    let reviewRequired = 0;

    for (const candidate of candidates) {
      // eslint-disable-next-line no-await-in-loop
      await this.ruleService.upsertNormalizedFact({
        ...candidate,
        supplierCampaignId: supplierCampaign.id,
        campaignSourceId,
        sourceAccountLabel,
        sourceEvidenceAt,
        metadata: {
          ...(candidate.metadata ?? {}),
          supplierCampaignDbId: supplierCampaign.id,
          campaignSourceId,
          cjAdvertiserId: String(advertiserId),
          cjProgramTermsId: text(contract?.programTerms?.id),
          cjContractStatus: text(contract?.status),
          sourceTransportVerified: context.sourceTransportVerified === true,
        },
      }, db);
      persisted += 1;
      if (candidate.mappingStatus === "VERIFIED" && candidate.metadata?.financeReady === true) {
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
      advertiserId: String(advertiserId),
      supplierCampaignId: supplierCampaign.id,
      campaignSourceId,
      programTermsId: text(contract?.programTerms?.id),
    };
  }

  async persistContracts(contracts = [], context = {}) {
    const summary = {
      examined: Array.isArray(contracts) ? contracts.length : 0,
      persisted: 0,
      financeReady: 0,
      reviewRequired: 0,
      skipped: 0,
      skipReasons: {},
    };

    for (const contract of Array.isArray(contracts) ? contracts : []) {
      // eslint-disable-next-line no-await-in-loop
      const result = await this.persistContract(contract, context);
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
