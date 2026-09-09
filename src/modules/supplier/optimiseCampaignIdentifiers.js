/**
 * Optimise campaign identifier namespaces.
 *
 * Optimise keys its endpoints by DIFFERENT identifiers:
 *   GET /campaigns/{productId}                      — campaign detail
 *   GET /campaigns/{campaignId}/commission-groups   — detailed commission groups
 *
 * These namespaces are independent: the same scalar may appear in more than one of
 * them on unrelated rows, meaning different things. Collapsing them into a single
 * "campaign id" is what allows a productId to be sent where a campaignId is
 * required, so they are kept apart here and resolved per endpoint by the caller.
 *
 * This module is a LEAF on purpose — it imports nothing, so the read-only
 * certification core can use it without pulling in the database layer.
 */

/** Trim and reject anything unusable as a single URL path segment. */
function cleanIdentifier(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text || /[\\/\s?#]/.test(text)) return null;
  return text;
}

/**
 * The distinct Optimise identifiers on a campaign row.
 *
 * `genericId` and `legacyId` are EVIDENCE ONLY: their supplier semantics are
 * unproven, so they must never be dispatched to either endpoint.
 *
 * @returns {{ productId: string|null, campaignId: string|null, genericId: string|null, legacyId: string|null }}
 */
export function optimiseCampaignIdentifiers(raw = {}) {
  return {
    productId: cleanIdentifier(raw?.productId),
    campaignId: cleanIdentifier(raw?.campaignId ?? raw?.campaign_id),
    genericId: cleanIdentifier(raw?.id),
    legacyId: cleanIdentifier(raw?.legacyId),
  };
}
