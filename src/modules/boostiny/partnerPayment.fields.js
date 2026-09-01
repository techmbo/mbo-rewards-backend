/**
 * Boostiny Partner Payment CSV — exact 9-field contract (MBO verified).
 * Do not invent columns; headers must match exactly after normalize.
 */

export const BOOSTINY_PARTNER_PAYMENT_FIELDS = Object.freeze([
  "Payment source",
  "Cycle",
  "Legal entity name",
  "Orders",
  "Revenue",
  "Sales amount USD",
  "Extra",
  "Deduction",
  "Delayed",
]);

/** Canonical internal keys aligned 1:1 with required headers. */
export const BOOSTINY_PARTNER_PAYMENT_KEYS = Object.freeze([
  "paymentSource",
  "cycle",
  "legalEntityName",
  "orders",
  "revenue",
  "salesAmountUsd",
  "extra",
  "deduction",
  "delayed",
]);

export function normalizeHeader(value) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

const HEADER_TO_KEY = new Map(
  BOOSTINY_PARTNER_PAYMENT_FIELDS.map((label, i) => [
    normalizeHeader(label),
    BOOSTINY_PARTNER_PAYMENT_KEYS[i],
  ]),
);

export function headerToKey(header) {
  return HEADER_TO_KEY.get(normalizeHeader(header)) ?? null;
}

/**
 * Validate that the CSV header row is exactly the required 9 fields (order-insensitive).
 * Extra or missing columns fail.
 */
export function validateExactHeaders(headers = []) {
  const normalized = headers.map((h) => normalizeHeader(h)).filter(Boolean);
  const required = BOOSTINY_PARTNER_PAYMENT_FIELDS.map((h) => normalizeHeader(h));
  const missing = required.filter((h) => !normalized.includes(h));
  const unknown = normalized.filter((h) => !required.includes(h));
  const duplicate = normalized.filter((h, i) => normalized.indexOf(h) !== i);

  if (missing.length || unknown.length || duplicate.length || normalized.length !== required.length) {
    return {
      ok: false,
      missing: missing.map((h) =>
        BOOSTINY_PARTNER_PAYMENT_FIELDS.find((l) => normalizeHeader(l) === h),
      ),
      unknown: unknown,
      duplicate,
      expected: [...BOOSTINY_PARTNER_PAYMENT_FIELDS],
    };
  }
  return { ok: true, expected: [...BOOSTINY_PARTNER_PAYMENT_FIELDS] };
}

export function buildSettlementKey({
  sourceAccountLabel = "default",
  paymentSource,
  cycle,
} = {}) {
  return `BOOSTINY|${String(sourceAccountLabel || "default").trim()}|${String(paymentSource || "")
    .trim()}|${String(cycle || "").trim()}`;
}
