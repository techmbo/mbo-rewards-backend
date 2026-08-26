import { prisma } from "../../../database/prisma.js";
import { fail } from "../../../core/apiResponse.js";
import {
  ClickRepository,
  ConversionRepository,
  DailyReportRepository,
} from "../repositories/reporting.repository.js";
import {
  computeConversionRate,
  computeEpc,
  dayBounds,
  grossCommissionForConversion,
  isRejectedConversionStatus,
  toReportDate,
} from "../attributionMath.js";
import {
  FinanceConsumerService,
  FINANCE_CONSUMER_MODES,
} from "../../finance/financeConsumer.service.js";

/** Persisted DailyReport business key (matches SQL expression unique index). */
export const DAILY_REPORT_GRAIN =
  "clientId × canonicalCampaignId × campaignSourceId? × country? × reportDate";

const CLICK_PAGE_SIZE = 5_000;

function dimensionKey(parts) {
  return parts.map((p) => p ?? "").join("|");
}

function emptyBucket() {
  return {
    clickCount: 0,
    conversionCount: 0,
    approvedConversionCount: 0,
    rejectedConversionCount: 0,
    grossCommission: 0,
    clientCommission: 0,
    mboCommission: 0,
    currency: null,
    seenConversionIds: new Set(),
  };
}

function addMoney(bucket, field, value) {
  bucket[field] += Number(value ?? 0);
}

function reportDayIso(value) {
  return toReportDate(value).toISOString().slice(0, 10);
}

/**
 * AggregationService — writes DailyReport from real Click + ATTRIBUTED Conversion rows.
 * Does not invent CampaignSource, commission, or order values.
 * Order values / channel / coupon remain Performance read-time projections (04C).
 */
export class AggregationService {
  constructor(deps = {}) {
    this.clickRepo = deps.clickRepo ?? new ClickRepository();
    this.conversionRepo = deps.conversionRepo ?? new ConversionRepository();
    this.dailyReportRepo = deps.dailyReportRepo ?? new DailyReportRepository();
    this.financeConsumer = deps.financeConsumer ?? new FinanceConsumerService();
  }

  /**
   * Aggregate one UTC calendar day (all sources for optional client).
   * Alias used by ops/docs; grain is still multi-dimensional (see DAILY_REPORT_GRAIN).
   */
  async aggregateDay(reportDate, { clientId } = {}, client = null) {
    return this.runForDate(reportDate, { clientId }, client);
  }

  async runForDate(reportDate, { clientId } = {}, client = null) {
    const { start, end } = dayBounds(reportDate);
    return this.aggregateRange({ from: start, to: end, clientId }, client);
  }

  /**
   * Idempotent range rebuild: delete existing DailyReport rows in range, then re-aggregate.
   * Empty source data → truthful rowsUpserted: 0 (no fabricated buckets).
   */
  async rebuild({ from, to, clientId } = {}, client = null) {
    if (!from || !to) throw fail("from and to are required for rebuild.", 400);
    const deleted = await this.dailyReportRepo.deleteForDateRange({ from, to, clientId }, client);

    const cursor = new Date(from);
    const end = new Date(to);
    const summaries = [];

    while (cursor <= end) {
      summaries.push(await this.runForDate(cursor, { clientId }, client));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return {
      daysProcessed: summaries.length,
      rowsUpserted: summaries.reduce((sum, s) => sum + s.rowsUpserted, 0),
      rowsDeleted: typeof deleted?.count === "number" ? deleted.count : null,
      grain: DAILY_REPORT_GRAIN,
    };
  }

  async aggregateRange({ from, to, clientId } = {}, client = null) {
    const run = async (tx) => {
      const buckets = new Map();

      await this.#accumulateClicks(buckets, { from, to, clientId }, tx);
      await this.#accumulateConversions(buckets, { from, to, clientId }, tx);

      let rowsUpserted = 0;
      for (const bucket of buckets.values()) {
        const conversionRate = computeConversionRate(bucket.conversionCount, bucket.clickCount);
        const epc = computeEpc(bucket.grossCommission, bucket.clickCount);

        await this.dailyReportRepo.upsertDimension(
          {
            clientId: bucket.clientId,
            merchantId: bucket.merchantId,
            canonicalCampaignId: bucket.canonicalCampaignId,
            campaignSourceId: bucket.campaignSourceId,
            country: bucket.country,
            reportDate: bucket.reportDate,
            clickCount: bucket.clickCount,
            conversionCount: bucket.conversionCount,
            approvedConversionCount: bucket.approvedConversionCount,
            grossCommission: bucket.grossCommission.toFixed(4),
            clientCommission: bucket.clientCommission.toFixed(4),
            mboCommission: bucket.mboCommission.toFixed(4),
            conversionRate,
            epc,
            ctr: null,
            currency: bucket.currency,
          },
          tx,
        );
        rowsUpserted += 1;
      }

      const mode = this.financeConsumer.getMode();
      let financeWriteMode = "LEGACY_FINANCIALS";
      let shadow = null;
      let coverage = null;

      if (mode === FINANCE_CONSUMER_MODES.SHADOW || mode === FINANCE_CONSUMER_MODES.FINANCE) {
        shadow = await this.financeConsumer.compareDailyReportDimensions(
          { from, to, clientId },
          tx,
        );
        coverage = await this.financeConsumer.getFinancialCoverage({ clientId }, tx);

        const hasDiscrepancy =
          shadow.summary.differences > 0 ||
          shadow.summary.legacyOnly > 0 ||
          shadow.summary.financeOnly > 0;

        if (mode === FINANCE_CONSUMER_MODES.SHADOW && hasDiscrepancy) {
          await this.financeConsumer.recordShadowDiscrepancy({
            scope: "daily_report",
            from,
            to,
            clientId: clientId ?? null,
            summary: shadow.summary,
            coverage,
          });
        }

        if (mode === FINANCE_CONSUMER_MODES.FINANCE) {
          const safeToWriteFinance =
            coverage.complete &&
            shadow.summary.differences === 0 &&
            shadow.summary.legacyOnly === 0 &&
            shadow.summary.financeOnly === 0;

          if (!safeToWriteFinance) {
            financeWriteMode = "SHADOW_RETAINED";
            await this.financeConsumer.recordShadowDiscrepancy({
              scope: "daily_report_finance_mode_blocked",
              from,
              to,
              clientId: clientId ?? null,
              summary: shadow.summary,
              coverage,
              reason: "Safe cutover criteria not met; financial fields not overwritten from FT",
            });
          } else {
            financeWriteMode = "FINANCE";
            const financeBuckets = await this.buildFinanceFinancialBuckets(
              { from, to, clientId },
              tx,
            );
            for (const bucket of financeBuckets.values()) {
              const conversionRate = computeConversionRate(bucket.conversionCount, bucket.clickCount);
              const epc = computeEpc(bucket.grossCommission, bucket.clickCount);
              await this.dailyReportRepo.upsertDimension(
                {
                  clientId: bucket.clientId,
                  merchantId: bucket.merchantId,
                  canonicalCampaignId: bucket.canonicalCampaignId,
                  campaignSourceId: bucket.campaignSourceId,
                  country: bucket.country,
                  reportDate: bucket.reportDate,
                  clickCount: bucket.clickCount,
                  conversionCount: bucket.conversionCount,
                  approvedConversionCount: bucket.approvedConversionCount,
                  grossCommission: bucket.grossCommission.toFixed(4),
                  clientCommission: bucket.clientCommission.toFixed(4),
                  mboCommission: bucket.mboCommission.toFixed(4),
                  conversionRate,
                  epc,
                  ctr: null,
                  currency: bucket.currency,
                },
                tx,
              );
            }
          }
        }
      }

      return {
        rowsUpserted,
        bucketCount: buckets.size,
        clickEvents: [...buckets.values()].reduce((n, b) => n + b.clickCount, 0),
        conversionEvents: [...buckets.values()].reduce((n, b) => n + b.conversionCount, 0),
        financeConsumerMode: mode,
        financeWriteMode,
        shadowSummary: shadow?.summary ?? null,
        coverage,
        grain: DAILY_REPORT_GRAIN,
        empty: buckets.size === 0,
      };
    };

    if (client) return run(client);
    return prisma.$transaction(run);
  }

  async #loadAllClicks({ from, to }, tx) {
    const rows = [];
    let skip = 0;
    for (;;) {
      const page = await this.clickRepo.findMany(
        { from, to },
        { skip, take: CLICK_PAGE_SIZE },
        tx,
      );
      const batch = page?.rows ?? [];
      rows.push(...batch);
      if (batch.length < CLICK_PAGE_SIZE) break;
      skip += CLICK_PAGE_SIZE;
      // Hard safety cap — avoid unbounded memory; ops should rebuild narrower ranges.
      if (rows.length >= 500_000) break;
    }
    return rows;
  }

  async #accumulateClicks(buckets, { from, to, clientId }, tx) {
    const clicks = await this.#loadAllClicks({ from, to }, tx);

    for (const click of clicks) {
      if (!click.clientAssignmentId) continue;
      const assignment = await tx.clientCampaignAssignment.findUnique({
        where: { id: click.clientAssignmentId },
        include: { canonicalCampaign: true },
      });
      if (!assignment?.canonicalCampaign?.merchantId) continue;
      if (clientId && assignment.clientId !== clientId) continue;

      const day = toReportDate(click.clickedAt);
      const key = dimensionKey([
        assignment.clientId,
        assignment.canonicalCampaign.merchantId,
        assignment.canonicalCampaignId,
        click.campaignSourceId,
        click.country,
        reportDayIso(click.clickedAt),
      ]);

      if (!buckets.has(key)) {
        buckets.set(key, {
          clientId: assignment.clientId,
          merchantId: assignment.canonicalCampaign.merchantId,
          canonicalCampaignId: assignment.canonicalCampaignId,
          campaignSourceId: click.campaignSourceId ?? null,
          country: click.country ?? null,
          reportDate: day,
          ...emptyBucket(),
        });
      }
      buckets.get(key).clickCount += 1;
    }
  }

  async #accumulateConversions(buckets, { from, to, clientId }, tx) {
    const conversions = await this.conversionRepo.findForAggregation(
      { from, to, clientAssignmentId: undefined },
      tx,
    );

    for (const conversion of conversions) {
      const assignment = conversion.clientAssignment;
      if (!assignment?.canonicalCampaign?.merchantId) continue;
      if (clientId && assignment.clientId !== clientId) continue;
      // Deduplicate by conversion id (respects unique business key already in DB).
      // Never count the same Conversion twice within a run.
      const country = conversion.metadata?.country ?? null;
      const day = toReportDate(conversion.conversionDate);
      const key = dimensionKey([
        assignment.clientId,
        assignment.canonicalCampaign.merchantId,
        assignment.canonicalCampaignId,
        conversion.campaignSourceId,
        country,
        reportDayIso(conversion.conversionDate),
      ]);

      if (!buckets.has(key)) {
        buckets.set(key, {
          clientId: assignment.clientId,
          merchantId: assignment.canonicalCampaign.merchantId,
          canonicalCampaignId: assignment.canonicalCampaignId,
          campaignSourceId: conversion.campaignSourceId ?? null,
          country,
          reportDate: day,
          ...emptyBucket(),
        });
      }

      const bucket = buckets.get(key);
      if (bucket.seenConversionIds.has(conversion.id)) continue;
      bucket.seenConversionIds.add(conversion.id);

      bucket.conversionCount += 1;
      if (conversion.status === "APPROVED" || conversion.status === "PAID") {
        bucket.approvedConversionCount += 1;
      }
      if (conversion.status === "REJECTED") {
        bucket.rejectedConversionCount += 1;
      }

      // Rejected conversions must not contribute to commission earnings.
      // Never use campaign headline / Product.price.
      if (!isRejectedConversionStatus(conversion.status)) {
        const gross = grossCommissionForConversion(conversion);
        addMoney(bucket, "grossCommission", gross);
        if (conversion.clientCommission != null && conversion.clientCommission !== "") {
          addMoney(bucket, "clientCommission", conversion.clientCommission);
        }
        if (conversion.mboCommission != null && conversion.mboCommission !== "") {
          addMoney(bucket, "mboCommission", conversion.mboCommission);
        }
        bucket.currency = conversion.currency ?? bucket.currency;
      }
    }
  }

  /**
   * Rebuild financial DailyReport amounts from FinancialTransaction (SoT)
   * while preserving operational click/conversion counts already in buckets.
   * Only invoked when FINANCE mode cutover criteria are met.
   */
  async buildFinanceFinancialBuckets({ from, to, clientId }, tx) {
    const conversions = await this.conversionRepo.findForAggregation(
      { from, to, clientAssignmentId: undefined },
      tx,
    );
    const conversionIds = conversions.map((c) => c.id);
    const txns =
      conversionIds.length === 0
        ? []
        : await tx.financialTransaction.findMany({
            where: { conversionId: { in: conversionIds } },
          });

    const byConversion = new Map();
    for (const txn of txns) {
      if (!txn.conversionId) continue;
      if (!byConversion.has(txn.conversionId)) {
        byConversion.set(txn.conversionId, {
          supplierReceivable: 0,
          clientPayable: 0,
          mboMargin: 0,
          currency: txn.originalCurrency,
        });
      }
      const agg = byConversion.get(txn.conversionId);
      agg.supplierReceivable += Number(txn.supplierReceivable);
      agg.clientPayable += Number(txn.clientPayable);
      agg.mboMargin += Number(txn.mboMargin);
      agg.currency = txn.originalCurrency || agg.currency;
    }

    const operational = new Map();
    await this.#accumulateClicks(operational, { from, to, clientId }, tx);
    for (const conversion of conversions) {
      const assignment = conversion.clientAssignment;
      if (!assignment?.canonicalCampaign?.merchantId) continue;
      if (clientId && assignment.clientId !== clientId) continue;
      const country = conversion.metadata?.country ?? null;
      const key = dimensionKey([
        assignment.clientId,
        assignment.canonicalCampaign.merchantId,
        assignment.canonicalCampaignId,
        conversion.campaignSourceId,
        country,
        reportDayIso(conversion.conversionDate),
      ]);
      if (!operational.has(key)) {
        operational.set(key, {
          clientId: assignment.clientId,
          merchantId: assignment.canonicalCampaign.merchantId,
          canonicalCampaignId: assignment.canonicalCampaignId,
          campaignSourceId: conversion.campaignSourceId ?? null,
          country,
          reportDate: toReportDate(conversion.conversionDate),
          ...emptyBucket(),
        });
      }
      const bucket = operational.get(key);
      if (bucket.seenConversionIds.has(conversion.id)) continue;
      bucket.seenConversionIds.add(conversion.id);
      bucket.conversionCount += 1;
      if (conversion.status === "APPROVED" || conversion.status === "PAID") {
        bucket.approvedConversionCount += 1;
      }
      const ft = byConversion.get(conversion.id);
      if (ft) {
        addMoney(bucket, "grossCommission", ft.supplierReceivable);
        addMoney(bucket, "clientCommission", ft.clientPayable);
        addMoney(bucket, "mboCommission", ft.mboMargin);
        bucket.currency = ft.currency ?? bucket.currency;
      }
    }

    return operational;
  }
}
