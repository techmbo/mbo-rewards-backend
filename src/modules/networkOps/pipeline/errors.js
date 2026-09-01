export class PipelineError extends Error {
  constructor(code, message, extras = {}) {
    super(message);
    this.name = "PipelineError";
    this.code = code;
    this.stage = extras.stage ?? null;
    this.details = extras.details ?? null;
  }
}

export class PipelineSkipError extends PipelineError {
  constructor(stage, reason, details = null) {
    super(
      "PIPELINE_STAGE_SKIPPED",
      `Network pipeline must not skip stage ${stage}${reason ? `: ${reason}` : ""}`,
      { stage, details: details ?? { reason } },
    );
    this.name = "PipelineSkipError";
    this.reason = reason ?? "skipped";
  }
}

export class PipelineStageError extends PipelineError {
  constructor(stage, code, message, details = null) {
    super(code, message, { stage, details });
    this.name = "PipelineStageError";
  }
}

export class ClientModelLeakError extends PipelineError {
  constructor(message, details = null) {
    super(
      "CLIENT_MODEL_NETWORK_LEAK",
      message || "Client APIs must not receive network-shaped data",
      { stage: "EXPOSE_CLIENT_SAFE_MODEL", details },
    );
    this.name = "ClientModelLeakError";
  }
}
