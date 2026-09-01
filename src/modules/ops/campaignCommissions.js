/**
 * Network Operations — every supplier commission on one campaign/operation.
 * Optimise often encodes percent AND currency in one string, e.g. "8.20% Or $17.50".
 * Boostiny nests multiple sale-share groups under payouts[].groups[].
 * Never invent rates. Never return a raw object as the display string.
 */

function trimNum(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
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
  if (/fix|flat|cpa|cpl|cpc|amount|fixed cost/.test(model) && !/percent/.test(model)) return false;
  const unit = String(fallbackUnit || "").toUpperCase();
  if (unit === "PERCENT") return true;
  if (unit === "FLAT" || unit === "FIXED") return false;
  return null;
}

function factKey(fact) {
  return `${fact.kind}|${fact.value}|${fact.currency || ""}|${fact.display}`;
}

function makePercentFact(value, { upTo = false } = {}) {
  const shown = trimNum(value);
  if (shown == null || Number(value) === 0) return null;
  return {
    kind: "PERCENT",
    value: Number(value),
    currency: null,
    display: upTo ? `Up to ${shown}%` : `${shown}%`,
  };
}

function makeFixedFact(value, currency) {
  const shown = trimNum(value);
  if (shown == null || Number(value) === 0) return null;
  return {
    kind: "FIXED",
    value: Number(value),
    currency: currency || null,
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
    if (!Number.isFinite(n) || n === 0) continue;
    const fact = makePercentFact(n, { upTo: Boolean(match[1]) });
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
    if (!Number.isFinite(amount) || amount === 0) continue;
    const fact = makeFixedFact(amount, currency);
    if (fact) facts.push(fact);
  }

  return facts;
}

function structuredFacts(entry, { fallbackUnit, fallbackCurrency } = {}) {
  if (entry == null || entry === "") return [];
  if (typeof entry !== "object") {
    const fromText = parseCommissionText(entry);
    if (fromText.length) return fromText;
    const n = numericFrom(entry);
    if (n == null || n === 0) return [];
    const percent = looksPercent({}, String(entry), fallbackUnit);
    return [
      percent === false
        ? makeFixedFact(n, fallbackCurrency)
        : makePercentFact(n),
    ].filter(Boolean);
  }

  const valueField =
    entry.value ??
    entry.commission ??
    entry.performance_value ??
    entry.amount ??
    entry.rate ??
    entry.payout_value ??
    entry.commissionCost ??
    null;

  if (valueField && typeof valueField === "object") {
    return structuredFacts(valueField, { fallbackUnit, fallbackCurrency: currencyFrom(entry, fallbackCurrency) });
  }

  if (typeof valueField === "string" && /%|or\b|\$|rp|£|€/i.test(valueField)) {
    const parsed = parseCommissionText(valueField);
    if (parsed.length) return parsed;
  }
  if (typeof entry.type === "string" && typeof valueField === "string") {
    const parsed = parseCommissionText(valueField);
    if (parsed.length) return parsed;
  }

  const amount = numericFrom(valueField);
  if (amount == null || amount === 0) return [];
  const currency = currencyFrom(entry, fallbackCurrency);
  const valueText = valueField != null && typeof valueField !== "object" ? String(valueField) : "";
  const percent = looksPercent(entry, valueText, fallbackUnit);
  if (percent === false) {
    const fact = makeFixedFact(amount, currency);
    return fact ? [fact] : [];
  }
  const fact = makePercentFact(amount);
  return fact ? [fact] : [];
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
 * @returns {{ facts: object[], display: string|null }}
 */
export function listCampaignCommissionFacts({
  groups = null,
  commissionUnit = null,
  currency = null,
  defaultValue = null,
  raw = {},
} = {}) {
  const facts = [];
  const seen = new Set();
  const pushAll = (list) => {
    for (const fact of list || []) {
      if (!fact?.display) continue;
      const key = factKey(fact);
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push(fact);
    }
  };

  for (const entry of collectSourceEntries({ groups, raw })) {
    pushAll(structuredFacts(entry, { fallbackUnit: commissionUnit, fallbackCurrency: currency }));
  }

  if (!facts.length) {
    pushAll(
      structuredFacts(
        { value: defaultValue, currency, model: commissionUnit },
        { fallbackUnit: commissionUnit, fallbackCurrency: currency },
      ),
    );
  }

  return {
    facts,
    display: facts.length ? facts.map((f) => f.display).join(" · ") : null,
    averageDisplay: averageCommissionFacts(facts),
  };
}

export function averageCommissionFacts(facts = []) {
  const percents = [];
  const fixedByCurrency = new Map();
  for (const fact of facts || []) {
    if (!fact) continue;
    const n =
      Number.isFinite(Number(fact.value)) && Number(fact.value) !== 0
        ? Number(fact.value)
        : numericFrom(fact.display);
    if (n == null || n === 0) continue;
    const display = String(fact.display || "");
    const isPercent = fact.kind === "PERCENT" || /%/.test(display);
    if (isPercent) {
      percents.push(n);
      continue;
    }
    const currency = fact.currency || null;
    const key = currency || "";
    const list = fixedByCurrency.get(key) || [];
    list.push(n);
    fixedByCurrency.set(key, list);
  }
  const parts = [];
  if (percents.length) {
    const avg = percents.reduce((sum, v) => sum + v, 0) / percents.length;
    const shown = trimNum(avg);
    if (shown != null) parts.push(`${shown}%`);
  }
  for (const [currency, amounts] of fixedByCurrency) {
    const avg = amounts.reduce((sum, v) => sum + v, 0) / amounts.length;
    const shown = trimNum(avg);
    if (shown == null) continue;
    parts.push(currency ? `${currency} ${shown}` : shown);
  }
  return parts.length ? parts.join(" · ") : null;
}
