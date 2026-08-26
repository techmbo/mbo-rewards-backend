#!/usr/bin/env node
/**
 * Dev-only Client Module visibility reconciliation.
 *
 * Usage:
 *   node scripts/reconcile-client-visibility.js <clientId|slug>
 *
 * Compares DB assignment facts vs PartnerCampaignService (portal/API visibility source).
 * Does not fabricate data. Does not print API secrets.
 */
import "dotenv/config";
import { prisma } from "../src/database/prisma.js";
import { PartnerCampaignService } from "../src/modules/client/services/partnerCampaign.service.js";
import { summarizeAssignmentProvisioning } from "../src/modules/client/provisioningStatus.js";
import { isClientCampaignVisible, explainClientVisibilityBlock } from "../src/modules/client/assignmentVisibilityTruth.js";
import { PARTNER_CAMPAIGN_INCLUDE } from "../src/modules/client/repositories/clientCampaignAssignment.repository.js";

function isProvisioned(row) {
  const p = summarizeAssignmentProvisioning(row);
  return p?.code === "READY" || p?.code === "ACTIVE" || p?.commercialReady === true && p?.trackingReady === true;
}

async function resolveClient(idOrSlug) {
  if (!idOrSlug) return null;
  const byId = await prisma.client.findFirst({
    where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }], deletedAt: null },
  });
  return byId;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: node scripts/reconcile-client-visibility.js <clientId|slug>");
    process.exit(2);
  }

  const client = await resolveClient(arg);
  if (!client) {
    console.error(`Client not found: ${arg}`);
    process.exit(1);
  }

  const assignments = await prisma.clientCampaignAssignment.findMany({
    where: { clientId: client.id },
    include: PARTNER_CAMPAIGN_INCLUDE,
    orderBy: [{ createdAt: "desc" }],
  });

  const assigned = assignments.filter((a) => a.status !== "REVOKED");
  const active = assignments.filter((a) => a.status === "ACTIVE");
  const published = assignments.filter((a) => a.published === true && a.status !== "REVOKED");
  const provisioned = assigned.filter((a) => {
    const p = summarizeAssignmentProvisioning(a);
    return Boolean(
      (p?.commercialReady || p?.hasCommissionRule) &&
        (p?.trackingReady || (a.couponAssignments || []).length > 0),
    );
  });

  const partner = new PartnerCampaignService();
  let apiCampaigns = [];
  let apiError = null;
  try {
    const result = await partner.listCampaigns(client.id, { pageSize: 200 });
    apiCampaigns = result.campaigns || [];
  } catch (err) {
    apiError = { message: err.message, statusCode: err.statusCode };
  }

  const visibleViaTruth = assigned.filter((a) =>
    isClientCampaignVisible({
      client,
      assignment: a,
      dto: partner.projectAssignment(a, client, { requirePublished: true }),
    }),
  );

  const serviceProjected = assigned
    .map((a) => ({ assignment: a, dto: partner.projectAssignment(a, client, { requirePublished: true }) }))
    .filter((x) => x.dto);

  const apiIds = new Set(apiCampaigns.map((c) => c.assignmentId));
  const projectedIds = new Set(serviceProjected.map((x) => x.assignment.id));
  const publishedIds = new Set(published.map((a) => a.id));

  const missingFromApi = [...projectedIds].filter((id) => !apiIds.has(id));
  const extraInApi = [...apiIds].filter((id) => !projectedIds.has(id));
  const publishedNotVisible = published.filter((a) => {
    const dto = partner.projectAssignment(a, client, { requirePublished: true });
    return !dto;
  });

  const rows = assigned.map((a) => {
    const dto = partner.projectAssignment(a, client, { requirePublished: true });
    const block = explainClientVisibilityBlock({ client, assignment: a, dto });
    const p = summarizeAssignmentProvisioning(a);
    return {
      assignmentId: a.id,
      campaign: a.canonicalCampaign?.displayName || a.canonicalCampaignId,
      merchant: a.canonicalCampaign?.merchant?.displayName || null,
      merchantLogo: a.canonicalCampaign?.merchant?.logoUrl || null,
      supplierLogo: a.campaignSource?.supplierCampaign?.campaignLogoUrl || null,
      projectedLogo: dto?.brandLogoUrl || null,
      status: a.status,
      published: a.published === true,
      provisionCode: p?.code || null,
      inApi: apiIds.has(a.id),
      projected: Boolean(dto),
      visibilityBlock: block,
      tracking: Boolean((a.trackingLinks || []).some((t) => t.mboTrackingUrl)),
      commissionEffective: (a.commissionRules || []).some((r) => r.status === "EFFECTIVE"),
    };
  });

  const pass =
    !apiError &&
    missingFromApi.length === 0 &&
    extraInApi.length === 0 &&
    apiCampaigns.length === serviceProjected.length;

  const report = {
    client: { id: client.id, name: client.name, slug: client.slug, status: client.status },
    counts: {
      assignments: assigned.length,
      assignedCount: assigned.length,
      provisionedCount: provisioned.length,
      publishedCount: published.length,
      activeCount: active.length,
      visibleCount: visibleViaTruth.length,
      serviceProjectedCount: serviceProjected.length,
      apiCount: apiCampaigns.length,
      portalSourceCount: apiCampaigns.length, // portal uses same PartnerCampaignService
    },
    apiError,
    discrepancies: {
      missingFromApi,
      extraInApi,
      publishedNotVisible: publishedNotVisible.map((a) => ({
        id: a.id,
        campaign: a.canonicalCampaign?.displayName,
        reason: explainClientVisibilityBlock({
          client,
          assignment: a,
          dto: partner.projectAssignment(a, client, { requirePublished: true }),
        }),
      })),
    },
    rows,
    verdict: pass ? "PASS" : apiError ? "FAIL_API_ERROR" : "FAIL",
  };

  console.log(JSON.stringify(report, null, 2));
  await prisma.$disconnect();
  process.exit(pass ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
