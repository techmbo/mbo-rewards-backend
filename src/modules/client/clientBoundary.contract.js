/**
 * Pointer 23 — Client boundary contract.
 * Clients never consume raw Network Operations tables.
 *
 * Pipeline:
 *   Network Operations → MBO Canonical → Client Campaign Assignment
 *   → Client Commercial Rule → Client-safe API → Client Portal
 *
 * Adding a new network should normally touch only adapter, source registry,
 * credentials, source schema, mapping registry, and fixtures/tests — not the client API contract.
 */

import { CLIENT_CAMPAIGN_FORBIDDEN_KEYS } from "./dto/clientCampaignContract.06c.js";
import { CLIENT_PERFORMANCE_FORBIDDEN_KEYS } from "./dto/clientPerformance.dto.js";
import {
  FORBIDDEN_CLIENT_ORDER_KEYS,
  FORBIDDEN_CLIENT_PAYMENT_KEYS,
} from "./dto/clientReporting.dto.js";
import { CLIENT_FORBIDDEN_FINANCE_KEYS } from "../ops/adminContract.dto.js";
import { FORBIDDEN_CLIENT_PRODUCT_KEYS } from "../product/productFeed.service.js";

export const CONTRACT_POINTER = 23;

export const CLIENT_BOUNDARY_PIPELINE = Object.freeze([
  "NETWORK_OPS",
  "MBO_CANONICAL",
  "CLIENT_CAMPAIGN_ASSIGNMENT",
  "CLIENT_COMMERCIAL_RULE",
  "CLIENT_SAFE_API",
  "CLIENT_PORTAL",
]);

/** Layers a new network integration should change — not the client API contract. */
export const NETWORK_PLUG_IN_LAYERS = Object.freeze([
  { layer: "network_adapter", path: "platform_backend/src/adapters/" },
  { layer: "source_registry", path: "platform_backend/src/modules/networkOps/sourceObjects.catalog.js" },
  { layer: "credentials", path: "MarketplaceAccount / network credentials" },
  { layer: "source_schema", path: "GET /fields + RawPayload observation" },
  { layer: "mapping_registry", path: "platform_backend/src/modules/mapping/mappingRegistry.contract.js" },
  { layer: "fixtures_tests", path: "platform_backend/test/" },
]);

/** Prisma models / ops modules clients must never read directly. */
export const FORBIDDEN_CLIENT_SOURCES = Object.freeze([
  "Entity",
  "RawPayload",
  "ImportedRecords",
  "NetworkSyncRun",
  "ExceptionCase",
]);

/** Ops / network keys that must never appear in client API or portal responses. */
export const CLIENT_BOUNDARY_NETWORK_OPS_KEYS = Object.freeze([
  ...new Set([
    ...CLIENT_CAMPAIGN_FORBIDDEN_KEYS,
    ...CLIENT_PERFORMANCE_FORBIDDEN_KEYS,
    ...FORBIDDEN_CLIENT_ORDER_KEYS,
    ...FORBIDDEN_CLIENT_PAYMENT_KEYS,
    ...CLIENT_FORBIDDEN_FINANCE_KEYS,
    ...FORBIDDEN_CLIENT_PRODUCT_KEYS,
    "rawPayloadId",
    "sourceFields",
    "sourceData",
    "normalizedData",
    "lastSyncedData",
    "rawData",
    "entityType",
    "entityId",
    "networkSource",
    "networkAccount",
    "supplierTrackingLink",
    "networkTrackingLink",
    "supplierCampaignExtId",
    "mapperVersion",
    "mappingVersion",
    "mappingStatus",
    "openMapperErrorId",
    "commissionRuleSnapshot",
    "grossCommission",
    "mboCommission",
    "supplierCommission",
    "supplierReceivable",
    "mboMargin",
    "mboReceivable",
    "payload",
    "sourceResponse",
    "encryptedAccessToken",
    "encryptedRefreshToken",
    "applicationKey",
    "userApiKey",
    "accessToken",
    "refreshToken",
    "clientSecret",
    "authToken",
    "apiSecret",
  ]),
]);

/** Credential metadata keys forbidden even on portal credential surfaces. */
export const CLIENT_BOUNDARY_CREDENTIAL_FORBIDDEN_KEYS = Object.freeze(["keyHash", "keyEnc"]);

export const CLIENT_BOUNDARY_FORBIDDEN_KEYS = Object.freeze([
  ...new Set([
    ...CLIENT_BOUNDARY_NETWORK_OPS_KEYS,
    ...CLIENT_BOUNDARY_CREDENTIAL_FORBIDDEN_KEYS,
    "apiKey",
  ]),
]);

/** ClientCommissionRule fields allowed across the boundary (display only). */
export const CLIENT_COMMERCIAL_RULE_ALLOWED_KEYS = Object.freeze([
  "commission",
  "currency",
  "displayLabel",
  "displayRangeMin",
  "displayRangeMax",
  "isDisplayOnly",
  "commissionType",
  "effectiveFrom",
  "effectiveUntil",
]);

const NETWORK_OPS_KEY_SET = new Set(
  CLIENT_BOUNDARY_NETWORK_OPS_KEYS.map((k) => String(k).toLowerCase()),
);
const CREDENTIAL_FORBIDDEN_SET = new Set(
  CLIENT_BOUNDARY_CREDENTIAL_FORBIDDEN_KEYS.map((k) => String(k).toLowerCase()),
);
const FULL_FORBIDDEN_SET = new Set(
  CLIENT_BOUNDARY_FORBIDDEN_KEYS.map((k) => String(k).toLowerCase()),
);

export class ClientBoundaryLeakError extends Error {
  constructor(message, { keys = [], surface = null } = {}) {
    super(message || "Client boundary violation");
    this.name = "ClientBoundaryLeakError";
    this.code = "CLIENT_BOUNDARY_LEAK";
    this.keys = keys;
    this.surface = surface;
    this.contractPointer = CONTRACT_POINTER;
  }
}

function collectLeakedKeys(value, found = new Set(), depth = 0, { blockedKeys = FULL_FORBIDDEN_SET, allowKeys = new Set() } = {}) {
  if (value == null || typeof value !== "object" || depth > 8) return found;
  if (Array.isArray(value)) {
    for (const item of value) collectLeakedKeys(item, found, depth + 1, { blockedKeys, allowKeys });
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    const lower = String(key).toLowerCase();
    if (blockedKeys.has(lower) && !allowKeys.has(lower)) found.add(key);
    collectLeakedKeys(child, found, depth + 1, { blockedKeys, allowKeys });
  }
  return found;
}

/**
 * Assert a client API / portal response payload contains no network-ops leakage.
 * @param {object} options.allowKeys — e.g. ['apiKey'] on one-time credential issue/rotate
 * @param {boolean} options.credentialsOnly — scan credential forbidden keys only (keyHash)
 */
export function assertClientBoundaryPayload(payload, { surface = "client", allowKeys = [], credentialsOnly = false } = {}) {
  if (payload == null) return payload;
  const allow = new Set(allowKeys.map((k) => String(k).toLowerCase()));
  const blockedKeys = credentialsOnly ? CREDENTIAL_FORBIDDEN_SET : FULL_FORBIDDEN_SET;
  const leaked = [...collectLeakedKeys(payload, new Set(), 0, { blockedKeys, allowKeys: allow })];
  if (leaked.length) {
    throw new ClientBoundaryLeakError(
      `Client boundary leak on surface "${surface}": ${leaked.join(", ")}`,
      { keys: leaked, surface },
    );
  }
  return payload;
}

export function applyClientBoundaryContract(response, { surface = "client" } = {}) {
  if (!response || typeof response !== "object") return response;
  const meta = {
    ...(response.meta && typeof response.meta === "object" ? response.meta : {}),
    contractPointer: CONTRACT_POINTER,
    clientBoundarySurface: surface,
  };
  return { ...response, meta };
}

export function isForbiddenClientModuleImport(specifier = "") {
  const s = String(specifier).toLowerCase();
  return (
    s.includes("importedrecords") ||
    s.includes("imported-records") ||
    s.includes("rawpayload") ||
    s.includes("raw.service") ||
    s.includes("entities.controller") ||
    s.includes("allnetworkdata") ||
    s.includes("/ops/imported") ||
    s.includes("mappingreviewops") ||
    s.includes("syncrunops")
  );
}

export function scanClientModuleImports(sourceText = "") {
  const violations = [];
  const importRe = /from\s+["']([^"']+)["']/g;
  let match;
  while ((match = importRe.exec(sourceText)) !== null) {
    if (isForbiddenClientModuleImport(match[1])) {
      violations.push(match[1]);
    }
  }
  return violations;
}

/** Re-export for ingest pipeline — network ops keys only (no apiKey). */
export function assertClientSafeNetworkOpsKeys(model, context = {}) {
  const leaked = [...collectLeakedKeys(model, new Set(), 0, { blockedKeys: NETWORK_OPS_KEY_SET, allowKeys: new Set() })];
  if (leaked.length) {
    throw new ClientBoundaryLeakError(
      context.message || "Client model contains network or internal keys",
      { keys: leaked, surface: context.surface || "ingest" },
    );
  }
  return model;
}
