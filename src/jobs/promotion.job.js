import { PROMOTION_BATCH_SIZE, SUPPLIER_ENTITY_TYPES } from "../modules/supplier/constants.js";
import { EntityRepository, MapperErrorRepository } from "../modules/supplier/repositories/index.js";
import { PromotionService } from "../modules/supplier/services/promotion.service.js";
import { SupplierCampaignPromotionService } from "../modules/supplier/services/supplierCampaignPromotion.service.js";
import {
  TrackierPayoutPersistenceService,
  TRACKIER_NETWORK_SOURCE,
} from "../modules/commercial/trackierPayoutPersistence.service.js";
import { SupplierCouponPromotionService } from "../modules/supplier/services/supplierCouponPromotion.service.js";
import { AWIN_NETWORK_SOURCE } from "../modules/supplier/services/awinAdvertiserParent.service.js";
import { CampaignNormalizationService } from "../modules/ops/campaignNormalization.service.js";
import {
  RakutenCommissionPersistenceService,
  persistRakutenCommissionOffers,
} from "../modules/commercial/rakutenCommissionPersistence.service.js";
import {
  OFFER_ENTITY_TYPE,
  OFFER_NETWORK_SOURCE,
  PROMOTION_PAGE_SIZE,
} from "./promotionUnit.js";
import { DEFAULT_LEASE_MS } from "./syncAccountLock.service.js";
import { logger } from "../platform/logging/logger.js";

function emptySummary() {
  return {
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    durationMs: 0,
    processed: 0,
    merchantMatched: 0,
    merchantNeedsReview: 0,
    catalogLinked: 0,
    // Retry only. `recovered`: a thrown retry whose row this job moved RETRYING -> OPEN.
    // `reclaimedStale`: a RETRYING row whose lease had expired and was claimed again.
    recovered: 0,
    reclaimedStale: 0,
  };
}

/**
 * How long a MapperError may sit in RETRYING before an automatic retry may reclaim it.
 *
 * A retry runs synchronously inside one serverless invocation, and the repository assumes a hard
 * ceiling of ~300 s for that invocation. The lease must outlive the longest invocation that could
 * legitimately still be working the row, so 5 minutes is too tight: an invocation that approaches
 * the cap would have its row stolen while it is still running. The durable sync worker already
 * settled this at 10 minutes (`DEFAULT_LEASE_MS`, "longer than a serverless invocation can live"),
 * and the same constant is reused here so there is exactly one lease length to reason about.
 */
export const MAPPER_ERROR_RETRY_LEASE_MS = DEFAULT_LEASE_MS;

/** The statuses an explicit retry (operator-selected ids) may claim. Nothing else re-enters. */
const EXPLICIT_RETRY_CLAIMABLE = new Set(["OPEN", "RETRYING"]);

/** A safe error code for logs: never the message, never the stack. */
function errorCodeOf(error) {
  return error?.code ?? error?.name ?? "Error";
}

function accumulate(summary, result) {
  if (result.result === "created") summary.created += 1;
  else if (result.result === "updated") summary.updated += 1;
  else if (result.result === "failed") summary.failed += 1;
  else summary.skipped += 1;
  summary.processed += 1;

  const norm = result.normalization;
  if (!norm) return;
  if (norm.catalogLinked) summary.catalogLinked += 1;
  if (norm.matchOutcome === "matched") summary.merchantMatched += 1;
  if (norm.matchOutcome === "needs_review" || norm.blockedReason === "merchant_no_match" || norm.blockedReason === "missing_merchant_identifier") {
    summary.merchantNeedsReview += 1;
  }
}

/**
 * The most Awin entities this UNBOUNDED walk may be asked to drain in one invocation.
 *
 * Four durable promotion pages. An Awin campaign carries the full promotion cost — supplier
 * lookup, raw-payload lookup, an interactive transaction, a mapper-error lookup, then merchant
 * matching and possible merchant creation — and its coupons carry most of it again, so a drain of
 * the real estate is tens of thousands of serial queries and a Vercel invocation is 300 seconds.
 * Production proved it: 5,011 offers and ~1,418 advertisers timed out at exactly that limit.
 */
export const AWIN_UNBOUNDED_RUN_BUDGET = PROMOTION_PAGE_SIZE * 4;

/** The code an operator sees when the legacy drain is refused. */
export const AWIN_DURABLE_PROMOTION_REQUIRED = "awin_durable_promotion_required";

function scopeIncludesAwin(networkSource) {
  const network = String(networkSource || "").toLowerCase();
  return !network || network === AWIN_NETWORK_SOURCE;
}

/**
 * Refuse an Awin promotion that the unbounded endpoint cannot finish, BEFORE anything is written.
 *
 * Fail fast and whole. The alternative shapes are both worse: draining times the request out after
 * doing partial, unreported work, and quietly promoting one page would return success for a
 * fraction of the estate, which is a lie an operator would act on. Refusing costs one COUNT and
 * leaves the estate exactly as it was, so the caller can re-issue it as a durable run.
 *
 * Scoped runs are unaffected: an explicit entityIds list, or any network other than Awin, is
 * counted on its own terms and passes when it is small.
 */
export async function assertAwinPromotionWithinBudget(
  { entityTypes, networkSource, entityIds } = {},
  { entityRepo = new EntityRepository(), budget = AWIN_UNBOUNDED_RUN_BUDGET } = {},
) {
  if (!scopeIncludesAwin(networkSource)) return { checked: false, pending: null, budget };

  const types = Array.isArray(entityTypes)
    ? entityTypes
    : [SUPPLIER_ENTITY_TYPES.CAMPAIGN, SUPPLIER_ENTITY_TYPES.COUPON];

  const pending = await entityRepo.countForPromotion({
    entityTypes: types,
    networkSource: AWIN_NETWORK_SOURCE,
    entityIds,
  });

  if (pending <= budget) return { checked: true, pending, budget };

  const error = new Error(
    `Awin has ${pending} entities pending promotion, above the ${budget} this endpoint can finish inside one invocation. ` +
      "Nothing was processed. Run Awin promotion as a durable run so it advances one bounded page per invocation.",
  );
  error.code = AWIN_DURABLE_PROMOTION_REQUIRED;
  error.statusCode = 422;
  error.pending = pending;
  error.budget = budget;
  throw error;
}

function shouldRunRakutenCommissionPromotion({ entityTypes, networkSource } = {}) {
  const types = Array.isArray(entityTypes) ? entityTypes : [];
  const includesCampaign = types.includes(SUPPLIER_ENTITY_TYPES.CAMPAIGN);
  const network = String(networkSource || "").toLowerCase();
  return includesCampaign && (!network || network === "rakuten");
}

export class PromotionJob {
  constructor(deps = {}) {
    this.campaignPromotion = deps.campaignPromotion ?? new SupplierCampaignPromotionService();
    this.trackierPayouts = deps.trackierPayouts ?? new TrackierPayoutPersistenceService();
    this.couponPromotion = deps.couponPromotion ?? new SupplierCouponPromotionService();
    this.promotionService = deps.promotionService ?? new PromotionService();
    this.mapperErrorRepo = deps.mapperErrorRepo ?? new MapperErrorRepository();
    this.entityRepo = deps.entityRepo ?? new EntityRepository();
    this.normalization = deps.normalization ?? new CampaignNormalizationService();
    this.rakutenCommissionPromotion = deps.rakutenCommissionPromotion ?? persistRakutenCommissionOffers;
    // The PER-OFFER Rakuten commission writer. The hook above is the legacy whole-sweep call and
    // stays exactly as it was for run(); a bounded offer page promotes one offer at a time.
    this.rakutenOfferPromotion = deps.rakutenOfferPromotion ?? new RakutenCommissionPersistenceService();
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Promote exactly ONE page of ONE entity type and return where it ended.
   *
   * This is the bounded entrypoint a durable unit executes. It does NOT drain, it does NOT walk
   * another type, and it never runs the whole-sweep Rakuten hook: an offer page promotes the
   * offers on that page and nothing else, so the commission work happens exactly once per offer
   * and can never fire from a campaign or coupon page.
   *
   * Supplier seeds are ensured on every page. They are five idempotent upserts against a static
   * table, and campaign promotion resolves its supplier reference through them, so a page that
   * skipped seeding could write campaigns with a null supplier reference. Making it a separate
   * once-only unit would buy five queries and cost a hard ordering dependency.
   */
  async runPage({ networkSource, entityType, cursorId, batchSize = PROMOTION_PAGE_SIZE } = {}) {
    const startedAt = Date.now();
    const summary = emptySummary();
    summary.lastCursor = null;
    summary.hasMore = false;

    await this.promotionService.ensureSuppliersSeeded();

    const batch = await this.entityRepo.findPageForPromotion({
      entityType,
      networkSource,
      batchSize,
      cursorId,
    });

    if (!batch.length) {
      summary.durationMs = Date.now() - startedAt;
      return summary;
    }

    for (const entity of batch) {
      // eslint-disable-next-line no-await-in-loop
      const result = await this.promotePagedEntity(entity, entityType);
      accumulate(summary, result);
    }

    summary.lastCursor = batch[batch.length - 1].id;
    summary.hasMore = batch.length >= batchSize;
    summary.promoted = summary.created + summary.updated;
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  /**
   * One entity of a bounded page. Campaigns and coupons take the existing promotion path; an
   * offer is Rakuten commission evidence and takes the per-offer commission writer.
   *
   * A thrown error is NOT swallowed: it fails the page, which returns the unit to PENDING with an
   * attempt spent, and the retry re-runs the same page from the same cursor.
   */
  async promotePagedEntity(entity, entityType) {
    if (entityType !== OFFER_ENTITY_TYPE) return this.promoteEntity(entity);
    if (entity?.networkSource !== OFFER_NETWORK_SOURCE) return { result: "skipped" };

    const outcome = await this.rakutenOfferPromotion.persistOfferEntity(entity);
    // upsertNormalizedFact is an upsert on the rule's natural key, so re-running a page that
    // already persisted its offers writes the same rows again rather than duplicating them.
    if (outcome?.skipped) return { result: "skipped" };
    return { result: (outcome?.persisted ?? 0) > 0 ? "updated" : "skipped" };
  }

  async run({
    entityTypes = [SUPPLIER_ENTITY_TYPES.CAMPAIGN, SUPPLIER_ENTITY_TYPES.COUPON],
    networkSource,
    entityIds,
    batchSize = PROMOTION_BATCH_SIZE,
  } = {}) {
    const startedAt = Date.now();
    const summary = emptySummary();

    await this.promotionService.ensureSuppliersSeeded();

    // Types are walked ONE AT A TIME, to completion, in the order they were requested. A coupon
    // connects to its parent SupplierCampaign by id and throws PARENT_CAMPAIGN_NOT_FOUND when it
    // is absent, so every campaign in scope must be promoted before the first coupon is attempted.
    // This walk previously asked for every requested type at once and let row order decide, which
    // promoted coupons ahead of the parents they depend on. The default [campaign, coupon] is
    // therefore a dependency order, not a list — postSyncStages already sequences the durable path
    // the same way.
    for (const entityType of entityTypes) {
      // Each type starts its own keyset walk. The cursor is a primary key inside ONE type's
      // ordering and carries no meaning across types, so it must not be carried over.
      let cursorId = undefined;

      while (true) {
        // eslint-disable-next-line no-await-in-loop
        const batch = await this.entityRepo.findManyForPromotion({
          entityTypes: [entityType],
          networkSource,
          entityIds,
          batchSize,
          cursorId,
        });

        if (!batch.length) break;

        for (const entity of batch) {
          // eslint-disable-next-line no-await-in-loop
          const result = await this.promoteEntity(entity);
          accumulate(summary, result);
        }

        cursorId = batch[batch.length - 1].id;
        if (batch.length < batchSize) break;
      }
    }

    if (shouldRunRakutenCommissionPromotion({ entityTypes, networkSource })) {
      try {
        summary.rakutenCommissionPromotion = await this.rakutenCommissionPromotion();
      } catch (error) {
        summary.rakutenCommissionPromotion = {
          failed: true,
          error: error?.message || "Rakuten commission promotion failed",
        };
      }
    }

    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  async promoteEntity(entity) {
    if (entity.entityType === SUPPLIER_ENTITY_TYPES.CAMPAIGN) {
      const result = await this.campaignPromotion.promoteEntity(entity);
      if ((result.result === "created" || result.result === "updated") && result.record) {
        result.normalization = await this.normalization.normalizeSupplierCampaign(result.record, {
          matchedBy: "promotion",
        });
        // Trackier carries its payout table on the campaign object itself, so the rules are
        // persisted here — the first moment the SupplierCampaign exists — from the rawData
        // staged earlier in this same run. One ingestion cycle therefore yields Commission 1..N,
        // with no second supplier fetch and no second sync. Reported, never fatal: a failure
        // here must not undo a promotion that succeeded.
        if (entity.networkSource === TRACKIER_NETWORK_SOURCE) {
          try {
            result.commissionRules = await this.trackierPayouts.persistPromotedCampaign({
              entity,
              supplierCampaign: result.record,
            });
          } catch (error) {
            result.commissionRules = { error: error?.message || String(error) };
          }
        }
      }
      return result;
    }
    if (entity.entityType === SUPPLIER_ENTITY_TYPES.COUPON) {
      return this.couponPromotion.promoteEntity(entity);
    }
    return { result: "skipped" };
  }

  /**
   * Retry mapper errors, one conditional claim per row.
   *
   * Explicit ids: OPEN and RETRYING are claimable (RETRYING regardless of lease age, because the
   * operator selected it). RESOLVED and DISCARDED are skipped untouched: re-promoting a resolved
   * entity belongs to /promotion/run, not to mapper-error retry. Unknown ids are ignored as before.
   *
   * No ids: OPEN rows plus RETRYING rows whose lease expired (or was never set), never a fresh
   * RETRYING row that another invocation may still be working.
   *
   * Every status write after the claim is conditional on the row still being RETRYING, so a final
   * write never overwrites what the promotion service or a concurrent writer already decided. A
   * throw inside one target is recovered (RETRYING -> OPEN when still RETRYING) and the batch
   * continues. A hard termination cannot be caught; the lease is what makes that row reclaimable.
   */
  async retryFailed({ mapperErrorIds, limit = PROMOTION_BATCH_SIZE } = {}) {
    const startedAt = Date.now();
    const summary = emptySummary();
    const explicit = Boolean(mapperErrorIds?.length);
    const staleBefore = new Date(this.now().getTime() - MAPPER_ERROR_RETRY_LEASE_MS);

    const targets = explicit
      ? await this.mapperErrorRepo.findByIds(mapperErrorIds)
      : await this.mapperErrorRepo.findRetryTargets({ staleBefore, take: limit });

    for (const mapperError of targets) {
      // eslint-disable-next-line no-await-in-loop
      const claim = await this.claimRetryTarget(mapperError, { explicit, staleBefore });
      if (!claim.claimed) {
        summary.skipped += 1;
        continue;
      }
      if (claim.reclaimedStale) {
        summary.reclaimedStale += 1;
        logger.warn(
          { mapperErrorId: mapperError.id, entityId: mapperError.entityId },
          "stale RETRYING mapper error reclaimed for retry",
        );
      }

      // eslint-disable-next-line no-await-in-loop
      await this.runClaimedRetry(mapperError, summary);
    }

    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  /**
   * The compare-and-set that decides whether this invocation owns the row. Exactly one of two
   * racing callers gets `claimed: true`; the other counts a skip and never promotes.
   */
  async claimRetryTarget(mapperError, { explicit, staleBefore }) {
    const status = mapperError.status;
    // RESOLVED and DISCARDED never re-enter the retry path, explicit or not.
    if (!EXPLICIT_RETRY_CLAIMABLE.has(status)) return { claimed: false, reclaimedStale: false };

    const now = this.now();
    if (status === "OPEN") {
      const claimed = await this.mapperErrorRepo.claimForRetry(mapperError.id, { from: "OPEN", now });
      return { claimed, reclaimedStale: false };
    }

    // RETRYING. An operator-selected id is an intentional override and may be claimed at any
    // lease age; the automatic path may only take a row whose lease has expired or was never set.
    if (explicit) {
      const claimed = await this.mapperErrorRepo.claimForRetry(mapperError.id, { from: "RETRYING", now });
      return { claimed, reclaimedStale: false };
    }
    const claimed = await this.mapperErrorRepo.claimForRetry(mapperError.id, {
      from: "RETRYING",
      now,
      staleBefore,
    });
    return { claimed, reclaimedStale: claimed };
  }

  /**
   * One claimed row, from lookup to final status. Counting is done exactly once per target:
   * `counted` flips the moment this target has been added to the summary, so a throw from the
   * final status write (after accumulate) does not count it a second time, while a throw before
   * accumulate counts it once as failed.
   */
  async runClaimedRetry(mapperError, summary) {
    let counted = false;
    try {
      const entity = await this.entityRepo.findById(mapperError.entityId);

      if (!entity) {
        summary.failed += 1;
        summary.processed += 1;
        counted = true;
        await this.mapperErrorRepo.finishRetry(mapperError.id, "DISCARDED", {
          message: "Source Entity no longer exists",
        });
        return;
      }

      const result = await this.promoteEntity(entity);
      accumulate(summary, result);
      counted = true;

      // A false return is normal here: on success the promotion service already resolved the
      // active mapper error, and on failure recordMapperFailure already reopened it.
      await this.mapperErrorRepo.finishRetry(
        mapperError.id,
        result.result !== "failed" ? "RESOLVED" : "OPEN",
      );
    } catch (error) {
      if (!counted) {
        summary.failed += 1;
        summary.processed += 1;
      }

      // Best effort, and honest about it: if the database is unavailable this write fails too,
      // the row stays RETRYING with its lease set, and the next automatic retry reclaims it once
      // the lease expires. A row the service already RESOLVED is not touched (count 0).
      let recovered = false;
      try {
        recovered = await this.mapperErrorRepo.finishRetry(mapperError.id, "OPEN");
      } catch {
        recovered = false;
      }
      if (recovered) {
        summary.recovered += 1;
        logger.warn(
          {
            mapperErrorId: mapperError.id,
            entityId: mapperError.entityId,
            errorCode: errorCodeOf(error),
          },
          "mapper error retry threw; row reopened",
        );
      }
    }
  }
}

export async function runPromotionJob(options = {}) {
  const job = new PromotionJob();
  return job.run(options);
}

export async function retryPromotionJob(options = {}) {
  const job = new PromotionJob();
  return job.retryFailed(options);
}
