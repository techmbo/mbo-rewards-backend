/**
 * Persist Trackier campaign `payouts[]` into canonical SupplierCommissionRule[] /
 * SupplierCommissionCondition[] rows.
 *
 * RAW campaign row → one rule per payout entry → SupplierCommissionRuleService
 * .upsertNormalizedFact (historical versioning, idempotent on identical economics).
 *
 * Before this existed, Trackier payouts reached the estate only as
 * SupplierCampaign.commissionGroups (an opaque Json blob) and defaultCommissionValue /
 * commissionUnit / commissionCurrency taken from `payouts[0]` alone. A campaign paying
 * different rates per country was therefore represented by its first payout and nothing
 * else — the collapse supplierCommissionFlattening.contract.js forbids, and the reason
 * Trackier could show neither Commission 1..N nor an average.
 *
 * Nothing here selects a payable winner, computes client commission or touches settlement:
 * these rows are supplier metadata. Client payable continues to come from
 * ClientCommissionRule via the campaign assignment.
 */

import { prisma } from "../../database/prisma.js";
import { parseNetworkSource } from "../supplier/entityIdentity.js";
import { looksPercent, payoutBasisFromText } from "../ops/campaignCommissions.js";
import { SupplierCommissionRuleService } from "./services/supplierCommissionRule.service.js";

/** Trackier exposes payouts on the campaigns object; the index is evidence, never identity. */
export const TRACKIER_PAYOUT_SOURCE_OBJECT = "campaigns";
export const TRACKIER_PAYOUT_SOURCE_PATH_PREFIX = "payouts[";
export const TRACKIER_NETWORK_SOURCE = "trackier";

function text(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

function first(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    return value;
  }
  return null;
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** ISO2 only. A country name is not a code, and inventing one would forge a condition. */
function toIso2(value) {
  const s = text(value);
  if (!s) return null;
  return /^[A-Za-z]{2}$/.test(s) ? s.toUpperCase() : null;
}

/** The payout array under a Trackier campaign row, or []. */
export function trackierPayouts(raw = {}) {
  return Array.isArray(raw?.payouts) ? raw.payouts.filter((p) => p && typeof p === "object") : [];
}

/** Whether a campaign row carries payout data worth normalizing. */
export function campaignHasPayouts(raw = {}) {
  return trackierPayouts(raw).length > 0;
}

export function trackierCampaignId(raw = {}) {
  return text(first(raw?.id, raw?._id, raw?.campaign_id, raw?.campaignId, raw?.offer_id));
}

/**
 * Geo targeting on one payout, ISO2 only.
 *
 * Accepts the array and scalar shapes the estate has evidence for. A value that is not an
 * ISO2 code is dropped rather than guessed at, and recorded as a review reason by the caller.
 */
export function payoutCountries(payout = {}) {
  const candidates = [payout?.geo, payout?.geos, payout?.countries, payout?.country, payout?.country_code];
  const out = [];
  const seen = new Set();
  let dropped = 0;
  for (const candidate of candidates) {
    if (candidate == null || candidate === "") continue;
    const list = Array.isArray(candidate) ? candidate : [candidate];
    for (const entry of list) {
      const value = typeof entry === "object" && entry !== null ? first(entry.code, entry.iso, entry.country) : entry;
      const iso = toIso2(value);
      if (!iso) {
        if (text(value)) dropped += 1;
        continue;
      }
      if (seen.has(iso)) continue;
      seen.add(iso);
      out.push(iso);
    }
  }
  return { countries: out, dropped };
}

/** The supplier's own wording for the payout model, in the shapes Trackier uses. */
export function payoutModelText(payout = {}) {
  return text(
    first(payout?.payout_model, payout?.payoutModel, payout?.model, payout?.type, payout?.payout_type),
  );
}

/** The payout amount, in the shapes Trackier uses. */
export function payoutValue(payout = {}) {
  return numberOrNull(first(payout?.payout, payout?.value, payout?.amount, payout?.revenue_payout));
}

/**
 * PERCENT / FIXED / UNKNOWN for one payout — never a guess.
 *
 * `looksPercent` returns a tri-state; null means the supplier wording does not establish the
 * kind, and the rule is persisted with basis UNKNOWN so the campaign summary reports MIXED
 * rather than averaging something it cannot interpret.
 */
export function classifyTrackierPayout(payout = {}) {
  const model = payoutModelText(payout);
  if (!model) return { kind: "UNKNOWN", model: null };
  const percent = looksPercent({ model }, "", null);
  if (percent === true) return { kind: "PERCENT", model };
  if (percent === false) return { kind: "FIXED", model };
  return { kind: "UNKNOWN", model };
}

/** The outcomeKey prefix shared by every payout rule of one campaign. */
export function trackierCampaignOutcomeKeyPrefix(sourceCampaignId) {
  return `trackier::campaign:${sourceCampaignId}::payout:`;
}

/**
 * Stable lineage identity for one payout.
 *
 * Deliberately excludes the payout value — the rule service versions economics under a stable
 * outcomeKey, so putting the rate here would make every rate change a new outcome instead of a
 * new version of the same one. The array index is excluded too: a reordered supplier response
 * must not fork lineage. The index survives in sourcePath as evidence.
 *
 * Preference: the supplier's own payout id; otherwise geo + model, which is what distinguishes
 * one payout from another in the payloads we have evidence for; index only as a last resort.
 */
export function payoutIdentity(payout = {}, index = 0) {
  const id = text(first(payout?.id, payout?._id, payout?.payout_id, payout?.payoutId));
  if (id) return id;
  const { countries } = payoutCountries(payout);
  const model = payoutModelText(payout);
  const signature = [countries.join("+") || null, model].filter(Boolean).join("|");
  return signature || `index:${index}`;
}

/**
 * One candidate rule per payout entry.
 *
 * @param {object} raw      Trackier campaign row
 * @param {object} context  { sourceAccountLabel, supplierCampaignId, campaignSourceId, fetchedAt, rawPayloadId }
 */
export function mapTrackierPayoutCandidates(raw = {}, context = {}) {
  const sourceCampaignId = trackierCampaignId(raw);
  if (!sourceCampaignId) return [];

  const payouts = trackierPayouts(raw);
  const prefix = trackierCampaignOutcomeKeyPrefix(sourceCampaignId);
  const candidates = [];
  let commissionSequence = 0;

  payouts.forEach((payout, index) => {
    const value = payoutValue(payout);
    const { kind, model } = classifyTrackierPayout(payout);
    const { countries, dropped } = payoutCountries(payout);
    // Payout currency only. The campaign currency is a different fact and using it here would
    // attach a currency the supplier never stated for this payout.
    const currency = text(first(payout?.currency, payout?.currency_code));

    const reviewReasons = [];
    if (kind === "UNKNOWN") reviewReasons.push(model ? "payout_model_semantics_unknown" : "payout_model_missing");
    if (value == null) reviewReasons.push("payout_value_missing");
    if (kind === "FIXED" && !currency) reviewReasons.push("fixed_payout_currency_missing");
    if (dropped > 0) reviewReasons.push("payout_geo_not_iso2");

    const basis =
      kind === "PERCENT"
        ? payoutBasisFromText(model, "PERCENT")
        : kind === "FIXED"
          ? payoutBasisFromText(model, "FIXED")
          : "UNKNOWN";

    commissionSequence += 1;

    candidates.push({
      supplier: "TRACKIER",
      sourceAccountLabel: context.sourceAccountLabel ?? "default",
      supplierCampaignId: context.supplierCampaignId ?? null,
      campaignSourceId: context.campaignSourceId ?? null,

      outcomeKey: `${prefix}${payoutIdentity(payout, index)}`,
      commissionSequence,

      sourceRuleId: text(first(payout?.id, payout?._id, payout?.payout_id)),
      sourceRuleName: text(first(payout?.name, payout?.title, payout?.goal, payout?.goal_name)),

      supplierRuleType: model,
      basis,
      // Exactly one of the two is ever set: a payout is a rate or an amount, never both.
      ratePercent: kind === "PERCENT" ? value : null,
      fixedAmount: kind === "FIXED" ? value : null,
      currency,

      conditions: countries.map((code) => ({
        conditionType: "COUNTRY",
        operator: "EQ",
        value: code,
        sourceConditionType: "geo",
        sourceConditionValue: code,
      })),

      networkSource: TRACKIER_NETWORK_SOURCE,
      sourceObject: TRACKIER_PAYOUT_SOURCE_OBJECT,
      sourcePath: `${TRACKIER_PAYOUT_SOURCE_PATH_PREFIX}${index}]`,
      mappingStatus: reviewReasons.length ? "NEEDS_REVIEW" : "MAPPED",
      fieldMappingOutcome: reviewReasons.length ? reviewReasons.join(",") : null,
      rawPayloadId: context.rawPayloadId ?? null,
      rawRuleReference: payout,
      sourceEvidenceAt: context.fetchedAt ?? null,
      metadata: {
        sourceCampaignId,
        payoutIndex: index,
        payoutKind: kind,
        ...(reviewReasons.length ? { reviewReasons } : {}),
      },
    });
  });

  return candidates;
}

export class TrackierPayoutPersistenceService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.ruleService = deps.ruleService ?? new SupplierCommissionRuleService({ prisma: this.db });
    this.now = deps.now ?? (() => new Date());
  }

  /** Source campaign ids whose rows carry payouts[] — the campaigns normalized here. */
  campaignIdsWithPayouts(campaigns = []) {
    const ids = new Set();
    for (const raw of Array.isArray(campaigns) ? campaigns : []) {
      const id = trackierCampaignId(raw);
      if (id && campaignHasPayouts(raw)) ids.add(id);
    }
    return ids;
  }

  async resolveSupplierCampaign({ sourceAccountLabel, sourceCampaignId }, client = null) {
    const db = client ?? this.db;
    if (!db?.supplierCampaign?.findFirst) return null;
    const { supplier, supplierRegion } = parseNetworkSource(TRACKIER_NETWORK_SOURCE);
    return db.supplierCampaign.findFirst({
      where: {
        supplier,
        supplierRegion,
        sourceAccountLabel: sourceAccountLabel ?? "default",
        supplierCampaignId: String(sourceCampaignId),
      },
      include: { campaignSources: { take: 1, orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] } },
    });
  }

  /**
   * Persist the payouts of ONE campaign entity that has just been promoted.
   *
   * Called from the promotion stage, where the SupplierCampaign provably exists because
   * promotion created it moments earlier. `entity.rawData` is the payload staged in this same
   * run, so the payouts are persisted from the first fetch — no second supplier call, and no
   * waiting for a later sync.
   *
   * Nothing is created here: the SupplierCampaign is promotion's to make, and campaignSourceId
   * is read from what exists or left null.
   */
  async persistPromotedCampaign({ entity, supplierCampaign, fetchedAt = null } = {}, client = null) {
    const raw = entity?.rawData && typeof entity.rawData === "object" ? entity.rawData : null;
    if (!raw || !supplierCampaign?.id) return { rules: 0, skipped: 1, persisted: [] };
    if (!campaignHasPayouts(raw)) return { rules: 0, skipped: 1, persisted: [] };

    const campaignSourceId =
      supplierCampaign.campaignSources?.[0]?.id ?? (await this.resolveCampaignSourceId(supplierCampaign.id, client));

    const candidates = mapTrackierPayoutCandidates(raw, {
      sourceAccountLabel: supplierCampaign.sourceAccountLabel ?? "default",
      supplierCampaignId: supplierCampaign.id,
      campaignSourceId,
      rawPayloadId: supplierCampaign.rawPayloadId ?? null,
      fetchedAt: fetchedAt ?? this.now(),
    });

    const persisted = [];
    for (const candidate of candidates) {
      const row = await this.ruleService.upsertNormalizedFact(candidate, client);
      if (row) persisted.push(row);
    }
    return { rules: candidates.length, skipped: 0, persisted };
  }

  /** The campaign's primary source, or null. Never invented. */
  async resolveCampaignSourceId(supplierCampaignId, client = null) {
    const db = client ?? this.db;
    if (!db?.campaignSource?.findFirst) return null;
    const row = await db.campaignSource.findFirst({
      where: { supplierCampaignId },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /**
   * Persist every payout of every supplied campaign row.
   *
   * A campaign with no payouts is skipped rather than written as an empty rule set, so a
   * coupon-only sync that happens to carry campaign rows changes nothing here.
   */
  async persistCampaigns({ campaigns = [], sourceAccountLabel = "default", fetchedAt = null } = {}, client = null) {
    const rows = Array.isArray(campaigns) ? campaigns : [];
    const summary = { campaigns: 0, rules: 0, skipped: 0, unresolved: 0 };
    const persisted = [];

    for (const raw of rows) {
      if (!campaignHasPayouts(raw)) {
        summary.skipped += 1;
        continue;
      }
      const sourceCampaignId = trackierCampaignId(raw);
      if (!sourceCampaignId) {
        summary.skipped += 1;
        continue;
      }

      const supplierCampaign = await this.resolveSupplierCampaign(
        { sourceAccountLabel, sourceCampaignId },
        client,
      );
      if (!supplierCampaign) {
        // The campaign has not been promoted yet. Nothing is invented: the payouts stay in
        // RawPayload and are picked up on the next run once promotion has created the row.
        summary.unresolved += 1;
        continue;
      }

      const candidates = mapTrackierPayoutCandidates(raw, {
        sourceAccountLabel,
        supplierCampaignId: supplierCampaign.id,
        campaignSourceId: supplierCampaign.campaignSources?.[0]?.id ?? null,
        rawPayloadId: supplierCampaign.rawPayloadId ?? null,
        fetchedAt: fetchedAt ?? this.now(),
      });
      if (!candidates.length) {
        summary.skipped += 1;
        continue;
      }

      for (const candidate of candidates) {
        const row = await this.ruleService.upsertNormalizedFact(candidate, client);
        if (row) persisted.push(row);
        summary.rules += 1;
      }
      summary.campaigns += 1;
    }

    return { ...summary, persisted };
  }
}
