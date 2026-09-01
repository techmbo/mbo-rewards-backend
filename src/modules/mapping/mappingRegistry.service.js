import { prisma } from "../../database/prisma.js";
import { runWithConcurrency } from "../../core/concurrency.js";
import {
  compileMappingRegistryFromFiles,
  dedupeCompiledRules,
} from "./mappingRegistry.compiler.js";
import { getSourceObject } from "../networkOps/sourceObjects.catalog.js";
import {
  buildMappingVersionId,
  inferMboTargetObject,
  MAPPING_RULE_STATUS,
  MAPPING_VERIFICATION_STATUS,
  normalizeMboCanonicalObject,
  normalizeRegistryNetwork,
  parseMappingVersionId,
  registryNetworkKey,
  toMappingRegistryRuleDto,
} from "./mappingRegistry.contract.js";
import {
  FIELD_MAPPING_OUTCOME,
  isEngineeringDefect,
} from "./mappingOutcome.contract.js";

const SYNC_CONCURRENCY = 25;

function sampleLookupKey(network, sourceObject, sourcePath) {
  return `${registryNetworkKey(network)}::${sourceObject}::${sourcePath}`;
}

async function loadFieldRegistrySamples(db, compiledRules) {
  const sourceObjects = [...new Set(compiledRules.map((r) => r.sourceObject))];
  if (!sourceObjects.length) return new Map();

  const rows = await db.fieldRegistry.findMany({
    where: { sourceObject: { in: sourceObjects } },
    select: {
      source: true,
      sourceObject: true,
      fieldPath: true,
      dataType: true,
      sampleValue: true,
    },
    take: 10000,
  });

  const sampleByKey = new Map();
  for (const row of rows) {
    const key = sampleLookupKey(row.source, row.sourceObject, row.fieldPath);
    if (!sampleByKey.has(key)) {
      sampleByKey.set(key, { sourceType: row.dataType, sampleRawValue: row.sampleValue });
    }
  }
  return sampleByKey;
}

function enrichRulesWithSamples(compiledRules, sampleByKey) {
  return compiledRules.map((rule) => {
    const key = sampleLookupKey(rule.network, rule.sourceObject, rule.sourcePath);
    const sample = sampleByKey.get(key);
    if (!sample) return rule;
    return {
      ...rule,
      sourceType: sample.sourceType || rule.sourceType,
      sampleRawValue: sample.sampleRawValue || rule.sampleRawValue,
      verificationStatus:
        rule.verificationStatus === MAPPING_VERIFICATION_STATUS.VERIFIED
          ? rule.verificationStatus
          : sample.sampleRawValue
            ? MAPPING_VERIFICATION_STATUS.NEEDS_REVIEW
            : rule.verificationStatus,
    };
  });
}

async function findMappingGaps(db, compiledRules) {
  const mappedKeys = new Set(
    compiledRules.map((r) => sampleLookupKey(r.network, r.sourceObject, r.sourcePath)),
  );

  const sourceObjects = [...new Set(compiledRules.map((r) => r.sourceObject))];
  if (!sourceObjects.length) return [];

  const observed = await db.fieldRegistry.findMany({
    where: { sourceObject: { in: sourceObjects } },
    select: {
      source: true,
      sourceObject: true,
      fieldPath: true,
      dataType: true,
      sampleValue: true,
    },
    take: 5000,
  });

  const gaps = [];
  for (const row of observed) {
    const key = sampleLookupKey(row.source, row.sourceObject, row.fieldPath);
    if (mappedKeys.has(key)) continue;
    const network = registryNetworkKey(row.source);
    const samplePresent =
      row.sampleValue != null && row.sampleValue !== "" && row.sampleValue !== "null";
    const fieldMappingOutcome = samplePresent
      ? FIELD_MAPPING_OUTCOME.SOURCE_PRESENT_MAPPING_MISSING
      : FIELD_MAPPING_OUTCOME.SOURCE_NULL;

    const catalogEntry = getSourceObject(row.source, row.sourceObject);

    gaps.push({
      network,
      networkAccountScope: "",
      networkProfile: "",
      sourceObject: row.sourceObject,
      endpointOrReport: catalogEntry?.endpoint ?? null,
      sourcePath: row.fieldPath,
      sourceType: row.dataType,
      sampleRawValue: row.sampleValue,
      mboTargetObject: inferMboTargetObject(row.sourceObject, null, {
        entityType: catalogEntry?.entityType ?? null,
      }),
      mboCanonicalField: "",
      transform: null,
      enumMap: undefined,
      fallbackSourcePaths: undefined,
      conditions: undefined,
      mappingStatus: MAPPING_RULE_STATUS.GAP,
      fieldMappingOutcome,
      mappingVersion: buildMappingVersionId(network, row.sourceObject, "gap"),
      definitionVersion: null,
      verificationStatus: row.sampleValue
        ? MAPPING_VERIFICATION_STATUS.NEEDS_REVIEW
        : MAPPING_VERIFICATION_STATUS.UNVERIFIED,
      sourceFile: null,
      required: false,
      ruleType: "Mapping Gap",
      notes: "Observed in source schema registry but no mapping rule exists.",
      lastSyncedAt: new Date(),
    });
  }
  return dedupeCompiledRules(gaps);
}

export async function syncMappingRegistry({ includeGaps = true } = {}, client = null) {
  const db = client ?? prisma;
  if (!db?.mappingRegistryRule?.upsert) {
    return { synced: 0, gaps: 0, skipped: true };
  }

  const compiled = dedupeCompiledRules(compileMappingRegistryFromFiles());
  const sampleByKey = await loadFieldRegistrySamples(db, compiled);
  const enriched = enrichRulesWithSamples(compiled, sampleByKey);
  const gaps = includeGaps ? await findMappingGaps(db, enriched) : [];
  const allRules = dedupeCompiledRules([...enriched, ...gaps]);
  const now = new Date();

  await runWithConcurrency(allRules, SYNC_CONCURRENCY, async (rule) => {
    await db.mappingRegistryRule.upsert({
      where: {
        network_sourceObject_sourcePath_mappingVersion_networkAccountScope_networkProfile: {
          network: rule.network,
          sourceObject: rule.sourceObject,
          sourcePath: rule.sourcePath,
          mappingVersion: rule.mappingVersion,
          networkAccountScope: rule.networkAccountScope || "",
          networkProfile: rule.networkProfile || "",
        },
      },
      create: {
        ...rule,
        enumMap: rule.enumMap ?? undefined,
        fallbackSourcePaths: rule.fallbackSourcePaths ?? undefined,
        conditions: rule.conditions ?? undefined,
        firstSyncedAt: now,
        lastSyncedAt: now,
      },
      update: {
        endpointOrReport: rule.endpointOrReport,
        sourceType: rule.sourceType,
        sampleRawValue: rule.sampleRawValue,
        mboTargetObject: rule.mboTargetObject,
        mboCanonicalField: rule.mboCanonicalField,
        transform: rule.transform,
        enumMap: rule.enumMap ?? undefined,
        fallbackSourcePaths: rule.fallbackSourcePaths ?? undefined,
        conditions: rule.conditions ?? undefined,
        mappingStatus: rule.mappingStatus,
        fieldMappingOutcome: rule.fieldMappingOutcome,
        definitionVersion: rule.definitionVersion,
        verificationStatus: rule.verificationStatus,
        sourceFile: rule.sourceFile,
        required: rule.required,
        ruleType: rule.ruleType,
        notes: rule.notes,
        lastSyncedAt: now,
      },
    });
  });

  return {
    synced: allRules.length,
    active: enriched.length,
    gaps: gaps.length,
    engineeringDefects: allRules.filter((r) => isEngineeringDefect(r.fieldMappingOutcome)).length,
    skipped: false,
  };
}

export async function listMappingRegistry(
  {
    network = null,
    sourceObject = null,
    mappingStatus = null,
    fieldMappingOutcome = null,
    mboTargetObject = null,
    mappingVersion = null,
    page = 1,
    pageSize = 50,
    autoSyncIfEmpty = true,
  } = {},
  client = null,
) {
  const db = client ?? prisma;
  if (!db?.mappingRegistryRule?.findMany) {
    return { rows: [], total: 0 };
  }

  if (autoSyncIfEmpty) {
    const count = await db.mappingRegistryRule.count();
    if (count === 0) {
      await syncMappingRegistry({ includeGaps: true }, db);
    }
  }

  const where = {
    ...(network ? { network: registryNetworkKey(network) } : {}),
    ...(sourceObject ? { sourceObject: String(sourceObject).toLowerCase() } : {}),
    ...(mappingStatus ? { mappingStatus: String(mappingStatus).toUpperCase() } : {}),
    ...(fieldMappingOutcome
      ? { fieldMappingOutcome: String(fieldMappingOutcome).toUpperCase() }
      : {}),
    ...(mboTargetObject
      ? { mboTargetObject: normalizeMboCanonicalObject(mboTargetObject) || String(mboTargetObject) }
      : {}),
    ...(mappingVersion ? { mappingVersion: String(mappingVersion) } : {}),
  };

  const [rows, total, engineeringDefects] = await Promise.all([
    db.mappingRegistryRule.findMany({
      where,
      orderBy: [
        { network: "asc" },
        { sourceObject: "asc" },
        { sourcePath: "asc" },
        { mappingVersion: "asc" },
      ],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.mappingRegistryRule.count({ where }),
    db.mappingRegistryRule.count({
      where: {
        ...where,
        fieldMappingOutcome: FIELD_MAPPING_OUTCOME.SOURCE_PRESENT_MAPPING_MISSING,
      },
    }),
  ]);

  return {
    rows: rows.map(toMappingRegistryRuleDto),
    total,
    engineeringDefects,
  };
}

export async function getMappingRegistryRule(id, client = null) {
  const db = client ?? prisma;
  const row = await db.mappingRegistryRule.findUnique({ where: { id } });
  return toMappingRegistryRuleDto(row);
}

export function resolveMappingContextFromVersion(mappingVersion) {
  return parseMappingVersionId(mappingVersion);
}
