/**
 * Network Operations — supplier commission listing (Commission 1...N).
 *
 * Locked rule: every distinct supplier payout outcome is one SupplierCommissionRule-shaped
 * row. Persisted canonical SupplierCommissionRule[] rows are authoritative PER CAMPAIGN;
 * campaigns without persisted rules get transitional projected rows built with the very
 * same fan-out/normalizer the ingestion engine uses (never a second parser). Projected
 * rows are display-only (`projected: true`), never order payout truth.
 *
 * `commissionSequence` here is MBO display sequencing (Commission 1...N) — supplier
 * lineage (sourceGroupId/Name, sourceRuleId/Name, outcomeKey) is never overwritten by it.
 */

import { collectEmbeddedCommissionRulesFromCampaigns } from "../commercial/supplierCommissionRuleFanOut.js";
import { toSupplierCommissionRuleDto } from "../commercial/supplierCommissionRule.contract.js";
import {
  assessSupplierCommissionReadiness,
  sourceCommissionText as readinessSourceText,
} from "../commercial/supplierCommissionReadiness.js";

function present(value) {
  return value !== null && value !== undefined && !(typeof value === "string" && value.trim() === "");
}

function text(value) {
  return present(value) ? String(value).trim() : null;
}

function lower(value) {
  return text(value)?.toLowerCase() ?? "";
}

function rawHasCommissionBag(raw = {}) {
  return Boolean(
    raw &&
      typeof raw === "object" &&
      (present(raw.commissionGroups) ||
        present(raw.commission_groups) ||
        present(raw.commissionGroup) ||
        present(raw.payouts) ||
        present(raw.commissions) ||
        present(raw.active_commissions) ||
        present(raw.commission) ||
        present(raw.commissionCost)),
  );
}

function sourceCommissionText(entry) {
  if (entry == null) return null;
  if (typeof entry !== "object") return String(entry);
  const value =
    entry.value ??
    entry.commission ??
    entry.performance_value ??
    entry.amount ??
    entry.rate ??
    entry.payout_value ??
    entry.commissionCost ??
    null;
  if (value == null) return null;
  if (typeof value === "object") {
    const nested = value.value ?? value.amount ?? value.rate ?? null;
    const type = value.type ?? value.model ?? null;
    return [type, nested].filter(present).map(String).join(" ") || null;
  }
  const model = entry.model ?? entry.performance_model ?? entry.type ?? entry.commissionType ?? null;
  return [String(value), model].filter(present).join(" ");
}

/**
 * Mapping/review status for a projected outcome — delegates to the central readiness
 * assessment so Network Ops never disagrees with the commission engine. Ambiguous supplier
 * text ("Up to 10%", bare numbers with no unit, tier/threshold/unknown conditions) never
 * becomes clean MAPPED financial truth.
 */
export function projectedMappingStatus(rule, { display = null } = {}) {
  const assessment = assessSupplierCommissionReadiness(
    { ...rule, metadata: null },
    { sourceText: readinessSourceText(rule?.rawRuleReference), factDisplay: display ?? rule?.metadata?.factDisplay ?? null },
  );
  return {
    mappingStatus: assessment.mappingStatus,
    fieldMappingOutcome: assessment.fieldMappingOutcome,
    reviewReasons: assessment.reviewReasons,
    financeReady: assessment.financeReady,
    semanticStatus: assessment.semanticStatus,
  };
}

/**
 * Project every distinct commission outcome of one SupplierCampaign that has no persisted
 * canonical rules, using the ingestion fan-out (same interpretation as the engine).
 * Returns rule-shaped records (not DTOs).
 */
export function projectCampaignCommissionOutcomes(sc = {}) {
  const raw = sc.rawPayload && typeof sc.rawPayload === "object" && !Array.isArray(sc.rawPayload) ? sc.rawPayload : {};
  const rawForFanOut = { ...raw, id: raw.id ?? raw.campaignId ?? raw.campaign_id ?? sc.supplierCampaignId ?? null };
  const currency = text(sc.commissionCurrency ?? sc.currencyCode);
  const campaigns = [
    {
      rawData: rawForFanOut,
      // Avoid double-collecting the same bag when the raw payload already carries it.
      commissionGroups: rawHasCommissionBag(raw) ? undefined : sc.commissionGroups ?? undefined,
    },
  ];
  let rules = collectEmbeddedCommissionRulesFromCampaigns(campaigns, { sourceObject: "campaigns" });
  let sourcePathOverride = null;

  if (!rules.length && present(sc.defaultCommissionValue)) {
    // Campaign summary/default value: same normalizer, explicitly marked as the source path.
    rules = collectEmbeddedCommissionRulesFromCampaigns(
      [
        {
          rawData: { id: rawForFanOut.id },
          commissionGroups: [
            {
              value: String(sc.defaultCommissionValue),
              currency,
              model: sc.commissionUnit ?? null,
            },
          ],
        },
      ],
      { sourceObject: "campaigns" },
    );
    sourcePathOverride = "defaultCommissionValue";
  }

  const projected = rules.map((rule) => {
    const status = projectedMappingStatus(rule, { display: rule.metadata?.factDisplay ?? null });
    return {
      id: `projected:${sc.id}:${rule.outcomeKey}`,
      supplier: sc.supplier,
      networkSource: sc.networkSource ?? sc.supplier ?? null,
      sourceAccountLabel: sc.sourceAccountLabel ?? null,
      supplierCampaignId: sc.id,
      sourceCampaignId: sc.supplierCampaignId ?? null,
      campaignSourceId: null,
      sourceGroupId: rule.sourceGroupId ?? null,
      sourceGroupName: rule.sourceGroupName ?? null,
      sourceRuleId: rule.sourceRuleId ?? null,
      sourceRuleName: rule.sourceRuleName ?? null,
      outcomeKey: rule.outcomeKey,
      outcomeSlot: rule.outcomeSlot ?? null,
      fanOutSequence: rule.commissionSequence ?? null,
      commissionModel: rule.commissionModel ?? null,
      commissionType: rule.commissionType ?? null,
      supplierRuleType: rule.supplierRuleType ?? null,
      basis: rule.basis ?? "UNKNOWN",
      ratePercent: rule.ratePercent ?? null,
      fixedAmount: rule.fixedAmount ?? null,
      currency: rule.currency ?? (rule.fixedAmount != null ? currency : null),
      priority: rule.priority ?? null,
      rank: rule.rank ?? null,
      customerType: rule.customerType ?? null,
      country: rule.country ?? null,
      categoryProductGoal: rule.categoryProductGoal ?? null,
      couponOrTier: rule.couponOrTier ?? null,
      conditions: rule.conditions ?? [],
      effectiveFrom: rule.effectiveFrom ?? null,
      effectiveUntil: rule.effectiveUntil ?? null,
      sourceObject: rule.sourceObject ?? "campaigns",
      sourcePath: sourcePathOverride ?? rule.sourcePath ?? "commission",
      mappingStatus: status.mappingStatus,
      fieldMappingOutcome: status.fieldMappingOutcome,
      ruleVersion: "PROJECTED",
      rawRuleReference: rule.rawRuleReference ?? null,
      metadata: {
        ...(rule.metadata ?? {}),
        reviewReasons: status.reviewReasons,
        financeReady: false,
        semanticStatus: status.semanticStatus,
        projected: true,
      },
      projected: true,
      projectionNote:
        "Projected from campaign commission evidence; not a persisted canonical SupplierCommissionRule and never order payout truth.",
      updatedAt: sc.updatedAt ?? null,
      supplierCampaign: sc,
    };
  });

  if (!projected.length && (present(sc.defaultCommissionValue) || present(sc.commissionGroups) || rawHasCommissionBag(raw))) {
    // Commission evidence exists but yields no interpretable outcome (e.g. "Variable",
    // "Depends on category"): keep the campaign visible as an UNMAPPED projected row.
    const evidence =
      sourceCommissionText(Array.isArray(sc.commissionGroups) ? sc.commissionGroups[0] : sc.commissionGroups) ??
      (present(sc.defaultCommissionValue) ? String(sc.defaultCommissionValue) : null) ??
      sourceCommissionText(raw.commission ?? raw.commissionCost ?? raw.payouts?.[0] ?? null);
    projected.push({
      id: `projected:${sc.id}:unmapped`,
      supplier: sc.supplier,
      networkSource: sc.networkSource ?? sc.supplier ?? null,
      supplierCampaignId: sc.id,
      sourceCampaignId: sc.supplierCampaignId ?? null,
      campaignSourceId: null,
      outcomeKey: null,
      outcomeSlot: null,
      fanOutSequence: null,
      supplierRuleType: null,
      basis: "UNKNOWN",
      ratePercent: null,
      fixedAmount: null,
      currency: null,
      conditions: [],
      sourceObject: "campaigns",
      sourcePath: "commission (uninterpreted)",
      mappingStatus: "UNMAPPED",
      fieldMappingOutcome: "REVIEW_REQUIRED",
      ruleVersion: "PROJECTED",
      metadata: { reviewReasons: ["commission_text_not_interpretable"], sourceCommissionText: evidence, projected: true },
      projected: true,
      projectionNote: `Supplier commission evidence could not be interpreted as a numeric outcome: ${evidence ?? "n/a"}`,
      updatedAt: sc.updatedAt ?? null,
      supplierCampaign: sc,
    });
  }

  return projected;
}

function nullsLast(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function campaignOf(rule) {
  return rule.supplierCampaign ?? rule.campaignSource?.supplierCampaign ?? null;
}

function campaignKeyOf(rule) {
  const sc = campaignOf(rule);
  return sc?.id ?? rule.supplierCampaignId ?? rule.campaignSource?.supplierCampaignId ?? `rule:${rule.id}`;
}

function campaignSortKey(rule) {
  const sc = campaignOf(rule);
  return [lower(sc?.merchantNameRaw ?? sc?.campaignName), lower(sc?.campaignName), lower(sc?.supplierCampaignId), campaignKeyOf(rule)];
}

function compareArrays(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const c = nullsLast(a[i], b[i]);
    if (c !== 0) return c;
  }
  return 0;
}

function timeOf(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Assign display sequencing (Commission 1...N) within one campaign.
 * Canonical: one sequence per distinct outcomeKey (historical versions share it); order by
 * persisted commissionSequence, first effectiveFrom, outcomeKey — never raw array position
 * when an identity exists. Projected: verified priority/rank first, then fan-out order.
 */
export function sequenceCampaignRows(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.outcomeKey ?? `row:${row.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const ordered = [...groups.entries()].sort(([keyA, a], [keyB, b]) => {
    const first = (list, pick) => list.map(pick).filter((v) => v != null).sort(nullsLast)[0] ?? null;
    const primary = a[0].projected
      ? compareArrays(
          [first(a, (r) => r.priority), first(a, (r) => r.rank), first(a, (r) => r.fanOutSequence)],
          [first(b, (r) => r.priority), first(b, (r) => r.rank), first(b, (r) => r.fanOutSequence)],
        )
      : compareArrays(
          [first(a, (r) => r.commissionSequence), first(a, (r) => timeOf(r.effectiveFrom))],
          [first(b, (r) => r.commissionSequence), first(b, (r) => timeOf(r.effectiveFrom))],
        );
    return primary !== 0 ? primary : nullsLast(keyA, keyB);
  });

  const out = [];
  let sequence = 0;
  for (const [, versions] of ordered) {
    sequence += 1;
    versions
      .sort((a, b) => nullsLast(timeOf(b.effectiveFrom), timeOf(a.effectiveFrom)) || nullsLast(a.id, b.id))
      .forEach((row) => out.push({ ...row, displaySequence: sequence }));
  }
  return out;
}

/**
 * Assemble the hybrid listing: canonical rules grouped per campaign; projected outcomes
 * only for campaigns with no canonical rule. Deterministic order: campaign (brand,
 * campaign name, supplier campaign id, id), then display sequence.
 */
export function assembleSupplierCommissionRows({ canonicalRules = [], fallbackCampaigns = [] } = {}) {
  const byCampaign = new Map();
  for (const rule of canonicalRules) {
    const key = campaignKeyOf(rule);
    if (!byCampaign.has(key)) byCampaign.set(key, { sortKey: campaignSortKey(rule), rows: [], canonical: true });
    byCampaign.get(key).rows.push({ ...rule, projected: false });
  }

  let projectedCampaigns = 0;
  for (const sc of fallbackCampaigns) {
    if (byCampaign.has(sc.id)) continue; // canonical rules are authoritative per campaign
    const rows = projectCampaignCommissionOutcomes(sc);
    if (!rows.length) continue;
    projectedCampaigns += 1;
    byCampaign.set(sc.id, {
      sortKey: [lower(sc.merchantNameRaw ?? sc.campaignName), lower(sc.campaignName), lower(sc.supplierCampaignId), sc.id],
      rows,
      canonical: false,
    });
  }

  const campaigns = [...byCampaign.values()].sort((a, b) => compareArrays(a.sortKey, b.sortKey));
  const rows = [];
  for (const campaign of campaigns) {
    for (const row of sequenceCampaignRows(campaign.rows)) rows.push(row);
  }
  return {
    rows,
    canonicalCampaigns: campaigns.filter((c) => c.canonical).length,
    projectedCampaigns,
  };
}

export function toListingDto(row) {
  const sc = campaignOf(row);
  const dto = toSupplierCommissionRuleDto(
    { ...row, commissionSequence: row.displaySequence ?? row.commissionSequence ?? null },
    { supplierCampaign: sc, campaignSource: row.campaignSource ?? null },
  );
  return {
    ...dto,
    displayLabel: dto.commissionSequence != null ? `Commission ${dto.commissionSequence}` : null,
    persistedCommissionSequence: row.projected ? null : row.commissionSequence ?? null,
    sourceAccountLabel: row.sourceAccountLabel ?? null,
    reviewReasons: row.metadata?.reviewReasons ?? [],
  };
}

/** Search across brand/campaign, supplier ids, lineage, rule-scoped dimensions, value. */
export function matchesCommissionSearch(dto, term) {
  const needle = lower(term);
  if (!needle) return true;
  // Only user-meaningful fields: brand/campaign, supplier ids, supplier lineage, rule-scoped
  // dimensions, condition values and the commission value. Internal enums (basis, status,
  // network) are excluded so short terms such as "SA" do not match "PERCENT_OF_SALE".
  const haystack = [
    dto.brandName,
    dto.campaignName,
    dto.supplierCampaignId,
    dto.sourceCampaignId,
    dto.sourceRuleId,
    dto.sourceRuleName,
    dto.sourceGroupId,
    dto.sourceGroupName,
    dto.country,
    dto.categoryProductGoal,
    dto.customerType,
    dto.couponOrTier,
    dto.commissionValue,
    dto.currency,
    ...(dto.conditions || []).flatMap((c) => [c.value]),
  ]
    .filter(present)
    .map((v) => String(v).toLowerCase());
  return haystack.some((value) => value.includes(needle));
}
