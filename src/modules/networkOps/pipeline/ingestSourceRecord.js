import { persistRawPayload, resolveMapperVersion, resolveResourceKey } from "../../raw/rawPayload.service.js";
import { parseNetworkSource } from "../../supplier/entityIdentity.js";
import { loadMappingDefinition } from "../../mapping/loader.js";
import { mapPayload } from "../../mapping/engine.js";
import {
  hasJsMapper,
  mapEntityToSupplierCampaign,
  mapEntityToSupplierCoupon,
} from "../../supplier/mappers/index.js";
import { PipelineStageError } from "./errors.js";
import { runNetworkPipeline } from "./runPipeline.js";
import { toClientSafeMboModel } from "./clientSafe.js";

function notApplicable(reason) {
  return { applicable: false, summary: reason };
}

function cloneJson(value) {
  if (value == null) return value;
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function requireRawPayloadId(ctx, stage) {
  if (!ctx.values.rawPayloadId) {
    throw new PipelineStageError(
      stage,
      "RAW_PAYLOAD_REQUIRED",
      "Cannot continue pipeline without an immutable raw payload id",
    );
  }
}

function detectSchema({ supplier, resourceKey, entityType, mappingVersion = null }) {
  try {
    const definition = loadMappingDefinition(supplier, resourceKey, { version: mappingVersion });
    return {
      kind: "versioned_mapping",
      mappingVersion: String(definition.mappingVersion || mappingVersion || "1"),
      definition,
      resourceKey,
      supplier,
    };
  } catch (error) {
    if (hasJsMapper(supplier, entityType)) {
      return {
        kind: "js_mapper",
        mappingVersion: resolveMapperVersion(String(supplier).toLowerCase(), entityType),
        definition: null,
        resourceKey,
        supplier,
        fallbackReason: error?.code || error?.message,
      };
    }
    const err = new PipelineStageError(
      "DETECT_SOURCE_SCHEMA",
      "SOURCE_SCHEMA_UNKNOWN",
      `No versioned mapping or JS mapper for ${supplier}/${resourceKey}`,
      { supplier, resourceKey, entityType },
    );
    throw err;
  }
}

function buildSyntheticEntity({ networkSource, entityType, externalId, payload, mapped }) {
  return {
    id: null,
    entityType,
    networkSource,
    externalId,
    rawData: payload,
    normalizedData: mapped?.normalizedData ?? {},
    campaignName: mapped?.normalizedData?.campaignName ?? payload?.name ?? payload?.campaignName ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

async function normalizeCanonical({ entityType, networkSource, externalId, payload, mapped }) {
  const entity = buildSyntheticEntity({ networkSource, entityType, externalId, payload, mapped });
  const type = String(entityType || "").toLowerCase();

  if (type === "campaign") {
    return mapEntityToSupplierCampaign(entity);
  }
  if (type === "coupon") {
    return mapEntityToSupplierCoupon(entity);
  }
  if (type === "conversion") {
    const { mapEntityToConversionIngest } = await import(
      "../../reporting/services/conversionPromotion.service.js"
    );
    const result = mapEntityToConversionIngest(entity);
    if (!result?.ok) {
      throw new PipelineStageError(
        "NORMALIZE_CANONICAL",
        "CANONICAL_NORMALIZE_FAILED",
        result?.reason || "conversion mapping failed",
      );
    }
    return {
      ...result.input,
      ...(result.input?._order || {}),
    };
  }

  return {
    ...(mapped?.normalizedData || {}),
    entityType,
  };
}

function validateCanonical(canonical, entityType) {
  const type = String(entityType || "").toLowerCase();
  const missing = [];

  if (type === "campaign") {
    if (!canonical?.supplierCampaignId) missing.push("supplierCampaignId");
    if (!canonical?.campaignName) missing.push("campaignName");
  } else if (type === "coupon") {
    if (!canonical?.supplierCouponId && !canonical?.couponCode) missing.push("supplierCouponId");
  } else if (type === "conversion") {
    if (!canonical?.supplierConversionId) missing.push("supplierConversionId");
  }

  if (missing.length) {
    throw new PipelineStageError(
      "VALIDATE_MBO_STANDARD",
      "MBO_STANDARD_INVALID",
      `Canonical object missing required fields: ${missing.join(", ")}`,
      { missing },
    );
  }

  return { ok: true, missing };
}

function defaultHandlers(deps = {}) {
  const persist = deps.persistRawPayload ?? persistRawPayload;
  const upsert = deps.upsert ?? null;
  const resolveAttribution = deps.resolveAttribution ?? null;
  const applyCommercialRules = deps.applyCommercialRules ?? null;
  const updateNetworkOps = deps.updateNetworkOps ?? null;
  const reconcileFinance = deps.reconcileFinance ?? null;

  return {
    async FETCH_SOURCE(ctx) {
      const input = ctx.input || {};
      let source = input.sourceResponse;
      if (source == null && typeof input.fetch === "function") {
        source = await input.fetch();
      }
      if (source == null || typeof source !== "object") {
        throw new PipelineStageError(
          "FETCH_SOURCE",
          "SOURCE_RESPONSE_MISSING",
          "Network fetch produced no source response",
        );
      }
      ctx.values.sourceResponse = cloneJson(source);
      return { summary: "fetched" };
    },

    async STORE_RAW_PAYLOAD(ctx) {
      const {
        networkSource,
        entityType,
        externalId,
        mappingVersion = null,
        metadata = null,
      } = ctx.input;
      const payload = ctx.values.sourceResponse;
      if (payload == null) {
        throw new PipelineStageError(
          "STORE_RAW_PAYLOAD",
          "RAW_PAYLOAD_MISSING",
          "Source response missing before raw persist",
        );
      }

      const outcome = await persist({
        networkSource,
        entityType,
        externalId,
        payload,
        fetchedAt: ctx.input.fetchedAt ?? null,
        metadata,
        mapperVersion: mappingVersion,
        processingStatus: "RECEIVED",
        network: ctx.input.network ?? networkSource,
        networkAccountId: ctx.input.networkAccountId ?? null,
        sourceObject: ctx.input.sourceObject ?? metadata?.sourceObject ?? null,
        endpointOrReport: ctx.input.endpointOrReport ?? metadata?.endpoint ?? null,
        apiVersion: ctx.input.apiVersion ?? null,
        syncRunId: ctx.input.syncRunId ?? null,
        requestWindow: ctx.input.requestWindow ?? null,
        checkpoint: ctx.input.checkpoint ?? null,
        httpStatus: ctx.input.httpStatus ?? null,
        bodyKind: ctx.input.bodyKind ?? null,
        bodyRef: ctx.input.bodyRef ?? null,
        payloadText: ctx.input.payloadText ?? null,
      });

      const record = outcome?.record ?? null;
      if (!record?.id) {
        throw new PipelineStageError(
          "STORE_RAW_PAYLOAD",
          "RAW_PAYLOAD_REQUIRED",
          "Immutable raw payload was not stored",
          { skipped: outcome?.skipped ?? false, error: outcome?.error ?? null },
        );
      }

      ctx.values.rawPayloadId = record.id;
      ctx.values.rawPayload = record;
      return {
        summary: outcome.duplicate ? "duplicate" : "stored",
        rawPayloadId: record.id,
      };
    },

    async DETECT_SOURCE_SCHEMA(ctx) {
      requireRawPayloadId(ctx, "DETECT_SOURCE_SCHEMA");
      const { networkSource, entityType, mappingVersion = null } = ctx.input;
      const { supplier } = parseNetworkSource(networkSource);
      const resourceKey = resolveResourceKey(entityType, ctx.input.metadata);
      const schema = detectSchema({
        supplier,
        resourceKey,
        entityType,
        mappingVersion,
      });
      ctx.values.schema = schema;
      return {
        summary: schema.kind,
        mappingVersion: schema.mappingVersion,
      };
    },

    async APPLY_VERSIONED_MAPPING(ctx) {
      requireRawPayloadId(ctx, "APPLY_VERSIONED_MAPPING");
      const schema = ctx.values.schema;
      const payload = ctx.values.sourceResponse;

      if (schema?.kind === "versioned_mapping" && schema.definition) {
        const mapped = mapPayload({
          supplier: schema.supplier,
          resourceKey: schema.resourceKey,
          payload,
          mappingVersion: schema.mappingVersion,
          definition: schema.definition,
        });
        if (!mapped.success) {
          throw new PipelineStageError(
            "APPLY_VERSIONED_MAPPING",
            mapped.errors?.[0]?.code || "MAPPING_FAILED",
            "Versioned network mapping failed",
            { errors: mapped.errors, warnings: mapped.warnings },
          );
        }
        ctx.values.mapped = mapped;
        return { summary: "mapped", mappingVersion: mapped.mappingVersion || schema.mappingVersion };
      }

      ctx.values.mapped = {
        success: true,
        kind: "js_mapper",
        mappingVersion: schema?.mappingVersion ?? null,
        normalizedData: {},
      };
      return { summary: "js_mapper", mappingVersion: schema?.mappingVersion ?? null };
    },

    async NORMALIZE_CANONICAL(ctx) {
      requireRawPayloadId(ctx, "NORMALIZE_CANONICAL");
      const { networkSource, entityType, externalId } = ctx.input;
      const canonical = await normalizeCanonical({
        entityType,
        networkSource,
        externalId,
        payload: ctx.values.sourceResponse,
        mapped: ctx.values.mapped,
      });
      if (!canonical || typeof canonical !== "object") {
        throw new PipelineStageError(
          "NORMALIZE_CANONICAL",
          "CANONICAL_NORMALIZE_FAILED",
          "Mapping did not produce an MBO canonical object",
        );
      }
      if (canonical === ctx.values.sourceResponse) {
        throw new PipelineStageError(
          "NORMALIZE_CANONICAL",
          "CANONICAL_IS_SOURCE",
          "Canonical object must not be the network source response",
        );
      }
      ctx.values.canonical = canonical;
      return { summary: entityType };
    },

    async VALIDATE_MBO_STANDARD(ctx) {
      requireRawPayloadId(ctx, "VALIDATE_MBO_STANDARD");
      ctx.values.validation = validateCanonical(ctx.values.canonical, ctx.input.entityType);
      return { summary: "valid" };
    },

    async IDEMPOTENT_UPSERT(ctx) {
      requireRawPayloadId(ctx, "IDEMPOTENT_UPSERT");
      if (typeof upsert !== "function") return notApplicable("upsert_not_wired");
      ctx.values.upsert = await upsert(ctx);
      return { summary: ctx.values.upsert?.result ?? "upserted" };
    },

    async RESOLVE_ATTRIBUTION(ctx) {
      requireRawPayloadId(ctx, "RESOLVE_ATTRIBUTION");
      if (typeof resolveAttribution !== "function") return notApplicable("attribution_not_wired");
      ctx.values.attribution = await resolveAttribution(ctx);
      return { summary: ctx.values.attribution?.attributionStatus ?? "resolved" };
    },

    async APPLY_COMMERCIAL_RULES(ctx) {
      requireRawPayloadId(ctx, "APPLY_COMMERCIAL_RULES");
      if (typeof applyCommercialRules !== "function") return notApplicable("commercial_not_wired");
      ctx.values.commercial = await applyCommercialRules(ctx);
      return { summary: "applied" };
    },

    async UPDATE_NETWORK_OPS(ctx) {
      requireRawPayloadId(ctx, "UPDATE_NETWORK_OPS");
      if (typeof updateNetworkOps !== "function") return notApplicable("network_ops_not_wired");
      ctx.values.networkOps = await updateNetworkOps(ctx);
      return { summary: "updated" };
    },

    async RECONCILE_FINANCE(ctx) {
      requireRawPayloadId(ctx, "RECONCILE_FINANCE");
      if (typeof reconcileFinance !== "function") return notApplicable("finance_not_wired");
      ctx.values.finance = await reconcileFinance(ctx);
      return { summary: "reconciled" };
    },

    async EXPOSE_CLIENT_SAFE_MODEL(ctx) {
      requireRawPayloadId(ctx, "EXPOSE_CLIENT_SAFE_MODEL");
      ctx.values.clientModel = toClientSafeMboModel(ctx.values.canonical, {
        entityType: ctx.input.entityType,
        sourceResponse: ctx.values.sourceResponse,
      });
      return { summary: "client_safe" };
    },
  };
}

/**
 * Process one fetched network record through the required runtime pipeline.
 * Mapping, canonicalization, and the client model never run without a raw payload id.
 */
export async function ingestSourceRecord(input, deps = {}) {
  const ctx = await runNetworkPipeline({
    handlers: { ...defaultHandlers(deps), ...(deps.handlers || {}) },
    input,
  });
  return {
    rawPayloadId: ctx.values.rawPayloadId,
    schema: ctx.values.schema,
    mapped: ctx.values.mapped,
    canonical: ctx.values.canonical,
    clientModel: ctx.values.clientModel,
    completed: [...ctx.completed],
    evidence: ctx.evidence,
    durationMs: ctx.durationMs,
    values: ctx.values,
  };
}

export { defaultHandlers };
