import { decodeCursor, encodeCursor } from "../../../../core/cursorPagination.js";
import { getPagination, toStandardPagedResponse } from "../../../../core/pagination.js";
import { prisma } from "../../../../database/prisma.js";
import { toMerchantDto, toMerchantReviewDto, toMerchantSummaryDto } from "../../dto/merchant.dto.js";
import { normalizeMerchantName, tokenSimilarity } from "../../normalizeName.js";
import { MerchantRepository } from "../../repositories/merchant.repository.js";
import { MerchantReviewRepository } from "../../repositories/merchantReview.repository.js";

export class MerchantQueryService {
  constructor(deps = {}) {
    this.merchantRepo = deps.merchantRepo ?? new MerchantRepository();
    this.reviewRepo = deps.reviewRepo ?? new MerchantReviewRepository();
  }

  buildFilters(query) {
    return {
      status: query.status,
      verificationStatus: query.verificationStatus,
      isVerified: query.isVerified,
      country: query.country,
      search: query.search,
      excludeMerged: query.unmatched ? undefined : true,
    };
  }

  async list(query) {
    const filters = this.buildFilters(query);
    const { page, pageSize, skip } = getPagination(query);
    const useCursor = Boolean(query.cursor);

    if (useCursor) {
      const cursor = decodeCursor(query.cursor, ["displayName", "id"]);
      const { rows, hasMore } = await this.merchantRepo.findManyCursor(filters, {
        take: pageSize,
        cursor,
      });

      const data = rows.map((row) => toMerchantSummaryDto(row));
      const nextCursor = hasMore ? encodeCursor(rows[rows.length - 1], ["displayName", "id"]) : null;

      return toStandardPagedResponse({
        rows: data,
        total: null,
        page: null,
        pageSize,
        nextCursor,
        hasMore,
      });
    }

    const { rows, total } = await this.merchantRepo.findMany(filters, { skip, take: pageSize });
    const data = rows.map((row) => toMerchantSummaryDto(row));

    return toStandardPagedResponse({ rows: data, total, page, pageSize, hasMore: skip + rows.length < total });
  }

  async getById(id) {
    const record = await this.merchantRepo.findById(id);
    if (!record) return null;
    return toMerchantDto(record);
  }

  async findDuplicates(merchantId) {
    const merchant = await this.merchantRepo.findById(merchantId);
    if (!merchant) return [];

    const { rows } = await this.merchantRepo.findMany({ excludeMerged: true }, { skip: 0, take: 500 });
    return rows
      .filter((candidate) => candidate.id !== merchantId)
      .map((candidate) => ({
        merchant: toMerchantSummaryDto(candidate),
        similarity: tokenSimilarity(merchant.displayName, candidate.displayName),
        normalizedMatch: candidate.normalizedName === merchant.normalizedName,
      }))
      .filter((entry) => entry.normalizedMatch || entry.similarity >= 0.6)
      .sort((a, b) => b.similarity - a.similarity);
  }

  async findPotentialMatchesForReview(reviewId) {
    const review = await this.reviewRepo.findById(reviewId);
    if (!review) return [];

    const normalized = normalizeMerchantName(review.merchantNameRaw);
    const { rows } = await this.merchantRepo.findMany({ excludeMerged: true }, { skip: 0, take: 200 });

    return rows
      .map((merchant) => ({
        merchant: toMerchantSummaryDto(merchant),
        similarity: tokenSimilarity(review.merchantNameRaw, merchant.displayName),
        normalizedMatch: merchant.normalizedName === normalized,
      }))
      .filter((entry) => entry.normalizedMatch || entry.similarity >= 0.5)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 20);
  }

  async listUnmatchedSupplierCampaigns({ page = 1, pageSize = 20 } = {}) {
    const skip = (page - 1) * pageSize;

    const [rows, total] = await Promise.all([
      prisma.supplierCampaign.findMany({
        where: {
          merchantId: null,
          merchantNameRaw: { not: null },
          archivedAt: null,
        },
        skip,
        take: pageSize,
        orderBy: [{ lastSyncedAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          supplier: true,
          merchantNameRaw: true,
          campaignName: true,
          lastSyncedAt: true,
        },
      }),
      prisma.supplierCampaign.count({
        where: {
          merchantId: null,
          merchantNameRaw: { not: null },
          archivedAt: null,
        },
      }),
    ]);

    return toStandardPagedResponse({
      rows,
      total,
      page,
      pageSize,
      hasMore: skip + rows.length < total,
    });
  }

  async listReviews(query) {
    const filters = {
      status: query.status,
      supplier: query.supplier,
      search: query.search,
    };
    const { page, pageSize, skip } = getPagination(query);
    const useCursor = Boolean(query.cursor);

    if (useCursor) {
      const cursor = decodeCursor(query.cursor, ["createdAt", "id"]);
      const { rows, hasMore } = await this.reviewRepo.findManyCursor(filters, {
        take: pageSize,
        cursor,
      });

      const data = rows.map((row) => toMerchantReviewDto(row));
      const nextCursor = hasMore ? encodeCursor(rows[rows.length - 1], ["createdAt", "id"]) : null;

      return toStandardPagedResponse({
        rows: data,
        total: null,
        page: null,
        pageSize,
        nextCursor,
        hasMore,
      });
    }

    const { rows, total } = await this.reviewRepo.findMany(filters, { skip, take: pageSize });
    const data = rows.map((row) => toMerchantReviewDto(row));

    return toStandardPagedResponse({ rows: data, total, page, pageSize, hasMore: skip + rows.length < total });
  }

  async getReviewById(id) {
    const record = await this.reviewRepo.findById(id);
    if (!record) return null;
    return toMerchantReviewDto(record);
  }
}
