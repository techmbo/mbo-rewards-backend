import { prisma } from "../../../database/prisma.js";
import { isPrismaUniqueViolation } from "../../../core/prismaErrors.js";
import { DOMAIN_EVENTS } from "../events/types.js";
import { mapEntityToSupplierCampaign, MapperError } from "../mappers/index.js";
import { asOptionalString } from "../mappers/shared.js";
import { parseNetworkSource } from "../entityIdentity.js";
import { SupplierCampaignRepository } from "../repositories/supplierCampaign.repository.js";
import { findLatestRawPayloadForEntity } from "../../raw/rawPayload.service.js";
import { OutboxWriter, PromotionService } from "./promotion.service.js";
import { buildSupplierCampaignMboTracking } from "../../commercial/supplierCampaignTracking.js";

function toCampaignWriteData(
  mapped,
  supplierRefId,
  { isCreate = false, rawPayloadId = null, existing = null } = {},
) {
  const data = {
    supplier: mapped.supplier,
    supplierRegion: mapped.supplierRegion,
    supplierCampaignId: mapped.supplierCampaignId,
    sourceAccountLabel: mapped.sourceAccountLabel,
    campaignName: asOptionalString(mapped.campaignName) ?? String(mapped.supplierCampaignId),
    campaignDescription: asOptionalString(mapped.campaignDescription),
    campaignLogoUrl: asOptionalString(mapped.campaignLogoUrl),
    merchantNameRaw: asOptionalString(mapped.merchantNameRaw),
    merchantVertical: asOptionalString(mapped.merchantVertical),
    categoryName: asOptionalString(mapped.categoryName),
    campaignType: asOptionalString(mapped.campaignType),
    pricingModel: mapped.pricingModel === "UNKNOWN" ? null : mapped.pricingModel,
    defaultCommissionValue: mapped.defaultCommissionValue,
    commissionUnit: mapped.commissionUnit === "UNKNOWN" ? null : mapped.commissionUnit,
    commissionCurrency: asOptionalString(mapped.commissionCurrency)?.slice(0, 3) ?? null,
    commissionGroups: mapped.commissionGroups,
    trackingUrl: asOptionalString(mapped.trackingUrl),
    destinationUrl: asOptionalString(mapped.destinationUrl),
    deepLinkingEnabled: mapped.deepLinkingEnabled,
    cookieDurationDays: mapped.cookieDurationDays,
    campaignStatus: mapped.campaignStatus,
    participationStatus: mapped.participationStatus === "UNKNOWN" ? null : mapped.participationStatus,
    isJoined: mapped.isJoined,
    countryCodes: mapped.countryCodes ?? [],
    currencyCode: asOptionalString(mapped.currencyCode)?.slice(0, 3) ?? null,
    campaignStartDate: mapped.campaignStartDate,
    rawPayload: mapped.rawPayload,
    normalizedPayload: mapped.normalizedPayload,
    mapperVersion: mapped.mapperVersion,
    syncConflict: mapped.syncConflict ?? false,
    fieldPolicies: mapped.fieldPolicies,
    adminOverrides: mapped.adminOverrides,
    lastSyncedAt: mapped.lastSyncedAt ?? new Date(),
  };

  if (mapped.entityId) {
    data.entity = { connect: { id: mapped.entityId } };
  }
  if (rawPayloadId) {
    data.rawPayloadRecord = { connect: { id: rawPayloadId } };
  }
  if (supplierRefId) {
    data.supplierRef = { connect: { id: supplierRefId } };
  }

  const mboTracking = buildSupplierCampaignMboTracking(mapped, existing);
  data.mboTrackingSlug = mboTracking.mboTrackingSlug;
  data.mboTrackingToken = mboTracking.mboTrackingToken;
  data.mboTrackingUrl = mboTracking.mboTrackingUrl;

  if (isCreate) {
    data.firstSeenAt = mapped.firstSeenAt ?? new Date();
  }

  return data;
}

export class SupplierCampaignPromotionService extends PromotionService {
  constructor(deps = {}) {
    super(deps);
    this.campaignRepo = deps.campaignRepo ?? new SupplierCampaignRepository();
    this.outboxWriter = deps.outboxWriter ?? new OutboxWriter();
    this.runInTransaction = deps.runInTransaction ?? ((fn) => prisma.$transaction(fn));
  }

  async upsertCampaign(tx, businessKey, mapped, supplierRefId, entity, rawPayloadId = null) {
    const existing = await this.campaignRepo.findByBusinessKey(businessKey, tx);
    const createData = toCampaignWriteData(mapped, supplierRefId, { isCreate: true, rawPayloadId, existing });
    const updateData = toCampaignWriteData(mapped, supplierRefId, { isCreate: false, rawPayloadId, existing });

    let record;
    try {
      record = await this.campaignRepo.upsertByBusinessKey(businessKey, createData, updateData, tx);
    } catch (error) {
      if (!isPrismaUniqueViolation(error)) throw error;
      const raced = await this.campaignRepo.findByBusinessKey(businessKey, tx);
      if (!raced) throw error;
      record = await this.campaignRepo.update(raced.id, updateData, tx);
    }

    const result = existing ? "updated" : "created";

    await this.outboxWriter.append(tx, {
      eventType:
        result === "created"
          ? DOMAIN_EVENTS.SUPPLIER_CAMPAIGN_CREATED
          : DOMAIN_EVENTS.SUPPLIER_CAMPAIGN_UPDATED,
      aggregateId: record.id,
      payload: { supplierCampaignId: record.id, entityId: entity.id },
    });

    if (mapped.campaignStatus === "RETIRED" && !record.archivedAt) {
      record = await this.campaignRepo.update(record.id, { archivedAt: new Date() }, tx);
      await this.outboxWriter.append(tx, {
        eventType: DOMAIN_EVENTS.SUPPLIER_CAMPAIGN_ARCHIVED,
        aggregateId: record.id,
        payload: { supplierCampaignId: record.id, entityId: entity.id },
      });
    }

    return { result, record };
  }

  async promoteEntity(entity) {
    const { supplier } = parseNetworkSource(entity.networkSource);

    try {
      const mapped = mapEntityToSupplierCampaign(entity);
      const supplierRow = await this.supplierRepo.findByKey(mapped.supplier);
      const supplierRefId = supplierRow?.id ?? null;

      const businessKey = {
        supplier: mapped.supplier,
        supplierRegion: mapped.supplierRegion,
        sourceAccountLabel: mapped.sourceAccountLabel,
        supplierCampaignId: mapped.supplierCampaignId,
      };

      const rawRow = entity?.id ? await findLatestRawPayloadForEntity(entity.id) : null;
      const rawPayloadId = rawRow?.id ?? null;

      let outcome = { result: "skipped", record: null };

      await this.runInTransaction(async (tx) => {
        outcome = await this.upsertCampaign(tx, businessKey, mapped, supplierRefId, entity, rawPayloadId);
        if (rawPayloadId && tx.rawPayload?.update) {
          try {
            await tx.rawPayload.update({
              where: { id: rawPayloadId },
              data: { processingStatus: "PROMOTED", entityId: entity.id },
            });
          } catch {
            // Lineage status is best-effort.
          }
        }
      });

      const openError = await this.mapperErrorRepo.findOpenByEntityId(entity.id);
      if (openError) {
        await this.mapperErrorRepo.updateStatus(openError.id, "RESOLVED", {
          message: openError.message,
        });
      }

      return outcome;
    } catch (error) {
      const mapperError =
        error instanceof MapperError
          ? error
          : new MapperError("PROMOTION_FAILED", error.message, { cause: error });

      await this.recordMapperFailure(entity, {
        code: mapperError.code,
        message: mapperError.message,
        stack: mapperError.stack,
        supplier,
      });

      return { result: "failed", error: mapperError };
    }
  }
}
