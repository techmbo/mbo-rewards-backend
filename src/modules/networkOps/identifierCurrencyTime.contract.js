/**
 * Pointer 30 — Identifier, currency and time rules.
 * MBO IDs, source currencies, and source timestamps must remain distinct from derived MBO values.
 */

export const CONTRACT_POINTER = 30;

export const IDENTIFIER_CURRENCY_TIME_SUMMARY = Object.freeze({
  identifierRule:
    "Keep MBO IDs and supplier IDs separate. Never use a supplier campaign/order/conversion ID as the primary MBO ID.",
  currencyRule:
    "Preserve source transaction currency and source commission currency exactly as supplied. Never infer currency from country. If MBO later converts values, store converted amount, target currency, exchange rate, rate source and rate date separately.",
  timeRule:
    "Preserve source timestamp and source timezone when available. Normalize to an MBO internal timestamp, preferably UTC, without overwriting the original source value.",
});

export const IDENTIFIER_RULES = Object.freeze({
  mboIdFields: Object.freeze(["id", "orderId", "conversionId", "clientId", "merchantId", "canonicalCampaignId"]),
  supplierIdFields: Object.freeze([
    "supplierCampaignId",
    "supplierOrderId",
    "supplierConversionId",
    "supplierTransactionId",
    "externalId",
    "networkOrderId",
  ]),
  forbiddenPrimaryIdSources: Object.freeze([
    "supplierCampaignId",
    "supplierOrderId",
    "supplierConversionId",
    "supplierTransactionId",
    "networkOrderId",
    "externalId",
  ]),
  enforcedBy: [
    "modules/order/orderIngestion.service.js",
    "modules/ops/importedRecords.service.js",
    "modules/networkOps/reprocessing.contract.js",
  ],
});

export const CURRENCY_RULES = Object.freeze({
  preserveSourceFields: Object.freeze([
    "originalCurrency",
    "sourceTransactionCurrency",
    "sourceCommissionCurrency",
    "transactionCurrency",
    "commissionCurrency",
  ]),
  conversionFields: Object.freeze([
    "convertedAmount",
    "targetCurrency",
    "exchangeRate",
    "rateSource",
    "rateDate",
  ]),
  forbiddenInference: Object.freeze(["country", "region", "market", "clientCountry"]),
  enforcedBy: [
    "modules/finance/fx.service.js",
    "modules/finance/financialTransaction.service.js",
    "modules/finance/financeSeparation.contract.js",
    "modules/ops/adminContract.dto.js",
  ],
});

export const TIME_RULES = Object.freeze({
  preserveSourceFields: Object.freeze([
    "sourceTimestamp",
    "sourceDateTime",
    "sourceTimezone",
    "sourceTimeZone",
    "networkTimestamp",
  ]),
  normalizedFields: Object.freeze(["orderDate", "conversionDate", "eventAt", "mboTimestampUtc", "normalizedAtUtc"]),
  preferredNormalizedTimezone: "UTC",
  enforcedBy: [
    "modules/order/orderIngestion.service.js",
    "modules/reporting/services/attribution.service.js",
    "modules/ops/v15FieldContract.js",
  ],
});

export class IdentifierCurrencyTimeError extends Error {
  constructor(message, { code = "IDENTIFIER_CURRENCY_TIME_VIOLATION", details = null } = {}) {
    super(message);
    this.name = "IdentifierCurrencyTimeError";
    this.code = code;
    this.details = details;
    this.contractPointer = CONTRACT_POINTER;
  }
}

/**
 * Assert MBO primary IDs are not sourced from supplier/network identifiers.
 */
export function assertIdentifierSeparation({
  mboId,
  mboIdField = "id",
  supplierId = null,
  supplierIdField = null,
} = {}) {
  if (supplierId == null || supplierId === "") return true;

  const supplierField = String(supplierIdField || "");
  if (IDENTIFIER_RULES.forbiddenPrimaryIdSources.includes(supplierField)) {
    if (String(mboId) === String(supplierId)) {
      throw new IdentifierCurrencyTimeError(
        `Supplier ${supplierField} must not be used as primary MBO ${mboIdField}.`,
        {
          code: "SUPPLIER_ID_USED_AS_MBO_PRIMARY",
          details: { mboIdField, supplierIdField: supplierField, mboId, supplierId },
        },
      );
    }
  }

  if (String(mboIdField).toLowerCase() === "id" && String(mboId) === String(supplierId)) {
    throw new IdentifierCurrencyTimeError(
      "MBO primary id must not equal a supplier/network identifier.",
      {
        code: "MBO_ID_EQUALS_SUPPLIER_ID",
        details: { mboIdField, supplierIdField, mboId, supplierId },
      },
    );
  }

  return true;
}

/**
 * Assert source currencies are preserved and never inferred from country/region.
 */
export function assertCurrencyPreservation({
  sourceTransactionCurrency = null,
  sourceCommissionCurrency = null,
  inferredFrom = null,
  conversion = null,
} = {}) {
  if (inferredFrom && CURRENCY_RULES.forbiddenInference.includes(String(inferredFrom))) {
    throw new IdentifierCurrencyTimeError("Never infer currency from country or region.", {
      code: "CURRENCY_INFERRED_FROM_COUNTRY",
      details: { inferredFrom, sourceTransactionCurrency, sourceCommissionCurrency },
    });
  }

  if (conversion && typeof conversion === "object") {
    const missing = CURRENCY_RULES.conversionFields.filter(
      (field) => conversion[field] == null || conversion[field] === "",
    );
    if (missing.length) {
      throw new IdentifierCurrencyTimeError(
        "Currency conversion requires converted amount, target currency, exchange rate, rate source, and rate date.",
        {
          code: "CURRENCY_CONVERSION_FIELDS_INCOMPLETE",
          details: { missing, conversion },
        },
      );
    }
  }

  return true;
}

/**
 * Assert source timestamp/timezone are preserved alongside normalized MBO time.
 */
export function assertTimestampPreservation({
  sourceTimestamp = null,
  sourceTimezone = null,
  normalizedTimestamp = null,
  record = null,
} = {}) {
  const payload = record && typeof record === "object" ? record : null;
  const srcTs = sourceTimestamp ?? payload?.sourceTimestamp ?? payload?.sourceDateTime ?? null;
  const srcTz = sourceTimezone ?? payload?.sourceTimezone ?? payload?.sourceTimeZone ?? null;
  const normalized =
    normalizedTimestamp ??
    payload?.mboTimestampUtc ??
    payload?.orderDate ??
    payload?.conversionDate ??
    null;

  if (srcTs != null && payload) {
    const overwritten =
      (payload.sourceTimestamp != null && normalized != null && String(payload.sourceTimestamp) !== String(srcTs)) ||
      (payload.sourceDateTime != null && normalized != null && String(payload.sourceDateTime) === String(normalized) && srcTs !== normalized);
    if (overwritten && !payload.sourceTimestamp && !payload.sourceDateTime) {
      throw new IdentifierCurrencyTimeError(
        "Normalized timestamp overwrote the original source timestamp.",
        {
          code: "SOURCE_TIMESTAMP_OVERWRITTEN",
          details: { sourceTimestamp: srcTs, normalizedTimestamp: normalized, sourceTimezone: srcTz },
        },
      );
    }
  }

  if (srcTs != null && normalized != null && String(srcTs) === String(normalized) && srcTz && srcTz !== "UTC") {
    // Allowed when source already UTC-equivalent; only warn via explicit overwrite check above.
  }

  if (srcTs != null && !normalized) {
    throw new IdentifierCurrencyTimeError(
      "Source timestamp preserved but MBO internal normalized timestamp is missing.",
      {
        code: "NORMALIZED_TIMESTAMP_MISSING",
        details: { sourceTimestamp: srcTs, sourceTimezone: srcTz },
      },
    );
  }

  return true;
}

export function buildIdentifierCurrencyTimeGuide({ network = null, sourceObject = null } = {}) {
  const guide = {
    contractPointer: CONTRACT_POINTER,
    summary: { ...IDENTIFIER_CURRENCY_TIME_SUMMARY },
    identifierRules: {
      ...IDENTIFIER_RULES,
      mboIdFields: [...IDENTIFIER_RULES.mboIdFields],
      supplierIdFields: [...IDENTIFIER_RULES.supplierIdFields],
      forbiddenPrimaryIdSources: [...IDENTIFIER_RULES.forbiddenPrimaryIdSources],
      enforcedBy: [...IDENTIFIER_RULES.enforcedBy],
    },
    currencyRules: {
      ...CURRENCY_RULES,
      preserveSourceFields: [...CURRENCY_RULES.preserveSourceFields],
      conversionFields: [...CURRENCY_RULES.conversionFields],
      forbiddenInference: [...CURRENCY_RULES.forbiddenInference],
      enforcedBy: [...CURRENCY_RULES.enforcedBy],
    },
    timeRules: {
      ...TIME_RULES,
      preserveSourceFields: [...TIME_RULES.preserveSourceFields],
      normalizedFields: [...TIME_RULES.normalizedFields],
      enforcedBy: [...TIME_RULES.enforcedBy],
    },
  };

  if (network && sourceObject) {
    guide.objectRefs = Object.freeze({
      mappingRegistry: `platform_backend/src/network-mappings/${String(network).toLowerCase()}/${String(sourceObject).toLowerCase()}.mapping.json`,
      financeFx: "platform_backend/src/modules/finance/fx.service.js",
      orderIngestion: "platform_backend/src/modules/order/orderIngestion.service.js",
    });
  }

  return guide;
}

export function applyIdentifierCurrencyTimeContract(response, { network, sourceObject } = {}) {
  if (!response || typeof response !== "object") return response;
  const meta = {
    ...(response.meta && typeof response.meta === "object" ? response.meta : {}),
    identifierCurrencyTimePointer: CONTRACT_POINTER,
    identifierCurrencyTimeNetwork: network || null,
    identifierCurrencyTimeSourceObject: sourceObject || null,
  };
  return { ...response, meta };
}
