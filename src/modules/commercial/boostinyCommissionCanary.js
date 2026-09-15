/**
 * Boostiny commission canary — one account, one supplier campaign, optional dry run.
 *
 * The production Boostiny sync already filters by network (/sync/:platform), account
 * (/sync/:platform/:accountLabel) and source object (?sourceObject=), but never by supplier
 * campaign: a campaigns sync normalizes commission rules for every campaign the account lists.
 * The canary adds the one missing dimension, applied to the campaign set the sync has ALREADY
 * fetched from the supplier — nothing is injected — and applied BEFORE any commission write, stale
 * closure or summary closure, so none of those can reach an unrelated campaign.
 *
 * The options travel through the existing per-run sync context (runWithSyncOptions) and are read
 * by the Boostiny account sync only; every other platform ignores them. Scheduled syncs never set
 * them.
 */

import { boostinyCampaignId } from "./boostinyPayoutGroup.mapper.js";

export const CANARY_NETWORK = "boostiny";
const SUPPLIER_CAMPAIGN_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

function present(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function parseBool(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return null;
}

/**
 * Validate admin input into a frozen canary option set. Dry run is the DEFAULT: a caller must say
 * dryRun=false to write. Throws with `status: 400` on anything malformed.
 */
export function normalizeBoostinyCanaryOptions(input = {}) {
  const supplierCampaignId = present(input.supplierCampaignId) ? String(input.supplierCampaignId).trim() : null;
  if (!supplierCampaignId) {
    throw Object.assign(new Error("supplierCampaignId is required for a Boostiny canary sync."), { status: 400 });
  }
  if (!SUPPLIER_CAMPAIGN_ID_RE.test(supplierCampaignId)) {
    throw Object.assign(new Error("supplierCampaignId must be a plain supplier campaign identifier."), { status: 400 });
  }
  const dryRun = parseBool(input.dryRun, true);
  if (dryRun === null) {
    throw Object.assign(new Error("dryRun must be true or false."), { status: 400 });
  }
  return Object.freeze({ network: CANARY_NETWORK, supplierCampaignId, dryRun });
}

/** The canary options of the current sync run, or null when this run is not a Boostiny canary. */
export function resolveBoostinyCanary(syncOptions = {}) {
  const canary = syncOptions?.canary;
  if (!canary || typeof canary !== "object") return null;
  if (canary.network !== CANARY_NETWORK) return null;
  if (!present(canary.supplierCampaignId)) return null;
  return { network: CANARY_NETWORK, supplierCampaignId: String(canary.supplierCampaignId).trim(), dryRun: canary.dryRun !== false };
}

/**
 * The selected campaign row(s) from the fetched supplier set — by exact supplier campaign id.
 * Any id that the supplier did not list selects nothing, and nothing is fabricated.
 */
export function selectCanaryCampaigns(campaigns = [], supplierCampaignId) {
  const wanted = present(supplierCampaignId) ? String(supplierCampaignId).trim() : null;
  if (!wanted) return [];
  return (Array.isArray(campaigns) ? campaigns : []).filter(
    (raw) => raw && typeof raw === "object" && boostinyCampaignId(raw) === wanted,
  );
}
