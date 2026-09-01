import { prisma } from "../../database/prisma.js";
import { ImportedRecordsService } from "../../modules/ops/importedRecords.service.js";
import { NetworkOpsService } from "../../modules/ops/networkOps.service.js";
import { AdminContractService } from "../../modules/ops/adminContract.service.js";
import { logger } from "../logging/logger.js";

const importedRecords = new ImportedRecordsService();
const networkOps = new NetworkOpsService();
const admin = new AdminContractService();

/** Warm DB pool + hot list caches so first UI navigation is instant. */
export async function warmListCaches() {
  await prisma.$connect();
  const jobs = [
    networkOps.listNetworks({}),
    importedRecords.list({ entityType: "campaign", page: 1, pageSize: 25 }),
    importedRecords.list({ page: 1, pageSize: 25 }),
    admin.listOrders({ skip: 0, take: 25 }, ["CONVERSIONS_READ", "FINANCE_OPS_READ"]),
  ];
  const results = await Promise.allSettled(jobs);
  const failed = results.filter((r) => r.status === "rejected").length;
  logger.info({ warmed: jobs.length - failed, failed }, "list cache warmup complete");
}
