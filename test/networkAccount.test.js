/**
 * NetworkAccount contract — credential health, secret-free DTO, error redaction.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CREDENTIAL_HEALTH,
  assertNoSecrets,
  deriveCredentialHealth,
  hasNetworkAccountSecret,
  networkAccountSecretRef,
  sanitizeSecretError,
  toNetworkAccountDto,
} from "../src/modules/networkOps/networkAccount.contract.js";
import { toNetworkDetailDto } from "../src/modules/ops/networkOps.dto.js";
import { sanitizeForLog } from "../src/platform/logging/context.js";

describe("network account — credential health", () => {
  it("NOT_CONFIGURED when no secret evidence exists", () => {
    assert.equal(deriveCredentialHealth({}), CREDENTIAL_HEALTH.NOT_CONFIGURED);
    assert.equal(hasNetworkAccountSecret({}), false);
  });

  it("EXPIRED when tokenExpiresAt is in the past", () => {
    assert.equal(
      deriveCredentialHealth({
        secretRef: networkAccountSecretRef("acc-1"),
        tokenExpiresAt: new Date("2020-01-01T00:00:00Z"),
      }),
      CREDENTIAL_HEALTH.EXPIRED,
    );
  });

  it("FAILED when lastSyncError is present", () => {
    assert.equal(
      deriveCredentialHealth({
        maskedApiKey: "abcd***wxyz",
        lastSyncError: "401 from network",
      }),
      CREDENTIAL_HEALTH.FAILED,
    );
  });

  it("HEALTHY when credentials exist and a successful sync or auth check is recorded", () => {
    assert.equal(
      deriveCredentialHealth({
        secretRef: networkAccountSecretRef("acc-1"),
        lastSuccessfulSync: new Date("2026-08-14T21:55:00Z"),
      }),
      CREDENTIAL_HEALTH.HEALTHY,
    );
  });

  it("UNKNOWN when credentials exist but have never synced", () => {
    assert.equal(
      deriveCredentialHealth({
        secretRef: networkAccountSecretRef("acc-1"),
      }),
      CREDENTIAL_HEALTH.UNKNOWN,
    );
  });
});

describe("network account — DTO secrecy", () => {
  it("never copies ciphertext, plaintext keys, or unsanitized sync errors", () => {
    const dto = toNetworkAccountDto({
      id: "acc-1",
      platform: "boostiny",
      accountLabel: "default",
      authType: "api_key",
      encryptedAccessToken: "SECRET_SHOULD_NOT_LEAK",
      encryptedRefreshToken: "REFRESH_SECRET",
      apiKey: "plain-key-value",
      secretRef: networkAccountSecretRef("acc-1"),
      maskedApiKey: "abcd***wxyz",
      environment: "PRODUCTION",
      syncEnabled: true,
      financeSyncEnabled: false,
      lastSyncError: "Boostiny 401 apiKey=supersecretvalue123",
      lastSuccessfulSync: new Date("2026-08-14T21:55:00Z"),
      tokenExpiresAt: new Date("2026-12-01T00:00:00Z"),
    });
    const blob = JSON.stringify(dto);
    assert.equal(blob.includes("SECRET_SHOULD_NOT_LEAK"), false);
    assert.equal(blob.includes("REFRESH_SECRET"), false);
    assert.equal(blob.includes("plain-key-value"), false);
    assert.equal(blob.includes("supersecretvalue123"), false);
    assert.equal("encryptedAccessToken" in dto, false);
    assert.equal("apiKey" in dto, false);
    assert.equal(dto.secretRef, "mbo-sm://local-encrypted/network-account/acc-1");
    assert.equal(dto.maskedApiKey, "abcd***wxyz");
    assert.equal(dto.credentialHealth, CREDENTIAL_HEALTH.FAILED);
    assert.equal(dto.financeSyncEnabled, false);
    assert.equal(dto.credentialsConfigured, true);
    assertNoSecrets(dto);
  });

  it("network detail accounts[] stay secret-free when a sync error is present", () => {
    const dto = toNetworkDetailDto({
      key: "BOOSTINY",
      name: "Boostiny",
      credentialsConfigured: true,
      accounts: [
        {
          id: "acc-1",
          platform: "boostiny",
          accountLabel: "prod",
          encryptedAccessToken: "SECRET_SHOULD_NOT_LEAK",
          lastSyncError: "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb",
          secretRef: networkAccountSecretRef("acc-1"),
          maskedApiKey: "6a39***1f81",
        },
      ],
    });
    const blob = JSON.stringify(dto);
    assert.equal(blob.includes("SECRET_SHOULD_NOT_LEAK"), false);
    assert.equal(blob.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), false);
    assert.equal(blob.includes("encryptedAccessToken"), false);
    assert.ok(dto.accounts[0].lastSyncError);
    assert.equal(dto.accounts[0].credentialHealth, CREDENTIAL_HEALTH.FAILED);
  });
});

describe("network account — log and error redaction", () => {
  it("redacts ciphertext field names in logs", () => {
    const sanitized = sanitizeForLog({
      encryptedAccessToken: "SECRET_SHOULD_NOT_LEAK",
      encryptedRefreshToken: "REFRESH_SECRET",
      applicationKey: "app-key",
      userApiKey: "user-key",
      clientSecret: "oauth-secret",
      secretRef: "mbo-sm://local-encrypted/network-account/acc-1",
    });
    assert.equal(sanitized.encryptedAccessToken, "[redacted]");
    assert.equal(sanitized.encryptedRefreshToken, "[redacted]");
    assert.equal(sanitized.applicationKey, "[redacted]");
    assert.equal(sanitized.userApiKey, "[redacted]");
    assert.equal(sanitized.clientSecret, "[redacted]");
    assert.equal(sanitized.secretRef, "mbo-sm://local-encrypted/network-account/acc-1");
  });

  it("strips bearer tokens and apiKey assignments from error text", () => {
    const out = sanitizeSecretError("401 apiKey=supersecretvalue123 Bearer abc.def.ghi");
    assert.equal(out.includes("supersecretvalue123"), false);
    assert.match(out, /apiKey=\[redacted\]/i);
  });
});
