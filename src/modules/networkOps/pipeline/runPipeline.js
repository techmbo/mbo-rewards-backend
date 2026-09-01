import { PIPELINE_STAGES, PIPELINE_STAGE_INDEX, pipelineStagesBefore } from "./stages.js";
import { PipelineSkipError, PipelineStageError } from "./errors.js";

function createContext(input = {}) {
  const completed = [];
  const evidence = {};
  const values = {
    sourceResponse: input.sourceResponse ?? null,
    rawPayloadId: null,
    rawPayload: null,
    schema: null,
    mapped: null,
    canonical: null,
    validation: null,
    upsert: null,
    attribution: null,
    commercial: null,
    networkOps: null,
    finance: null,
    clientModel: null,
  };

  return {
    input,
    values,
    completed,
    evidence,
    startedAt: Date.now(),
    hasCompleted(stage) {
      return completed.includes(stage);
    },
    requireCompleted(stage) {
      if (!this.hasCompleted(stage)) {
        throw new PipelineSkipError(stage, "stage_not_completed");
      }
    },
    requirePriorStages(stage) {
      for (const prior of pipelineStagesBefore(stage)) {
        this.requireCompleted(prior);
      }
    },
  };
}

function assertKnownStage(stage) {
  if (PIPELINE_STAGE_INDEX[stage] == null) {
    throw new PipelineStageError(stage, "PIPELINE_UNKNOWN_STAGE", `Unknown pipeline stage: ${stage}`);
  }
}

/**
 * Run the Network Operations pipeline in contract order.
 *
 * Every stage in PIPELINE_STAGES must have a handler. A handler may return
 * `{ applicable: false }` when the record type does not use that stage
 * (the stage still ran). Returning `{ skip: true }` or omitting a handler
 * is a contract violation.
 *
 * @param {{ handlers: Record<string, Function>, input?: object }} options
 */
export async function runNetworkPipeline({ handlers = {}, input = {} } = {}) {
  const ctx = createContext(input);

  for (const stage of PIPELINE_STAGES) {
    assertKnownStage(stage);
    ctx.requirePriorStages(stage);

    const handler = handlers[stage];
    if (typeof handler !== "function") {
      throw new PipelineSkipError(stage, "handler_missing");
    }

    let result;
    try {
      result = await handler(ctx);
    } catch (error) {
      if (error instanceof PipelineSkipError || error instanceof PipelineStageError) {
        throw error;
      }
      throw new PipelineStageError(
        stage,
        error?.code || "PIPELINE_STAGE_FAILED",
        error?.message || String(error),
        { cause: error },
      );
    }

    if (result?.skip === true) {
      throw new PipelineSkipError(stage, result.reason || "handler_requested_skip", result);
    }

    ctx.completed.push(stage);
    ctx.evidence[stage] = {
      applicable: result?.applicable !== false,
      at: Date.now(),
      summary: result?.summary ?? null,
    };
  }

  ctx.finishedAt = Date.now();
  ctx.durationMs = ctx.finishedAt - ctx.startedAt;
  return ctx;
}

export { createContext };
