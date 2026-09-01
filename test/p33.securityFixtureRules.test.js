/**
 * Pointer 33 — Security and fixture rules.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  CONTRACT_POINTER,
  FORBIDDEN_SECRET_SURFACES,
  FORBIDDEN_SECRET_TYPES,
  SECURITY_FIXTURE_SUMMARY,
  SecurityFixtureRulesError,
  applySecurityFixtureRulesContract,
  assertFixtureSanitized,
  assertNoSecretsInSurface,
  buildSecurityFixtureRulesGuide,
} from "../src/modules/networkOps/securityFixtureRules.contract.js";
import { loadAiIntegrationFixtureBundle } from "../src/modules/networkOps/aiAssistedDevelopment.contract.js";
import { AiIntegrationGuideService } from "../src/modules/networkOps/aiIntegrationGuide.service.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

describe("Pointer 33 — securityFixtureRules.contract", () => {
  it("declares contract pointer 33 and forbidden secret surfaces", () => {
    assert.equal(CONTRACT_POINTER, 33);
    assert.equal(FORBIDDEN_SECRET_SURFACES.length, 7);
    assert.equal(FORBIDDEN_SECRET_TYPES.length, 6);
    assert.match(SECURITY_FIXTURE_SUMMARY.secretPlacementRule, /must never be placed in frontend code, AI prompts/);
    assert.match(SECURITY_FIXTURE_SUMMARY.sanitizationRule, /preserve field structure and realistic value types/);
  });

  it("assertNoSecretsInSurface rejects secrets on forbidden surfaces", () => {
    assert.throws(
      () =>
        assertNoSecretsInSurface({
          surface: "logs",
          payload: { accessToken: "live-token-value" },
        }),
      (err) => {
        assert.equal(err.code, "SECRET_EXPOSED_ON_SURFACE");
        return true;
      },
    );
    assert.throws(
      () =>
        assertNoSecretsInSurface({
          surface: "exception_payloads",
          payload: { message: "Authorization: Bearer abc.def.ghi" },
        }),
      (err) => {
        assert.equal(err.code, "SECRET_EXPOSED_ON_SURFACE");
        return true;
      },
    );
    assert.doesNotThrow(() =>
      assertNoSecretsInSurface({
        surface: "test_fixtures",
        payload: { networkProprietaryField: "[redacted-sample-only]" },
      }),
    );
  });

  it("assertFixtureSanitized accepts optimise/campaigns exemplar fixture", () => {
    const bundle = loadAiIntegrationFixtureBundle("optimise", "campaigns");
    assert.doesNotThrow(() =>
      assertFixtureSanitized(bundle.sourceFixture, { label: "optimise/campaigns/source.api.json" }),
    );
  });

  it("assertFixtureSanitized rejects unsanitized secrets", () => {
    assert.throws(
      () =>
        assertFixtureSanitized(
          {
            id: 1,
            apiKey: "super-secret-key-value",
          },
          { label: "bad-fixture" },
        ),
      (err) => {
        assert.equal(err instanceof SecurityFixtureRulesError, true);
        assert.equal(err.code, "FIXTURE_NOT_SANITIZED");
        return true;
      },
    );
  });

  it("buildSecurityFixtureRulesGuide includes scoped object refs", () => {
    const globalGuide = buildSecurityFixtureRulesGuide();
    assert.equal(globalGuide.contractPointer, 33);

    const objectGuide = buildSecurityFixtureRulesGuide({ network: "optimise", sourceObject: "campaigns" });
    assert.match(objectGuide.objectRefs.sourceFixture, /optimise\/campaigns\/source\.api\.json/);
  });

  it("applySecurityFixtureRulesContract stamps response meta", () => {
    const wrapped = applySecurityFixtureRulesContract(
      { ok: true, data: {} },
      { network: "optimise", sourceObject: "campaigns" },
    );
    assert.equal(wrapped.meta.securityFixturePointer, 33);
    assert.equal(wrapped.meta.securityFixtureNetwork, "optimise");
  });
});

describe("Pointer 33 — AI integration guide includes security fixture rules", () => {
  const guide = new AiIntegrationGuideService();

  it("global guide exposes securityFixtureRules", () => {
    const payload = guide.getGlobalGuide();
    assert.equal(payload.securityFixturePointer, 33);
    assert.equal(payload.securityFixtureRules.contractPointer, 33);
    assert.equal(payload.securityFixtureRules.forbiddenSecretSurfaces.length, 7);
  });

  it("object guide includes scoped security fixture refs", () => {
    const payload = guide.getObjectGuide("optimise", "campaigns");
    assert.equal(payload.securityFixtureRules.contractPointer, 33);
    assert.match(payload.securityFixtureRules.objectRefs.fixtureDir, /campaigns/);
  });
});

describe("Pointer 33 — GET /ops/network/ai-integration-guide", () => {
  /** @type {{ baseUrl: string, close: () => Promise<void> } | null} */
  let server = null;

  before(async () => {
    server = await startTestServer();
  });

  after(async () => {
    if (server) await server.close();
  });

  it("returns 401 without auth for global guide", async () => {
    const { status } = await apiRequest(server.baseUrl, {
      path: "/ops/network/ai-integration-guide",
    });
    assert.equal(status, 401);
  });
});
