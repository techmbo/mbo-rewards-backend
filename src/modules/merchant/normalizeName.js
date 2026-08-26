/**
 * Normalize merchant/brand names for deduplication.
 * @see PHASE2_DOMAIN_MODEL.md §6, OQ-2
 */
export function normalizeMerchantName(value) {
  if (!value) return "";

  return String(value)
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function slugifyMerchantName(value) {
  const normalized = normalizeMerchantName(value);
  const slug = normalized.replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return slug || "merchant";
}

export function tokenSimilarity(a, b) {
  const left = new Set(normalizeMerchantName(a).split(" ").filter(Boolean));
  const right = new Set(normalizeMerchantName(b).split(" ").filter(Boolean));
  if (!left.size || !right.size) return 0;

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }

  return intersection / Math.max(left.size, right.size);
}
