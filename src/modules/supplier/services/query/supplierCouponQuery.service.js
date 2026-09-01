import { decodeCursor, encodeCursor } from "../../../../core/cursorPagination.js";
import { getPagination, toStandardPagedResponse } from "../../../../core/pagination.js";
import { applySupplierCouponAccess } from "../../../../auth/supplierDataAccess.js";
import { toSupplierCouponDto } from "../../dto/supplierCoupon.dto.js";
import { SupplierCouponRepository } from "../../repositories/supplierCoupon.repository.js";

export class SupplierCouponQueryService {
  constructor(deps = {}) {
    this.couponRepo = deps.couponRepo ?? new SupplierCouponRepository();
  }

  buildFilters(query) {
    return {
      supplierCampaignId: query.supplierCampaignId,
      couponType: query.couponType,
      couponStatus: query.couponStatus,
      networkSource: query.networkSource,
      search: query.search,
    };
  }

  project(record, permissions, options) {
    return applySupplierCouponAccess(toSupplierCouponDto(record), permissions, options);
  }

  async list(query, permissions = []) {
    const filters = this.buildFilters(query);
    const { page, pageSize, skip } = getPagination(query);
    const includePayloads = query.includePayloads === true;
    const useCursor = Boolean(query.cursor);

    if (useCursor) {
      const cursor = decodeCursor(query.cursor, ["lastSyncedAt", "id"]);
      const { rows, hasMore } = await this.couponRepo.findManyCursor(filters, {
        take: pageSize,
        cursor,
      });

      const data = rows.map((row) => this.project(row, permissions, { includePayloads }));
      const nextCursor = hasMore ? encodeCursor(rows[rows.length - 1], ["lastSyncedAt", "id"]) : null;

      return toStandardPagedResponse({
        rows: data,
        total: null,
        page: null,
        pageSize,
        nextCursor,
        hasMore,
      });
    }

    const { rows, total } = await this.couponRepo.findMany(filters, { skip, take: pageSize });
    const data = rows.map((row) => this.project(row, permissions, { includePayloads }));

    return toStandardPagedResponse({ rows: data, total, page, pageSize, hasMore: skip + rows.length < total });
  }

  async getById(id, permissions = [], options = {}) {
    const record = await this.couponRepo.findById(id);
    if (!record) return null;
    return this.project(record, permissions, options);
  }
}
