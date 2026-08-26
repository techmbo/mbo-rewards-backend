/**
 * Derive assignment provisioning completeness from commercial + tracking facts.
 * Does not invent FAILED enum values on TrackingLink — PENDING means no usable link yet.
 */

export function deriveProvisioningStatus({
  assignmentStatus = null,
  published = false,
  commissionRuleStatus = null,
  hasCommissionRule = false,
  trackingLinkStatus = null,
  hasTrackingUrl = false,
  trackingIssue = null,
} = {}) {
  if (String(assignmentStatus || "").toUpperCase() === "REVOKED") {
    return {
      code: "REVOKED",
      label: "Revoked",
      assignmentReady: false,
      commercialReady: false,
      trackingReady: false,
      fullyProvisioned: false,
      issue: null,
    };
  }

  const commercialReady =
    hasCommissionRule &&
    ["DRAFT", "EFFECTIVE"].includes(String(commissionRuleStatus || "").toUpperCase());
  const trackingReady = Boolean(hasTrackingUrl);
  const assignmentReady = ["ASSIGNED", "ACTIVE", "PAUSED"].includes(
    String(assignmentStatus || "").toUpperCase(),
  );

  let code = "ASSIGNED";
  let label = "Assigned";
  let issue = trackingIssue || null;

  if (!commercialReady && !trackingReady) {
    code = "PROVISIONING";
    label = "Provisioning";
    issue = issue || "Commercial rule and tracking are pending";
  } else if (!commercialReady) {
    code = "PROVISIONING";
    label = "Provisioning";
    issue = issue || "Commercial rule pending";
  } else if (!trackingReady) {
    code = "TRACKING_PENDING";
    label = "Tracking pending";
    issue = issue || "Publisher tracking URL not confirmed";
  } else if (published && String(assignmentStatus).toUpperCase() === "ACTIVE") {
    code = "ACTIVE";
    label = "Active";
  } else if (trackingReady && commercialReady) {
    code = "READY";
    label = "Ready to provision";
  }

  return {
    code,
    label,
    assignmentReady,
    commercialReady,
    trackingReady,
    fullyProvisioned:
      assignmentReady &&
      commercialReady &&
      trackingReady &&
      published === true &&
      String(assignmentStatus).toUpperCase() === "ACTIVE",
    issue,
  };
}

export function summarizeAssignmentProvisioning(assignment = {}) {
  const rules = assignment.commissionRules || [];
  const rule =
    rules.find((r) => r.status === "EFFECTIVE") || rules.find((r) => r.status === "DRAFT") || null;
  const links = (assignment.trackingLinks || []).filter((l) => l.status !== "REVOKED");
  const primary =
    links.find((l) => l.isPrimary) || links.find((l) => l.mboTrackingUrl) || links[0] || null;

  return deriveProvisioningStatus({
    assignmentStatus: assignment.status,
    published: assignment.published === true,
    commissionRuleStatus: rule?.status || null,
    hasCommissionRule: Boolean(rule),
    trackingLinkStatus: primary?.status || null,
    hasTrackingUrl: Boolean(primary?.mboTrackingUrl),
  });
}
