/**
 * Provider-neutral credential resolution for Network Connections.
 *
 * MarketplaceAccount.secretRef holds `<provider>:<reference>`. Supplier adapters and sync logic
 * never read secrets from a provider directly: they ask this resolver for a SLOT of a platform's
 * catalogued profile (credentialCatalog.js), and the resolver asks the registered provider.
 *
 *   env     — the current provider (Vercel project environment). Reference = the platform key.
 *             Reads ONLY the env names the catalog lists for that platform.
 *   aws-sm  — AWS Secrets Manager (not registered by default). Reference = the canonical secret id
 *             `mbo/<environment>/networks/<platform>/<accountLabel>`; the secret is a JSON object
 *             keyed by slot name. Registering it (registerCredentialProvider) changes no adapter.
 *
 * References are BUILT by the server (buildSecretRef) from platform/environment/label; an admin
 * only chooses a provider. A stored reference is re-validated against the catalog on every
 * resolution, so a tampered row cannot reach another platform's names or an arbitrary secret.
 * Resolved values are returned to the caller only — never logged, persisted or put in errors.
 */
import { credentialProfile, SECRET_SLOTS } from "./credentialCatalog.js";

export const CREDENTIAL_PROVIDER_NAMES = Object.freeze({ ENV: "env", AWS_SECRETS_MANAGER: "aws-sm" });

/** A secretRef value from the pre-resolver era (`mbo-sm://local-encrypted/...`): not a provider ref. */
export const LEGACY_PLACEHOLDER_PREFIX = "mbo-sm://";

const KNOWN_PROVIDERS = new Set(Object.values(CREDENTIAL_PROVIDER_NAMES));
const ACCOUNT_LABEL_RE = /^[a-z0-9_-]{1,40}$/;
const ENVIRONMENT_RE = /^(production|sandbox)$/;

export class CredentialResolutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CredentialResolutionError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------------------ providers */

/** Env provider: the catalog decides the variable name; the reference only selects the platform. */
export function createEnvCredentialProvider({ envSource = process.env } = {}) {
  return Object.freeze({
    name: CREDENTIAL_PROVIDER_NAMES.ENV,
    referenceFor({ platform }) {
      return platform;
    },
    validateReference({ platform, reference }) {
      return reference === platform ? { ok: true } : { ok: false, reason: "reference_platform_mismatch" };
    },
    async resolve({ profile, slots }) {
      const values = {};
      for (const slot of slots) {
        const name = profile.slots[slot]?.env;
        const raw = name ? envSource[name] : undefined;
        values[slot] = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
      }
      return values;
    },
  });
}

/**
 * AWS Secrets Manager provider. `fetchSecretString(secretId)` is injected (the AWS SDK call lives
 * with the infrastructure bootstrap, not here), so supplier code is unchanged when it is enabled.
 */
export function createAwsSecretsManagerProvider({ fetchSecretString } = {}) {
  if (typeof fetchSecretString !== "function") {
    throw new CredentialResolutionError("provider_misconfigured", "AWS Secrets Manager provider needs fetchSecretString.");
  }
  const canonicalId = ({ platform, accountLabel, environment }) =>
    `mbo/${String(environment).toLowerCase()}/networks/${platform}/${accountLabel}`;
  return Object.freeze({
    name: CREDENTIAL_PROVIDER_NAMES.AWS_SECRETS_MANAGER,
    referenceFor(ctx) {
      return canonicalId(ctx);
    },
    validateReference(ctx) {
      return ctx.reference === canonicalId(ctx) ? { ok: true } : { ok: false, reason: "reference_not_canonical" };
    },
    async resolve({ reference, profile, slots }) {
      let parsed;
      try {
        parsed = JSON.parse(await fetchSecretString(reference));
      } catch {
        throw new CredentialResolutionError("provider_read_failed", "Secret could not be read from the provider.");
      }
      const values = {};
      for (const slot of slots) {
        // Only catalogued slots are read; any other key in the secret is ignored.
        const raw = profile.slots[slot] ? parsed?.[slot] : undefined;
        values[slot] = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
      }
      return values;
    },
  });
}

const providers = new Map([[CREDENTIAL_PROVIDER_NAMES.ENV, createEnvCredentialProvider()]]);

/** Register (or replace) a provider, e.g. AWS Secrets Manager at infrastructure bootstrap. */
export function registerCredentialProvider(provider) {
  if (!provider?.name || !KNOWN_PROVIDERS.has(provider.name)) {
    throw new CredentialResolutionError("unknown_provider", "Only known credential providers can be registered.");
  }
  for (const fn of ["referenceFor", "validateReference", "resolve"]) {
    if (typeof provider[fn] !== "function") {
      throw new CredentialResolutionError("provider_misconfigured", `Credential provider is missing ${fn}.`);
    }
  }
  providers.set(provider.name, provider);
  return provider;
}

/** Test seam: restore the default provider set. */
export function resetCredentialProvidersForTests() {
  providers.clear();
  providers.set(CREDENTIAL_PROVIDER_NAMES.ENV, createEnvCredentialProvider());
}

export function registeredCredentialProviders() {
  return [...providers.keys()];
}

/* ------------------------------------------------------------------------------ references */

function normalizeContext({ platform, accountLabel = "default", environment = "PRODUCTION" } = {}) {
  const p = String(platform || "").trim().toLowerCase();
  const label = String(accountLabel || "default").trim().toLowerCase();
  const env = String(environment || "PRODUCTION").trim().toLowerCase();
  return { platform: p, accountLabel: label, environment: env };
}

/** `<provider>:<reference>` → { provider, reference } for known providers; null otherwise. */
export function parseSecretRef(secretRef) {
  if (typeof secretRef !== "string") return null;
  if (secretRef.startsWith(LEGACY_PLACEHOLDER_PREFIX)) return null;
  const idx = secretRef.indexOf(":");
  if (idx <= 0) return null;
  const provider = secretRef.slice(0, idx);
  const reference = secretRef.slice(idx + 1);
  if (!KNOWN_PROVIDERS.has(provider) || !reference) return null;
  return { provider, reference };
}

/** True when secretRef points at a credential provider (as opposed to encrypted DB storage). */
export function isProviderSecretRef(secretRef) {
  return parseSecretRef(secretRef) !== null;
}

/**
 * Build the only acceptable reference for a connection. Refuses platforms outside the catalog,
 * malformed labels/environments and providers that are not registered in this deployment.
 */
export function buildSecretRef({ provider, platform, accountLabel, environment }) {
  const ctx = normalizeContext({ platform, accountLabel, environment });
  if (!credentialProfile(ctx.platform)) {
    throw new CredentialResolutionError("platform_not_allowed", "This network has no credential allow-list entry.");
  }
  if (!ACCOUNT_LABEL_RE.test(ctx.accountLabel)) {
    throw new CredentialResolutionError("invalid_account_label", "Account label is not valid.");
  }
  if (!ENVIRONMENT_RE.test(ctx.environment)) {
    throw new CredentialResolutionError("invalid_environment", "Environment must be PRODUCTION or SANDBOX.");
  }
  const impl = providers.get(provider);
  if (!impl) {
    throw new CredentialResolutionError("provider_not_configured", "That credential provider is not configured.");
  }
  return `${impl.name}:${impl.referenceFor(ctx)}`;
}

/** Validate a stored secretRef against the catalog for this exact connection. */
export function validateSecretRef(secretRef, context) {
  const parsed = parseSecretRef(secretRef);
  if (!parsed) return { ok: false, reason: "not_a_provider_reference" };
  const ctx = normalizeContext(context);
  if (!credentialProfile(ctx.platform)) return { ok: false, reason: "platform_not_allowed" };
  const impl = providers.get(parsed.provider);
  if (!impl) return { ok: false, reason: "provider_not_configured", provider: parsed.provider };
  const check = impl.validateReference({ ...ctx, reference: parsed.reference });
  return check.ok ? { ok: true, provider: parsed.provider } : { ok: false, reason: check.reason, provider: parsed.provider };
}

/** Safe, value-free description of a reference for DTOs and audit rows. */
export function describeSecretRef(secretRef) {
  const parsed = parseSecretRef(secretRef);
  if (!parsed) return { provider: null, configured: false };
  return { provider: parsed.provider, configured: true };
}

/* ------------------------------------------------------------------------------ resolution */

/**
 * Resolve catalogued slots for one connection. Returns values for the caller only, plus which
 * required slots are missing (names of SLOTS, never of variables or secrets).
 */
export async function resolveCredentialSlots({ platform, accountLabel, environment, secretRef, slots = null } = {}) {
  const ctx = normalizeContext({ platform, accountLabel, environment });
  const profile = credentialProfile(ctx.platform);
  if (!profile) throw new CredentialResolutionError("platform_not_allowed", "This network has no credential allow-list entry.");

  const check = validateSecretRef(secretRef, ctx);
  if (!check.ok) throw new CredentialResolutionError(check.reason, "Credential reference is not valid for this connection.");

  const wanted = (slots ?? Object.keys(profile.slots)).filter((slot) => profile.slots[slot]);
  const parsed = parseSecretRef(secretRef);
  const values = await providers.get(parsed.provider).resolve({ ...ctx, reference: parsed.reference, profile, slots: wanted });
  const missingRequired = wanted.filter((slot) => profile.slots[slot].required && !values[slot]);
  return { provider: parsed.provider, values, missingRequired };
}

/** One slot for one connection, or null. */
export async function resolveCredentialSlot(context, slot) {
  const { values } = await resolveCredentialSlots({ ...context, slots: [slot] });
  return values[slot] ?? null;
}

/**
 * Legacy fallback for networks that still sync WITHOUT a connection record: the same catalogued
 * env names production reads today, through the env provider (never a free-form name).
 */
export async function legacyEnvCredential(platform, slot) {
  const ctx = normalizeContext({ platform });
  const profile = credentialProfile(ctx.platform);
  if (!profile?.slots[slot]) return null;
  const env = providers.get(CREDENTIAL_PROVIDER_NAMES.ENV);
  if (!env) return null;
  const values = await env.resolve({ ...ctx, reference: ctx.platform, profile, slots: [slot] });
  return values[slot] ?? null;
}

/** Whether a slot holds a secret (as opposed to an identifier such as a publisher id). */
export function isSecretSlot(slot) {
  return SECRET_SLOTS.has(slot);
}
