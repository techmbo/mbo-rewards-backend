import { prisma } from "../../../database/prisma.js";
import { isPrismaUniqueViolation } from "../../../core/prismaErrors.js";
import { DOMAIN_EVENTS } from "../events/types.js";
import { mapEntityToSupplierCoupon, MapperError } from "../mappers/index.js";
import { parseNetworkSource, parseSourceAccountLabel } from "../entityIdentity.js";
import { SupplierCampaignRepository } from "../repositories/supplierCampaign.repository.js";
import { SupplierCouponRepository } from "../repositories/supplierCoupon.repository.js";
import { findLatestRawPayloadForEntity } from "../../raw/rawPayload.service.js";
import { OutboxWriter, PromotionService } from "./promotion.service.js";

function toCouponWriteData(mapped, supplierCampaignId, { isCreate = false, rawPayloadId = null } = {}) {
  const data = {
    supplierCampaign: { connect: { id: supplierCampaignId } },
    supplierCouponId: mapped.supplierCouponId,
    couponType: mapped.couponType,
    couponCode: mapped.couponCode,
    couponLink: mapped.couponLink,
    couponDescription: mapped.couponDescription,
    discountValue: mapped.discountValue,
    couponStartDate: mapped.couponStartDate,
    couponEndDate: mapped.couponEndDate,
    couponStatus: mapped.couponStatus,
    couponIsExclusive: mapped.couponIsExclusive,
    title: mapped.title,
    promotionDescription: mapped.promotionDescription,
    discountType: mapped.discountType,
    customerType: mapped.customerType,
    country: mapped.country,
    networkSource: mapped.networkSource,
    sourceObject: mapped.sourceObject,
    sourcePath: mapped.sourcePath,
    mappingStatus: mapped.mappingStatus,
    fieldMappingOutcome: mapped.fieldMappingOutcome,
    mappingVersion: mapped.mappingVersion ?? mapped.mapperVersion,
    rawPayload: mapped.rawPayload,
    normalizedPayload: mapped.normalizedPayload,
    mapperVersion: mapped.mapperVersion,
    lastSyncedAt: mapped.lastSyncedAt ?? new Date(),
  };

  if (mapped.entityId) {
    data.entity = { connect: { id: mapped.entityId } };
  }
  if (rawPayloadId) {
    data.rawPayloadRecord = { connect: { id: rawPayloadId } };
  }

  if (isCreate) {
    data.firstSeenAt = mapped.firstSeenAt ?? new Date();
  }

  return data;
}

export class SupplierCouponPromotionService extends PromotionService {
  constructor(deps = {}) {
    super(deps);
    this.campaignRepo = deps.campaignRepo ?? new SupplierCampaignRepository();
    this.couponRepo = deps.couponRepo ?? new SupplierCouponRepository();
    this.outboxWriter = deps.outboxWriter ?? new OutboxWriter();
    this.runInTransaction = deps.runInTransaction ?? ((fn) => prisma.$transaction(fn));
  }

  async resolveParentCampaign(entity, mapped) {
    const { supplier, supplierRegion } = parseNetworkSource(entity.networkSource);
    const { sourceAccountLabel } = parseSourceAccountLabel(entity.externalId);

    if (mapped.parentSupplierCampaignId) {
      const byId = await this.campaignRepo.findByBusinessKey({
        supplier,
        supplierRegion,
        sourceAccountLabel,
        supplierCampaignId: mapped.parentSupplierCampaignId,
      });
      if (byId) return byId;
    }

    if (mapped.parentCampaignName) {
      return this.campaignRepo.findByCampaignName({
        supplier,
        supplierRegion,
        sourceAccountLabel,
        campaignName: mapped.parentCampaignName,
      });
    }

    return null;
  }

  async promoteEntity(entity) {
    const { supplier } = parseNetworkSource(entity.networkSource);

    try {
      const mapped = mapEntityToSupplierCoupon(entity);
      const parent = await this.resolveParentCampaign(entity, mapped);

      if (!parent) {
        throw new MapperError(
          "PARENT_CAMPAIGN_NOT_FOUND",
          `SupplierCampaign not found for parent id ${mapped.parentSupplierCampaignId}`,
        );
      }

      const naturalKey = {
        supplierCampaignId: parent.id,
        couponType: mapped.couponType,
        couponCode: mapped.couponCode,
        couponLink: mapped.couponLink,
      };

      const rawRow = entity?.id ? await findLatestRawPayloadForEntity(entity.id) : null;
      const rawPayloadId = rawRow?.id ?? null;

      let outcome = { result: "skipped", record: null };

      await this.runInTransaction(async (tx) => {
        const existingByEntity = await this.couponRepo.findByEntityId(entity.id, tx);
        const existing =
          existingByEntity ??
          (await this.couponRepo.findByNaturalKey(naturalKey, tx));

        const createData = toCouponWriteData(mapped, parent.id, { isCreate: true, rawPayloadId });
        const updateData = toCouponWriteData(mapped, parent.id, { isCreate: false, rawPayloadId });

        let record;
        let result;

        if (existing) {
          record = await this.couponRepo.update(existing.id, updateData, tx);
          result = "updated";
        } else {
          try {
            record = await this.couponRepo.create(createData, tx);
            result = "created";
          } catch (error) {
            if (!isPrismaUniqueViolation(error)) throw error;
            const raced =
              (await this.couponRepo.findByNaturalKey(naturalKey, tx)) ??
              (await this.couponRepo.findByEntityId(entity.id, tx));
            if (!raced) throw error;
            record = await this.couponRepo.update(raced.id, updateData, tx);
            result = "updated";
          }
        }

        await this.outboxWriter.append(tx, {
          eventType:
            result === "created"
              ? DOMAIN_EVENTS.SUPPLIER_COUPON_CREATED
              : DOMAIN_EVENTS.SUPPLIER_COUPON_UPDATED,
          aggregateId: record.id,
          payload: { supplierCouponId: record.id, entityId: entity.id },
        });

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

        outcome = { result, record };
      });

      // CouponCodeMaster inventory — new codes alert Network Ops; never mutates client assignments.
      if (outcome.record?.couponCode) {
        try {
          const { NetworkPortalService } = await import("../../networkPortal/networkPortal.service.js");
          const portal = new NetworkPortalService({ prisma });
          await portal.upsertCouponCodeMasterFromSupplierCoupon(outcome.record, {
            source: "NETWORK_API",
            isNew: outcome.result === "created",
          });
        } catch {
          // Inventory upsert is best-effort; supplier coupon promotion remains SoT.
        }
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
