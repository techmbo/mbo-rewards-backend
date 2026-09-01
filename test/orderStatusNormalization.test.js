/**
 * Pointer 16 / PR4 — source-scoped status normalization contract tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MBO_ORDER_STATUS,
  STATUS_MAPPING_STATUS,
  buildOrderStatusMetadata,
  mapMboOrderStatusToConversionStatus,
  mapMboOrderStatusToValidation,
  mapNetworkRawToSupplierPayment,
  preserveNetworkRawStatus,
  resolveOrderStatusFromNetworkRaw,
  resolveSupplierPaymentStatusFromNetworkRaw,
} from "../src/modules/order/orderStatusNormalization.contract.js";
import {
  mapConversionStatusToValidation,
  mapConversionStatusToSupplierPayment,
  mapLegacyConversionStatus,
} from "../src/modules/order/orderMerge.js";
import { mapEntityToConversionIngest } from "../src/modules/reporting/services/conversionPromotion.service.js";

const VERIFIED_FIXTURE_REGISTRY = [
  {
    supplier: "IMPACT",
    sourceObject: "ACTION",
    rawStatus: "APPROVED",
    mboOrderStatus: MBO_ORDER_STATUS.CONFIRMED,
    evidence: "test-fixture",
  },
  {
    supplier: "IMPACT",
    sourceObject: "ACTION",
    rawStatus: "REVERSED",
    mboOrderStatus: MBO_ORDER_STATUS.REJECTED,
    evidence: "test-fixture",
  },
  {
    supplier: "AWIN",
    sourceObject: "PAYMENT_REPORT",
    rawStatus: "PAID",
    supplierPaymentStatus: "PAYMENT_RECEIVED",
    evidence: "test-fixture",
  },
];

describe("Pointer 16 / PR4 — orderStatusNormalization.contract", () => {
  it("preserves network raw status casing and spacing", () => {
    assert.equal(preserveNetworkRawStatus("Approved"), "Approved");
    assert.equal(preserveNetworkRawStatus(" on hold "), " on hold ");
    assert.equal(preserveNetworkRawStatus(42), "42");
  });

  it("does not universally map contextless order statuses", () => {
    for (const raw of ["approved", "cancelled", "OPEN", "PAID", "INVOICED", "PAYABLE"]) {
      const resolution = resolveOrderStatusFromNetworkRaw(raw);
      assert.equal(resolution.mapped, false);
      assert.equal(resolution.mboOrderStatus, null);
      assert.equal(resolution.mappingExceptionRequired, true);
      assert.equal(resolution.mappingStatus, STATUS_MAPPING_STATUS.REVIEW_REQUIRED);
      assert.equal(resolution.mappingReason, "source_context_missing");
      assert.equal(resolution.networkRawStatus, raw);
    }
  });

  it("maps only an exact verified supplier + source object + raw status", () => {
    const resolution = resolveOrderStatusFromNetworkRaw("APPROVED", {
      supplier: "IMPACT",
      sourceObject: "ACTION",
      registry: VERIFIED_FIXTURE_REGISTRY,
    });

    assert.equal(resolution.mapped, true);
    assert.equal(resolution.mboOrderStatus, MBO_ORDER_STATUS.CONFIRMED);
    assert.equal(resolution.mappingStatus, STATUS_MAPPING_STATUS.MAPPED);
    assert.equal(resolution.mappingExceptionRequired, false);
  });

  it("does not cross-apply a verified mapping to another supplier or source object", () => {
    const wrongSupplier = resolveOrderStatusFromNetworkRaw("APPROVED", {
      supplier: "AWIN",
      sourceObject: "ACTION",
      registry: VERIFIED_FIXTURE_REGISTRY,
    });
    const wrongObject = resolveOrderStatusFromNetworkRaw("APPROVED", {
      supplier: "IMPACT",
      sourceObject: "PAYMENT_REPORT",
      registry: VERIFIED_FIXTURE_REGISTRY,
    });

    assert.equal(wrongSupplier.mapped, false);
    assert.equal(wrongSupplier.mappingReason, "source_status_mapping_not_verified");
    assert.equal(wrongObject.mapped, false);
    assert.equal(wrongObject.mappingReason, "source_status_mapping_not_verified");
  });

  it("keeps exact raw token semantics instead of case-folding source statuses", () => {
    const resolution = resolveOrderStatusFromNetworkRaw("approved", {
      supplier: "IMPACT",
      sourceObject: "ACTION",
      registry: VERIFIED_FIXTURE_REGISTRY,
    });
    assert.equal(resolution.mapped, false);
    assert.equal(resolution.networkRawStatus, "approved");
  });

  it("keeps supplier payment mapping independent from order validation", () => {
    const payment = resolveSupplierPaymentStatusFromNetworkRaw("PAID", {
      supplier: "AWIN",
      sourceObject: "PAYMENT_REPORT",
      registry: VERIFIED_FIXTURE_REGISTRY,
    });
    const order = resolveOrderStatusFromNetworkRaw("PAID", {
      supplier: "AWIN",
      sourceObject: "PAYMENT_REPORT",
      registry: VERIFIED_FIXTURE_REGISTRY,
    });

    assert.equal(payment.supplierPaymentStatus, "PAYMENT_RECEIVED");
    assert.equal(payment.mapped, true);
    assert.equal(order.mboOrderStatus, null);
    assert.equal(order.mapped, false);
    assert.equal(
      mapNetworkRawToSupplierPayment("PAID", {
        supplier: "AWIN",
        sourceObject: "PAYMENT_REPORT",
        registry: VERIFIED_FIXTURE_REGISTRY,
      }),
      "PAYMENT_RECEIVED",
    );
    assert.equal(mapNetworkRawToSupplierPayment("PAID"), null);
  });

  it("maps canonical order status to validation without guessing unknown raw values", () => {
    assert.equal(mapMboOrderStatusToValidation(MBO_ORDER_STATUS.CONFIRMED), "VALIDATION_APPROVED");
    assert.equal(mapMboOrderStatusToValidation(MBO_ORDER_STATUS.CANCELLED), "VALIDATION_REJECTED");
    assert.equal(mapConversionStatusToValidation("partially_approved"), "VALIDATION_NEEDS_REVIEW");
    assert.equal(mapConversionStatusToValidation("APPROVED"), "VALIDATION_APPROVED");
    assert.equal(mapConversionStatusToSupplierPayment("PAID"), null);
  });

  it("buildOrderStatusMetadata stores raw status and review provenance", () => {
    const meta = buildOrderStatusMetadata({}, {
      networkRawStatus: "Approved",
      mboOrderStatus: null,
      mappingExceptionRequired: true,
      mappingStatus: STATUS_MAPPING_STATUS.REVIEW_REQUIRED,
      mappingReason: "source_status_mapping_not_verified",
      supplier: "OPTIMISE",
      sourceObject: "CONVERSION",
      sourceReport: "TRANSACTION_REPORT",
    });
    assert.equal(meta.network_raw_status, "Approved");
    assert.equal(meta.mboOrderStatus, null);
    assert.equal(meta.statusMappingExceptionRequired, true);
    assert.equal(meta.statusMappingStatus, STATUS_MAPPING_STATUS.REVIEW_REQUIRED);
    assert.equal(meta.statusMappingSupplier, "OPTIMISE");
    assert.equal(meta.statusMappingSourceObject, "CONVERSION");
    assert.equal(meta.statusMappingSourceReport, "TRANSACTION_REPORT");
  });

  it("promotion preserves a raw status but does not guess order confirmation without proven source context", () => {
    const mapped = mapEntityToConversionIngest({
      id: "e1",
      networkSource: "optimise_sea",
      externalId: "optimise_sea-conversion-77",
      entityType: "conversion",
      commission: 10,
      rawData: {
        conversionId: 77,
        commission: 10,
        status: "Approved",
        conversionDate: "2026-08-01T00:00:00.000Z",
      },
      normalizedData: {},
    });
    assert.equal(mapped.ok, true);
    assert.equal(mapped.input.metadata.network_raw_status, "Approved");
    assert.equal(mapped.input.metadata.mboOrderStatus, null);
    assert.equal(mapped.input._order.statusMappingExceptionRequired, true);
    assert.equal(mapped.input.status, "UNKNOWN");
    assert.equal(mapped.input._order.networkRawStatus, "Approved");
  });

  it("promotion flags an unknown raw status for mapping review", () => {
    const mapped = mapEntityToConversionIngest({
      id: "e2",
      networkSource: "trackier",
      externalId: "trackier-conversion-88",
      entityType: "conversion",
      commission: 5,
      rawData: {
        id: 88,
        payout: 5,
        status: "AwaitingMerchantReview",
        conversion_date: "2026-08-01",
      },
      normalizedData: {},
    });
    assert.equal(mapped.ok, true);
    assert.equal(mapped.input.metadata.network_raw_status, "AwaitingMerchantReview");
    assert.equal(mapped.input.metadata.mboOrderStatus, null);
    assert.equal(mapped.input._order.statusMappingExceptionRequired, true);
    assert.equal(mapped.input.status, "UNKNOWN");
  });

  it("mapLegacyConversionStatus uses canonical CONFIRMED label", () => {
    assert.equal(mapLegacyConversionStatus("VALIDATION_APPROVED"), "CONFIRMED");
    assert.equal(mapLegacyConversionStatus("VALIDATION_NEEDS_REVIEW"), null);
  });

  it("maps mbo order status to conversion enum bridge", () => {
    assert.equal(mapMboOrderStatusToConversionStatus(MBO_ORDER_STATUS.CONFIRMED), "APPROVED");
    assert.equal(mapMboOrderStatusToConversionStatus(MBO_ORDER_STATUS.CANCELLED), "REJECTED");
  });
});
