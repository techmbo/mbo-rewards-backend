/**
 * Network Connections — the account/config control plane over MarketplaceAccount.
 *
 * A connection created here never holds a secret. The admin chooses a CREDENTIAL PROVIDER; the
 * server builds the reference from the connection's own platform, environment and label
 * (buildSecretRef), and the provider may only read the slots the fixed per-network catalog lists
 * for that platform. Nothing in a request body can name a variable, a secret id or a value.
 *
 * Safety defaults for a new connection:
 *   - it is created PAUSED (PENDING_ACTIVATION): no sync enumerates it until an admin resumes it;
 *   - only the campaign switch is on unless the request states otherwise;
 *   - it can be resumed only after a passing Test Connection;
 *   - an initial sync is campaigns-only and only for an active, tested connection.
 *
 * Every mutation writes an AuditEvent (aggregateType NetworkConnection) with value-free
 * before/after snapshots.
 */
import { prisma as defaultPrisma } from "../../database/prisma.js";
import { auditService as defaultAudit } from "../../platform/audit/audit.service.js";
import { credentialProfile, listCredentialPlatforms } from "./credentials/credentialCatalog.js";
import {
  CREDENTIAL_PROVIDER_NAMES,
  CredentialResolutionError,
  buildSecretRef,
  parseSecretRef,
  registeredCredentialProviders,
  resolveCredentialSlots,
} from "./credentials/credentialResolver.js";
import { CREDENTIAL_HEALTH, normalizeEnvironment, toNetworkConnectionDto } from "../networkOps/networkAccount.contract.js";

export const CONNECTION_AUDIT_TYPE = "NetworkConnection";
export const CREDENTIAL_SOURCE = Object.freeze({ ENCRYPTED_DB: "ENCRYPTED_DB", PROVIDER_REF: "PROVIDER_REF" });
export const PAUSE_REASON = Object.freeze({
  PENDING_ACTIVATION: "PENDING_ACTIVATION",
  MANUAL: "MANUAL",
  AUTH_FAILED: "AUTH_FAILED",
});
export const TEST_STATUS = Object.freeze({ PASSED: "PASSED", FAILED: "FAILED", NOT_CONFIGURED: "NOT_CONFIGURED" });

export const CONNECTION_SWITCHES = Object.freeze([
  "syncEnabled",
  "campaignSyncEnabled",
  "couponSyncEnabled",
  "productSyncEnabled",
  "conversionSyncEnabled",
  "financeSyncEnabled",
]);

/** A new connection ingests campaigns only until an admin turns anything else on. */
export const NEW_CONNECTION_SWITCHES = Object.freeze({
  syncEnabled: true,
  campaignSyncEnabled: true,
  couponSyncEnabled: false,
  productSyncEnabled: false,
  conversionSyncEnabled: false,
  financeSyncEnabled: false,
});

/**
 * Test Connection: ONE read-only certification probe per network, the lightest one that proves
 * the credentials are accepted. Impact has no probe yet, so it cannot be tested (or resumed) here.
 */
export const CONNECTION_TEST_PROBES = Object.freeze({
  optimise_sea: Object.freeze({ network: "optimise", region: "sea", sourceObject: "campaigns" }),
  optimise_mena: Object.freeze({ network: "optimise", region: "mena", sourceObject: "campaigns" }),
  optimise_uk: Object.freeze({ network: "optimise", region: "uk", sourceObject: "campaigns" }),
  boostiny: Object.freeze({ network: "boostiny", sourceObject: "campaigns" }),
  trackier: Object.freeze({ network: "trackier", sourceObject: "profile" }),
  awin: Object.freeze({ network: "awin", sourceObject: "campaigns" }),
  partnerize: Object.freeze({ network: "partnerize", sourceObject: "authenticate" }),
});

/** The campaign source object an initial sync runs, per platform. */
export const INITIAL_SYNC_SOURCE = Object.freeze({
  optimise_sea: "campaigns",
  optimise_mena: "campaigns",
  optimise_uk: "campaigns",
  boostiny: "campaigns",
  trackier: "campaigns",
  awin: "programmes",
  partnerize: "campaigns",
});

const ACCOUNT_LABEL_RE = /^[a-z0-9_-]{1,40}$/;
const MAX_REASON = 200;

export class ConnectionError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = "ConnectionError";
    this.status = status;
    this.statusCode = status;
    this.code = code;
    this.extra = extra;
  }
}

function assertKnownKeys(body, allowed) {
  const input = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const unexpected = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unexpected.length) {
    throw new ConnectionError(400, "unsupported_fields", `Unsupported field(s): ${unexpected.join(", ")}`);
  }
  return input;
}

function parseSwitches(value, { partial }) {
  if (value === undefined) return partial ? {} : { ...NEW_CONNECTION_SWITCHES };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConnectionError(400, "invalid_switches", "switches must be an object of booleans.");
  }
  const out = partial ? {} : { ...NEW_CONNECTION_SWITCHES };
  for (const [key, flag] of Object.entries(value)) {
    if (!CONNECTION_SWITCHES.includes(key)) {
      throw new ConnectionError(400, "invalid_switches", `Unknown switch: ${key}`);
    }
    if (typeof flag !== "boolean") throw new ConnectionError(400, "invalid_switches", `${key} must be a boolean.`);
    out[key] = flag;
  }
  return out;
}

function parseProvider(value) {
  const provider = String(value ?? "").trim().toLowerCase();
  if (!Object.values(CREDENTIAL_PROVIDER_NAMES).includes(provider)) {
    throw new ConnectionError(400, "invalid_provider", `credentialProvider must be one of: ${Object.values(CREDENTIAL_PROVIDER_NAMES).join(", ")}.`);
  }
  if (!registeredCredentialProviders().includes(provider)) {
    throw new ConnectionError(422, "provider_not_configured", "That credential provider is not configured in this deployment.");
  }
  return provider;
}

function parseReason(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ConnectionError(400, "invalid_reason", "reason must be a string.");
  return value.trim().slice(0, MAX_REASON) || null;
}

/** Value-free audit snapshot of a connection row. */
function snapshot(row) {
  if (!row) return null;
  const { lastSyncError, ...dto } = toNetworkConnectionDto(row);
  return { ...dto, hasSyncError: Boolean(lastSyncError) };
}

/** Summarise a certification result for storage: categories and counts, never values or text. */
export function summariseTestResult(certification, probe) {
  const rows = Array.isArray(certification?.results) ? certification.results : [];
  const entry = rows.find((r) => r?.sourceObject === probe.sourceObject) ?? rows[0] ?? null;
  const ok = Boolean(entry?.ok);
  const supplierStatusCode = Number.isInteger(entry?.supplierStatusCode) ? entry.supplierStatusCode : null;
  return {
    status: ok ? TEST_STATUS.PASSED : TEST_STATUS.FAILED,
    result: {
      network: probe.network,
      region: probe.region ?? null,
      sourceObject: probe.sourceObject,
      ok,
      statusCategory: entry?.statusCategory ?? (entry ? null : "NO_RESULT"),
      supplierStatusCode,
      sampleCount: Number.isFinite(entry?.sampleCount) ? entry.sampleCount : 0,
      readOnly: true,
    },
    authFailed: supplierStatusCode === 401 || supplierStatusCode === 403,
  };
}

export class NetworkConnectionService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? defaultPrisma;
    this.audit = deps.audit ?? defaultAudit;
    this.now = deps.now ?? (() => new Date());
    // (network, options) => certification result. Lazily defaults to the live certification probe.
    this.certify = deps.certify ?? null;
    // ({ platform, accountLabel, sourceObject }) => { runId, created, ... }. Injected by the controller.
    this.startScopedRun = deps.startScopedRun ?? null;
    this.resolveSlots = deps.resolveSlots ?? resolveCredentialSlots;
  }

  catalog() {
    return {
      platforms: listCredentialPlatforms().map((platform) => {
        const profile = credentialProfile(platform);
        return {
          platform,
          authType: profile.authType,
          // Slot NAMES and whether they are required. Never a variable name or a secret id.
          credentialSlots: Object.entries(profile.slots).map(([slot, def]) => ({ slot, required: Boolean(def.required) })),
          testable: Boolean(CONNECTION_TEST_PROBES[platform]),
          initialSyncSource: INITIAL_SYNC_SOURCE[platform] ?? null,
        };
      }),
      credentialProviders: registeredCredentialProviders(),
      switches: [...CONNECTION_SWITCHES],
      newConnectionDefaults: { ...NEW_CONNECTION_SWITCHES, paused: true, pausedReason: PAUSE_REASON.PENDING_ACTIVATION },
    };
  }

  async list() {
    const rows = await this.db.marketplaceAccount.findMany({ orderBy: [{ platform: "asc" }, { accountLabel: "asc" }] });
    return rows.map(toNetworkConnectionDto);
  }

  async get(id) {
    const row = await this.#find(id);
    return toNetworkConnectionDto(row);
  }

  async #find(id) {
    if (typeof id !== "string" || !id || id.length > 64) throw new ConnectionError(404, "connection_not_found", "Connection not found.");
    const row = await this.db.marketplaceAccount.findUnique({ where: { id } });
    if (!row) throw new ConnectionError(404, "connection_not_found", "Connection not found.");
    return row;
  }

  #providerManaged(row) {
    if (row.credentialSource !== CREDENTIAL_SOURCE.PROVIDER_REF || !parseSecretRef(row.secretRef)) {
      throw new ConnectionError(409, "connection_not_provider_managed", "This connection stores encrypted credentials and is managed by the legacy connect flow.");
    }
  }

  async #record(action, { before, after, actor, reason = null, metadata = null }) {
    await this.audit.record({
      aggregateType: CONNECTION_AUDIT_TYPE,
      aggregateId: after?.id ?? before?.id ?? null,
      action,
      actorId: actor?.id ?? null,
      actorEmail: actor?.email ?? null,
      before: snapshot(before),
      after: snapshot(after),
      reason,
      metadata,
    });
  }

  async create(body, { actor } = {}) {
    const input = assertKnownKeys(body, ["platform", "accountLabel", "environment", "credentialProvider", "switches"]);
    const platform = String(input.platform ?? "").trim().toLowerCase();
    const profile = credentialProfile(platform);
    if (!profile) throw new ConnectionError(400, "platform_not_allowed", "This network has no credential allow-list entry.");
    const accountLabel = String(input.accountLabel ?? "default").trim().toLowerCase() || "default";
    if (!ACCOUNT_LABEL_RE.test(accountLabel)) throw new ConnectionError(400, "invalid_account_label", "accountLabel must be 1-40 of a-z, 0-9, _ or -.");
    const envRaw = String(input.environment ?? "PRODUCTION").trim().toUpperCase();
    if (!["PRODUCTION", "SANDBOX"].includes(envRaw)) throw new ConnectionError(400, "invalid_environment", "environment must be PRODUCTION or SANDBOX.");
    const environment = normalizeEnvironment(envRaw);
    const provider = parseProvider(input.credentialProvider);
    // The env provider holds exactly one credential set per platform, so it backs one connection.
    if (provider === CREDENTIAL_PROVIDER_NAMES.ENV && accountLabel !== "default") {
      throw new ConnectionError(400, "env_provider_single_account", "The env credential provider supports only the \"default\" account label.");
    }
    const switches = parseSwitches(input.switches, { partial: false });

    let secretRef;
    try {
      secretRef = buildSecretRef({ provider, platform, accountLabel, environment });
    } catch (error) {
      if (error instanceof CredentialResolutionError) throw new ConnectionError(400, error.code, error.message);
      throw error;
    }

    const existing = await this.db.marketplaceAccount.findUnique({
      where: { platform_accountLabel: { platform, accountLabel } },
      select: { id: true },
    });
    if (existing) throw new ConnectionError(409, "connection_exists", "A connection already exists for this network and account label.");

    const now = this.now();
    let row;
    try {
      row = await this.db.marketplaceAccount.create({
        data: {
          platform,
          accountLabel,
          authType: profile.authType,
          environment,
          credentialSource: CREDENTIAL_SOURCE.PROVIDER_REF,
          secretRef,
          encryptedAccessToken: null,
          encryptedRefreshToken: null,
          maskedApiKey: null,
          credentialHealth: CREDENTIAL_HEALTH.UNKNOWN,
          pausedAt: now,
          pausedReason: PAUSE_REASON.PENDING_ACTIVATION,
          connectedAt: now,
          ...switches,
        },
      });
    } catch (error) {
      // A concurrent create for the same platform + label lost the unique-constraint race.
      if (error?.code === "P2002") {
        throw new ConnectionError(409, "connection_exists", "A connection already exists for this network and account label.");
      }
      throw error;
    }
    await this.#record("network_connection.create", { before: null, after: row, actor, metadata: { provider } });
    return toNetworkConnectionDto(row);
  }

  async update(id, body, { actor } = {}) {
    const input = assertKnownKeys(body, ["switches", "credentialProvider"]);
    const before = await this.#find(id);
    this.#providerManaged(before);
    const data = parseSwitches(input.switches, { partial: true });
    if (input.credentialProvider !== undefined) {
      const provider = parseProvider(input.credentialProvider);
      if (provider === CREDENTIAL_PROVIDER_NAMES.ENV && before.accountLabel !== "default") {
        throw new ConnectionError(400, "env_provider_single_account", "The env credential provider supports only the \"default\" account label.");
      }
      data.secretRef = buildSecretRef({ provider, platform: before.platform, accountLabel: before.accountLabel, environment: before.environment });
      if (data.secretRef !== before.secretRef) {
        // New credentials are unproven: health and the last test no longer describe them.
        Object.assign(data, { credentialHealth: CREDENTIAL_HEALTH.UNKNOWN, lastTestStatus: null, lastTestAt: null, lastTestResult: null });
      }
    }
    if (!Object.keys(data).length) throw new ConnectionError(400, "nothing_to_update", "Nothing to update.");
    const after = await this.db.marketplaceAccount.update({ where: { id }, data });
    await this.#record("network_connection.update", { before, after, actor });
    return toNetworkConnectionDto(after);
  }

  async pause(id, body, { actor } = {}) {
    const input = assertKnownKeys(body, ["reason"]);
    const reason = parseReason(input.reason);
    const before = await this.#find(id);
    if (before.pausedAt) return toNetworkConnectionDto(before);
    const after = await this.db.marketplaceAccount.update({
      where: { id },
      data: { pausedAt: this.now(), pausedReason: PAUSE_REASON.MANUAL },
    });
    await this.#record("network_connection.pause", { before, after, actor, reason });
    return toNetworkConnectionDto(after);
  }

  /** Resume requires a passing Test Connection since the credentials last changed. */
  async resume(id, body, { actor } = {}) {
    const input = assertKnownKeys(body, ["reason"]);
    const reason = parseReason(input.reason);
    const before = await this.#find(id);
    if (!before.pausedAt) return toNetworkConnectionDto(before);
    this.#providerManaged(before);
    if (before.lastTestStatus !== TEST_STATUS.PASSED) {
      throw new ConnectionError(409, "test_required", "Run Test Connection successfully before resuming this connection.");
    }
    if (before.lastFailureAt && before.lastTestAt && new Date(before.lastFailureAt) > new Date(before.lastTestAt)) {
      throw new ConnectionError(409, "test_required", "The connection failed after its last test; run Test Connection again before resuming.");
    }
    const after = await this.db.marketplaceAccount.update({ where: { id }, data: { pausedAt: null, pausedReason: null } });
    await this.#record("network_connection.resume", { before, after, actor, reason });
    return toNetworkConnectionDto(after);
  }

  /**
   * Test Connection: resolve the catalogued slots (no supplier call when a required one is
   * missing), then one read-only certification probe. Records the verdict on the connection.
   * Works while paused: testing is how a PENDING_ACTIVATION connection earns its resume.
   */
  async test(id, { actor } = {}) {
    const before = await this.#find(id);
    this.#providerManaged(before);
    const probe = CONNECTION_TEST_PROBES[before.platform];
    if (!probe) throw new ConnectionError(422, "test_unavailable", "No read-only test probe exists for this network yet.");

    const now = this.now();
    let summary;
    try {
      const { missingRequired } = await this.resolveSlots({
        platform: before.platform,
        accountLabel: before.accountLabel,
        environment: before.environment,
        secretRef: before.secretRef,
      });
      if (missingRequired.length) {
        summary = {
          status: TEST_STATUS.NOT_CONFIGURED,
          result: { network: probe.network, region: probe.region ?? null, sourceObject: probe.sourceObject, ok: false, statusCategory: "CREDENTIALS_MISSING", missingSlots: missingRequired, readOnly: true },
          authFailed: false,
        };
      }
    } catch (error) {
      summary = {
        status: TEST_STATUS.NOT_CONFIGURED,
        result: { network: probe.network, region: probe.region ?? null, sourceObject: probe.sourceObject, ok: false, statusCategory: "CREDENTIAL_REFERENCE_INVALID", code: error instanceof CredentialResolutionError ? error.code : "resolution_failed", readOnly: true },
        authFailed: false,
      };
    }

    if (!summary) {
      const certify = this.certify ?? (await defaultCertify());
      try {
        const certification = await certify(probe.network, {
          sourceObjects: [probe.sourceObject],
          region: probe.region ?? "sea",
          accountLabel: before.accountLabel,
          compareRaw: false,
        });
        summary = summariseTestResult(certification, probe);
      } catch (error) {
        const status = Number(error?.statusCode ?? error?.status);
        summary = {
          status: status === 424 ? TEST_STATUS.NOT_CONFIGURED : TEST_STATUS.FAILED,
          result: { network: probe.network, region: probe.region ?? null, sourceObject: probe.sourceObject, ok: false, statusCategory: status === 424 ? "CREDENTIALS_MISSING" : "PROBE_ERROR", readOnly: true },
          authFailed: false,
        };
      }
    }

    const passed = summary.status === TEST_STATUS.PASSED;
    const data = {
      lastTestAt: now,
      lastTestStatus: summary.status,
      lastTestResult: summary.result,
      lastAuthCheckAt: now,
      credentialHealth: passed
        ? CREDENTIAL_HEALTH.HEALTHY
        : summary.status === TEST_STATUS.NOT_CONFIGURED
          ? CREDENTIAL_HEALTH.NOT_CONFIGURED
          : summary.authFailed
            ? CREDENTIAL_HEALTH.FAILED
            : before.credentialHealth,
      ...(passed ? {} : { lastFailureAt: now, lastFailureCode: summary.authFailed ? `HTTP_${summary.result.supplierStatusCode}` : summary.result.statusCategory }),
    };
    const after = await this.db.marketplaceAccount.update({ where: { id }, data });
    await this.#record("network_connection.test", { before, after, actor, metadata: { status: summary.status, statusCategory: summary.result.statusCategory ?? null } });
    return { connection: toNetworkConnectionDto(after), test: { status: summary.status, ...summary.result } };
  }

  /**
   * Initial sync: a durable, campaigns-only run for this one connection. Refused unless the
   * connection is active (not paused), its campaign switch is on and its last test passed.
   */
  async initialSync(id, { actor } = {}) {
    const row = await this.#find(id);
    this.#providerManaged(row);
    const sourceObject = INITIAL_SYNC_SOURCE[row.platform];
    if (!sourceObject) throw new ConnectionError(422, "initial_sync_unavailable", "No bounded campaign source is planned for this network.");
    if (row.pausedAt) throw new ConnectionError(409, "connection_paused", "Resume the connection before starting its initial sync.");
    if (row.syncEnabled === false || row.campaignSyncEnabled === false) {
      throw new ConnectionError(409, "campaign_sync_disabled", "Campaign sync is switched off for this connection.");
    }
    if (row.lastTestStatus !== TEST_STATUS.PASSED) throw new ConnectionError(409, "test_required", "Run Test Connection successfully first.");
    if (typeof this.startScopedRun !== "function") throw new ConnectionError(503, "initial_sync_unavailable", "Initial sync is not available.");

    const run = await this.startScopedRun({ platform: row.platform, accountLabel: row.accountLabel, sourceObject });
    await this.#record("network_connection.initial_sync", {
      before: row,
      after: row,
      actor,
      metadata: { sourceObject, runId: run?.runId ?? null, created: Boolean(run?.created) },
    });
    return { connection: toNetworkConnectionDto(row), sourceObject, run };
  }
}

async function defaultCertify() {
  const { NetworkCertificationService } = await import("../ops/networkCertification.service.js");
  const service = new NetworkCertificationService();
  return (network, options) => service.certify(network, options);
}
