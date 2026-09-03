/**
 * Network Operations — every supplier commission on one campaign/operation.
 * Optimise often encodes percent AND currency in one string, e.g. "8.20% Or $17.50".
 * Boostiny nests multiple sale-share groups under payouts[].groups[].
 * Never invent rates. Never return a raw object as the display string.
 */

/**
 * Explicit numeric value only.
 *
 * An explicit zero (0, "0", "0.0", "0.00") is a real supplier commission fact: excluded
 * categories, non-commissionable products, excluded customer types, markets with no payout,
 * promotional exclusions. Blank or missing input (null, undefined, "", "   ") stays missing
 * and malformed text stays invalid — neither is ever coerced to zero the way Number("")
 * would. Objects are not numbers; callers unwrap them first.
 */
export function explicitNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.replace(/,/g, "").trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function trimNum(n) {
  const x = explicitNumber(n);
  if (x == null) return null;
  return Number.isInteger(x) ? String(x) : String(Number(x.toFixed(4))).replace(/\.?0+$/, "");
}

function numericFrom(value) {
  if (value == null || value === "") return null;
  if (typeof value === "object") {
    return numericFrom(
      value.amount ?? value.value ?? value.rate ?? value.performance_value ?? value.commission,
    );
  }
  const text = String(value).trim();
  if (!text) return null;
  const match = text.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

function currencyFrom(entry, fallback = null) {
  if (entry == null) return fallback || null;
  if (typeof entry === "string") {
    const code = entry.trim().toUpperCase().slice(0, 3);
    return /^[A-Z]{3}$/.test(code) ? code : fallback || null;
  }
  if (typeof entry !== "object") return fallback || null;
  const raw =
    entry.currency ??
    entry.currency_code ??
    entry.currencyCode ??
    entry.iso ??
    entry.code ??
    null;
  if (raw && typeof raw === "object") return currencyFrom(raw, fallback);
  if (raw == null || raw === "") return fallback || null;
  const code = String(raw).trim().toUpperCase().slice(0, 3);
  return /^[A-Z]{3}$/.test(code) ? code : fallback || null;
}

function symbolCurrency(symbol) {
  const s = String(symbol || "");
  if (/^s\$/i.test(s)) return "SGD";
  if (/^hk\$/i.test(s)) return "HKD";
  if (/^(au\$|a\$)$/i.test(s)) return "AUD";
  if (/^nz\$/i.test(s)) return "NZD";
  if (/^(ca\$|c\$)$/i.test(s)) return "CAD";
  if (/^us\$/i.test(s) || s === "$") return "USD";
  if (s === "£") return "GBP";
  if (s === "€") return "EUR";
  if (/^rp$/i.test(s)) return "IDR";
  if (/^rm$/i.test(s)) return "MYR";
  if (/^rs\.?$/i.test(s) || s === "₹") return "INR";
  return null;
}

function isEmptyBag(value) {
  if (value == null || value === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

function looksPercent(entry, valueText, fallbackUnit) {
  const model = String(
    entry?.model ??
      entry?.performance_model ??
      entry?.type ??
      entry?.payout_type ??
      entry?.commissionType ??
      entry?.commission_type ??
      "",
  ).toLowerCase();
  if (/%/.test(String(valueText || ""))) return true;
  if (/percent|revshare|sale-share|cps|share/.test(model)) return true;
  if (/fix|flat|cpa|cpl|cpc|cpi|cpm|amount|fixed cost/.test(model) && !/percent/.test(model)) return false;
  const unit = String(fallbackUnit || "").toUpperCase();
  if (unit === "PERCENT") return true;
  if (unit === "FLAT" || unit === "FIXED") return false;
  return null;
}

function payoutBasisFrom(entry = {}, fallbackUnit = null, kind = null) {
  const text = String(
    entry?.basis ??
      entry?.model ??
      entry?.performance_model ??
      entry?.performanceModel ??
      entry?.pricing_model ??
      entry?.pricingModel ??
      entry?.type ??
      entry?.payout_type ??
      entry?.commissionType ??
      entry?.commission_type ??
      fallbackUnit ??
      "",
  ).toUpperCase();

  // Only derive a basis from explicit source wording. Otherwise keep a neutral canonical basis.
  if (/\bCPA\b/.test(text)) return "CPA";
  if (/\bCPL\b/.test(text)) return "CPL";
  if (/\bCPI\b/.test(text)) return "CPI";
  if (/\bCPC\b/.test(text)) return "CPC";
  if (/\bCPM\b/.test(text)) return "CPM";
  if (/\bCPS\b/.test(text)) return kind === "PERCENT" ? "PERCENT_OF_SALE" : "CPS";
  if (/PER[ _-]?ITEM|ITEM/.test(text) && /FIX|FLAT|AMOUNT/.test(text)) return "FIXED_PER_ITEM";
  if (/PER[ _-]?ORDER|ORDER/.test(text) && /FIX|FLAT|AMOUNT/.test(text)) return "FIXED_PER_ORDER";
  if (kind === "PERCENT") return "PERCENT_OF_SALE";
  if (kind === "FIXED") return "FIXED_AMOUNT";
  return "UNKNOWN";
}

function firstDefined(...values) {
  return values.find((value) => value != null && value !== "");
}

function effectiveWindowFrom(entry = {}) {
  if (!entry || typeof entry !== "object") {
    return { effectiveFrom: null, effectiveUntil: null };
  }
  return {
    effectiveFrom:
      firstDefined(
        entry.effectiveFrom,
        entry.effective_from,
        entry.startDate,
        entry.start_date,
        entry.validFrom,
        entry.valid_from,
      ) ?? null,
    effectiveUntil:
      firstDefined(
        entry.effectiveUntil,
        entry.effective_until,
        entry.endDate,
        entry.end_date,
        entry.validUntil,
        entry.valid_until,
      ) ?? null,
  };
}

function withEffectiveWindow(facts = [], entry = {}) {
  const window = effectiveWindowFrom(entry);
  return (facts || []).map((fact) => ({
    ...fact,
    effectiveFrom: fact?.effectiveFrom ?? window.effectiveFrom,
    effectiveUntil: fact?.effectiveUntil ?? window.effectiveUntil,
  }));
}

function parseDate(value) {
  if (value == null || value === "") return { present: false, date: null };
  const date = value instanceof Date ? value : new Date(value);
  return {
    present: true,
    date: Number.isNaN(date.getTime()) ? null : date,
  };
}

/**
 * Current-summary window semantics mirror persisted SupplierCommissionRule matching:
 * effectiveFrom is inclusive and effectiveUntil is exclusive.
 * Invalid source dates are never guessed as active.
 */
export function classifyCommissionFactWindow(fact = {}, { at = new Date() } = {}) {
  const current = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(current.getTime())) return "REVIEW_REQUIRED";

  const from = parseDate(fact.effectiveFrom);
  const until = parseDate(fact.effectiveUntil);
  if ((from.present && !from.date) || (until.present && !until.date)) return "REVIEW_REQUIRED";
  if (from.date && until.date && until.date.getTime() <= from.date.getTime()) return "REVIEW_REQUIRED";
  if (from.date && from.date.getTime() > current.getTime()) return "FUTURE";
  if (until.date && until.date.getTime() <= current.getTime()) return "EXPIRED";
  return "ACTIVE";
}

function factKey(fact) {
  return `${fact.kind}|${fact.value}|${fact.currency || ""}|${fact.basis || ""}|${fact.effectiveFrom || ""}|${fact.effectiveUntil || ""}|${fact.display}`;
}

function makePercentFact(value, { upTo = false, basis = "PERCENT_OF_SALE" } = {}) {
  // Explicit zero is a valid PERCENT fact (e.g. "Category X: 0%"); blank input is not.
  const n = explicitNumber(value);
  const shown = trimNum(n);
  if (n == null || shown == null) return null;
  return {
    kind: "PERCENT",
    value: n,
    currency: null,
    basis,
    display: upTo ? `Up to ${shown}%` : `${shown}%`,
  };
}

function makeFixedFact(value, currency, { basis = "FIXED_AMOUNT" } = {}) {
  // Explicit fixed zero (e.g. "USD 0 per order") is a valid FIXED fact; blank input is not.
  const n = explicitNumber(value);
  const shown = trimNum(n);
  if (n == null || shown == null) return null;
  return {
    kind: "FIXED",
    value: n,
    currency: currency || null,
    basis,
    display: currency ? `${currency} ${shown}` : shown,
  };
}

/**
 * Split supplier display strings that carry more than one commission,
 * e.g. "8.20% Or $17.50", "Up to 5.40% Or Rp80000.00", "2.50% Or $1.20".
 */
export function parseCommissionText(text) {
  if (text == null || text === "") return [];
  if (typeof text === "object") return [];
  const s = String(text);
  const facts = [];
  const used = [];

  const mark = (start, end) => used.push([start, end]);
  const overlaps = (start, end) => used.some(([a, b]) => start < b && end > a);

  for (const match of s.matchAll(/(up\s*to\s*)?(-?\d+(?:[.,]\d+)?)\s*%/gi)) {
    const n = Number(String(match[2]).replace(",", "."));
    if (!Number.isFinite(n)) continue;
    const fact = makePercentFact(n, { upTo: Boolean(match[1]), basis: "PERCENT_OF_SALE" });
    if (fact) facts.push(fact);
    mark(match.index, match.index + match[0].length);
  }

  const moneyRe =
    /(S\$|HK\$|AU\$|NZ\$|CA\$|US\$|A\$|C\$|Rp|RM|Rs\.?|USD|AED|SAR|GBP|EUR|IDR|MYR|SGD|HKD|THB|INR|£|€|\$|₹)\s*(-?\d+(?:[.,]\d+)?)|(-?\d+(?:[.,]\d+)?)\s*(USD|AED|SAR|GBP|EUR|IDR|MYR|SGD|HKD|THB|INR)/gi;

  for (const match of s.matchAll(moneyRe)) {
    const start = match.index;
    const end = start + match[0].length;
    if (overlaps(start, end)) continue;
    let amount = null;
    let currency = null;
    if (match[1] && match[2]) {
      amount = Number(String(match[2]).replace(/,/g, ""));
      currency = symbolCurrency(match[1]) || currencyFrom(match[1]);
    } else if (match[3] && match[4]) {
      amount = Number(String(match[3]).replace(/,/g, ""));
      currency = currencyFrom(match[4]);
    }
    if (!Number.isFinite(amount)) continue;
    const fact = makeFixedFact(amount, currency, { basis: "FIXED_AMOUNT" });
    if (fact) facts.push(fact);
  }

  return facts;
}

const PERCENT_VALUE_KEYS = ["percentage", "percent", "rate_percent", "ratePercent"];
const FIXED_VALUE_KEYS = ["fixed", "fixed_amount", "fixedAmount"];

function isPresent(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  if (typeof value === "boolean") return false;
  return true;
}

/**
 * Pick the supplied commission value of a structured entry.
 * Presence is decided by the property being supplied (0 is supplied; ""/null are not),
 * never by truthiness. Explicit percent/fixed keys also carry their kind.
 */
function commissionValueField(entry = {}) {
  const generic = [
    entry.value,
    entry.commission,
    entry.performance_value,
    entry.amount,
    entry.rate,
    entry.payout_value,
    entry.commissionCost,
  ];
  for (const candidate of generic) {
    if (isPresent(candidate)) return { valueField: candidate, valueKind: null };
  }
  for (const key of PERCENT_VALUE_KEYS) {
    if (isPresent(entry[key]) && typeof entry[key] !== "object") return { valueField: entry[key], valueKind: "PERCENT" };
  }
  for (const key of FIXED_VALUE_KEYS) {
    if (isPresent(entry[key]) && typeof entry[key] !== "object") return { valueField: entry[key], valueKind: "FIXED" };
  }
  return { valueField: null, valueKind: null };
}

function structuredFacts(entry, { fallbackUnit, fallbackCurrency } = {}) {
  if (entry == null || entry === "") return [];
  if (typeof entry !== "object") {
    const fromText = parseCommissionText(entry);
    if (fromText.length) return fromText;
    const n = numericFrom(entry);
    if (n == null) return [];
    const percent = looksPercent({}, String(entry), fallbackUnit);
    return [
      percent === false
        ? makeFixedFact(n, fallbackCurrency, { basis: payoutBasisFrom({}, fallbackUnit, "FIXED") })
        : makePercentFact(n, { basis: payoutBasisFrom({}, fallbackUnit, "PERCENT") }),
    ].filter(Boolean);
  }

  const { valueField, valueKind: keyedKind } = commissionValueField(entry);

  if (valueField && typeof valueField === "object") {
    return withEffectiveWindow(
      structuredFacts(valueField, {
        fallbackUnit,
        fallbackCurrency: currencyFrom(entry, fallbackCurrency),
      }),
      entry,
    );
  }

  if (typeof valueField === "string" && /%|or\b|\$|rp|£|€/i.test(valueField)) {
    const parsed = parseCommissionText(valueField);
    if (parsed.length) {
      return withEffectiveWindow(
        parsed.map((fact) => ({
          ...fact,
          basis: payoutBasisFrom(entry, fallbackUnit, fact.kind),
        })),
        entry,
      );
    }
  }
  if (typeof entry.type === "string" && typeof valueField === "string") {
    const parsed = parseCommissionText(valueField);
    if (parsed.length) {
      return withEffectiveWindow(
        parsed.map((fact) => ({
          ...fact,
          basis: payoutBasisFrom(entry, fallbackUnit, fact.kind),
        })),
        entry,
      );
    }
  }

  // A supplied zero survives normalization; only a missing/blank/malformed value is dropped.
  const amount = numericFrom(valueField);
  if (amount == null) return [];
  const currency = currencyFrom(entry, fallbackCurrency);
  const valueText = valueField != null && typeof valueField !== "object" ? String(valueField) : "";
  const percent = keyedKind === "FIXED" ? false : keyedKind === "PERCENT" ? true : looksPercent(entry, valueText, fallbackUnit);
  if (percent === false) {
    const fact = makeFixedFact(amount, currency, {
      basis: payoutBasisFrom(entry, fallbackUnit, "FIXED"),
    });
    return withEffectiveWindow(fact ? [fact] : [], entry);
  }
  const fact = makePercentFact(amount, {
    basis: payoutBasisFrom(entry, fallbackUnit, "PERCENT"),
  });
  return withEffectiveWindow(fact ? [fact] : [], entry);
}

function keyedCommissionBag(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (
    input.value != null ||
    input.amount != null ||
    input.rate != null ||
    input.performance_value != null ||
    input.payout_value != null
  ) {
    return null;
  }
  const keys = Object.keys(input);
  const values = Object.values(input);
  if (!keys.length) return null;
  const numericKeys = keys.every((k) => /^\d+$/.test(k));
  const objectValues = values.every((v) => v != null && typeof v === "object");
  if (numericKeys || (objectValues && input.type == null && input.model == null)) {
    return values;
  }
  return null;
}

function flattenCommissionEntries(input) {
  if (isEmptyBag(input)) return [];
  if (Array.isArray(input)) return input.flatMap((item) => flattenCommissionEntries(item));
  if (typeof input !== "object") return [input];

  const nested =
    input.groups ||
    input.commissionGroups ||
    input.commission_groups ||
    input.commissionGroup ||
    input.commissions ||
    input.active_commissions;
  if (!isEmptyBag(nested)) {
    const list = Array.isArray(nested) ? nested : Object.values(nested);
    const kids = flattenCommissionEntries(list).map((group) => {
      if (!group || typeof group !== "object") {
        return {
          ...input,
          value: group,
          groups: undefined,
          commissionGroups: undefined,
          commission_groups: undefined,
          commissionGroup: undefined,
          commissions: undefined,
          active_commissions: undefined,
        };
      }
      return {
        ...input,
        ...group,
        groups: undefined,
        commissionGroups: undefined,
        commission_groups: undefined,
        commissionGroup: undefined,
        commissions: undefined,
        active_commissions: undefined,
      };
    });
    return kids;
  }
  const keyed = keyedCommissionBag(input);
  if (keyed) return keyed.flatMap((item) => flattenCommissionEntries(item));
  return [input];
}

function collectSourceEntries({ groups, raw } = {}) {
  const bags = [];
  const add = (value) => {
    if (isEmptyBag(value)) return;
    bags.push(value);
  };
  add(groups);
  if (raw && typeof raw === "object") {
    add(raw.payouts);
    add(raw.commissions);
    add(raw.active_commissions);
    add(raw.commissionGroups);
    add(raw.commission_groups);
    add(raw.commissionGroup);
    add(raw.commission);
    add(raw.commissionCost);
  }
  return bags.flatMap((bag) => flattenCommissionEntries(bag));
}

export { collectSourceEntries };

/**
 * Current campaign display/reporting facts only.
 * Historical/future commission facts remain available in allFacts but do not enter
 * the current display or Avg Commission. Invalid source windows fail closed.
 *
 * @returns {{ facts: object[], display: string|null, averageDisplay: string|null, allFacts: object[], excludedFacts: object[], windowReviewRequired: boolean }}
 */
export function listCampaignCommissionFacts({
  groups = null,
  commissionUnit = null,
  currency = null,
  defaultValue = null,
  raw = {},
  at = new Date(),
} = {}) {
  const collected = [];
  const seen = new Set();
  const pushAll = (list) => {
    for (const fact of list || []) {
      if (!fact?.display) continue;
      const key = factKey(fact);
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(fact);
    }
  };

  for (const entry of collectSourceEntries({ groups, raw })) {
    pushAll(structuredFacts(entry, { fallbackUnit: commissionUnit, fallbackCurrency: currency }));
  }

  // Fall back only when there are no supplier commission facts at all. If supplier
  // facts exist but are expired/future, do not revive the campaign default as current.
  if (!collected.length) {
    pushAll(
      structuredFacts(
        { value: defaultValue, currency, model: commissionUnit },
        { fallbackUnit: commissionUnit, fallbackCurrency: currency },
      ),
    );
  }

  const allFacts = collected.map((fact) => ({
    ...fact,
    windowStatus: classifyCommissionFactWindow(fact, { at }),
  }));
  const facts = allFacts.filter((fact) => fact.windowStatus === "ACTIVE");
  const excludedFacts = allFacts.filter((fact) => fact.windowStatus !== "ACTIVE");

  return {
    facts,
    display: facts.length ? facts.map((f) => f.display).join(" · ") : null,
    averageDisplay: averageCommissionFacts(facts),
    allFacts,
    excludedFacts,
    windowReviewRequired: excludedFacts.some((fact) => fact.windowStatus === "REVIEW_REQUIRED"),
  };
}

/**
 * Current campaign Avg / Min / Max Commission are display/reporting summaries only.
 * They must never be used as an order-level supplier or client payout rate.
 *
 * Explicit zero facts participate: [0%, 10%] → avg 5%, min 0%, max 10%.
 *
 * Comparable sets:
 * - percentages with percentages;
 * - fixed amounts only when currency AND payout basis are the same.
 * Anything else is MIXED.
 *
 * @returns {{ comparable: boolean, kind: "PERCENT"|"FIXED"|"MIXED"|null, count: number,
 *   average: number|null, min: number|null, max: number|null, currency: string|null, basis: string|null,
 *   averageDisplay: string|null, minDisplay: string|null, maxDisplay: string|null }}
 */
export function summarizeCommissionFacts(facts = []) {
  const normalized = [];
  for (const fact of facts || []) {
    if (!fact) continue;
    // fact.value wins when it is an explicit number (including 0); otherwise parse the display.
    const n = explicitNumber(fact.value) ?? numericFrom(fact.display);
    if (n == null) continue;
    const display = String(fact.display || "");
    const isPercent = fact.kind === "PERCENT" || /%/.test(display);
    normalized.push({
      kind: isPercent ? "PERCENT" : "FIXED",
      value: n,
      currency: fact.currency || null,
      basis: fact.basis || (isPercent ? "PERCENT_OF_SALE" : "FIXED_AMOUNT"),
    });
  }

  const empty = {
    comparable: false,
    kind: null,
    count: normalized.length,
    average: null,
    min: null,
    max: null,
    currency: null,
    basis: null,
    averageDisplay: null,
    minDisplay: null,
    maxDisplay: null,
  };
  if (!normalized.length) return empty;

  const mixed = { ...empty, kind: "MIXED", averageDisplay: "MIXED", minDisplay: "MIXED", maxDisplay: "MIXED" };

  const kinds = new Set(normalized.map((fact) => fact.kind));
  if (kinds.size > 1) return mixed;

  const values = normalized.map((fact) => fact.value);
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);

  if (kinds.has("PERCENT")) {
    const format = (value) => {
      const shown = trimNum(value);
      return shown == null ? null : `${shown}%`;
    };
    return {
      comparable: true,
      kind: "PERCENT",
      count: normalized.length,
      average,
      min,
      max,
      currency: null,
      basis: "PERCENT_OF_SALE",
      averageDisplay: format(average),
      minDisplay: format(min),
      maxDisplay: format(max),
    };
  }

  const currencies = new Set(normalized.map((fact) => fact.currency || ""));
  const bases = new Set(normalized.map((fact) => fact.basis || "FIXED_AMOUNT"));
  if (currencies.size > 1 || bases.size > 1) return mixed;

  const currency = normalized[0].currency;
  const format = (value) => {
    const shown = trimNum(value);
    if (shown == null) return null;
    return currency ? `${currency} ${shown}` : shown;
  };
  return {
    comparable: true,
    kind: "FIXED",
    count: normalized.length,
    average,
    min,
    max,
    currency,
    basis: normalized[0].basis,
    averageDisplay: format(average),
    minDisplay: format(min),
    maxDisplay: format(max),
  };
}

/**
 * Current campaign Avg Commission display string (see summarizeCommissionFacts).
 * Display/reporting only — never an order-level payout input.
 */
export function averageCommissionFacts(facts = []) {
  return summarizeCommissionFacts(facts).averageDisplay;
}
