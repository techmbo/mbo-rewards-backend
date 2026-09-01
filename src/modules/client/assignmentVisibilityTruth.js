/**
 * Assignment → Client API / Portal visibility truth (v15 08A / 06E / 09A).
 *
 * Lifecycle (conceptual — maps onto existing DB columns, no migration required):
 *
 *   ELIGIBLE          → CampaignEligibilityService (pre-assignment)
 *   ASSIGNED          → ClientCampaignAssignment.status = ASSIGNED|ACTIVE|PAUSED
 *   COMMISSION READY  → ClientCommissionRule.status = EFFECTIVE
 *   TRACKING READY    → TrackingLink with mboTrackingUrl (or coupon-only with code)
 *   PROVISIONED       → commission ready + tracking ready (or coupon fallback)
 *   PUBLISHED         → assignment.published === true && status === ACTIVE
 *   CLIENT VISIBLE    → client.status === ACTIVE + PUBLISHED + usable client asset
 *
 * DB field meanings:
 *   ClientCampaignAssignment.status
 *     ASSIGNED  — allotted, not yet live for client API
 *     ACTIVE    — operational; must also be published for client visibility
 *     PAUSED    — held; not client-visible
 *     REVOKED   — permanently removed; not client-visible
 *   ClientCampaignAssignment.published
 *     true  — approved for Client API / portal catalog (only after provision gates)
 *     false — admin-only allotment; never returned by client campaign API
 *   ClientCommissionRule.status
 *     DRAFT | EFFECTIVE | SUPERSEDED — EFFECTIVE required before publish
 *   TrackingLink.status
 *     GENERATED | ACTIVE | REVOKED — ACTIVE + mboTrackingUrl required when link channel needed
 */

/**
 * Whether an assignment may appear on the canonical Client API / portal campaigns list.
 * @param {object} input
 * @param {object|null} input.client
 * @param {object|null} input.assignment
 * @param {object|null} [input.dto] — already-projected partner DTO (optional)
 */
export function isClientCampaignVisible(input = {}) {
  const client = input.client;
  const assignment = input.assignment;
  if (!client || client.deletedAt || client.status !== "ACTIVE") return false;
  if (!assignment || assignment.status === "REVOKED") return false;
  if (assignment.published !== true) return false;
  if (String(assignment.status || "").toUpperCase() !== "ACTIVE") return false;

  if (input.dto) {
    const hasLink = Boolean(input.dto.link || input.dto.trackingUrl);
    const hasCoupon = Boolean(input.dto.couponCode || input.dto.coupon?.code);
    if (!hasLink && !hasCoupon) return false;
  }

  return true;
}

/**
 * Human-readable reason when not client-visible (admin diagnostics).
 */
export function explainClientVisibilityBlock(input = {}) {
  const client = input.client;
  const assignment = input.assignment;
  if (!client) return "missing_client";
  if (client.deletedAt) return "client_deleted";
  if (client.status !== "ACTIVE") return "client_not_active";
  if (!assignment) return "missing_assignment";
  if (assignment.status === "REVOKED") return "assignment_revoked";
  if (assignment.published !== true) return "not_published";
  if (String(assignment.status || "").toUpperCase() !== "ACTIVE") {
    return `assignment_status_${String(assignment.status || "unknown").toLowerCase()}`;
  }
  if (input.dto) {
    const hasLink = Boolean(input.dto.link || input.dto.trackingUrl);
    const hasCoupon = Boolean(input.dto.couponCode || input.dto.coupon?.code);
    if (!hasLink && !hasCoupon) return "no_tracking_or_coupon";
  }
  return null;
}
