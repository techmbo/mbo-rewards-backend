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

export function normalizeCouponStatus(...candidates) {
  for (const raw of candidates) {
    if (raw === undefined || raw === null || raw === "") continue;
    const value = String(raw).trim().toLowerCase();

    if (["active", "live", "enabled", "running"].includes(value)) return "ACTIVE";
    if (["expired", "ended", "closed"].includes(value)) return "EXPIRED";
    if (["scheduled", "upcoming", "pending"].includes(value)) return "SCHEDULED";
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
