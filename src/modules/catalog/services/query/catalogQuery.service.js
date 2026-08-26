import { decodeCursor, encodeCursor } from "../../../../core/cursorPagination.js";
import { getPagination, toStandardPagedResponse } from "../../../../core/pagination.js";
import {
  applyCatalogDetailAccess,
  applyCatalogSummaryAccess,
} from "../../../../auth/catalogDataAccess.js";
import { toCanonicalCampaignSummaryDto } from "../../dto/catalog.dto.js";
import { CatalogRepository } from "../../repositories/catalog.repository.js";
import { CatalogService } from "../catalog.service.js";

export class CatalogQueryService {
  constructor(deps = {}) {
    this.catalogRepo = deps.catalogRepo ?? new CatalogRepository();
    this.catalogService = deps.catalogService ?? new CatalogService();
  }

  buildFilters(query) {
    return {
      merchantId: query.merchantId,
      status: query.status,
      visibility: query.visibility,
      category: query.category,
      country: query.country,
      supplier: query.supplier,
      search: query.search,
      joined: query.joined,
      supportsCoupon: query.supportsCoupon,
      supportsLink: query.supportsLink,
    };
  }

  async list(query, permissions = []) {
    const filters = this.buildFilters(query);
    const { page, pageSize, skip } = getPagination(query);
    const useCursor = Boolean(query.cursor);

    if (useCursor) {
      const cursor = decodeCursor(query.cursor, ["displayName", "id"]);
      const { rows, hasMore } = await this.catalogRepo.findManyCursor(filters, {
        take: pageSize,
        cursor,
      });

      const data = rows.map((row) => applyCatalogSummaryAccess(row, permissions));
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

    const { rows, total } = await this.catalogRepo.findMany(filters, { skip, take: pageSize });
    const data = rows.map((row) => toCanonicalCampaignSummaryDto(row));

    return toStandardPagedResponse({ rows: data, total, page, pageSize, hasMore: skip + rows.length < total });
  }

  async getById(id, permissions = []) {
    const record = await this.catalogRepo.findById(id, { includeSources: true });
    if (!record) return null;

    const { selection } = await this.catalogService.getRouting(id);
    return applyCatalogDetailAccess(record, selection, permissions);
  }
}
