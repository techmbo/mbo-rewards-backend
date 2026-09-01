import { decodeCursor, encodeCursor } from "../../../../core/cursorPagination.js";
import { getPagination, toStandardPagedResponse } from "../../../../core/pagination.js";
import {
  applyCommissionRuleAccess,
  applyCouponAssignmentAccess,
  applyTrackingLinkAccess,
} from "../../../../auth/commercialDataAccess.js";
import {
  CommissionRuleRepository,
  CouponAssignmentRepository,
  TrackingLinkRepository,
} from "../../repositories/commercial.repository.js";

export class CommercialQueryService {
  constructor(deps = {}) {
    this.trackingRepo = deps.trackingRepo ?? new TrackingLinkRepository();
    this.couponRepo = deps.couponRepo ?? new CouponAssignmentRepository();
    this.commissionRepo = deps.commissionRepo ?? new CommissionRuleRepository();
  }

  async listTrackingLinks(query, permissions = []) {
    const filters = {
      assignmentId: query.assignmentId,
      clientId: query.clientId,
      canonicalCampaignId: query.canonicalCampaignId,
      status: query.status,
      search: query.search,
      isPrimary: query.isPrimary,
    };
    return this.list(this.trackingRepo, filters, query, permissions, applyTrackingLinkAccess, ["createdAt", "id"]);
  }

  async listCouponAssignments(query, permissions = []) {
    const filters = {
      assignmentId: query.assignmentId,
      status: query.status,
      couponType: query.couponType,
    };
    return this.list(this.couponRepo, filters, query, permissions, applyCouponAssignmentAccess, ["createdAt", "id"]);
  }

  async listCommissionRules(query, permissions = []) {
    const filters = {
      assignmentId: query.assignmentId,
      status: query.status,
    };
    return this.list(
      this.commissionRepo,
      filters,
      query,
      permissions,
      applyCommissionRuleAccess,
      ["effectiveFrom", "id"],
    );
  }

  async list(repo, filters, query, permissions, projector, cursorFields) {
    const { page, pageSize, skip } = getPagination(query);
    const useCursor = Boolean(query.cursor);

    if (useCursor) {
      const cursor = decodeCursor(query.cursor, cursorFields);
      const { rows, hasMore } = await repo.findManyCursor(filters, { take: pageSize, cursor });
      const data = rows.map((row) => projector(row, permissions));
      const nextCursor = hasMore ? encodeCursor(rows[rows.length - 1], cursorFields) : null;
      return toStandardPagedResponse({
        rows: data,
        total: null,
        page: null,
        pageSize,
        nextCursor,
        hasMore,
      });
    }

    const { rows, total } = await repo.findMany(filters, { skip, take: pageSize });
    const data = rows.map((row) => projector(row, permissions));
    return toStandardPagedResponse({ rows: data, total, page, pageSize, hasMore: skip + rows.length < total });
  }
}
