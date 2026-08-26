import { decodeCursor, encodeCursor } from "../../../../core/cursorPagination.js";
import { getPagination, toStandardPagedResponse } from "../../../../core/pagination.js";
import { applyMapperErrorAccess } from "../../../../auth/supplierDataAccess.js";
import { toMapperErrorDto } from "../../dto/mapperError.dto.js";
import { MapperErrorRepository } from "../../repositories/mapperError.repository.js";

export class MapperErrorQueryService {
  constructor(deps = {}) {
    this.mapperErrorRepo = deps.mapperErrorRepo ?? new MapperErrorRepository();
  }

  buildFilters(query) {
    return {
      status: query.status,
      supplier: query.supplier,
      entityType: query.entityType,
      entityId: query.entityId,
    };
  }

  project(record, permissions) {
    return applyMapperErrorAccess(toMapperErrorDto(record), permissions);
  }

  async list(query, permissions = []) {
    const filters = this.buildFilters(query);
    const { page, pageSize, skip } = getPagination(query);
    const useCursor = Boolean(query.cursor);

    if (useCursor) {
      const cursor = decodeCursor(query.cursor, ["createdAt", "id"]);
      const { rows, hasMore } = await this.mapperErrorRepo.findManyCursor(filters, {
        take: pageSize,
        cursor,
      });

      const data = rows.map((row) => this.project(row, permissions));
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

    const { rows, total } = await this.mapperErrorRepo.findMany(filters, { skip, take: pageSize });
    const data = rows.map((row) => this.project(row, permissions));

    return toStandardPagedResponse({ rows: data, total, page, pageSize, hasMore: skip + rows.length < total });
  }

  async getById(id, permissions = []) {
    const record = await this.mapperErrorRepo.findById(id);
    if (!record) return null;
    return this.project(record, permissions);
  }
}
