/**
 * Pointer 10 — explode embedded coupon arrays from campaign payloads into individual coupon rows.
 */

const EMBEDDED_ARRAY_KEYS = Object.freeze([
  { key: "vouchers", sourcePath: "vouchers" },
  { key: "coupons", sourcePath: "coupons" },
  { key: "voucher_codes", sourcePath: "voucher_codes" },
  { key: "voucher_commissions", sourcePath: "voucher_commissions" },
]);

function campaignIdFromRaw(raw = {}) {
  return (
    raw.id ??
    raw.campaignId ??
    raw.campaign_id ??
    raw.productId ??
    raw.program_id ??
    null
  );
}

function normalizeEmbeddedCouponItem(item, { campaignId, sourcePath, sourceObject }) {
  if (!item || typeof item !== "object") return null;
  const vc =
    item.voucher_code && typeof item.voucher_code === "object"
      ? item.voucher_code
      : item.voucher && typeof item.voucher === "object"
        ? item.voucher
        : item;

  const code = vc.voucher_code ?? vc.code ?? vc.couponCode ?? vc.coupon_code ?? null;
  const link = vc.deeplink ?? vc.deep_link ?? vc.link ?? vc.tracking_url ?? vc.trackingUrl ?? null;
  const id =
    vc.voucher_code_id ??
    vc.id ??
    vc.couponId ??
    (code && campaignId != null ? `${campaignId}:${code}` : null);

  if (!code && !link && !id) return null;

  return {
    ...vc,
    id: id != null ? String(id) : undefined,
    voucher_code_id: vc.voucher_code_id ?? vc.id ?? id,
    voucher_code: code != null ? String(code) : undefined,
    code: code != null ? String(code) : undefined,
    campaign_id: vc.campaign_id ?? vc.campaignId ?? campaignId,
    campaignId: vc.campaignId ?? vc.campaign_id ?? campaignId,
    _mboSourcePath: sourcePath,
    _mboSourceObject: sourceObject,
  };
}

/**
 * Extract individual coupon payloads embedded in a campaign raw object.
 */
export function extractEmbeddedCouponsFromCampaignRaw(raw, { sourceObject = "campaigns" } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const campaignId = campaignIdFromRaw(raw);
  const dedupe = new Map();

  for (const { key, sourcePath } of EMBEDDED_ARRAY_KEYS) {
    const arr = Array.isArray(raw[key]) ? raw[key] : [];
    for (const item of arr) {
      const normalized = normalizeEmbeddedCouponItem(item, {
        campaignId,
        sourcePath,
        sourceObject,
      });
      if (!normalized) continue;
      const dedupeKey = String(
        normalized.voucher_code_id ??
          normalized.id ??
          `${normalized.campaign_id}:${normalized.voucher_code ?? normalized.code ?? ""}`,
      );
      if (!dedupe.has(dedupeKey)) dedupe.set(dedupeKey, normalized);
    }
  }

  return [...dedupe.values()];
}

/**
 * Fan out embedded coupons from staged campaign records into coupon entity rows.
 */
export function collectEmbeddedCouponsFromCampaigns(campaigns = [], { sourceObject = "campaigns" } = {}) {
  const all = [];
  for (const campaign of campaigns) {
    const raw = campaign?.rawData ?? campaign?.originalPayload ?? campaign;
    const extracted = extractEmbeddedCouponsFromCampaignRaw(raw, { sourceObject });
    for (const row of extracted) {
      all.push(row);
    }
  }
  return all;
}
