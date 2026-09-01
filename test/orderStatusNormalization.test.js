/**
 * Pointer 16 — Status normalization contract tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MBO_ORDER_STATUS,
  buildOrderStatusMetadata,
  mapMboOrderStatusToConversionStatus,
  mapMboOrderStatusToValidation,
  mapNetworkRawToSupplierPayment,
  preserveNetworkRawStatus,
  resolveOrderStatusFromNetworkRaw,
} from "../src/modules/order/orderStatusNormalization.contract.js";
import {
  mapConversionStatusToValidation,
  mapConversionStatusToSupplierPayment,
  mapLegacyConversionStatus,
} from "../src/modules/order/orderMerge.js";
import { mapEntityToConversionIngest } from "../src/modules/reporting/services/conversionPromotion.service.js";

describe("Pointer 16 — orderStatusNormalization.contract", () => {
  it("preserves network raw status casing and spacing", () => {
    assert.equal(preserveNetworkRawStatus("Approved"), "Approved");
    assert.equal(preserveNetworkRawStatus(" on hold "), " on hold ");
    assert.equal(preserveNetworkRawStatus(42), "42");
  });

  it("maps known network statuses to canonical MBO order statuses", () => {
    assert.deepEqual(resolveOrderStatusFromNetworkRaw("approved"), {
      networkRawStatus: "approved",
      mboOrderStatus: MBO_ORDER_STATUS.CONFIRMED,
      mapped: true,
      mappingExceptionRequired: false,
      supplier: null,
    });
    assert.equal(resolveOrderStatusFromNetworkRaw("cancelled").mboOrderStatus, MBO_ORDER_STATUS.CANCELLED);
    assert.equal(resolveOrderStatusFromNetworkRaw("OPEN").mboOrderStatus, MBO_ORDER_STATUS.PENDING);
  });

  it("does not fuzzy-match unknown statuses", () => {
    const resolution = resolveOrderStatusFromNetworkRaw("partially_approved");
    assert.equal(resolution.mapped, false);
    assert.equal(resolution.mboOrderStatus, null);
    assert.equal(resolution.mappingExceptionRequired, true);
    assert.equal(resolution.networkRawStatus, "partially_approved");
  });

  it("maps canonical order status to validation without guessing unknown raw values", () => {
    assert.equal(mapMboOrderStatusToValidation(MBO_ORDER_STATUS.CONFIRMED), "VALIDATION_APPROVED");
    assert.equal(mapMboOrderStatusToValidation(MBO_ORDER_STATUS.CANCELLED), "VALIDATION_REJECTED");
    assert.equal(mapConversionStatusToValidation("partially_approved"), "VALIDATION_NEEDS_REVIEW");
    assert.equal(mapConversionStatusToValidation("APPROVED"), "VALIDATION_APPROVED");
  });

  it("keeps payment mapping separate from order status — network PAID is not supplier RECEIVED", () => {
    assert.equal(mapConversionStatusToSupplierPayment("PAID"), null);
    assert.equal(resolveOrderStatusFromNetworkRaw("PAID").mboOrderStatus, MBO_ORDER_STATUS.CONFIRMED);
  });

  it("buildOrderStatusMetadata stores network_raw_status and mboOrderStatus", () => {
    const meta = buildOrderStatusMetadata({}, {
      networkRawStatus: "Approved",
      mboOrderStatus: MBO_ORDER_STATUS.CONFIRMED,
      mappingExceptionRequired: false,
    });
    assert.equal(meta.network_raw_status, "Approved");
    assert.equal(meta.mboOrderStatus, MBO_ORDER_STATUS.CONFIRMED);
  });

  it("promotion preserves raw status and maps approved to conversion APPROVED", () => {
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
    assert.equal(mapped.input.metadata.mboOrderStatus, MBO_ORDER_STATUS.CONFIRMED);
    assert.equal(mapped.input.status, "APPROVED");
    assert.equal(mapped.input._order.networkRawStatus, "Approved");
  });

  it("promotion flags unknown status for mapping exception", () => {
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
