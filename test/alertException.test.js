/**
 * Pointer 21 — Alert / exception contract tests.
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  ALERT_ACTION,
  ALERT_CONDITION,
  ALERT_SEVERITY,
  applyAlertContract,
  isAuthenticationSyncError,
  isRateLimitExhaustion,
  mapMappingErrorToCondition,
  resolveAlertSpec,
} from "../src/modules/ops/alertException.contract.js";
import { ExceptionCaseService } from "../src/modules/order/exceptionCase.service.js";
import { handleSyncAuthFailure } from "../src/modules/ops/syncAlert.service.js";
import { RECONCILIATION_PAIR } from "../src/modules/finance/reconciliationLogic.contract.js";

describe("Pointer 21 — alertException.contract", () => {
  it("resolves all nine canonical alert conditions", () => {
    const conditions = [
      ALERT_CONDITION.AUTHENTICATION_FAILURE,
      ALERT_CONDITION.RATE_LIMIT_EXHAUSTION,
      ALERT_CONDITION.REQUIRED_MAPPING_MISSING,
      ALERT_CONDITION.UNKNOWN_SOURCE_STATUS,
      ALERT_CONDITION.CAMPAIGN_BRAND_MAPPING_MISSING,
      ALERT_CONDITION.ATTRIBUTION_AMBIGUOUS,
      ALERT_CONDITION.ATTRIBUTION_UNRESOLVED_ORPHAN,
      ALERT_CONDITION.DUPLICATE_PAYMENT_IMPORT,
      ALERT_CONDITION.NETWORK_PAYMENT_MISMATCH,
      ALERT_CONDITION.CLIENT_PAYABLE_MISMATCH,
    ];
    for (const condition of conditions) {
      const spec = resolveAlertSpec({ condition });
      assert.ok(spec, `missing spec for ${condition}`);
      assert.ok(spec.type);
      assert.ok(spec.severity);
      assert.ok(spec.requiredAction);
    }
  });

  it("maps client payable reconciliation to CRITICAL", () => {
    const spec = resolveAlertSpec({
      reconciliationPair: RECONCILIATION_PAIR.MBO_RECEIPT_VS_CLIENT_PAYABLE,
    });
    assert.equal(spec.condition, ALERT_CONDITION.CLIENT_PAYABLE_MISMATCH);
    assert.equal(spec.severity, ALERT_SEVERITY.CRITICAL);
    assert.equal(spec.requiredAction, ALERT_ACTION.BLOCK_CLIENT_PAYABLE_RELEASE);
  });

  it("maps network payment mismatch to HIGH finance queue", () => {
    const spec = resolveAlertSpec({
      reconciliationPair: RECONCILIATION_PAIR.NETWORK_PAYMENT_VS_MBO_RECEIPT,
    });
    assert.equal(spec.condition, ALERT_CONDITION.NETWORK_PAYMENT_MISMATCH);
    assert.equal(spec.severity, ALERT_SEVERITY.HIGH);
    assert.equal(spec.requiredAction, ALERT_ACTION.FINANCE_RECON_QUEUE);
  });

  it("applyAlertContract injects metadata without overriding explicit severity", () => {
    const resolved = applyAlertContract({
      condition: ALERT_CONDITION.ATTRIBUTION_AMBIGUOUS,
      severity: "LOW",
      type: "ATTRIBUTION_UNRESOLVED",
    });
    assert.equal(resolved.severity, "LOW");
    assert.equal(resolved.metadata.alertCondition, ALERT_CONDITION.ATTRIBUTION_AMBIGUOUS);
    assert.equal(resolved.metadata.requiredAction, ALERT_ACTION.OPS_REVIEW);
  });

  it("classifies authentication and rate-limit errors", () => {
    assert.equal(isAuthenticationSyncError({ response: { status: 401 } }), true);
    assert.equal(isAuthenticationSyncError({ response: { status: 403, data: { error: "Invalid API key" } } }), true);
    assert.equal(isAuthenticationSyncError({ message: "timeout" }), false);
    assert.equal(isRateLimitExhaustion({ response: { status: 429 }, syncAttemptCount: 2 }), true);
    assert.equal(isRateLimitExhaustion({ response: { status: 429 }, syncAttemptCount: 1 }), false);
  });

  it("maps mapping error codes to alert conditions", () => {
    assert.equal(mapMappingErrorToCondition("MAPPING_UNKNOWN_ENUM"), ALERT_CONDITION.UNKNOWN_SOURCE_STATUS);
    assert.equal(
      mapMappingErrorToCondition("MAPPING_REQUIRED_FIELD_MISSING"),
      ALERT_CONDITION.REQUIRED_MAPPING_MISSING,
    );
  });
});

describe("Pointer 21 — exception reporting integration", () => {
  it("report() resolves condition to CRITICAL auth failure", async () => {
    const db = {
      exceptionCase: {
        findFirst: async () => null,
        create: async ({ data }) => ({ id: "ex-auth", ...data, detectedAt: new Date() }),
      },
    };
    const svc = new ExceptionCaseService({ prisma: db, audit: { record: async () => {} } });
    const { record } = await svc.report({
      condition: ALERT_CONDITION.AUTHENTICATION_FAILURE,
      supplier: "IMPACT",
      reason: "401 unauthorized",
    });
    assert.equal(record.type, "NETWORK_AUTH_FAILURE");
    assert.equal(record.severity, "CRITICAL");
    assert.equal(record.metadata.requiredAction, ALERT_ACTION.PAUSE_ACCOUNT_SYNC);
  });

  it("handleSyncAuthFailure pauses account sync", async () => {
    const updates = [];
    const reports = [];
    const paused = await handleSyncAuthFailure(
      {
        platform: "impact",
        accountLabel: "default",
        error: { response: { status: 401 }, message: "Unauthorized" },
      },
      {
        exceptions: {
          report: async (input) => {
            reports.push(input);
            return { record: { id: "ex1" }, created: true };
          },
        },
        updateTimestamps: async (platform, label, data) => {
          updates.push({ platform, label, data });
          return 1;
        },
      },
    );
    assert.equal(paused, true);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].condition, ALERT_CONDITION.AUTHENTICATION_FAILURE);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].data.syncEnabled, false);
    assert.equal(updates[0].data.credentialHealth, "FAILED");
  });
});
