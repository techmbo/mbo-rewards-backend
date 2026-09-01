/**
 * Pointer 33 — Security and fixture rules.
 * Secrets never belong in client-visible surfaces; AI/tests use sanitized fixtures only.
 */
import { NETWORK_ACCOUNT_FORBIDDEN_KEYS } from "./networkAccount.contract.js";
import { sanitizeSampleValue } from "../../field-system/sampleSanitizer.js";

export const CONTRACT_POINTER = 33;

export const SECURITY_FIXTURE_SUMMARY = Object.freeze({
  secretPlacementRule:
    "Production credentials, access tokens, refresh tokens, API keys, secrets and signed authorization headers must never be placed in frontend code, AI prompts, screenshots, test fixtures, downloadable HTML, logs, or exception payloads.",
  sanitizationRule:
    "AI and automated tests must use sanitized fixtures. Sanitization must preserve field structure and realistic value types while removing secrets and unnecessary personal data.",
});

/** Surfaces where secrets must never appear. */
export const FORBIDDEN_SECRET_SURFACES = Object.freeze([
  { key: "frontend_code", label: "Frontend code" },
  { key: "ai_prompts", label: "AI prompts" },
  { key: "screenshots", label: "Screenshots" },
  { key: "test_fixtures", label: "Test fixtures" },
  { key: "downloadable_html", label: "Downloadable HTML" },
  { key: "logs", label: "Logs" },
  { key: "exception_payloads", label: "Exception payloads" },
]);

export const FORBIDDEN_SECRET_TYPES = Object.freeze([
  "production_credentials",
  "access_token",
  "refresh_token",
  "api_key",
  "secret",
  "signed_authorization_header",
]);

const SENSITIVE_KEY =
  /password|secret|token|api[_-]?key|authorization|access[_-]?key|refresh[_-]?token|credential|private[_-]?key|client[_-]?secret/i;

const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._\-+/=]+/i;
const LONG_SECRET_PATTERN = /[A-Za-z0-9+/_-]{40,}={0,2}/;

const PII_KEY = /email|phone|ssn|national[_-]?id|passport/i;

export const SANITIZATION_REQUIREMENTS = Object.freeze({
  preserveFieldStructure: true,
  preserveRealisticValueTypes: true,
  removeSecrets: true,
  removeUnnecessaryPersonalData: true,
  allowedRedactionMarkers: Object.freeze(["[redacted]", "[redacted-sample-only]", "[sanitized]"]),
});

export class SecurityFixtureRulesError extends Error {
  constructor(message, { code = "SECURITY_FIXTURE_VIOLATION", details = null } = {}) {
    super(message);
    this.name = "SecurityFixtureRulesError";
    this.code = code;
    this.details = details;
    this.contractPointer = CONTRACT_POINTER;
  }
}

function isAllowedRedaction(value) {
  const text = String(value || "");
  return SANITIZATION_REQUIREMENTS.allowedRedactionMarkers.some((marker) => text.includes(marker));
}

function collectViolations(value, path = "", violations = []) {
  if (value == null || typeof value !== "object") {
    if (typeof value === "string") {
      if (BEARER_PATTERN.test(value) && !isAllowedRedaction(value)) {
        violations.push({ path: path || "(root)", issue: "bearer_token", sample: "[redacted]" });
      } else if (LONG_SECRET_PATTERN.test(value) && !isAllowedRedaction(value) && !value.startsWith("http")) {
        violations.push({ path: path || "(root)", issue: "long_secret_like_string", sample: "[redacted]" });
      }
    }
    return violations;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectViolations(item, `${path}[${index}]`, violations));
    return violations;
  }

  for (const [key, child] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    if (SENSITIVE_KEY.test(key) && child != null && child !== "" && !isAllowedRedaction(child)) {
      violations.push({ path: nextPath, issue: "sensitive_key", key });
    }
    if (PII_KEY.test(key) && typeof child === "string" && child.includes("@") && !isAllowedRedaction(child)) {
      violations.push({ path: nextPath, issue: "unnecessary_personal_data", key });
    }
    collectViolations(child, nextPath, violations);
  }

  return violations;
}

/**
 * Assert secrets are not exposed on a forbidden surface.
 */
export function assertNoSecretsInSurface({
  surface,
  payload = null,
} = {}) {
  const known = FORBIDDEN_SECRET_SURFACES.some((item) => item.key === surface);
  if (!known) {
    throw new SecurityFixtureRulesError(`Unknown secret surface: ${surface}`, {
      code: "UNKNOWN_SECRET_SURFACE",
      details: { surface },
    });
  }

  if (payload == null) return true;

  const violations = collectViolations(payload);
  if (violations.length) {
    throw new SecurityFixtureRulesError(
      `Secrets must not appear in ${surface.replace(/_/g, " ")}.`,
      {
        code: "SECRET_EXPOSED_ON_SURFACE",
        details: { surface, violations },
      },
    );
  }

  for (const key of NETWORK_ACCOUNT_FORBIDDEN_KEYS) {
    if (payload && typeof payload === "object" && key in payload && !isAllowedRedaction(payload[key])) {
      throw new SecurityFixtureRulesError(`Forbidden credential key exposed: ${key}`, {
        code: "FORBIDDEN_CREDENTIAL_KEY",
        details: { surface, key },
      });
    }
  }

  return true;
}

/**
 * Assert a fixture is sanitized — structure/types preserved, secrets removed.
 */
export function assertFixtureSanitized(fixture, { label = "fixture" } = {}) {
  if (fixture == null || typeof fixture !== "object") {
    throw new SecurityFixtureRulesError(`${label} must be an object or array.`, {
      code: "FIXTURE_NOT_OBJECT",
      details: { label },
    });
  }

  const violations = collectViolations(fixture);
  if (violations.length) {
    throw new SecurityFixtureRulesError(`${label} contains unsanitized secrets or personal data.`, {
      code: "FIXTURE_NOT_SANITIZED",
      details: { label, violations },
    });
  }

  // Structure/type smoke check via sample sanitizer — should not collapse entire fixture.
  if (!Array.isArray(fixture)) {
    for (const [key, value] of Object.entries(fixture)) {
      const sanitized = sanitizeSampleValue(value, { fieldPath: key });
      if (sanitized == null && value != null) {
        throw new SecurityFixtureRulesError(`${label} lost value type for field ${key}.`, {
          code: "FIXTURE_STRUCTURE_LOST",
          details: { label, key },
        });
      }
    }
  }

  return true;
}

export function buildSecurityFixtureRulesGuide({ network = null, sourceObject = null } = {}) {
  const guide = {
    contractPointer: CONTRACT_POINTER,
    summary: { ...SECURITY_FIXTURE_SUMMARY },
    forbiddenSecretSurfaces: FORBIDDEN_SECRET_SURFACES.map((item) => ({ ...item })),
    forbiddenSecretTypes: [...FORBIDDEN_SECRET_TYPES],
    sanitizationRequirements: {
      ...SANITIZATION_REQUIREMENTS,
      allowedRedactionMarkers: [...SANITIZATION_REQUIREMENTS.allowedRedactionMarkers],
    },
    runtimeRefs: Object.freeze({
      networkAccountContract: "networkOps/networkAccount.contract.js",
      sampleSanitizer: "field-system/sampleSanitizer.js",
      sanitizeForLog: "platform/logging/context.js",
      clientBoundary: "client/clientBoundary.contract.js",
    }),
  };

  if (network && sourceObject) {
    const family = String(network).toLowerCase();
    const obj = String(sourceObject).toLowerCase();
    guide.objectRefs = Object.freeze({
      fixtureDir: `platform_backend/test/fixtures/networks/${family}/${obj}/`,
      sourceFixture: `platform_backend/test/fixtures/networks/${family}/${obj}/source.api.json`,
      aiIntegrationFixture: "aiAssistedDevelopment.contract.js",
    });
  }

  return guide;
}

export function applySecurityFixtureRulesContract(response, { network, sourceObject } = {}) {
  if (!response || typeof response !== "object") return response;
  const meta = {
    ...(response.meta && typeof response.meta === "object" ? response.meta : {}),
    securityFixturePointer: CONTRACT_POINTER,
    securityFixtureNetwork: network || null,
    securityFixtureSourceObject: sourceObject || null,
  };
  return { ...response, meta };
}
