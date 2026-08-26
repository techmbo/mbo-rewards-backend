import { prisma } from "../../../database/prisma.js";
import { fail } from "../../../core/apiResponse.js";
import { normalizeMerchantName, slugifyMerchantName } from "../normalizeName.js";
import { MerchantRepository } from "../repositories/merchant.repository.js";
import { MerchantAliasRepository } from "../repositories/merchantAlias.repository.js";
import { SupplierCampaignRepository } from "../../supplier/repositories/supplierCampaign.repository.js";
import { MerchantReviewRepository } from "../repositories/merchantReview.repository.js";

function uniqueSlug(base, attempt = 0) {
  if (!attempt) return base;
  return `${base}-${attempt}`;
}

export class MerchantService {
  constructor(deps = {}) {
    this.merchantRepo = deps.merchantRepo ?? new MerchantRepository();
    this.aliasRepo = deps.aliasRepo ?? new MerchantAliasRepository();
    this.campaignRepo = deps.campaignRepo ?? new SupplierCampaignRepository();
    this.reviewRepo = deps.reviewRepo ?? new MerchantReviewRepository();
  }

  async resolveUniqueSlug(displayName, client = null) {
    const base = slugifyMerchantName(displayName);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const slug = uniqueSlug(base, attempt);
      const existing = await this.merchantRepo.findBySlug(slug, client);
      if (!existing) return slug;
    }
    throw fail("Unable to generate unique merchant slug.", 409);
  }

  async ensureNetworkSourceAlias(merchantId, displayName, networkSource, client = null) {
    if (!networkSource) return null;

    const aliasValue = displayName.trim();
    const normalizedAlias = normalizeMerchantName(aliasValue);
    const payload = {
      merchantId,
      normalizedAlias,
      source: "MANUAL",
      status: "CONFIRMED",
      confidence: 1,
    };

    return this.aliasRepo.upsertBySupplierAlias(
      { supplier: networkSource, aliasValue },
      payload,
      payload,
      client,
    );
  }

  async create(input, client = null) {
    const normalizedName = normalizeMerchantName(input.displayName);
    if (!normalizedName) throw fail("displayName normalizes to empty string.", 400);

    const existing = await this.merchantRepo.findByNormalizedName(normalizedName, client);
    if (existing) throw fail("Merchant with this normalized name already exists.", 409);

    const slug = await this.resolveUniqueSlug(input.displayName, client);
    const displayName = input.displayName.trim();

    const merchant = await this.merchantRepo.create(
      {
        displayName,
        normalizedName,
        slug,
        website: input.website ?? null,
        supplierTrackingLink: input.supplierTrackingLink ?? null,
        couponDescription: input.couponDescription ?? null,
        category: input.category ?? null,
        logoUrl: input.logoUrl ?? null,
        country: input.country ?? null,
        status: input.status ?? "DRAFT",
        verificationStatus: input.verificationStatus ?? "UNVERIFIED",
        isVerified: input.isVerified ?? false,
        notes: input.notes ?? null,
      },
      client,
    );

    if (input.networkSource) {
      await this.ensureNetworkSourceAlias(merchant.id, displayName, input.networkSource, client);
    }

    return this.merchantRepo.findById(merchant.id, client);
  }

  /**
   * Network sync: resolve or create a Merchant from supplier advertiser/brand name
   * so CampaignSource (network supplier source) can be attached.
   */
  async findOrCreateFromNetworkAdvertiser(
    {
      displayName,
      website = null,
      logoUrl = null,
      country = null,
      networkSource = null,
      category = null,
    } = {},
    client = null,
  ) {
    const name = displayName != null ? String(displayName).trim() : "";
    const normalizedName = normalizeMerchantName(name);
    if (!normalizedName) throw fail("Network advertiser name is empty.", 400);

    const existing = await this.merchantRepo.findByNormalizedName(normalizedName, client);
    if (existing && existing.status !== "MERGED") {
      if (networkSource) {
        await this.ensureNetworkSourceAlias(existing.id, existing.displayName || name, networkSource, client);
      }
      return existing;
    }

    try {
      return await this.create(
        {
          displayName: name,
          website,
          logoUrl,
          country: country ? String(country).slice(0, 2).toUpperCase() : null,
          category,
          networkSource,
          status: "ACTIVE",
          verificationStatus: "UNVERIFIED",
          notes: "Provisioned from network campaign sync for CampaignSource linkage.",
        },
        client,
      );
    } catch (error) {
      // Race: another sync created the same normalized name.
      const raced = await this.merchantRepo.findByNormalizedName(normalizedName, client);
      if (raced) return raced;
      throw error;
    }
  }

  async update(id, input, client = null) {
    const merchant = await this.merchantRepo.findById(id, client);
    if (!merchant) throw fail("Merchant not found.", 404);
    if (merchant.status === "MERGED") throw fail("Cannot update a merged merchant.", 409);

    const data = {};

    if (input.displayName !== undefined) {
      const normalizedName = normalizeMerchantName(input.displayName);
      if (!normalizedName) throw fail("displayName normalizes to empty string.", 400);

      const duplicate = await this.merchantRepo.findByNormalizedName(normalizedName, client);
      if (duplicate && duplicate.id !== id) {
        throw fail("Merchant with this normalized name already exists.", 409);
      }

      data.displayName = input.displayName.trim();
      data.normalizedName = normalizedName;
    }

    if (input.website !== undefined) data.website = input.website;
    if (input.supplierTrackingLink !== undefined) data.supplierTrackingLink = input.supplierTrackingLink;
    if (input.couponDescription !== undefined) data.couponDescription = input.couponDescription;
    if (input.category !== undefined) data.category = input.category;
    if (input.logoUrl !== undefined) data.logoUrl = input.logoUrl;
    if (input.country !== undefined) data.country = input.country;
    if (input.status !== undefined) data.status = input.status;
    if (input.verificationStatus !== undefined) data.verificationStatus = input.verificationStatus;
    if (input.isVerified !== undefined) data.isVerified = input.isVerified;
    if (input.notes !== undefined) data.notes = input.notes;

    if (Object.keys(data).length) {
      await this.merchantRepo.update(id, data, client);
    }

    if (input.networkSource !== undefined && input.networkSource !== null) {
      const displayName = data.displayName ?? merchant.displayName;
      await this.ensureNetworkSourceAlias(id, displayName, input.networkSource, client);
    }

    return this.merchantRepo.findById(id, client);
  }

  async merge(sourceId, { targetMerchantId, notes }, reviewedBy = null, client = null) {
    if (sourceId === targetMerchantId) throw fail("Cannot merge merchant into itself.", 400);

    const run = async (tx) => {
      const source = await this.merchantRepo.findById(sourceId, tx);
      const target = await this.merchantRepo.findById(targetMerchantId, tx);

      if (!source) throw fail("Source merchant not found.", 404);
      if (!target) throw fail("Target merchant not found.", 404);
      if (source.status === "MERGED") throw fail("Source merchant is already merged.", 409);
      if (target.status === "MERGED") throw fail("Target merchant is merged.", 409);

      await this.aliasRepo.reassignMerchant(sourceId, targetMerchantId, tx);

      await tx.supplierCampaign.updateMany({
        where: { merchantId: sourceId },
        data: { merchantId: targetMerchantId },
      });

      await tx.merchantReview.updateMany({
        where: { merchantId: sourceId, status: { in: ["PENDING_REVIEW", "AUTO_MATCHED"] } },
        data: { merchantId: targetMerchantId, status: "MERGED", reviewedAt: new Date(), reviewedBy },
      });

      await this.merchantRepo.update(
        sourceId,
        {
          status: "MERGED",
          mergedIntoId: targetMerchantId,
          notes: notes ?? source.notes,
        },
        tx,
      );

      return this.merchantRepo.findById(targetMerchantId, tx);
    };

    if (client) return run(client);
    return prisma.$transaction(run);
  }
}
