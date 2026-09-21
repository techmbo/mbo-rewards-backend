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

/**
 * Whether a coupon found by NATURAL KEY may be adopted as this entity's row.
 *
 * The natural key is (parent, couponType, couponCode | couponLink). It does NOT contain the
 * supplier's own coupon identity, so two GENUINELY DIFFERENT supplier offers that share a parent
 * and a link — or a parent and a code — look identical to it. Awin proves this at scale: a
 * code-less promotion carries the advertiser's generic tracking link, so every such promotion for
 * one advertiser shares one natural key. Adopting the match then made each offer overwrite the
 * previous one's entityId and supplierCouponId, leaving the earlier entities with no row at all
 * while every one of them reported "updated" — a success that resolved its mapper error.
 *
 * The key remains useful for what it was built for: a row staged before entityId linkage existed,
 * which has no owner and no supplier identity to contradict. So a match is adopted only when it
 * cannot belong to some OTHER supplier coupon:
 *
 *   - it is unowned, or already owned by this entity; AND
 *   - it carries no supplierCouponId, or the same one this entity maps to.
 *
 * Anything else is a different coupon that happens to share a link, and it gets its own row.
 */
export function canAdoptCouponByNaturalKey(candidate, { entityId, supplierCouponId } = {}) {
  if (!candidate) return false;
  if (candidate.entityId && candidate.entityId !== entityId) return false;
  if (
    candidate.supplierCouponId &&
    supplierCouponId &&
    String(candidate.supplierCouponId) !== String(supplierCouponId)
  ) {
    return false;
  }
  return true;
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
        // The entity's OWN row always wins. Only when it has none does the natural key get a say,
        // and then only over a row that no other supplier coupon has claimed.
        const byNaturalKey = existingByEntity
          ? null
          : await this.couponRepo.findByNaturalKey(naturalKey, tx);
        const existing =
          existingByEntity ??
          (canAdoptCouponByNaturalKey(byNaturalKey, {
            entityId: entity.id,
            supplierCouponId: mapped.supplierCouponId,
          })
            ? byNaturalKey
            : null);

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
            // Same rule on the race path: a row another coupon owns is not ours to take, so a
            // genuine unique violation is re-thrown rather than resolved by overwriting a stranger.
            const racedByEntity = await this.couponRepo.findByEntityId(entity.id, tx);
            const racedByNaturalKey = racedByEntity
              ? null
              : await this.couponRepo.findByNaturalKey(naturalKey, tx);
            const raced =
              racedByEntity ??
              (canAdoptCouponByNaturalKey(racedByNaturalKey, {
                entityId: entity.id,
                supplierCouponId: mapped.supplierCouponId,
              })
                ? racedByNaturalKey
                : null);
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

      // A coupon that failed earlier — most often PARENT_CAMPAIGN_NOT_FOUND, because its parent
      // campaign had not been promoted yet — leaves an OPEN MapperError behind. Promotion has now
      // succeeded, so that error describes a state that no longer exists and must be closed here,
      // on the normal walk, rather than waiting for an explicit retryFailed run. This is the same
      // lifecycle SupplierCampaignPromotionService already applies, deliberately reusing its
      // repository calls rather than introducing a second one: reached only after the transaction
      // committed, so a coupon that still fails throws past it and its error stays OPEN.
      const openError = await this.mapperErrorRepo.findOpenByEntityId(entity.id);
      if (openError) {
        await this.mapperErrorRepo.updateStatus(openError.id, "RESOLVED", {
          message: openError.message,
        });
      }

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
