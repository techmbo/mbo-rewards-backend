/**
 * Pointer 26 — Evaluate production readiness for one network + source object.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mapPayload } from "../mapping/engine.js";
import {
  compileMappingRegistryFromFiles,
  dedupeCompiledRules,
} from "../mapping/mappingRegistry.compiler.js";
import {
  buildMappingVersionId,
  MAPPING_RULE_STATUS,
} from "../mapping/mappingRegistry.contract.js";
import {
  FIELD_MAPPING_OUTCOME,
  isValidFieldMappingOutcome,
  parseDeclaredOutcomeFromField,
  parseDeclaredOutcomeFromNotes,
} from "../mapping/mappingOutcome.contract.js";
import { assertClientSafeMboModel, toClientSafeMboModel } from "./pipeline/clientSafe.js";
import {
  fixtureBundleDir,
  loadAiIntegrationFixtureBundle,
} from "./aiAssistedDevelopment.contract.js";
import { resolveSequenceStage } from "./networkIntegrationSequence.js";
import { getSourceObject, networkFamily } from "./sourceObjects.catalog.js";
import {
  CONTRACT_POINTER,
  SOURCE_OBJECT_DONE_CRITERIA,
  SOURCE_OBJECT_DONE_STATUS,
  isAttributionApplicable,
  isReconciliationApplicable,
} from "./sourceObjectDefinitionOfDone.contract.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const MAPPINGS_ROOT = join(MODULE_DIR, "../../network-mappings");

function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function supplierCode(network) {
  const family = networkFamily(String(network || "").toLowerCase());
  return String(family || network || "").toUpperCase();
}

function mappingFilePath(network, sourceObject) {
  return join(MAPPINGS_ROOT, String(network || "").toLowerCase(), `${String(sourceObject || "").toLowerCase()}.mapping.json`);
}

function resultItem(criterion, status, { detail = null, blockers = [] } = {}) {
  return {
    key: criterion.key,
    label: criterion.label,
    description: criterion.description,
    status,
    detail,
    blockers: Array.isArray(blockers) ? blockers : [],
  };
}

function collectVerifyLiveItems(mappingDefinition = {}, manifestDone = {}) {
  const items = [];
  for (const field of mappingDefinition.fields || []) {
    const outcome =
      parseDeclaredOutcomeFromField(field) ||
      parseDeclaredOutcomeFromNotes(field.notes);
    if (outcome === FIELD_MAPPING_OUTCOME.VERIFY_LIVE && !field.productionBlocked) {
      items.push({
        targetField: field.targetField || null,
        sources: field.sources || field.sourcePath || null,
        productionBlocked: Boolean(field.productionBlocked),
      });
    }
  }
  for (const entry of manifestDone.verifyLiveItems || []) {
    if (entry?.outcome === FIELD_MAPPING_OUTCOME.VERIFY_LIVE && !entry.resolved && !entry.productionBlocked) {
      items.push(entry);
    }
  }
  return items;
}

function entityTypeForGuide(catalogEntry, sourceObject) {
  return catalogEntry?.entityType || resolveSequenceStage(sourceObject)?.stage || "campaign";
}

export class SourceObjectDefinitionOfDoneService {
  evaluate(network, sourceObject, { catalogEntry = null, bundle = null } = {}) {
    const family = String(network || "").toLowerCase();
    const obj = String(sourceObject || "").toLowerCase();
    const catalog = catalogEntry || getSourceObject(family, obj);
    const sequenceStage = resolveSequenceStage(obj, catalog?.entityType);
    const manifestDone = bundle?.manifest?.definitionOfDone || {};
    const criteria = [];
    let bundleError = null;

    let loadedBundle = bundle;
    if (!loadedBundle) {
      try {
        loadedBundle = loadAiIntegrationFixtureBundle(family, obj);
      } catch (error) {
        bundleError = error.message;
        loadedBundle = null;
      }
    }

    const supplier = supplierCode(family);
    const mappingPath = mappingFilePath(family, obj);
    const mappingDefinition = readJson(mappingPath);
    const observedSchemaPath = join(
      fixtureBundleDir(family, obj),
      manifestDone.observedSchemaFile || "schema.observed.json",
    );
    const observedSchema = readJson(observedSchemaPath);

    const mapContext = loadedBundle
      ? {
          supplier: loadedBundle.mappingRows?.supplier || supplier,
          resourceKey: loadedBundle.mappingRows?.resourceKey || obj,
          payload: loadedBundle.sourceFixture,
          expectedCanonical: loadedBundle.expectedCanonical,
        }
      : null;

    let mapResult = null;
    if (mapContext?.payload) {
      mapResult = mapPayload({
        supplier: mapContext.supplier,
        resourceKey: mapContext.resourceKey,
        payload: mapContext.payload,
      });
    }

    for (const criterion of SOURCE_OBJECT_DONE_CRITERIA) {
      if (criterion.applicability === "attribution") {
        if (!isAttributionApplicable({ sequenceStage, entityType: catalog?.entityType })) {
          criteria.push(
            resultItem(criterion, SOURCE_OBJECT_DONE_STATUS.NOT_APPLICABLE, {
              detail: "Not required for this source object stage.",
            }),
          );
          continue;
        }
        const attestation = manifestDone.tests?.attribution;
        criteria.push(
          resultItem(
            criterion,
            attestation?.status === "passed"
              ? SOURCE_OBJECT_DONE_STATUS.PASSED
              : SOURCE_OBJECT_DONE_STATUS.FAILED,
            {
              detail: attestation?.detail || "Attribution tests must be declared in fixture definitionOfDone.tests.attribution.",
              blockers: attestation?.status === "passed" ? [] : ["attribution_tests_missing"],
            },
          ),
        );
        continue;
      }

      if (criterion.applicability === "reconciliation") {
        if (!isReconciliationApplicable({ sequenceStage, entityType: catalog?.entityType })) {
          criteria.push(
            resultItem(criterion, SOURCE_OBJECT_DONE_STATUS.NOT_APPLICABLE, {
              detail: "Not required until finance/payment source objects.",
            }),
          );
          continue;
        }
        const attestation = manifestDone.tests?.reconciliation;
        criteria.push(
          resultItem(
            criterion,
            attestation?.status === "passed"
              ? SOURCE_OBJECT_DONE_STATUS.PASSED
              : SOURCE_OBJECT_DONE_STATUS.FAILED,
            {
              detail: attestation?.detail || "Reconciliation sample must be declared in fixture definitionOfDone.tests.reconciliation.",
              blockers: attestation?.status === "passed" ? [] : ["reconciliation_sample_missing"],
            },
          ),
        );
        continue;
      }

      switch (criterion.key) {
        case "source_fixture_captured": {
          const passed =
            Boolean(loadedBundle?.sourceFixture) &&
            typeof loadedBundle.sourceFixture === "object" &&
            Object.keys(loadedBundle.sourceFixture).length > 0;
          criteria.push(
            resultItem(
              criterion,
              passed ? SOURCE_OBJECT_DONE_STATUS.PASSED : SOURCE_OBJECT_DONE_STATUS.FAILED,
              {
                detail: passed
                  ? `Fixture captured at ${fixtureBundleDir(family, obj)}/`
                  : bundleError || "Missing fixture bundle or source.api.json.",
                blockers: passed ? [] : ["source_fixture_missing"],
              },
            ),
          );
          break;
        }
        case "raw_payload_retention_verified": {
          const passed = Boolean(mapResult?.sourceUnchanged);
          criteria.push(
            resultItem(
              criterion,
              passed ? SOURCE_OBJECT_DONE_STATUS.PASSED : SOURCE_OBJECT_DONE_STATUS.FAILED,
              {
                detail: passed
                  ? "Mapping engine leaves the source payload unchanged (sourceUnchanged=true)."
                  : "Source payload mutation detected or mapping could not run.",
                blockers: passed ? [] : ["raw_payload_not_retained"],
              },
            ),
          );
          break;
        }
        case "observed_schema_recorded": {
          const passed =
            Boolean(observedSchema?.paths?.length) ||
            Boolean(manifestDone.observedSchemaRecorded);
          criteria.push(
            resultItem(
              criterion,
              passed ? SOURCE_OBJECT_DONE_STATUS.PASSED : SOURCE_OBJECT_DONE_STATUS.FAILED,
              {
                detail: passed
                  ? `Observed schema recorded (${observedSchema?.paths?.length || 0} paths).`
                  : `Missing ${observedSchemaPath}.`,
                blockers: passed ? [] : ["observed_schema_missing"],
              },
            ),
          );
          break;
        }
        case "mapping_rules_versioned": {
          const versionId = buildMappingVersionId(
            supplier,
            obj,
            mappingDefinition?.mappingVersion || "1",
          );
          const rules = dedupeCompiledRules(compileMappingRegistryFromFiles());
          const activeRules = rules.filter(
            (rule) =>
              String(rule.network || "").toUpperCase() === supplier &&
              String(rule.sourceObject || "").toLowerCase() === obj &&
              rule.mappingStatus === MAPPING_RULE_STATUS.ACTIVE,
          );
          const passed = Boolean(mappingDefinition) && activeRules.length > 0;
          criteria.push(
            resultItem(
              criterion,
              passed ? SOURCE_OBJECT_DONE_STATUS.PASSED : SOURCE_OBJECT_DONE_STATUS.FAILED,
              {
                detail: passed
                  ? `${activeRules.length} active registry rules · version ${versionId}.`
                  : `Missing or inactive mapping registry at ${mappingPath}.`,
                blockers: passed ? [] : ["mapping_registry_missing"],
              },
            ),
          );
          break;
        }
        case "required_mbo_fields_populated": {
          const requiredFields = (loadedBundle?.mappingRows?.fields || mappingDefinition?.fields || []).filter(
            (field) => field.required,
          );
          const missing = [];
          if (mapResult?.success && mapContext?.expectedCanonical) {
            for (const field of requiredFields) {
              const expected = mapContext.expectedCanonical[field.targetField];
              const actual = mapResult.normalizedData?.[field.targetField];
              if (expected !== undefined && JSON.stringify(actual) !== JSON.stringify(expected)) {
                missing.push(field.targetField);
              }
            }
          } else if (!mapResult?.success) {
            missing.push("(mapping failed)");
          }
          const passed = mapResult?.success && missing.length === 0;
          criteria.push(
            resultItem(
              criterion,
              passed ? SOURCE_OBJECT_DONE_STATUS.PASSED : SOURCE_OBJECT_DONE_STATUS.FAILED,
              {
                detail: passed
                  ? "Required canonical fields match expected fixture output."
                  : `Required field gaps: ${missing.join(", ") || "unknown"}.`,
                blockers: passed ? [] : ["required_mbo_fields_incomplete"],
              },
            ),
          );
          break;
        }
        case "source_only_fields_retained": {
          const unmapped = mapResult?.unmappedOutcomes || [];
          const invalid = unmapped.filter(
            (entry) => entry.fieldMappingOutcome !== FIELD_MAPPING_OUTCOME.SOURCE_ONLY,
          );
          const passed = mapResult?.success && invalid.length === 0 && unmapped.length > 0;
          criteria.push(
            resultItem(
              criterion,
              passed ? SOURCE_OBJECT_DONE_STATUS.PASSED : SOURCE_OBJECT_DONE_STATUS.FAILED,
              {
                detail: passed
                  ? `${unmapped.length} unmapped path(s) retained as SOURCE_ONLY.`
                  : invalid.length
                    ? `Unmapped paths misclassified: ${invalid.map((e) => e.sourcePath).join(", ")}`
                    : "No source-only retention evidence in fixture map run.",
                blockers: passed ? [] : ["source_only_retention_failed"],
              },
            ),
          );
          break;
        }
        case "mapping_gaps_classified": {
          const defectCount = Number(mapResult?.engineeringDefectCount || 0);
          const invalidOutcomes = (mapResult?.unmappedOutcomes || []).filter(
            (entry) => !isValidFieldMappingOutcome(entry.fieldMappingOutcome),
          );
          const passed = mapResult?.success && defectCount === 0 && invalidOutcomes.length === 0;
          criteria.push(
            resultItem(
              criterion,
              passed ? SOURCE_OBJECT_DONE_STATUS.PASSED : SOURCE_OBJECT_DONE_STATUS.FAILED,
              {
                detail: passed
                  ? "No engineering-defect mapping outcomes detected."
                  : `${defectCount} engineering defect(s); ${invalidOutcomes.length} invalid outcome(s).`,
                blockers: passed ? [] : ["mapping_gaps_misclassified"],
              },
            ),
          );
          break;
        }
        case "duplicate_idempotency_tests": {
          let passed = false;
          let detail = "Idempotency check could not run.";
          if (mapContext?.payload) {
            const second = mapPayload({
              supplier: mapContext.supplier,
              resourceKey: mapContext.resourceKey,
              payload: mapContext.payload,
            });
            passed =
              mapResult?.success &&
              second.success &&
              JSON.stringify(mapResult.normalizedData) === JSON.stringify(second.normalizedData);
            detail = passed
              ? "Repeated mapping yields identical canonical output."
              : "Repeated mapping diverged or failed.";
          }
          criteria.push(
            resultItem(
              criterion,
              passed ? SOURCE_OBJECT_DONE_STATUS.PASSED : SOURCE_OBJECT_DONE_STATUS.FAILED,
              { detail, blockers: passed ? [] : ["idempotency_failed"] },
            ),
          );
          break;
        }
        case "null_conditional_field_tests": {
          let passed = false;
          let detail = "Null/conditional check could not run.";
          if (mapContext?.payload) {
            const optionalTarget = (loadedBundle?.mappingRows?.fields || []).find((field) => !field.required)?.targetField;
            const stripped = { ...mapContext.payload };
            if (optionalTarget) delete stripped.commissionCost;
            const conditional = mapPayload({
              supplier: mapContext.supplier,
              resourceKey: mapContext.resourceKey,
              payload: stripped,
            });
            passed = conditional.success;
            detail = passed
              ? "Optional/conditional source fields can be absent without breaking mapping."
              : "Mapping failed when optional source fields were removed.";
          }
          criteria.push(
            resultItem(
              criterion,
              passed ? SOURCE_OBJECT_DONE_STATUS.PASSED : SOURCE_OBJECT_DONE_STATUS.FAILED,
              { detail, blockers: passed ? [] : ["null_conditional_failed"] },
            ),
          );
          break;
        }
        case "status_update_tests": {
          let passed = false;
          let detail = "Status update check could not run.";
          if (mapContext?.payload) {
            const updated = mapPayload({
              supplier: mapContext.supplier,
              resourceKey: mapContext.resourceKey,
              payload: { ...mapContext.payload, status: "paused" },
            });
            passed = updated.success && updated.normalizedData?.campaignStatus === "paused";
            detail = passed
              ? "Updated source status maps to canonical campaignStatus."
              : "Status-bearing payload did not map to expected canonical status.";
          }
          criteria.push(
            resultItem(
              criterion,
              passed ? SOURCE_OBJECT_DONE_STATUS.PASSED : SOURCE_OBJECT_DONE_STATUS.FAILED,
              { detail, blockers: passed ? [] : ["status_update_failed"] },
            ),
          );
          break;
        }
        case "client_data_leakage_review": {
          let passed = false;
          let detail = "Client-safe review could not run.";
          if (mapResult?.success && mapContext?.payload) {
            try {
              const clientModel = toClientSafeMboModel(mapResult.normalizedData, {
                entityType: entityTypeForGuide(catalog, obj),
                sourceResponse: mapContext.payload,
              });
              assertClientSafeMboModel(clientModel, { sourceResponse: mapContext.payload });
              passed = true;
              detail = "Client-safe projection passes boundary review.";
            } catch (error) {
              detail = error.message;
            }
          }
          criteria.push(
            resultItem(
              criterion,
              passed ? SOURCE_OBJECT_DONE_STATUS.PASSED : SOURCE_OBJECT_DONE_STATUS.FAILED,
              { detail, blockers: passed ? [] : ["client_leakage_detected"] },
            ),
          );
          break;
        }
        case "verify_live_resolved": {
          const unresolved = collectVerifyLiveItems(mappingDefinition || {}, manifestDone);
          const passed = unresolved.length === 0;
          criteria.push(
            resultItem(
              criterion,
              passed ? SOURCE_OBJECT_DONE_STATUS.PASSED : SOURCE_OBJECT_DONE_STATUS.FAILED,
              {
                detail: passed
                  ? "No unresolved VERIFY_LIVE mapping items."
                  : `${unresolved.length} VERIFY_LIVE item(s) still exposed.`,
                blockers: passed ? [] : unresolved.map((item) => item.targetField || "verify_live"),
              },
            ),
          );
          break;
        }
        default:
          criteria.push(
            resultItem(criterion, SOURCE_OBJECT_DONE_STATUS.FAILED, {
              detail: "Unknown criterion.",
              blockers: ["unknown_criterion"],
            }),
          );
      }
    }

    const applicable = criteria.filter((item) => item.status !== SOURCE_OBJECT_DONE_STATUS.NOT_APPLICABLE);
    const passedCount = applicable.filter((item) => item.status === SOURCE_OBJECT_DONE_STATUS.PASSED).length;
    const blockers = applicable.flatMap((item) =>
      item.status === SOURCE_OBJECT_DONE_STATUS.PASSED ? [] : item.blockers,
    );

    return {
      contractPointer: CONTRACT_POINTER,
      network: family,
      sourceObject: obj,
      productionReady: applicable.length > 0 && passedCount === applicable.length,
      passedCount,
      applicableCount: applicable.length,
      totalCriteria: SOURCE_OBJECT_DONE_CRITERIA.length,
      blockers: [...new Set(blockers)],
      criteria,
    };
  }
}
