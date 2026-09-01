import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildClientSetupProgress } from "../src/modules/client/setupProgress.js";

describe("buildClientSetupProgress", () => {
  it("marks only create complete for a brand new prospect", () => {
    const progress = buildClientSetupProgress({
      status: "PROSPECT",
      commercialModel: null,
      hasAssignments: false,
      allPublished: false,
      hasApiKey: false,
      hasAdmin: false,
    });
    assert.equal(progress.completedSteps, 1);
    assert.equal(progress.setupComplete, false);
    assert.equal(progress.suggestedStep, 2);
    assert.equal(progress.checklist.activated, false);
  });

  it("reflects a fully provisioned active client", () => {
    const progress = buildClientSetupProgress({
      status: "ACTIVE",
      commercialModel: "OFFERS_PLUS_COMMISSION",
      hasAssignments: true,
      allPublished: true,
      hasApiKey: true,
      hasAdmin: true,
      hasCouponAssignments: true,
      hasCommissionRules: true,
      hasTrackingLinks: true,
    });
    assert.equal(progress.setupComplete, true);
    assert.equal(progress.completedSteps, 5);
    assert.equal(progress.checklist.provisioned, true);
    assert.equal(progress.checklist.activated, true);
    assert.equal(progress.suggestedStep, 5);
  });

  it("keeps portal/login incomplete when no admin even if active", () => {
    const progress = buildClientSetupProgress({
      status: "ACTIVE",
      commercialModel: "OFFERS_ONLY",
      hasAssignments: true,
      allPublished: true,
      hasApiKey: true,
      hasAdmin: false,
    });
    assert.equal(progress.checklist.activated, true);
    assert.equal(progress.checklist.administratorConfigured, false);
    assert.equal(progress.setupComplete, false);
    assert.equal(progress.suggestedStep, 5);
  });

  it("skips API requirement for PORTAL_ONLY delivery", () => {
    const progress = buildClientSetupProgress({
      status: "PROSPECT",
      commercialModel: "OFFERS_ONLY",
      deliveryMethod: "PORTAL_ONLY",
      hasAssignments: true,
      allPublished: true,
      hasApiKey: false,
      hasAdmin: true,
    });
    assert.equal(progress.checklist.needsApi, false);
    assert.equal(progress.checklist.apiKeyIssued, true);
    assert.equal(progress.checklist.provisioned, true);
    assert.equal(progress.checklist.administratorConfigured, true);
  });

  it("skips portal requirement for API_ONLY delivery", () => {
    const progress = buildClientSetupProgress({
      status: "PROSPECT",
      commercialModel: "OFFERS_ONLY",
      deliveryMethod: "API_ONLY",
      agreementStatus: "SIGNED",
      hasAssignments: true,
      allPublished: true,
      hasProductionKey: true,
      hasAdmin: false,
    });
    assert.equal(progress.checklist.needsPortal, false);
    assert.equal(progress.checklist.administratorConfigured, true);
    assert.equal(progress.checklist.apiKeyIssued, true);
    assert.equal(progress.checklist.agreementSigned, true);
  });

  it("requires signed agreement for checklist", () => {
    const progress = buildClientSetupProgress({
      status: "PROSPECT",
      commercialModel: "OFFERS_ONLY",
      agreementStatus: "PENDING",
      hasAssignments: true,
      allPublished: true,
      hasApiKey: true,
      hasAdmin: true,
    });
    assert.equal(progress.checklist.agreementSigned, false);
  });
});
