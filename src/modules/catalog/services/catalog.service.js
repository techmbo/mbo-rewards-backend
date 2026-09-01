import { prisma } from "../../../database/prisma.js";
import { fail } from "../../../core/apiResponse.js";
import { DEFAULT_SOURCE_PRIORITY } from "../constants.js";
import { CatalogRepository } from "../repositories/catalog.repository.js";
import { CampaignSourceRepository } from "../repositories/campaignSource.repository.js";
import { MerchantRepository } from "../../merchant/repositories/merchant.repository.js";
import { SupplierCampaignRepository } from "../../supplier/repositories/supplierCampaign.repository.js";
import { SourceSelectionService } from "./sourceSelection.service.js";
import { normalizeMerchantName, slugifyMerchantName } from "../../merchant/normalizeName.js";
import { buildAllotmentDisplayFields } from "../../coupons/allotmentFields.js";
import { resolveBoostinyDefaultCommission } from "../../supplier/mappers/boostiny.mapper.js";

function resolveGrossCommission(supplierCampaign) {
  if (
    supplierCampaign?.defaultCommissionValue != null &&
    String(supplierCampaign.defaultCommissionValue).trim() !== ""
  ) {
    return supplierCampaign.defaultCommissionValue;
  }
  if (String(supplierCampaign?.supplier || "").toUpperCase() === "BOOSTINY") {
    return resolveBoostinyDefaultCommission({
      commissionGroups: supplierCampaign.commissionGroups,
    });
  }
  return null;
}

function mapRelationshipStatus(supplierCampaign) {
  if (supplierCampaign?.isJoined) return "JOINED";
  const participation = String(supplierCampaign?.participationStatus || "")
    .trim()
    .toUpperCase();
  if (participation === "JOINED" || participation === "APPROVED") return "JOINED";
  if (participation === "PENDING") return "PENDING";
  if (
    participation === "NOT_JOINED" ||
    participation === "NOT_APPLIED" ||
    participation === "REJECTED" ||
    participation === "SUSPENDED"
  ) {
    return "NOT_JOINED";
  }
  return "UNKNOWN";
}

function deriveChannelSupport(supplierCampaign) {
  const channels = [];
  if (supplierCampaign.trackingUrl || supplierCampaign.destinationUrl) channels.push("WEB");
  if (supplierCampaign.deepLinkingEnabled) channels.push("DEEPLINK");
  return channels;
}

/** Usable coupon statuses for CampaignSource.supportsCoupon (supplier facts, not CMS Entity). */
const USABLE_COUPON_STATUSES = ["ACTIVE", "SCHEDULED", "UNKNOWN"];

/**
 * Wave B — supportsCoupon is true only when SupplierCoupon rows show a usable coupon
 * (code and/or link). Do not infer from staging Entity alone.
 */
export async function deriveSupportsCoupon(supplierCampaignId, tx) {
  if (!supplierCampaignId || !tx?.supplierCoupon?.findMany) return false;
  const coupons = await tx.supplierCoupon.findMany({
    where: {
      supplierCampaignId,
      couponStatus: { in: USABLE_COUPON_STATUSES },
    },
    select: { couponCode: true, couponLink: true, couponStatus: true },
    take: 25,
  });
  return coupons.some((row) => {
    const code = row.couponCode != null && String(row.couponCode).trim() !== "";
    const link = row.couponLink != null && String(row.couponLink).trim() !== "";
    return code || link;
  });
}

function buildSourceSnapshot(supplierCampaign, { priority, isPrimary, supportsCoupon = false } = {}) {
  return {
    priority: priority ?? DEFAULT_SOURCE_PRIORITY,
    isPrimary: isPrimary ?? false,
    relationshipStatus: mapRelationshipStatus(supplierCampaign),
    supportsLink: Boolean(supplierCampaign.trackingUrl || supplierCampaign.destinationUrl),
    supportsCoupon: Boolean(supportsCoupon),
    grossCommission: resolveGrossCommission(supplierCampaign),
    channelSupport: deriveChannelSupport(supplierCampaign),
    isActive: true,
    status: isPrimary ? "PREFERRED" : "LINKED",
  };
}

export class CatalogService {
  constructor(deps = {}) {
    this.catalogRepo = deps.catalogRepo ?? new CatalogRepository();
    this.sourceRepo = deps.sourceRepo ?? new CampaignSourceRepository();
    this.merchantRepo = deps.merchantRepo ?? new MerchantRepository();
    this.campaignRepo = deps.campaignRepo ?? new SupplierCampaignRepository();
    this.selection = deps.selection ?? new SourceSelectionService();
  }

  async create(input, client = null) {
    const merchant = await this.merchantRepo.findById(input.merchantId, client);
    if (!merchant) throw fail("Merchant not found.", 404);
    if (merchant.status === "MERGED") throw fail("Cannot create catalog entry for a merged merchant.", 409);

    return this.catalogRepo.create(
      {
        merchantId: input.merchantId,
        displayName: input.displayName.trim(),
        status: input.status ?? "DRAFT",
        visibility: input.visibility ?? "INTERNAL",
        category: input.category ?? null,
        countries: input.countries ?? [],
        defaultCurrency: input.defaultCurrency ?? null,
      },
      client,
    );
  }

  async update(id, input, client = null) {
    const campaign = await this.catalogRepo.findById(id, {}, client);
    if (!campaign) throw fail("Catalog campaign not found.", 404);

    const data = {};
    if (input.displayName !== undefined) data.displayName = input.displayName.trim();
    if (input.status !== undefined) data.status = input.status;
    if (input.visibility !== undefined) data.visibility = input.visibility;
    if (input.category !== undefined) data.category = input.category;
    if (input.countries !== undefined) data.countries = input.countries;
    if (input.defaultCurrency !== undefined) data.defaultCurrency = input.defaultCurrency;

    return this.catalogRepo.update(id, data, client);
  }

  async attachSource(canonicalCampaignId, { supplierCampaignId, priority, isPrimary }, client = null) {
    const run = async (tx) => {
      const catalog = await this.catalogRepo.findById(canonicalCampaignId, {}, tx);
      if (!catalog) throw fail("Catalog campaign not found.", 404);

      const supplierCampaign = await this.campaignRepo.findById(supplierCampaignId, tx);
      if (!supplierCampaign) throw fail("Supplier campaign not found.", 404);
      if (supplierCampaign.archivedAt) throw fail("Cannot attach archived supplier campaign.", 409);

      if (supplierCampaign.merchantId && supplierCampaign.merchantId !== catalog.merchantId) {
        throw fail("Supplier campaign merchant does not match catalog merchant.", 409);
      }

      const existingPair = await this.sourceRepo.findByCampaignPair(
        { canonicalCampaignId, supplierCampaignId },
        tx,
      );
      if (existingPair) throw fail("Supplier campaign is already attached to this catalog entry.", 409);

      const existingLinks = await this.sourceRepo.findBySupplierCampaignId(supplierCampaignId, tx);
      if (existingLinks.some((link) => link.canonicalCampaignId !== canonicalCampaignId)) {
        throw fail("Supplier campaign is already linked to another catalog entry.", 409);
      }

      const currentSources = await this.sourceRepo.findByCanonicalCampaignId(canonicalCampaignId, tx);
      const shouldBePrimary = isPrimary === true || currentSources.length === 0;

      if (shouldBePrimary) {
        await this.sourceRepo.clearPrimaryForCampaign(canonicalCampaignId, null, tx);
      }

      const snapshot = buildSourceSnapshot(supplierCampaign, {
        priority,
        isPrimary: shouldBePrimary,
        supportsCoupon: await deriveSupportsCoupon(supplierCampaignId, tx),
      });

      return this.sourceRepo.create(
        {
          canonicalCampaignId,
          supplierCampaignId,
          ...snapshot,
        },
        tx,
      );
    };

    if (client) return run(client);
    return prisma.$transaction(run);
  }

  async detachSource(sourceId, client = null) {
    const source = await this.sourceRepo.findById(sourceId, {}, client);
    if (!source) throw fail("Campaign source not found.", 404);

    return this.sourceRepo.deactivate(sourceId, client);
  }

  async promotePrimarySource(sourceId, client = null) {
    const run = async (tx) => {
      const source = await this.sourceRepo.findById(sourceId, { includeSupplierCampaign: true }, tx);
      if (!source) throw fail("Campaign source not found.", 404);
      if (!source.isActive || source.status === "DEPRECATED") {
        throw fail("Cannot promote an inactive source.", 409);
      }
      if (source.relationshipStatus !== "JOINED") {
        throw fail("Cannot promote a source that is not JOINED.", 409);
      }

      await this.sourceRepo.clearPrimaryForCampaign(source.canonicalCampaignId, sourceId, tx);

      return this.sourceRepo.update(
        sourceId,
        { isPrimary: true, status: "PREFERRED", priority: Math.min(source.priority, 1) },
        tx,
      );
    };

    if (client) return run(client);
    return prisma.$transaction(run);
  }

  async disableSource(sourceId, client = null) {
    const source = await this.sourceRepo.findById(sourceId, {}, client);
    if (!source) throw fail("Campaign source not found.", 404);
    return this.sourceRepo.deactivate(sourceId, client);
  }

  async updateSource(sourceId, input, client = null) {
    const source = await this.sourceRepo.findById(sourceId, {}, client);
    if (!source) throw fail("Campaign source not found.", 404);

    if (input.isActive === false) {
      return this.disableSource(sourceId, client);
    }

    const data = {};
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.status !== undefined) data.status = input.status;
    if (input.channelSupport !== undefined) data.channelSupport = input.channelSupport;

    return this.sourceRepo.update(sourceId, data, client);
  }

  async resolveSourceConflicts(canonicalCampaignId, client = null) {
    const sources = await this.sourceRepo.findByCanonicalCampaignId(canonicalCampaignId, client);
    const conflicts = this.selection.detectConflicts(sources);

    if (!conflicts.length) {
      return { resolved: false, conflicts: [], selection: this.selection.select(sources) };
    }

    const run = async (tx) => {
      const primaries = sources.filter((source) => source.isPrimary && source.isActive);
      if (primaries.length > 1) {
        const winner = [...primaries].sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt)[0];
        await this.sourceRepo.clearPrimaryForCampaign(canonicalCampaignId, winner.id, tx);
        await this.sourceRepo.update(winner.id, { isPrimary: true, status: "PREFERRED" }, tx);
      }

      const refreshed = await this.sourceRepo.findByCanonicalCampaignId(canonicalCampaignId, tx);
      return {
        resolved: true,
        conflicts,
        selection: this.selection.select(refreshed),
      };
    };

    if (client) return run(client);
    return prisma.$transaction(run);
  }

  async getRouting(canonicalCampaignId, client = null) {
    const sources = await this.sourceRepo.findByCanonicalCampaignId(canonicalCampaignId, client);
    return {
      selection: this.selection.select(sources),
      conflicts: this.selection.detectConflicts(sources),
    };
  }

  /**
   * Resolve or create a catalog campaign for a Coupon CMS Entity so it can be allotted.
   * LEGACY / MIGRATION bridge — prefer ensureFromSupplierCampaign + CampaignSource for SoT.
   * When a SupplierCoupon→SupplierCampaign link exists, attaches CampaignSource (merchant-safe).
   * Returns the canonical campaign id.
   */
  async ensureFromCouponCmsEntity(entity, client = null) {
    if (!entity?.id) throw fail("Coupon CMS entity is required.", 400);

    const run = async (tx) => {
      // Prefer supplier-normalized path when linked (Wave B SoT).
      const linkedCoupon = await tx.supplierCoupon.findFirst({
        where: { entityId: entity.id },
        orderBy: { lastSyncedAt: "desc" },
        include: { supplierCampaign: true },
      });
      if (linkedCoupon?.supplierCampaignId && linkedCoupon.supplierCampaign?.merchantId) {
        return await this.ensureFromSupplierCampaign(linkedCoupon.supplierCampaignId, tx);
      }

      const allotment = buildAllotmentDisplayFields(entity);
      const brand =
        allotment.brandName ||
        entity.advertiserName ||
        entity.campaignName ||
        entity.entityName ||
        "Unknown brand";
      const displayName = String(entity.campaignName || entity.entityName || brand).trim();
      if (!displayName) throw fail("Coupon CMS entry is missing a campaign name.", 400);

      const normalizedName = normalizeMerchantName(brand);
      if (!normalizedName) throw fail("Coupon CMS brand name is invalid.", 400);

      let merchant = await this.merchantRepo.findByNormalizedName(normalizedName, tx);
      if (!merchant) {
        const slug = await this.resolveUniqueMerchantSlug(brand, tx);
        merchant = await this.merchantRepo.create(
          {
            displayName: String(brand).trim(),
            normalizedName,
            slug,
            website: allotment.websiteUrl ?? null,
            logoUrl: allotment.brandLogo ?? null,
            supplierTrackingLink: allotment.trackingUrl ?? null,
            status: "ACTIVE",
            verificationStatus: "UNVERIFIED",
            isVerified: false,
          },
          tx,
        );
      } else if (merchant.status === "DRAFT" || merchant.status === "ARCHIVED") {
        merchant = await this.merchantRepo.update(merchant.id, { status: "ACTIVE" }, tx);
      }

      const existing = await tx.canonicalCampaign.findFirst({
        where: {
          merchantId: merchant.id,
          deletedAt: null,
          displayName: { equals: displayName, mode: "insensitive" },
        },
        orderBy: [{ updatedAt: "desc" }],
      });

      let canonicalId = existing?.id ?? null;

      if (existing) {
        if (existing.status === "ARCHIVED" || existing.visibility === "HIDDEN" || existing.status === "DRAFT") {
          await this.catalogRepo.update(
            existing.id,
            {
              status: "PUBLISHED",
              visibility: "ASSIGNABLE",
            },
            tx,
          );
        }
      } else {
        const catalog = await this.catalogRepo.create(
          {
            merchantId: merchant.id,
            displayName,
            status: "PUBLISHED",
            visibility: "ASSIGNABLE",
            category: entity.category ?? null,
            countries: [],
            defaultCurrency: null,
          },
          tx,
        );
        canonicalId = catalog.id;
      }

      // Attach CampaignSource when supplier campaign is known and merchant-consistent.
      if (linkedCoupon?.supplierCampaignId) {
        const sc = linkedCoupon.supplierCampaign;
        if (!sc?.archivedAt) {
          if (sc.merchantId && sc.merchantId !== merchant.id) {
            // Do not silently reassign merchants — leave review / ops to resolve.
          } else {
            try {
              const pair = await this.sourceRepo.findByCampaignPair(
                { canonicalCampaignId: canonicalId, supplierCampaignId: sc.id },
                tx,
              );
              if (!pair) {
                await this.attachSource(
                  canonicalId,
                  { supplierCampaignId: sc.id, isPrimary: true },
                  tx,
                );
              }
            } catch {
              // Attachment failures must not block CMS allotment compatibility.
            }
          }
        }
      }

      return canonicalId;
    };

    if (client) return run(client);
    return prisma.$transaction(run);
  }

  async resolveUniqueMerchantSlug(displayName, client = null) {
    const base = slugifyMerchantName(displayName);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const slug = attempt ? `${base}-${attempt}` : base;
      const existing = await this.merchantRepo.findBySlug(slug, client);
      if (!existing) return slug;
    }
    throw fail("Unable to generate unique merchant slug.", 409);
  }

  /**
   * Resolve or create a catalog campaign for a synced supplier campaign so it can be allotted.
   * Returns the canonical campaign id.
   */
  async ensureFromSupplierCampaign(supplierCampaignId, client = null) {
    const run = async (tx) => {
      const links = await this.sourceRepo.findBySupplierCampaignId(supplierCampaignId, tx);
      const existing = links.find((link) => link.isActive && link.canonicalCampaignId);
      if (existing?.canonicalCampaignId) {
        const catalog = await this.catalogRepo.findById(existing.canonicalCampaignId, {}, tx);
        if (!catalog || catalog.deletedAt) {
          throw fail("Linked catalog campaign is unavailable.", 409);
        }
        if (catalog.status === "ARCHIVED" || catalog.visibility === "HIDDEN") {
          await this.catalogRepo.update(
            catalog.id,
            {
              status: catalog.status === "ARCHIVED" ? "PUBLISHED" : catalog.status,
              visibility: catalog.visibility === "HIDDEN" ? "ASSIGNABLE" : catalog.visibility,
            },
            tx,
          );
        }
        // Refresh relationship / channel snapshot from current SupplierCampaign facts
        // (do not leave UNKNOWN after mapper proves JOINED / NOT_JOINED).
        const supplierCampaign = await this.campaignRepo.findById(supplierCampaignId, tx);
        if (supplierCampaign) {
          const snapshot = buildSourceSnapshot(supplierCampaign, {
            priority: existing.priority,
            isPrimary: existing.isPrimary,
            supportsCoupon: await deriveSupportsCoupon(supplierCampaignId, tx),
          });
          await this.sourceRepo.update(
            existing.id,
            {
              relationshipStatus: snapshot.relationshipStatus,
              supportsLink: snapshot.supportsLink,
              supportsCoupon: snapshot.supportsCoupon,
              grossCommission: snapshot.grossCommission,
              channelSupport: snapshot.channelSupport,
            },
            tx,
          );
        }
        return existing.canonicalCampaignId;
      }

      const supplierCampaign = await this.campaignRepo.findById(supplierCampaignId, tx);
      if (!supplierCampaign) throw fail("Supplier campaign not found.", 404);
      if (supplierCampaign.archivedAt) throw fail("Cannot assign an archived supplier campaign.", 409);
      if (!supplierCampaign.merchantId) {
        throw fail("Supplier campaign must be matched to a merchant before it can be allotted.", 409);
      }

      const displayName =
        supplierCampaign.campaignName?.trim() ||
        supplierCampaign.merchantNameRaw?.trim() ||
        `Supplier campaign ${supplierCampaign.supplierCampaignId}`;

      const catalog = await this.catalogRepo.create(
        {
          merchantId: supplierCampaign.merchantId,
          displayName,
          status: "PUBLISHED",
          visibility: "ASSIGNABLE",
          category: null,
          countries: Array.isArray(supplierCampaign.countryCodes)
            ? supplierCampaign.countryCodes.map((c) => String(c).slice(0, 2).toUpperCase()).filter(Boolean)
            : [],
          defaultCurrency: supplierCampaign.currencyCode ?? null,
        },
        tx,
      );

      const snapshot = buildSourceSnapshot(supplierCampaign, {
        isPrimary: true,
        priority: DEFAULT_SOURCE_PRIORITY,
        supportsCoupon: await deriveSupportsCoupon(supplierCampaignId, tx),
      });

      await this.sourceRepo.create(
        {
          canonicalCampaignId: catalog.id,
          supplierCampaignId,
          ...snapshot,
        },
        tx,
      );

      return catalog.id;
    };

    if (client) return run(client);
    return prisma.$transaction(run);
  }
}
