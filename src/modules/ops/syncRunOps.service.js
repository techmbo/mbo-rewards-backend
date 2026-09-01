import { prisma } from "../../database/prisma.js";
import { fail } from "../../core/apiResponse.js";
import { toSyncObservabilityDto } from "../networkOps/syncObservability.contract.js";

export class SyncRunOpsService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
  }

  async list({
    network = null,
    networkAccountId = null,
    status = null,
    jobType = null,
    sourceObject = null,
    from = null,
    to = null,
    skip = 0,
    take = 50,
  } = {}) {
    const where = {};
    if (network) where.network = String(network).toLowerCase();
    if (networkAccountId) where.networkAccountId = networkAccountId;
    if (status) where.status = String(status).toUpperCase();
    if (jobType) where.jobType = String(jobType).toUpperCase();
    if (sourceObject) where.sourceObject = String(sourceObject).toLowerCase();
    if (from || to) {
      where.startedAt = {};
      if (from) where.startedAt.gte = new Date(from);
      if (to) where.startedAt.lte = new Date(to);
    }

    const [rows, total] = await Promise.all([
      this.db.networkSyncRun.findMany({
        where,
        orderBy: { startedAt: "desc" },
        skip,
        take,
      }),
      this.db.networkSyncRun.count({ where }),
    ]);

    return {
      total,
      items: rows.map((row) => toSyncObservabilityDto(row)),
    };
  }

  async getById(id) {
    const row = await this.db.networkSyncRun.findUnique({ where: { id } });
    if (!row) throw fail("Sync run not found.", 404);

    let rawPayloadCount = 0;
    try {
      rawPayloadCount = await this.db.rawPayload.count({ where: { syncRunId: id } });
    } catch {
      rawPayloadCount = 0;
    }

    let childRuns = [];
    try {
      childRuns = await this.db.networkSyncRun.findMany({
        where: { parentSyncRunId: id },
        orderBy: { startedAt: "asc" },
        take: 100,
      });
    } catch {
      childRuns = [];
    }

    return {
      ...toSyncObservabilityDto(row),
      rawPayloadCount,
      childRuns: childRuns.map((r) => toSyncObservabilityDto(r)),
    };
  }
}

export const syncRunOps = new SyncRunOpsService();
