/**
 * MBO Rewards Network Operations — required runtime pipeline.
 *
 * Networks provide source facts. MBO owns the canonical standard.
 * Clients consume only the MBO standard.
 *
 * Never skip a stage. Never map a network response directly into the client API.
 */

export const PIPELINE_STAGES = Object.freeze([
  "FETCH_SOURCE",
  "STORE_RAW_PAYLOAD",
  "DETECT_SOURCE_SCHEMA",
  "APPLY_VERSIONED_MAPPING",
  "NORMALIZE_CANONICAL",
  "VALIDATE_MBO_STANDARD",
  "IDEMPOTENT_UPSERT",
  "RESOLVE_ATTRIBUTION",
  "APPLY_COMMERCIAL_RULES",
  "UPDATE_NETWORK_OPS",
  "RECONCILE_FINANCE",
  "EXPOSE_CLIENT_SAFE_MODEL",
]);

export const PIPELINE_STAGE_INDEX = Object.freeze(
  Object.fromEntries(PIPELINE_STAGES.map((stage, index) => [stage, index])),
);

export function previousPipelineStage(stage) {
  const index = PIPELINE_STAGE_INDEX[stage];
  if (index == null || index === 0) return null;
  return PIPELINE_STAGES[index - 1];
}

export function pipelineStagesBefore(stage) {
  const index = PIPELINE_STAGE_INDEX[stage];
  if (index == null || index <= 0) return [];
  return PIPELINE_STAGES.slice(0, index);
}
