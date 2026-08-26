import {
  BOOSTINY_PARTNER_PAYMENT_KEYS,
  headerToKey,
  validateExactHeaders,
} from "./partnerPayment.fields.js";

/**
 * Minimal RFC4180-ish CSV parser (quoted fields, commas, CRLF).
 * No external dependency — Partner Payment files are small admin uploads.
 */
export function parseCsvText(text) {
  const input = String(text ?? "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      field = "";
      if (row.some((c) => String(c).trim() !== "")) rows.push(row);
      row = [];
      continue;
    }
    if (ch === "\r") continue;
    field += ch;
  }

  if (field.length || row.length) {
    row.push(field);
    if (row.some((c) => String(c).trim() !== "")) rows.push(row);
  }

  return rows;
}

function toNumberOrNull(value) {
  if (value == null || String(value).trim() === "") return null;
  const cleaned = String(value).replace(/,/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function toIntOrNull(value) {
  const n = toNumberOrNull(value);
  if (n == null) return null;
  return Math.trunc(n);
}

/**
 * Parse + validate Boostiny Partner Payment CSV.
 * @returns {{ ok: true, headers: string[], rows: object[] } | { ok: false, error: string, details?: object }}
 */
export function parsePartnerPaymentCsv(text) {
  const table = parseCsvText(text);
  if (!table.length) {
    return { ok: false, error: "CSV is empty." };
  }

  const headerCells = table[0].map((c) => String(c ?? "").trim());
  const headerCheck = validateExactHeaders(headerCells);
  if (!headerCheck.ok) {
    return {
      ok: false,
      error: "CSV headers must be exactly the 9 required Boostiny Partner Payment fields.",
      details: headerCheck,
    };
  }

  const keyOrder = headerCells.map((h) => headerToKey(h));
  const rows = [];

  for (let i = 1; i < table.length; i += 1) {
    const cells = table[i];
    const raw = {};
    for (let c = 0; c < keyOrder.length; c += 1) {
      const key = keyOrder[c];
      raw[key] = cells[c] != null ? String(cells[c]).trim() : "";
    }

    // Skip fully blank data rows
    if (BOOSTINY_PARTNER_PAYMENT_KEYS.every((k) => !raw[k])) continue;

    if (!raw.paymentSource || !raw.cycle) {
      return {
        ok: false,
        error: `Row ${i + 1}: Payment source and Cycle are required.`,
        details: { rowNumber: i + 1, raw },
      };
    }

    rows.push({
      rowNumber: i + 1,
      paymentSource: raw.paymentSource,
      cycle: raw.cycle,
      legalEntityName: raw.legalEntityName || null,
      orders: toIntOrNull(raw.orders),
      revenue: toNumberOrNull(raw.revenue),
      salesAmountUsd: toNumberOrNull(raw.salesAmountUsd),
      extra: toNumberOrNull(raw.extra),
      deduction: toNumberOrNull(raw.deduction),
      delayed: toNumberOrNull(raw.delayed),
      raw,
    });
  }

  return { ok: true, headers: headerCells, rows };
}
