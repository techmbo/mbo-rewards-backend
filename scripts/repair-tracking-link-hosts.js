/**
 * Repair TrackingLink.mboTrackingUrl hosts that no longer match TRACKING_BASE_URL / BACKEND_URL.
 * Preserves id, assignment, slug, subId, pathname, and query — changes only obsolete origin.
 *
 * Usage:
 *   node scripts/repair-tracking-link-hosts.js [--dry-run]
 */
import "dotenv/config";
import { prisma } from "../src/database/prisma.js";
import {
  getTrackingBaseUrl,
  getTrackingBaseOrigin,
  rewriteTrackingUrlOrigin,
} from "../src/modules/commercial/trackingUrl.js";

export async function repairTrackingLinkHosts({ dryRun = false, client = prisma } = {}) {
  const canonicalBase = getTrackingBaseUrl();
  const canonicalOrigin = getTrackingBaseOrigin(canonicalBase);

  const rows = await client.trackingLink.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      mboTrackingUrl: true,
      slug: true,
      subId: true,
      assignmentId: true,
    },
  });

  const toUpdate = [];
  for (const row of rows) {
    if (!row.mboTrackingUrl) continue;
    const next = rewriteTrackingUrlOrigin(row.mboTrackingUrl, canonicalBase);
    if (!next) continue;
    toUpdate.push({
      id: row.id,
      before: row.mboTrackingUrl,
      after: next,
      slug: row.slug,
      subId: row.subId,
      assignmentId: row.assignmentId,
    });
  }

  if (!dryRun) {
    for (const item of toUpdate) {
      await client.trackingLink.update({
        where: { id: item.id },
        data: { mboTrackingUrl: item.after },
      });
    }
  }

  return {
    canonicalBase,
    canonicalOrigin,
    scanned: rows.length,
    alreadyCorrect: rows.length - toUpdate.length,
    updated: toUpdate.length,
    dryRun,
    samples: toUpdate.slice(0, 5).map((r) => ({ id: r.id, before: r.before, after: r.after })),
  };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const result = await repairTrackingLinkHosts({ dryRun });
  console.log(JSON.stringify(result, null, 2));
  await prisma.$disconnect();
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("repair-tracking-link-hosts.js") ||
    process.argv[1].includes("repair-tracking-link-hosts"));

if (isDirectRun) {
  main().catch(async (err) => {
    console.error(err);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
}
