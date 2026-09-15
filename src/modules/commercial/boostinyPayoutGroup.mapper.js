/**
 * Boostiny campaign payouts[].groups[] → SupplierCommissionRule candidates.
 *
 * Source (live-certified shape, GET /publisher/campaigns):
 *   payouts[]  model / level / is_global / start_date / end_date
 *     groups[] id / priority / type / value / conditions / capping / product_categories / coupons
 *
 * Locked MBO architecture (Pointer 12 / 38 / 39):
 * - every distinct payout outcome — every group under every payout — is its own
 *   SupplierCommissionRule. Nothing is averaged, merged or collapsed; "Commission 1..N" is a
 *   display sequence, never identity;
 * - identity is supplier evidence and nothing else: network + source object + source campaign id
 *   + payout identity + group id. The group id is only known to be unique within its payout, so
 *   the payout identity is part of the key. Value, rate, amount, priority, qualifiers, display
 *   sequence and array positions are all EXCLUDED: a change to any of them versions the same
 *   outcome through the rule service instead of minting a second, unrelated identity;
 * - qualifiers are NOT flattened into the outcome: groups[].conditions, product_categories,
 *   coupons and capping become child conditions of the one rule they qualify, so later matching
 *   can decide which supplier rule applies to an order. Nothing here decides that;
 * - groups[].type decides the value kind ONLY when it is an established convention
 *   (looksPercent): sale-share/percent → percent; fixed/flat/cpa/… → fixed amount. An unfamiliar
 *   type is preserved as-is with the numeric value kept as evidence, never guessed;
 * - no currency exists in the live payout/group structure, and the Boostiny contract only ever
 *   reads currency from the payout itself — so currency is null unless the payout/group states
 *   one. Campaign currency is never inherited;
 * - payouts[].start_date/end_date are preserved as the rule's effective window. Expired and future
 *   payouts are normalized like any other; nothing is discarded by date;
 * - groups[].priority is preserved as supplier precedence. Selecting a payable winner, client
 *   commission and settlement are separate layers and are not touched here.
 */

import { looksPercent, payoutBasisFrom } from "../ops/campaignCommissions.js";
import { canonicalJson, fingerprint } from "./supplierCommissionReadiness.js";
import { conditionsFromSourceEntry } from "./supplierCommissionRuleFanOut.js";

/** The rules come from the campaigns rows themselves; there is no separate Boostiny endpoint. */
export const BOOSTINY_PAYOUT_GROUP_SOURCE_OBJECT = "campaigns";
export const BOOSTINY_PAYOUT_GROUP_RULE_VERSION = "BOO-PG-1";
/** The generic campaign-summary fan-out marks its rules with this sourcePath. */
export const BOOSTINY_SUMMARY_FAN_OUT_SOURCE_PATH = "commission";

/** Fail-closed gate: the matcher cannot evaluate this MBO condition, so an unverified rule
 *  yields REVIEW_REQUIRED rather than a payout guess or a silent fallback to a broader rule. */
export const BOOSTINY_VERIFY_LIVE_GATE = Object.freeze({
  conditionType: "OTHER_SOURCE_CONDITION",
  operator: "EQ",
  value: "VERIFY_LIVE",
  sourceConditionType: "MBO_VERIFY_LIVE_GATE",
});

/** Payout-model bases under which a percent group is coherent (or the model says nothing). */
const PERCENT_COMPATIBLE_MODEL_BASES = new Set(["UNKNOWN", "PERCENT_OF_SALE", "CPS"]);
/** Payout-model bases that name a percent-of-sale model, incoherent with a fixed-amount group. */
const PERCENT_ONLY_MODEL_BASES = new Set(["PERCENT_OF_SALE", "CPS"]);

function present(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  return true;
}

function text(value) {
  return present(value) ? String(value).trim() : null;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function isEmpty(value) {
  if (!present(value)) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/** Explicit numeric value, including zero and numeric strings ("4", "4.5", "4%"). Blank → null. */
function explicitNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/%/g, "").replace(/,/g, "").trim();
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function currencyCode(value) {
  if (!present(value)) return null;
  if (typeof value === "object") {
    return currencyCode(value.code ?? value.currency_code ?? value.currencyCode ?? value.iso ?? value.currency);
  }
  const code = String(value).trim().toUpperCase().slice(0, 3);
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function validDateText(value) {
  if (!present(value)) return { present: false, valid: true, value: null };
  const date = new Date(value);
  return { present: true, valid: !Number.isNaN(date.getTime()), value: String(value) };
}

export function boostinyCampaignId(raw = {}) {
  return text(raw?.id ?? raw?.campaign_id ?? raw?.campaignId);
}

export function boostinyPayouts(raw = {}) {
  return asArray(raw?.payouts).filter((payout) => payout && typeof payout === "object");
}

export function boostinyGroups(payout = {}) {
  return asArray(payout?.groups).filter((group) => group && typeof group === "object");
}

/** Whether a campaign row carries the detailed structure this mapper normalizes. */
export function campaignHasPayoutGroups(raw = {}) {
  return boostinyPayouts(raw).some((payout) => boostinyGroups(payout).length > 0);
}

/**
 * Payout identity. A supplier payout id when one exists; otherwise a fingerprint of the payout's
 * stable non-economic semantics (model, level, is_global, window). Never the array index — a
 * reordered response must not create new lineage. The index stays in sourcePath as evidence.
 */
export function boostinyPayoutIdentity(payout = {}) {
  const id = text(payout.id ?? payout.payout_id ?? payout.payoutId);
  if (id) return { strategy: "SUPPLIER_ID", key: `id:${id}`, inputs: { id } };
  const inputs = {
    model: text(payout.model)?.toLowerCase() ?? null,
    level: text(payout.level)?.toLowerCase() ?? null,
    isGlobal: payout.is_global ?? payout.isGlobal ?? null,
    startDate: text(payout.start_date ?? payout.startDate),
    endDate: text(payout.end_date ?? payout.endDate),
  };
  return { strategy: "PAYOUT_SEMANTIC_FINGERPRINT", key: `fp:${fingerprint(inputs)}`, inputs };
}

/**
 * Group identity: the supplier group id. Without one, a deterministic fingerprint of the group's
 * stable STRUCTURAL semantics (type and qualifiers) — enough to tell sibling groups apart, but
 * never the value, the priority, the display sequence or the array index, so a change to any of
 * those still versions the same fallback identity. Always flagged for review.
 */
export function boostinyGroupIdentity(group = {}) {
  const id = text(group.id ?? group.group_id ?? group.groupId);
  if (id) return { strategy: "SUPPLIER_ID", sufficient: true, key: id, inputs: { id } };
  const inputs = {
    type: text(group.type)?.toLowerCase() ?? null,
    conditions: isEmpty(group.conditions) ? null : group.conditions,
    productCategories: isEmpty(group.product_categories) ? null : group.product_categories,
    coupons: isEmpty(group.coupons) ? null : group.coupons,
    capping: isEmpty(group.capping) ? null : group.capping,
  };
  const sufficient = Object.values(inputs).some((value) => value !== null);
  return {
    strategy: sufficient ? "ANONYMOUS_SEMANTIC_FINGERPRINT" : "ANONYMOUS_INSUFFICIENT",
    sufficient,
    key: `${sufficient ? "ANON" : "ANON_UNIDENTIFIED"}:${fingerprint(sufficient ? inputs : { ...inputs, group })}`,
    inputs,
  };
}

/**
 * Value kind from groups[].type, using the established convention (looksPercent) and nothing
 * newer. The payout model is consulted only when the group states no type at all.
 *
 * @returns {{ kind: "PERCENT"|"FIXED"|"UNKNOWN", decidedBy: "group.type"|"payout.model"|null }}
 */
export function classifyBoostinyGroupType(group = {}, payout = {}) {
  const type = text(group.type);
  const valueText = typeof group.value === "string" ? group.value : "";
  if (type) {
    const percent = looksPercent({ type }, valueText, null);
    if (percent === true) return { kind: "PERCENT", decidedBy: "group.type" };
    if (percent === false) return { kind: "FIXED", decidedBy: "group.type" };
    return { kind: "UNKNOWN", decidedBy: null };
  }
  const model = text(payout.model);
  if (model) {
    const percent = looksPercent({ model }, valueText, null);
    if (percent === true) return { kind: "PERCENT", decidedBy: "payout.model" };
    if (percent === false) return { kind: "FIXED", decidedBy: "payout.model" };
  }
  return { kind: "UNKNOWN", decidedBy: null };
}

function qualifierValues(list) {
  return asArray(list)
    .map((item) => {
      if (item == null) return null;
      if (typeof item !== "object") return { value: text(item), source: item };
      const value = text(item.id ?? item.code ?? item.coupon ?? item.name ?? item.value ?? item.slug);
      return value ? { value, source: item } : null;
    })
    .filter(Boolean);
}

/**
 * Boostiny operations that state membership or equality over the listed value(s). Each expands
 * to one EQ row per value — the shared representation of same-dimension alternatives, which the
 * matcher evaluates as "any of". Anything else passes through verbatim (upper-cased) so the
 * matcher reports an unsupported operator and fails closed rather than guessing a meaning.
 */
const BOOSTINY_OPERATION_MAP = Object.freeze({ contains: "EQ", in: "EQ", equals: "EQ", eq: "EQ", "=": "EQ" });

/**
 * Certified Boostiny condition semantics. Certified on the production Bloomingdales payload
 * (supplier campaign 61): `dimension: "country"` with `contains` over a list, or `equals` over one
 * value, means "the transaction's country is one of the listed values" — exactly what the matcher
 * evaluates for same-dimension COUNTRY / EQ alternatives. Nothing else is certified: any other
 * dimension (business-category included) or operation stays unverified and gates the rule.
 */
const BOOSTINY_CERTIFIED_DIMENSIONS = new Set(["country"]);
const BOOSTINY_CERTIFIED_OPERATIONS = new Set(["contains", "in", "equals", "eq", "="]);
const BOOSTINY_COUNTRY_CERTIFICATION = "boostiny_country_semantics_certified";

/**
 * Whether ONE normalized row from a Boostiny group condition has certified semantics: it must be a
 * canonical COUNTRY row produced from the certified dimension, with a certified operation that
 * normalized to EQ, from the Boostiny { dimension, operation, value } shape. Anything else — an
 * unmapped dimension, an unknown operation, a generic-shaped condition — is not certified.
 */
function boostinyConditionCertified(condition, { original, sourceDimension, sourceOperation }) {
  if (!original || typeof original !== "object") return false;
  if (!sourceDimension || !BOOSTINY_CERTIFIED_DIMENSIONS.has(sourceDimension.toLowerCase())) return false;
  if (!sourceOperation || !BOOSTINY_CERTIFIED_OPERATIONS.has(sourceOperation.toLowerCase())) return false;
  return condition?.conditionType === "COUNTRY" && condition?.operator === "EQ";
}

/**
 * Adapt ONE Boostiny group condition — { dimension, operation, value } — to the key names the
 * shared normalizer reads (type / operator / value). `dimension` becomes the source dimension, so
 * "country" reaches the canonical COUNTRY map while an unmapped dimension such as
 * "business-category" stays OTHER_SOURCE_CONDITION with its dimension preserved as the source
 * type. Conditions not in that shape are returned as-is. The input is never mutated.
 */
export function adaptBoostinyCondition(condition) {
  if (!condition || typeof condition !== "object") return condition;
  const dimension = text(condition.dimension);
  const operation = text(condition.operation);
  if (!dimension && !operation) return condition;
  const operator = operation
    ? (BOOSTINY_OPERATION_MAP[operation.toLowerCase()] ?? operation.toUpperCase().replace(/[^A-Z0-9]+/g, "_"))
    : "EQ";
  return { type: dimension ?? "conditions", operator, value: condition.value ?? condition.values ?? null };
}

/**
 * Child conditions of ONE rule. Each qualifier dimension stays with the outcome it qualifies
 * (Pointer 39); same-dimension values are alternatives, different dimensions are conjunctive —
 * exactly as the matcher evaluates them.
 */
export function boostinyGroupConditions(group = {}) {
  const conditions = Array.isArray(group.conditions)
    ? group.conditions.flatMap((original, sourceConditionIndex) => {
        if (original == null) return [];
        // Adapt the Boostiny { dimension, operation, value } shape for the shared normalizer, then
        // re-attach the ORIGINAL supplier object as the evidence — never the adapted one.
        const adapted = adaptBoostinyCondition(original);
        const sourceDimension = typeof original === "object" ? text(original.dimension) : null;
        const sourceOperation = typeof original === "object" ? text(original.operation) : null;
        const lineage = { sourceCondition: original, sourceConditionIndex, sourceDimension, sourceOperation };
        const rows = conditionsFromSourceEntry({ conditions: [adapted] });
        if (rows.length === 0) {
          // A condition that yields no value (e.g. an empty list) must not vanish into an
          // unconditioned rule: keep it as an unverified source condition so the rule fails closed.
          return [{
            conditionType: "OTHER_SOURCE_CONDITION",
            operator: typeof adapted === "object" && adapted?.operator ? adapted.operator : "EQ",
            value: canonicalJson(original),
            sourceConditionType: sourceDimension ?? "conditions",
            sourceConditionValue: original,
            metadata: { ...lineage, emptyValue: true, matcherReady: false, reason: "boostiny_condition_semantics_not_verified_live" },
          }];
        }
        return rows.map((condition) => {
          const certified = boostinyConditionCertified(condition, { original, sourceDimension, sourceOperation });
          return {
            ...condition,
            sourceConditionValue: original,
            metadata: certified
              ? { ...(condition.metadata ?? {}), ...lineage, matcherReady: true, semanticsVerified: true, verifiedBy: BOOSTINY_COUNTRY_CERTIFICATION }
              : { ...(condition.metadata ?? {}), ...lineage, matcherReady: false, reason: "boostiny_condition_semantics_not_verified_live" },
          };
        });
      })
    : conditionsFromSourceEntry({ conditions: group.conditions ?? null }).map((condition) => ({
        ...condition,
        metadata: { ...(condition.metadata ?? {}), matcherReady: false, reason: "boostiny_condition_semantics_not_verified_live" },
      }));

  for (const { value, source } of qualifierValues(group.product_categories)) {
    conditions.push({
      conditionType: "CATEGORY",
      operator: "EQ",
      value,
      sourceConditionType: "product_categories",
      sourceConditionValue: source,
      metadata: { matcherReady: false, reason: "boostiny_product_category_semantics_not_verified_live" },
    });
  }
  for (const { value, source } of qualifierValues(group.coupons)) {
    conditions.push({
      conditionType: "COUPON",
      operator: "EQ",
      value,
      sourceConditionType: "coupons",
      sourceConditionValue: source,
      metadata: { matcherReady: false, reason: "boostiny_coupon_qualifier_semantics_not_verified_live" },
    });
  }
  if (!isEmpty(group.capping)) {
    // A cap bounds the payout; it is not a matching dimension. Kept as a source condition so the
    // matcher fails closed on a capped rule instead of computing an uncapped amount.
    conditions.push({
      conditionType: "OTHER_SOURCE_CONDITION",
      operator: "SOURCE_CAP",
      value: canonicalJson(group.capping),
      sourceConditionType: "capping",
      sourceConditionValue: group.capping,
      metadata: { matcherReady: false, reason: "boostiny_capping_semantics_not_verified_live" },
    });
  }
  return conditions;
}

/** The stable supplier-rule identity. Exactly these five segments; nothing mutable in them. */
export function boostinyPayoutGroupOutcomeKey({ campaignId, payoutKey, groupKey }) {
  return [
    "boostiny",
    BOOSTINY_PAYOUT_GROUP_SOURCE_OBJECT,
    campaignId ?? "NO_CAMPAIGN_ID",
    `payout:${payoutKey}`,
    `group:${groupKey}`,
  ].join("::");
}

/** The outcomeKey prefix shared by every payout-group rule of one campaign. */
export function boostinyCampaignOutcomeKeyPrefix(campaignId) {
  return `boostiny::${BOOSTINY_PAYOUT_GROUP_SOURCE_OBJECT}::${campaignId ?? "NO_CAMPAIGN_ID"}::payout:`;
}

/** Source campaign id encoded in a payout-group outcomeKey (null for other keys). */
export function sourceCampaignIdFromBoostinyOutcomeKey(outcomeKey) {
  if (typeof outcomeKey !== "string") return null;
  const parts = outcomeKey.split("::");
  if (parts[0] !== "boostiny" || parts[1] !== BOOSTINY_PAYOUT_GROUP_SOURCE_OBJECT || !parts[3]?.startsWith("payout:")) return null;
  return parts[2] && parts[2] !== "NO_CAMPAIGN_ID" ? parts[2] : null;
}

function payoutWithoutGroups(payout = {}) {
  const { groups, ...rest } = payout;
  return rest;
}

/**
 * Map every payout group of one campaign row into SupplierCommissionRule candidates.
 *
 * @param {object} raw       one Boostiny campaign row as the supplier sent it
 * @param {object} context   { networkSource, sourceAccountLabel, supplierCampaignId, campaignSourceId, fetchedAt }
 */
export function mapBoostinyPayoutGroupCandidates(raw = {}, context = {}) {
  const campaignId = boostinyCampaignId(raw);
  const results = [];
  const seen = new Set();
  let commissionSequence = 0;

  boostinyPayouts(raw).forEach((payout, payoutIndex) => {
    const payoutIdentity = boostinyPayoutIdentity(payout);
    const model = text(payout.model);
    const level = text(payout.level);
    const isGlobal = payout.is_global ?? payout.isGlobal ?? null;
    const startDate = validDateText(payout.start_date ?? payout.startDate);
    const endDate = validDateText(payout.end_date ?? payout.endDate);
    const payoutCurrency = currencyCode(payout.currency ?? payout.currency_code ?? payout.currencyCode);

    boostinyGroups(payout).forEach((group, groupIndex) => {
      const groupIdentity = boostinyGroupIdentity(group);
      const groupId = groupIdentity.strategy === "SUPPLIER_ID" ? groupIdentity.key : null;
      const groupType = text(group.type);
      const { kind, decidedBy } = classifyBoostinyGroupType(group, payout);
      const value = explicitNumber(group.value);
      const currency = currencyCode(group.currency ?? group.currency_code ?? group.currencyCode) ?? payoutCurrency;
      const priority = explicitNumber(group.priority);
      const conditions = boostinyGroupConditions(group);
      const sourcePath = `payouts[${payoutIndex}].groups[${groupIndex}]`;

      const reviewReasons = [];
      if (!groupId) reviewReasons.push("supplier_group_id_missing");
      if (!groupId && !groupIdentity.sufficient) reviewReasons.push("anonymous_group_identity_insufficient");
      if (kind === "UNKNOWN") reviewReasons.push(groupType ? "group_type_semantics_unknown" : "group_type_missing");
      if (value == null) reviewReasons.push("group_value_missing");
      if (kind === "FIXED" && !currency) reviewReasons.push("fixed_payout_currency_missing");
      if (conditions.some((condition) => condition.metadata?.reason === "boostiny_condition_semantics_not_verified_live"))
        reviewReasons.push("boostiny_condition_semantics_not_verified_live");
      if (!isEmpty(group.product_categories)) reviewReasons.push("boostiny_product_category_semantics_not_verified_live");
      if (!isEmpty(group.coupons)) reviewReasons.push("boostiny_coupon_qualifier_semantics_not_verified_live");
      if (!isEmpty(group.capping)) reviewReasons.push("boostiny_capping_semantics_not_verified_live");
      if (!startDate.valid || !endDate.valid) reviewReasons.push("payout_window_invalid");

      // The group type decides the value kind; the payout model decides the basis wording. When
      // the two disagree (a percent group under a CPA payout, a fixed amount under a CPS payout)
      // the conflict is preserved for review rather than resolved by guessing.
      const modelBasis = model ? payoutBasisFrom({ model }, null, null) : "UNKNOWN";
      let basis = "UNKNOWN";
      if (kind === "PERCENT") {
        basis = payoutBasisFrom({ type: groupType }, null, "PERCENT");
        if (!PERCENT_COMPATIBLE_MODEL_BASES.has(modelBasis)) reviewReasons.push("payout_model_group_type_conflict");
      } else if (kind === "FIXED") {
        basis = payoutBasisFrom({ model, type: groupType }, null, "FIXED");
        if (PERCENT_ONLY_MODEL_BASES.has(modelBasis)) reviewReasons.push("payout_model_group_type_conflict");
      }

      const mappingStatus = reviewReasons.length ? "REVIEW_REQUIRED" : "VERIFIED";
      const persistedConditions = conditions.map((condition) => ({ ...condition }));
      if (mappingStatus !== "VERIFIED") {
        persistedConditions.push({
          ...BOOSTINY_VERIFY_LIVE_GATE,
          sourceConditionValue: { reviewReasons },
          metadata: { mboGate: true, reviewReasons },
        });
      }

      const outcomeKey = boostinyPayoutGroupOutcomeKey({
        campaignId,
        payoutKey: payoutIdentity.key,
        groupKey: groupIdentity.key,
      });
      if (seen.has(outcomeKey)) return;
      seen.add(outcomeKey);
      commissionSequence += 1;

      results.push({
        supplier: "BOOSTINY",
        sourceAccountLabel: context.sourceAccountLabel ?? "default",
        campaignSourceId: context.campaignSourceId ?? null,
        supplierCampaignId: context.supplierCampaignId ?? null,
        sourceCampaignId: campaignId,
        sourceGroupId: groupId,
        sourceGroupName: text(group.name) ?? null,
        sourceRuleId: groupId,
        sourceRuleName: text(group.name) ?? null,
        outcomeKey,
        outcomeSlot: 1,
        commissionSequence,
        commissionModel: model,
        commissionType: kind === "PERCENT" ? "PERCENTAGE" : kind === "FIXED" ? "FIXED" : "OTHER",
        supplierRuleType: groupType ?? (kind === "UNKNOWN" ? "UNKNOWN" : kind),
        basis,
        ratePercent: kind === "PERCENT" ? value : null,
        fixedAmount: kind === "FIXED" ? value : null,
        currency: kind === "FIXED" ? currency : null,
        actionType: null,
        priority,
        rank: null,
        customerType: null,
        country: null,
        categoryProductGoal: null,
        couponOrTier: null,
        conditions: persistedConditions,
        effectiveFrom: startDate.valid ? startDate.value : null,
        effectiveUntil: endDate.valid ? endDate.value : null,
        networkSource: context.networkSource ?? "boostiny",
        sourceObject: BOOSTINY_PAYOUT_GROUP_SOURCE_OBJECT,
        sourcePath,
        mappingStatus,
        fieldMappingOutcome: mappingStatus === "VERIFIED" ? "MAPPED" : "REVIEW_REQUIRED",
        ruleVersion: BOOSTINY_PAYOUT_GROUP_RULE_VERSION,
        rawRuleReference: {
          supplier: "BOOSTINY",
          campaignId,
          payoutIndex,
          payout: payoutWithoutGroups(payout),
          groupIndex,
          group,
        },
        metadata: {
          sourceEndpoint: "GET /publisher/campaigns",
          sourceCampaignId: campaignId,
          payoutIndex,
          payoutIdentityStrategy: payoutIdentity.strategy,
          payoutIdentityKey: payoutIdentity.key,
          payoutIdentityInputs: payoutIdentity.inputs,
          payoutModel: model,
          payoutLevel: level,
          payoutIsGlobal: isGlobal,
          payoutStartDate: startDate.value,
          payoutEndDate: endDate.value,
          groupIndex,
          groupId,
          groupIdentityStrategy: groupIdentity.strategy,
          groupIdentityKey: groupIdentity.key,
          groupPriority: priority,
          groupType,
          groupValue: group.value ?? null,
          valueKind: kind,
          valueKindDecidedBy: decidedBy,
          conditions: group.conditions ?? null,
          capping: group.capping ?? null,
          productCategories: group.product_categories ?? null,
          coupons: group.coupons ?? null,
          currencySource: currency ? (group.currency != null ? "group" : "payout") : null,
          reviewReasons,
          semanticStatus: mappingStatus === "VERIFIED" ? "VERIFIED" : "VERIFY_LIVE",
          financeReady: mappingStatus === "VERIFIED",
          sourceEffectiveFromProvided: startDate.present && startDate.valid,
          fetchedAt: context.fetchedAt ?? null,
        },
      });
    });
  });

  return results;
}
