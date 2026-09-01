import { networkFamily } from "../networkOps/sourceObjects.catalog.js";
import {
  inferMboTargetObject,
  MBO_CANONICAL_OBJECT,
  MBO_CANONICAL_OBJECT_LIST,
  mboCanonicalObjectLabel,
  normalizeMboCanonicalObject,
} from "./mboCanonicalObjects.contract.js";

export {
  inferMboTargetObject,
  MBO_CANONICAL_OBJECT,
  MBO_CANONICAL_OBJECT_LIST,
  mboCanonicalObjectLabel,
  normalizeMboCanonicalObject,
};

export const MAPPING_RULE_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  DRAFT: "DRAFT",
  GAP: "GAP",
  DEPRECATED: "DEPRECATED",
});

export const MAPPING_VERIFICATION_STATUS = Object.freeze({
  VERIFIED: "VERIFIED",
  UNVERIFIED: "UNVERIFIED",
  NEEDS_REVIEW: "NEEDS_REVIEW",
});

const SUPPLIER_CODES = Object.freeze({
  OPTIMISE: "OPT",
  PARTNERIZE: "PAR",
  IMPACT: "IMP",
  TRACKIER: "TRK",
  BOOSTINY: "BST",
  AWIN: "AWN",
});

const SUPPLIER_FROM_CODE = Object.freeze(
  Object.fromEntries(Object.entries(SUPPLIER_CODES).map(([k, v]) => [v, k])),
);

const OBJECT_CODES = Object.freeze({
  campaigns: "CMP",
  conversions: "CONV",
  products: "PRD",
  coupons: "CPN",
  reporting: "RPT",
  payments: "PAY",
  programs: "PRG",
  actions: "ACT",
  catalogs: "CAT",
});

const OBJECT_FROM_CODE = Object.freeze(
  Object.fromEntries(Object.entries(OBJECT_CODES).map(([k, v]) => [v, k])),
);

export function normalizeRegistryNetwork(value) {
  return String(value || "").trim().toUpperCase();
}

/** Collapse optimise_sea / OPTIMISE to shared registry network key. */
export function registryNetworkKey(value) {
  const family = networkFamily(String(value || "").toLowerCase());
  return normalizeRegistryNetwork(family || value);
}

export function buildMappingVersionId(supplier, sourceObject, definitionVersion = "1") {
  const network = normalizeRegistryNetwork(supplier);
  const sup = SUPPLIER_CODES[network] || network.slice(0, 3);
  const objKey = String(sourceObject || "").trim().toLowerCase();
  const obj = OBJECT_CODES[objKey] || objKey.replace(/[^a-z0-9]/gi, "").slice(0, 4).toUpperCase() || "OBJ";
  const ver = String(definitionVersion || "1").trim();
  return `${sup}-${obj}-${ver}`;
}

/**
 * Resolve registry version id (OPT-CONV-1.3) to loader inputs.
 */
export function parseMappingVersionId(versionId) {
  const raw = String(versionId || "").trim();
  if (!raw.includes("-")) return null;
  const parts = raw.split("-");
  if (parts.length < 3) return null;
  const supCode = parts[0].toUpperCase();
  const objCode = parts[1].toUpperCase();
  const definitionVersion = parts.slice(2).join("-");
  const supplier = SUPPLIER_FROM_CODE[supCode] || supCode.toLowerCase();
  const sourceObject = OBJECT_FROM_CODE[objCode] || objCode.toLowerCase();
  return {
    supplier: supplier.toLowerCase(),
    resourceKey: sourceObject,
    definitionVersion,
    mappingVersion: raw,
  };
}

export function resolveLoaderMappingVersion(mappingVersion) {
  if (!mappingVersion) return null;
  const parsed = parseMappingVersionId(mappingVersion);
  if (parsed) return parsed.definitionVersion;
  return mappingVersion;
}

export function classifyRuleType(sourceObject, sourcePath, mboCanonicalField, transform) {
  const mbo = String(mboCanonicalField || "").toLowerCase();
  const raw = String(sourcePath || "").toLowerCase();
  const obj = String(sourceObject || "").toLowerCase();
  if (String(transform || "").toUpperCase() === "ENUM" || /status|state/.test(`${mbo}|${raw}`)) {
    return "Status Mapping";
  }
  if (/subid|clickref|pubref|tracking|uid2|uid/.test(`${mbo}|${raw}`) || obj.includes("track")) {
    return "Tracking Param";
  }
  return "Field Mapping";
}

export function inferVerificationStatus({ required, quality, notes, sampleRawValue, qa }) {
  const noteText = String(notes || "");
  if (qa || /verified|qa\s*yes|master:/i.test(noteText)) {
    return MAPPING_VERIFICATION_STATUS.VERIFIED;
  }
  if (required || String(quality || "").toUpperCase() === "REQUIRED") {
    return sampleRawValue
      ? MAPPING_VERIFICATION_STATUS.NEEDS_REVIEW
      : MAPPING_VERIFICATION_STATUS.UNVERIFIED;
  }
  return sampleRawValue
    ? MAPPING_VERIFICATION_STATUS.NEEDS_REVIEW
    : MAPPING_VERIFICATION_STATUS.UNVERIFIED;
}

export function toMappingRegistryRuleDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    network: row.network,
    networkSource: row.network,
    networkAccountScope: row.networkAccountScope || null,
    networkProfile: row.networkProfile || null,
    sourceObject: row.sourceObject,
    endpointOrReport: row.endpointOrReport,
    sourcePath: row.sourcePath,
    sourceFieldPath: row.sourcePath,
    sourceType: row.sourceType,
    sampleRawValue: row.sampleRawValue,
    observedExample: row.sampleRawValue,
    mboTargetObject: normalizeMboCanonicalObject(row.mboTargetObject) || row.mboTargetObject,
    mboCanonicalField: row.mboCanonicalField,
    mboField: row.mboCanonicalField,
    transform: row.transform,
    transformation: row.transform,
    enumMap: row.enumMap,
    fallbackSourcePaths: row.fallbackSourcePaths,
    fallback: Array.isArray(row.fallbackSourcePaths)
      ? row.fallbackSourcePaths.join(" | ")
      : null,
    conditions: row.conditions,
    mappingStatus: row.mappingStatus,
    fieldMappingOutcome: row.fieldMappingOutcome,
    mappingVersion: row.mappingVersion,
    definitionVersion: row.definitionVersion,
    verificationStatus: row.verificationStatus,
    evidenceStatus: row.verificationStatus,
    sourceFile: row.sourceFile,
    required: row.required,
    ruleType: row.ruleType,
    notes: row.notes,
    lastSyncedAt: row.lastSyncedAt,
    firstSyncedAt: row.firstSyncedAt,
  };
}
