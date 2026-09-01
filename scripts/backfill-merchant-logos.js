/**
 * Idempotent Merchant.logoUrl backfill from persisted SupplierCampaign.campaignLogoUrl.
 * Never invents or scrapes URLs.
 *
 * Usage:
 *   node scripts/backfill-merchant-logos.js [--dry-run]
 */
import "dotenv/config";
import { prisma } from "../src/database/prisma.js";

function okHttpUrl(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return trimmed;
  } catch {
    return null;
  }
}

export async function backfillMerchantLogos({ dryRun = false, client = prisma } = {}) {
  const merchants = await client.merchant.findMany({
    where: { deletedAt: null },
    select: { id: true, displayName: true, logoUrl: true },
  });

  const report = [];
  let updated = 0;
  let alreadyHadLogo = 0;
  let noSourceLogo = 0;

  for (const m of merchants) {
    const existing = okHttpUrl(m.logoUrl);
    if (existing) {
      alreadyHadLogo += 1;
      report.push({
        merchant: m.displayName,
        merchantId: m.id,
        merchantLogoUrl: existing,
        supplierLogo: null,
        final: existing,
        action: "unchanged",
      });
      continue;
    }

    const source = await client.campaignSource.findFirst({
      where: {
        isActive: true,
        canonicalCampaign: { merchantId: m.id, deletedAt: null },
        supplierCampaign: { campaignLogoUrl: { not: null } },
      },
      include: {
        supplierCampaign: {
          select: { campaignLogoUrl: true, supplier: true, campaignName: true },
        },
      },
      orderBy: { updatedAt: "desc" },
    });

    const supplierLogo = okHttpUrl(source?.supplierCampaign?.campaignLogoUrl);
    if (!supplierLogo) {
      noSourceLogo += 1;
      report.push({
        merchant: m.displayName,
        merchantId: m.id,
        merchantLogoUrl: null,
        supplierLogo: null,
        final: null,
        action: "fallback_initials",
      });
      continue;
    }

    if (!dryRun) {
      await client.merchant.update({
        where: { id: m.id },
        data: { logoUrl: supplierLogo },
      });
    }
    updated += 1;
    report.push({
      merchant: m.displayName,
      merchantId: m.id,
      merchantLogoUrl: null,
      supplierLogo,
      supplier: source?.supplierCampaign?.supplier ?? null,
      final: supplierLogo,
      action: dryRun ? "would_backfill" : "backfilled",
    });
  }

  return {
    scanned: merchants.length,
    updated,
    alreadyHadLogo,
    noSourceLogo,
    dryRun,
    report,
  };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const result = await backfillMerchantLogos({ dryRun });
  console.log(
    JSON.stringify(
      {
        scanned: result.scanned,
        updated: result.updated,
        alreadyHadLogo: result.alreadyHadLogo,
        noSourceLogo: result.noSourceLogo,
        dryRun: result.dryRun,
        merchants: result.report.map((r) => ({
          merchant: r.merchant,
          merchantLogoUrl: r.merchantLogoUrl ? "SET" : null,
          supplierLogo: r.supplierLogo ? "SET" : null,
          final: r.final ? "SET" : null,
          action: r.action,
        })),
      },
      null,
      2,
    ),
  );
  await prisma.$disconnect();
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("backfill-merchant-logos.js") ||
    process.argv[1].includes("backfill-merchant-logos"));

if (isDirectRun) {
  main().catch(async (err) => {
    console.error(err);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
}
