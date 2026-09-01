import { prisma } from "../database/prisma.js";
import {
  CAMPAIGN_REFRESH_HOURS,
  COUPON_REFRESH_HOURS,
} from "./syncConfig.js";
import { isFastSyncEnabled } from "./syncContext.js";

function normalizeAccountLabel(accountLabel) {
  return accountLabel && accountLabel !== "default" ? accountLabel : "default";
}

/**
 * Phase 1 — load per-account sync timestamps for incremental date windows.
 */
export async function getAccountSyncTimestamps(platform, accountLabel) {
  const label = normalizeAccountLabel(accountLabel);
  return prisma.marketplaceAccount.findUnique({
    where: {
      platform_accountLabel: { platform, accountLabel: label },
    },
    select: {
      lastSuccessfulSync: true,
      lastCampaignSyncAt: true,
      lastCouponSyncAt: true,
    },
  });
}

/**
 * Phase 1 — persist timestamps only after a successful account sync.
 * Phase 5 — track campaign/coupon refresh times separately.
 *
 * Env-credential syncs (Partnerize/Impact/etc.) can run with no MarketplaceAccount
 * row. updateMany is a no-op in that case instead of throwing P2025.
 */
export async function updateAccountSyncTimestamps(platform, accountLabel, updates) {
  const label = normalizeAccountLabel(accountLabel);
  const result = await prisma.marketplaceAccount.updateMany({
    where: { platform, accountLabel: label },
    data: updates,
  });
  return result.count;
}

export function hoursSince(date) {
  if (!date) return Number.POSITIVE_INFINITY;
  return (Date.now() - new Date(date).getTime()) / (60 * 60 * 1000);
}

/**
 * Decide whether to re-fetch campaigns from the API.
 * - Fast/incremental sync: skip unless cache TTL (CAMPAIGN_REFRESH_HOURS) expired
 * - Full sync: always refresh so the catalog stays complete
 */
export function shouldRefreshCampaigns(lastCampaignSyncAt, { fastSync } = {}) {
  if (!lastCampaignSyncAt) return true;
  const useFast = typeof fastSync === "boolean" ? fastSync : isFastSyncEnabled();
  if (useFast) return hoursSince(lastCampaignSyncAt) >= CAMPAIGN_REFRESH_HOURS;
  return true;
}

/**
 * Decide whether to re-fetch coupons/voucher codes from the API.
 * Same TTL rules as campaigns.
 */
export function shouldRefreshCoupons(lastCouponSyncAt, { fastSync } = {}) {
  if (!lastCouponSyncAt) return true;
  const useFast = typeof fastSync === "boolean" ? fastSync : isFastSyncEnabled();
  if (useFast) return hoursSince(lastCouponSyncAt) >= COUPON_REFRESH_HOURS;
  return true;
}
