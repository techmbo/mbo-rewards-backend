export function normalizeCampaignStatus(...candidates) {
  for (const raw of candidates) {
    if (raw === undefined || raw === null || raw === "") continue;
    if (typeof raw === "boolean") {
      if (raw) return "ACTIVE";
      continue;
    }
    const value = String(raw).trim().toLowerCase().replace(/[\s-]+/g, "_");

    // Relationship-only / participation codes — never treat as campaign lifecycle.
    if (
      value === "notapplied" ||
      value === "not_applied" ||
      value === "a" ||
      value === "p" ||
      value === "r" ||
      value === "need_approval" ||
      value === "approval_pending" ||
      value === "denied" ||
      value === "rejected"
    ) {
      continue;
    }

    if (
      ["active", "live", "approved", "enabled", "running", "open", "online", "accepted"].includes(
        value,
      )
    ) {
      return "ACTIVE";
    }
    if (["paused", "inactive", "suspended", "on_hold", "disabled"].includes(value)) return "PAUSED";
    if (["pending", "awaiting", "review", "submitted", "waiting"].includes(value)) return "PENDING";
    if (["retired", "closed", "ended", "expired", "archived"].includes(value)) return "RETIRED";
  }
  return "UNKNOWN";
}

export function normalizeParticipationStatus(...candidates) {
  for (const raw of candidates) {
    if (raw === undefined || raw === null || raw === "") continue;
    if (typeof raw === "boolean") {
      return raw ? "JOINED" : "NOT_JOINED";
    }
    const value = String(raw).trim().toLowerCase().replace(/[\s-]+/g, "_");

    // Partnerize publisher path / publisher_status codes
    if (value === "a") return "JOINED";
    if (value === "p") return "PENDING";
    if (value === "r") return "NOT_JOINED";

    if (
      [
        "joined",
        "approved",
        "active",
        "live",
        "accepted",
        "allocated",
        "yes",
        "true",
        "1",
      ].includes(value)
    ) {
      return "JOINED";
    }
    if (
      [
        "not_joined",
        "notapplied",
        "not_applied",
        "rejected",
        "declined",
        "denied",
        "unavailable",
        "available",
        "expired",
        "terminated",
        "no",
        "false",
        "0",
      ].includes(value)
    ) {
      return "NOT_JOINED";
    }
    if (
      [
        "pending",
        "awaiting",
        "invited",
        "requested",
        "waiting",
        "apply",
        "need_approval",
        "approval_pending",
        "requires_approval",
      ].includes(value)
    ) {
      return "PENDING";
    }
  }
  return "UNKNOWN";
}

/**
 * The ONLY way a coupon status may reach SupplierCoupon.couponStatus.
 *
 * That column is the Prisma enum CouponStatus, so a supplier's raw string can never be written
 * through: an unrecognised value is not a lenient write, it is a rejected one, and it fails the
 * whole coupon. Every return below is an enum member, and an unrecognised candidate falls through
 * to UNKNOWN rather than being passed along.
 *
 * Already-canonical values round-trip unchanged, so a mapper may pass its own fallback in as the
 * last candidate without special-casing it.
 */
export function normalizeCouponStatus(...candidates) {
  for (const raw of candidates) {
    if (raw === undefined || raw === null || raw === "") continue;
    const value = String(raw).trim().toLowerCase();

    if (["active", "live", "enabled", "running"].includes(value)) return "ACTIVE";
    if (["expired", "ended", "closed"].includes(value)) return "EXPIRED";
    if (["scheduled", "upcoming", "pending"].includes(value)) return "SCHEDULED";
    // A supplier saying "not active" is evidence, not absence of evidence: DISABLED is an existing
    // CouponStatus member and keeps that distinct from UNKNOWN, which means we were told nothing.
    if (["disabled", "inactive", "paused", "suspended", "deactivated", "stopped"].includes(value)) {
      return "DISABLED";
    }
  }
  return "UNKNOWN";
}

export function normalizePricingModel(...candidates) {
  for (const raw of candidates) {
    if (raw === undefined || raw === null || raw === "") continue;
    const value = String(raw).trim().toUpperCase();
    if (value.includes("CPA")) return "CPA";
    if (value.includes("CPC")) return "CPC";
    if (value.includes("CPL")) return "CPL";
    if (value.includes("CPS")) return "CPS";
    if (value.includes("HYBRID")) return "HYBRID";
  }
  return "UNKNOWN";
}

export function normalizeCommissionUnit(...candidates) {
  for (const raw of candidates) {
    if (raw === undefined || raw === null || raw === "") continue;
    const value = String(raw).trim().toLowerCase();
    if (value.includes("%") || value.includes("percent")) return "PERCENT";
    if (value.includes("flat") || value.includes("fixed")) return "FLAT";
  }
  return "UNKNOWN";
}
