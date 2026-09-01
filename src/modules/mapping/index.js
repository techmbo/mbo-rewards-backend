export { mapPayload, mapWithDefinition, loadMappingDefinition } from "./engine.js";
export { loadMappingDefinition as loadMapping, clearMappingCache, listMappingFiles } from "./loader.js";
export { applyTransform, registerTransform, TRANSFORM_NAMES } from "./transforms.js";
export { MappingReplayService, buildMappingReview } from "./replay.service.js";
export {
  buildMappingVersionId,
  parseMappingVersionId,
  resolveLoaderMappingVersion,
  MAPPING_RULE_STATUS,
  MAPPING_VERIFICATION_STATUS,
} from "./mappingRegistry.contract.js";
export {
  compileMappingRegistryFromFiles,
  dedupeCompiledRules,
} from "./mappingRegistry.compiler.js";
export {
  syncMappingRegistry,
  listMappingRegistry,
  getMappingRegistryRule,
} from "./mappingRegistry.service.js";
export {
  FIELD_MAPPING_OUTCOME,
  isEngineeringDefect,
  fieldMappingOutcomeLabel,
  normalizeFieldMappingOutcome,
} from "./mappingOutcome.contract.js";
export { attachFieldMappingOutcomes, enrichMapResult } from "./mappingOutcome.resolver.js";
export {
  MBO_CANONICAL_OBJECT,
  MBO_CANONICAL_OBJECT_LIST,
  inferMboTargetObject,
  mboCanonicalObjectLabel,
  normalizeMboCanonicalObject,
} from "./mboCanonicalObjects.contract.js";
