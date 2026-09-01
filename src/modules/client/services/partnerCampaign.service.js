import { fail } from "../../../core/apiResponse.js";
import { decodeCursor, encodeCursor } from "../../../core/cursorPagination.js";
import { getPagination } from "../../../core/pagination.js";
import { toPartnerCampaignDto, toPartnerClientSummaryDto } from "../dto/partnerCampaign.dto.js";
import { isClientCampaignVisible } from "../assignmentVisibilityTruth.js";
import { ClientCampaignAssignmentRepository } from "../repositories/clientCampaignAssignment.repository.js";
import { ClientRepository } from "../repositories/client.repository.js";
import { ClientVisibilityService } from "./visibility.service.js";

/**
 * Canonical Client Campaign API service (v15 06C).
 * Served by GET /api/v1/client/campaigns and compatibility aliases
 * (/api/partner/v1/campaigns, /api/portal/v1/campaigns) — one visibility pipeline.
 * Client identity comes only from authenticated credentials — never from request params.
 */
export class PartnerCampaignService {
  constructor(deps = {}) {
    this.clientRepo = deps.clientRepo ?? new ClientRepository();
    this.assignmentRepo = deps.assignmentRepo ?? new ClientCampaignAssignmentRepository();
    this.visibility = deps.visibility ?? new ClientVisibilityService();
  }

  async assertPartnerClient(clientId) {
    const client = await this.clientRepo.findById(clientId);
    if (!client) throw fail("Client not found.", 404);
    if (client.status === "OFFBOARDED" || client.deletedAt) {
      throw fail("Client account is not available.", 403);
    }
    if (client.status !== "ACTIVE") {
      throw fail("Client account is not active.", 403);
    }
    return client;
  }

  /**
   * @param {object} assignment
   * @param {object|null} client
   * @param {{ requirePublished?: boolean }} [opts]
   */
  projectAssignment(assignment, client = null, opts = {}) {
    const requirePublished = opts.requirePublished !== false;
    const clientCtx = client || { status: "ACTIVE", deletedAt: null };

    const allotted = this.visibility.isAssignmentAllottedToClient(assignment, {
      client: clientCtx,
      catalogCampaign: assignment.canonicalCampaign,
    });
    if (!allotted) return null;

    // Default public surface: published only (matches client API access copy + provision flow).
    if (requirePublished && assignment.published !== true) return null;

    // 06E: catalog must remain publishable (ACTIVE/PUBLISHED + assignable visibility).
    if (
      requirePublished &&
      !this.visibility.isCatalogPublishable(assignment.canonicalCampaign)
    ) {
      return null;
    }

    const projected = this.visibility.projectVisibleCampaign(assignment);
    if (!projected) return null;

    // 06E Validity: drop inverted / empty intersection windows.
    if (projected.validityInvalid) return null;

    // Outside assignment window → not returned.
    if (requirePublished) {
      const now = Date.now();
      const start = projected.campaign?.validity?.startDate
        ? new Date(projected.campaign.validity.startDate).getTime()
        : null;
      const end = projected.campaign?.validity?.endDate
        ? new Date(projected.campaign.validity.endDate).getTime()
        : null;
      if (start != null && !Number.isNaN(start) && now < start) return null;
      if (end != null && !Number.isNaN(end) && now > end) return null;
    }

    // Supplier campaign must still be ACTIVE when status is known.
    if (requirePublished && projected.sourceActive === false) return null;
    const supplierStatus = String(projected.campaign?.supplierCampaignStatus || "").toUpperCase();
    if (
      requirePublished &&
      supplierStatus &&
      !["ACTIVE", "UNKNOWN", ""].includes(supplierStatus) &&
      supplierStatus !== "JOINED"
    ) {
      // PAUSED / EXPIRED / INACTIVE supplier campaigns are not client-eligible.
      if (["PAUSED", "EXPIRED", "RETIRED", "INACTIVE", "DISABLED"].includes(supplierStatus)) {
        return null;
      }
    }

    const dto = toPartnerCampaignDto(projected, {
      client,
    });
    if (!dto) return null;

    if (
      requirePublished &&
      !isClientCampaignVisible({ client: clientCtx, assignment, dto })
    ) {
      return null;
    }

    // Never expose a broken client offer: need MBO link and/or assigned coupon.
    if (requirePublished && !dto.link && !dto.couponCode) {
      return null;
    }

    return dto;
  }

  /**
   * List campaigns assigned to the authenticated client.
   * Supports page/cursor pagination and search/category/brand/country/status filters.
   */
  async listCampaigns(clientId, query = {}) {
    const client = await this.assertPartnerClient(clientId);

    const includeInactive = query.includeInactive === true;
    const requirePublished = !includeInactive && query.published !== false;
    const filters = {
      clientId,
      status: query.status,
      category: query.category,
      brand: query.brand,
      country: query.country,
      search: query.search,
      published:
        query.published !== undefined
          ? query.published
          : includeInactive
            ? undefined
            : true,
      includeInactive,
      requirePublished,
    };

    const { page, pageSize, skip } = getPagination(query);
    const useCursor = Boolean(query.cursor);
    const projectOpts = { requirePublished };

    if (useCursor) {
      const cursor = decodeCursor(query.cursor, ["createdAt", "id"]);
      const { rows, hasMore } = await this.assignmentRepo.findManyCursorForPartner(filters, {
        take: pageSize,
        cursor,
      });

      const campaigns = rows
        .map((row) => this.projectAssignment(row, client, projectOpts))
        .filter(Boolean);
      const nextCursor = hasMore ? encodeCursor(rows[rows.length - 1], ["createdAt", "id"]) : null;

      return {
        client: toPartnerClientSummaryDto(client),
        campaigns,
        pagination: {
          page: null,
          pageSize,
          total: null,
          totalPages: null,
          nextCursor,
          hasMore,
        },
      };
    }

    const { rows, total } = await this.assignmentRepo.findManyForPartner(filters, {
      skip,
      take: pageSize,
    });
    const campaigns = rows
      .map((row) => this.projectAssignment(row, client, projectOpts))
      .filter(Boolean);

    return {
      client: toPartnerClientSummaryDto(client),
      campaigns,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(Math.ceil(total / pageSize), 1),
        nextCursor: null,
        hasMore: skip + rows.length < total,
      },
    };
  }

  /**
   * Get a single campaign by assignment id or canonical campaign id.
   * Always scoped to the authenticated client — never cross-tenant.
   */
  async getCampaign(clientId, id) {
    const client = await this.assertPartnerClient(clientId);

    const assignment = await this.assignmentRepo.findPartnerCampaignForClient({ clientId, id });
    if (!assignment) throw fail("Campaign not found.", 404);

    const projected = this.projectAssignment(assignment, client, { requirePublished: true });
    if (!projected) throw fail("Campaign not found.", 404);

    return {
      client: toPartnerClientSummaryDto(client),
      campaign: projected,
    };
  }
}
