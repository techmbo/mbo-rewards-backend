/**
 * Shared setup / onboarding progress for client list + wizard checklist.
 * Steps match the staff Clients page pipeline.
 */

import { deliveryChannelRequirements } from "./deliveryMethod.js";

export function emptyOrderMetrics() {
  return {
    grossOrders: 0,
    netOrders: 0,
    grossOrderValue: 0,
    netOrderValue: 0,
    currency: null,
  };
}

/**
 * @param {object} input
 * @param {string} [input.status]
 * @param {string|null} [input.commercialModel]
 * @param {string} [input.deliveryMethod]
 * @param {string} [input.agreementStatus]
 * @param {boolean} [input.hasAssignments]
 * @param {boolean} [input.hasPublishedAssignment]
 * @param {boolean} [input.allPublished]
 * @param {boolean} [input.hasApiKey] — production (or any) key when needsApi
 * @param {boolean} [input.hasSandboxKey]
 * @param {boolean} [input.hasProductionKey]
 * @param {boolean} [input.hasAdmin]
 * @param {boolean} [input.hasCouponAssignments]
 * @param {boolean} [input.hasCommissionRules]
 * @param {boolean} [input.hasTrackingLinks]
 */
export function buildClientSetupProgress(input = {}) {
  const status = input.status ?? "PROSPECT";
  const { needsApi, needsPortal } = deliveryChannelRequirements(input.deliveryMethod);
  const commercialConfigured = Boolean(input.commercialModel);
  const agreementSigned = String(input.agreementStatus || "").toUpperCase() === "SIGNED";
  const campaignsAllotted = Boolean(input.hasAssignments);
  const hasPublishedAssignment = Boolean(input.hasPublishedAssignment ?? input.allPublished);
  const assignmentsPublished = hasPublishedAssignment && campaignsAllotted;

  const hasProductionKey = Boolean(input.hasProductionKey ?? input.hasApiKey);
  const hasSandboxKey = Boolean(input.hasSandboxKey);
  const hasAdmin = Boolean(input.hasAdmin);

  const apiKeyIssued = needsApi ? hasProductionKey : true;
  const sandboxConfigured = needsApi ? hasSandboxKey : true;
  const administratorConfigured = needsPortal ? hasAdmin : true;
  const activated = status === "ACTIVE";
  const provisioned =
    campaignsAllotted && assignmentsPublished && (!needsApi || hasProductionKey);

  const checklist = {
    clientCreated: true,
    agreementSigned,
    commercialConfigured,
    campaignsAllotted,
    couponAssignmentsPrepared: Boolean(input.hasCouponAssignments),
    commissionRulesPrepared: Boolean(input.hasCommissionRules ?? true),
    trackingLinksGenerated: Boolean(input.hasTrackingLinks ?? false),
    assignmentsPublished,
    apiKeyIssued,
    sandboxConfigured,
    administratorConfigured,
    provisioned,
    activated,
    needsApi,
    needsPortal,
  };

  const steps = [
    { key: "create", label: "Create client", done: true },
    { key: "allot", label: "Allot campaigns", done: campaignsAllotted },
    {
      key: "provision",
      label: needsApi ? "Provision API" : "API (not required)",
      done: needsApi ? apiKeyIssued || provisioned : true,
    },
    {
      key: "portal",
      label: needsPortal ? "Portal login" : "Portal (not required)",
      done: needsPortal ? administratorConfigured : true,
    },
    { key: "activate", label: "Activate", done: activated },
  ];

  const completedSteps = steps.filter((step) => step.done).length;
  const totalSteps = steps.length;
  const setupComplete = steps.every((step) => step.done);

  let suggestedStep = 1;
  if (activated || provisioned) suggestedStep = 5;
  else if (!commercialConfigured) suggestedStep = 2;
  else if (!campaignsAllotted) suggestedStep = 3;
  else if (!provisioned) suggestedStep = 4;
  else suggestedStep = 5;

  return {
    checklist,
    steps,
    completedSteps,
    totalSteps,
    setupComplete,
    suggestedStep,
  };
}
