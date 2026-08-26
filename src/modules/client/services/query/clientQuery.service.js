import { decodeCursor, encodeCursor } from "../../../../core/cursorPagination.js";
import { getPagination, toStandardPagedResponse } from "../../../../core/pagination.js";
import {
  toClientBrandRequestDto,
  toClientCampaignAssignmentDto,
  toClientDetailDto,
  toClientDto,
  toClientSummaryDto,
} from "../../dto/client.dto.js";
import {
  aggregateOrderMetricsByAssignmentIds,
  collectSuppliersForAssignment,
} from "../../../coupons/couponCommercial.service.js";
import { buildClientSetupProgress } from "../../setupProgress.js";
import { prisma } from "../../../../database/prisma.js";
import { ClientRepository } from "../../repositories/client.repository.js";
import { ClientBrandRequestRepository } from "../../repositories/clientBrandRequest.repository.js";
import { ClientCampaignAssignmentRepository } from "../../repositories/clientCampaignAssignment.repository.js";
import { ClientAssignmentService } from "../clientAssignment.service.js";
import { ClientVisibilityService } from "../visibility.service.js";

export class ClientQueryService {
  constructor(deps = {}) {
    this.clientRepo = deps.clientRepo ?? new ClientRepository();
    this.requestRepo = deps.requestRepo ?? new ClientBrandRequestRepository();
    this.assignmentRepo = deps.assignmentRepo ?? new ClientCampaignAssignmentRepository();
    this.assignmentService = deps.assignmentService ?? new ClientAssignmentService();
    this.visibility = deps.visibility ?? new ClientVisibilityService();
    this.prisma = deps.prisma ?? prisma;
  }

  /**
   * Attach live setup progress so the Clients dashboard reflects DB state immediately.
   */
  async attachSetupProgress(clients = []) {
    if (!clients.length) return clients;
    const ids = clients.map((c) => c.id).filter(Boolean);
    if (!ids.length) return clients;

    const [assignmentRows, apiKeyRows, portalUserRows] = await Promise.all([
      this.prisma.clientCampaignAssignment.findMany({
        where: { clientId: { in: ids }, status: { not: "REVOKED" } },
        select: {
          clientId: true,
          published: true,
          couponAssignments: {
            where: { status: { in: ["ASSIGNED", "ACTIVE"] } },
            select: { id: true },
            take: 1,
          },
          commissionRules: {
            where: { status: { in: ["DRAFT", "EFFECTIVE"] } },
            select: { id: true },
            take: 1,
          },
          trackingLinks: {
            where: { deletedAt: null, status: { in: ["GENERATED", "ACTIVE"] } },
            select: { id: true },
            take: 1,
          },
        },
      }),
      this.prisma.clientApiCredential.findMany({
        where: { clientId: { in: ids }, revokedAt: null },
        select: { clientId: true, environment: true },
      }),
      this.prisma.user.findMany({
        where: { clientId: { in: ids }, role: "CLIENT", isActive: true },
        select: { clientId: true },
      }),
    ]);

    const byClient = new Map();
    for (const id of ids) {
      byClient.set(id, {
        assignments: [],
        hasApiKey: false,
        hasSandboxKey: false,
        hasProductionKey: false,
        hasAdmin: false,
      });
    }
    for (const row of assignmentRows) {
      const bucket = byClient.get(row.clientId);
      if (bucket) bucket.assignments.push(row);
    }
    for (const row of apiKeyRows) {
      const bucket = byClient.get(row.clientId);
      if (!bucket) continue;
      bucket.hasApiKey = true;
      if (row.environment === "SANDBOX") bucket.hasSandboxKey = true;
      else bucket.hasProductionKey = true;
    }
    for (const row of portalUserRows) {
      const bucket = byClient.get(row.clientId);
      if (bucket) bucket.hasAdmin = true;
    }

    return clients.map((client) => {
      const stats = byClient.get(client.id) || {
        assignments: [],
        hasApiKey: false,
        hasSandboxKey: false,
        hasProductionKey: false,
        hasAdmin: false,
      };
      const assignments = stats.assignments;
      const hasAssignments = assignments.length > 0;
      const allPublished = hasAssignments && assignments.every((a) => a.published);
      const publishedCount = assignments.filter((a) => a.published === true).length;
      const progress = buildClientSetupProgress({
        status: client.status,
        commercialModel: client.commercialModel,
        deliveryMethod: client.deliveryMethod,
        agreementStatus: client.agreementStatus,
        hasAssignments,
        hasPublishedAssignment: publishedCount > 0,
        allPublished,
        hasApiKey: stats.hasProductionKey || stats.hasApiKey,
        hasSandboxKey: stats.hasSandboxKey,
        hasProductionKey: stats.hasProductionKey,
        hasAdmin: stats.hasAdmin,
        hasCouponAssignments: assignments.some((a) => (a.couponAssignments?.length ?? 0) > 0),
        hasCommissionRules: !hasAssignments || assignments.every((a) => (a.commissionRules?.length ?? 0) > 0),
        hasTrackingLinks:
          !hasAssignments ||
          assignments.every((a) => (a.trackingLinks || []).some((t) => t.mboTrackingUrl)),
      });

      return {
        ...client,
        opsSummary: {
          assignedCount: assignments.length,
          publishedCount,
          apiAccess: stats.hasProductionKey || stats.hasApiKey ? "CONFIGURED" : "NOT_CREATED",
          sandboxAccess: stats.hasSandboxKey ? "CONFIGURED" : "NOT_CREATED",
          portalAccess: stats.hasAdmin ? "CONFIGURED" : "NOT_CREATED",
          deliveryMethod: client.deliveryMethod ?? "API_AND_PORTAL",
          agreementStatus: client.agreementStatus ?? "NONE",
          commercialConfigured: Boolean(client.commercialModel),
          agreementSigned: String(client.agreementStatus || "").toUpperCase() === "SIGNED",
          readyForActivation: Boolean(
            progress.checklist.provisioned &&
              progress.checklist.agreementSigned &&
              (!progress.checklist.needsPortal || progress.checklist.administratorConfigured),
          ),
          activated: client.status === "ACTIVE",
        },
        setupProgress: {
          steps: progress.steps,
          completedSteps: progress.completedSteps,
          totalSteps: progress.totalSteps,
          setupComplete: progress.setupComplete,
          suggestedStep: progress.suggestedStep,
          checklist: progress.checklist,
        },
      };
    });
  }

  async listClients(query) {
    const filters = {
      status: query.status,
      country: query.country,
      industry: query.industry,
      search: query.search,
    };
    const { page, pageSize, skip } = getPagination(query);
    const useCursor = Boolean(query.cursor);

    if (useCursor) {
      const cursor = decodeCursor(query.cursor, ["name", "id"]);
      const { rows, hasMore } = await this.clientRepo.findManyCursor(filters, {
        take: pageSize,
        cursor,
      });

      const withProgress = await this.attachSetupProgress(rows);
      const data = withProgress.map((row) => toClientSummaryDto(row));
      const nextCursor = hasMore ? encodeCursor(rows[rows.length - 1], ["name", "id"]) : null;

      return toStandardPagedResponse({
        rows: data,
        total: null,
        page: null,
        pageSize,
        nextCursor,
        hasMore,
      });
    }

    const { rows, total } = await this.clientRepo.findMany(filters, { skip, take: pageSize });
    const withProgress = await this.attachSetupProgress(rows);
    const data = withProgress.map((row) => toClientSummaryDto(row));

    return toStandardPagedResponse({ rows: data, total, page, pageSize, hasMore: skip + rows.length < total });
  }

  async getClientById(id) {
    const record = await this.clientRepo.findById(id, { includeRelations: true });
    if (!record) return null;

    const visibleAssignments = this.visibility.filterVisibleAssignments(record.assignments ?? [], record);

    return toClientDetailDto(record, { visibleAssignments });
  }

  async listBrandRequests(query) {
    const filters = {
      clientId: query.clientId,
      merchantId: query.merchantId,
      status: query.status,
      search: query.search,
    };
    const { page, pageSize, skip } = getPagination(query);
    const useCursor = Boolean(query.cursor);

    if (useCursor) {
      const cursor = decodeCursor(query.cursor, ["requestedAt", "id"]);
      const { rows, hasMore } = await this.requestRepo.findManyCursor(filters, {
        take: pageSize,
        cursor,
      });

      const data = rows.map((row) => toClientBrandRequestDto(row));
      const nextCursor = hasMore ? encodeCursor(rows[rows.length - 1], ["requestedAt", "id"]) : null;

      return toStandardPagedResponse({
        rows: data,
        total: null,
        page: null,
        pageSize,
        nextCursor,
        hasMore,
      });
    }

    const { rows, total } = await this.requestRepo.findMany(filters, { skip, take: pageSize });
    const data = rows.map((row) => toClientBrandRequestDto(row));

    return toStandardPagedResponse({ rows: data, total, page, pageSize, hasMore: skip + rows.length < total });
  }

  async listAssignments(query) {
    const filters = {
      clientId: query.clientId,
      canonicalCampaignId: query.canonicalCampaignId,
      status: query.status,
      published: query.published,
      visibleToClient: query.visibleToClient,
      search: query.search || query.q || null,
      network: query.network || query.networkSource || null,
      networkSource: query.networkSource || query.network || null,
    };
    const { page, pageSize, skip } = getPagination(query);
    const useCursor = Boolean(query.cursor);

    const applyLedgerFilters = (rows) => {
      let data = rows;
      const commercial = query.commercialModel
        ? String(query.commercialModel).toUpperCase()
        : null;
      if (commercial) {
        data = data.filter((r) => String(r.commercialModel || "").toUpperCase() === commercial);
      }
      const channel = query.channel ? String(query.channel).toUpperCase() : null;
      if (channel === "LINK") data = data.filter((r) => r.channels?.link && !r.channels?.coupon);
      else if (channel === "COUPON") data = data.filter((r) => r.channels?.coupon && !r.channels?.link);
      else if (channel === "DEEPLINK") data = data.filter((r) => r.channels?.deeplink);
      else if (channel === "COUPON_LINK" || channel === "LINK_AND_COUPON") {
        data = data.filter((r) => r.channels?.link && r.channels?.coupon);
      }
      const tracking = query.trackingStatus ? String(query.trackingStatus).toUpperCase() : null;
      if (tracking === "READY") data = data.filter((r) => r.hasTrackingUrl === true);
      else if (tracking === "PENDING") {
        data = data.filter(
          (r) =>
            !r.hasTrackingUrl &&
            (r.provisioning?.code === "TRACKING_PENDING" || r.provisioning?.code === "PROVISIONING"),
        );
      } else if (tracking === "MISSING") {
        data = data.filter((r) => !r.hasTrackingUrl);
      } else if (tracking === "REVOKED") {
        data = data.filter((r) => String(r.trackingStatus || "").toUpperCase() === "REVOKED");
      }
      const coupon = query.couponStatus ? String(query.couponStatus).toUpperCase() : null;
      if (coupon === "ASSIGNED") data = data.filter((r) => r.couponAssigned === true);
      else if (coupon === "NOT_AVAILABLE") data = data.filter((r) => r.couponAssigned !== true);
      else if (coupon === "PENDING") {
        data = data.filter(
          (r) => r.couponAssigned && String(r.couponStatus || "").toUpperCase() === "PENDING",
        );
      }
      const lifecycle = query.lifecycle || query.assignmentLifecycle || null;
      if (lifecycle) {
        const want = String(lifecycle).toUpperCase();
        data = data.filter((r) => String(r.assignmentStatus || "").toUpperCase() === want);
      }
      return data;
    };

    if (useCursor) {
      const cursor = decodeCursor(query.cursor, ["createdAt", "id"]);
      const { rows, hasMore } = await this.assignmentRepo.findManyCursor(filters, {
        take: pageSize,
        cursor,
      });

      const data = applyLedgerFilters(await this.projectAssignments(rows));
      const nextCursor = hasMore ? encodeCursor(rows[rows.length - 1], ["createdAt", "id"]) : null;

      return toStandardPagedResponse({
        rows: data,
        total: null,
        page: null,
        pageSize,
        nextCursor,
        hasMore,
        meta: {
          totalCampaigns: null,
          ledgerNote:
            "Derived filters (lifecycle/channel/commercial/tracking/coupon) apply within the fetched page window.",
        },
      });
    }

    const { rows, total } = await this.assignmentRepo.findMany(filters, { skip, take: pageSize });
    const data = applyLedgerFilters(await this.projectAssignments(rows));

    return {
      ...toStandardPagedResponse({ rows: data, total, page, pageSize, hasMore: skip + rows.length < total }),
      meta: {
        totalCampaigns: total,
        pageMatched: data.length,
        ledgerNote:
          "totalCampaigns is SQL-filtered (client/status/published/search/network). Derived lifecycle/channel/commercial/tracking/coupon filters may reduce the current page further.",
      },
    };
  }

  async projectAssignments(rows = []) {
    const metricsMap = await aggregateOrderMetricsByAssignmentIds(
      rows.map((row) => row.id),
      rows,
    );
    return rows.map((row) => {
      const suppliers = collectSuppliersForAssignment(row);
      const metrics = metricsMap.get(row.id) || {
        grossOrders: 0,
        netOrders: 0,
        grossOrderValue: 0,
        netOrderValue: 0,
        currency: null,
      };
      return this.projectAssignment({
        ...row,
        suppliers,
        supplierLabel: formatSupplierLabel(suppliers),
        grossOrders: metrics.grossOrders,
        netOrders: metrics.netOrders,
        grossOrderValue: metrics.grossOrderValue,
        netOrderValue: metrics.netOrderValue,
        ordersCurrency: metrics.currency,
      });
    });
  }

  projectAssignment(row) {
    const dto = toClientCampaignAssignmentDto(row, { includeStaffCommercial: true });
    if (dto) {
      dto.lifecycle = this.assignmentService.resolveLifecycle(row);
    }
    return dto;
  }
}

function formatSupplierLabel(suppliers = []) {
  if (!suppliers.length) return null;
  if (suppliers.length === 1) return suppliers[0];
  return `${suppliers[0]} +${suppliers.length - 1} more`;
}
