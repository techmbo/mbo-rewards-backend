/**
 * Aggregation rebuild — canonical date normalization at the service boundary.
 *
 * Production evidence: the post-sync auto-rebuild enqueues
 *   { rebuild: true, from: "2026-08-27", to: "2026-09-10" }
 * (date-only strings). rebuild() passed them straight into
 * DailyReportRepository.deleteForDateRange → prisma.dailyReport.deleteMany, whose
 * DateTime filter rejects a date-only string, so every such job died with
 *   Invalid `prisma.dailyReport.deleteMany()` invocation
 * before any day was rebuilt. These tests prove the repository now receives Date
 * objects, that invalid or inverted ranges fail BEFORE the delete, and that the
 * Date / ISO-datetime / runForDate paths are unchanged.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { AggregationService } from "../src/modules/reporting/services/aggregation.service.js";
import { DailyReportRepository } from "../src/modules/reporting/repositories/reporting.repository.js";
import { dayBounds, normalizeReportDateRange, parseReportDateInput } from "../src/modules/reporting/attributionMath.js";

const PROD_FROM = "2026-08-27";
const PROD_TO = "2026-09-10";
const UTC = (iso) => new Date(iso);

/**
 * AggregationService whose per-day aggregation is stubbed (recorded, not run), so
 * only the range handling and the delete are exercised. `dailyReportRepo` is the
 * REAL repository over a fake Prisma client, so the assertion is made on the exact
 * argument prisma.dailyReport.deleteMany receives.
 */
function harness({ deleteCount = 3 } = {}) {
  const deleteMany = mock.fn(async () => ({ count: deleteCount }));
  const client = { dailyReport: { deleteMany } };
  const service = new AggregationService({
    clickRepo: { findMany: async () => ({ rows: [], total: 0 }) },
    conversionRepo: { findForAggregation: async () => [] },
    dailyReportRepo: new DailyReportRepository(),
    financeConsumer: { getMode: () => "LEGACY" },
  });
  const days = [];
  service.runForDate = async (date) => {
    days.push(new Date(date));
    return { rowsUpserted: 1 };
  };
  const deleteWhere = () => deleteMany.mock.calls[0]?.arguments?.[0]?.where;
  return { service, client, deleteMany, days, deleteWhere };
}

describe("parseReportDateInput / normalizeReportDateRange", () => {
  it("reads YYYY-MM-DD as that UTC calendar day", () => {
    assert.equal(parseReportDateInput(PROD_FROM).toISOString(), "2026-08-27T00:00:00.000Z");
    assert.equal(parseReportDateInput(" 2026-09-10 ").toISOString(), "2026-09-10T00:00:00.000Z");
  });

  it("keeps valid Date instances (copied) and ISO-8601 datetimes with an offset", () => {
    const d = UTC("2026-08-27T13:45:00.000Z");
    const parsed = parseReportDateInput(d);
    assert.equal(parsed.getTime(), d.getTime());
    assert.notEqual(parsed, d, "a copy, not the caller's instance");
    assert.equal(parseReportDateInput("2026-08-27T13:45:00.000Z").toISOString(), "2026-08-27T13:45:00.000Z");
    assert.equal(parseReportDateInput("2026-09-10T23:59:59+02:00").toISOString(), "2026-09-10T21:59:59.000Z");
    assert.equal(parseReportDateInput("2026-09-10T23:59+0200").toISOString(), "2026-09-10T21:59:00.000Z");
  });

  it("rejects malformed, impossible, offset-less, numeric, empty and invalid-Date input with a 400 — nothing is silently coerced", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "not-a-date", "2026/08/27", "27-08-2026", "Aug 27 2026", "2026-08-27T10:00", "", "   ", 12345, null, undefined, new Date("x"), {}, ["2026-08-27"]]) {
      assert.throws(
        () => parseReportDateInput(bad, "from"),
        (error) => error.statusCode === 400 && error.code === "invalid_report_date_range" && /^from /.test(error.message),
        `must reject ${JSON.stringify(bad)}`,
      );
    }
  });

  it("normalizes a range to inclusive UTC calendar days and rejects an inverted range", () => {
    assert.deepEqual(normalizeReportDateRange({ from: PROD_FROM, to: PROD_TO }), { from: UTC("2026-08-27T00:00:00.000Z"), to: UTC("2026-09-10T00:00:00.000Z") });
    assert.deepEqual(normalizeReportDateRange({ from: "2026-08-27T13:45:00.000Z", to: UTC("2026-09-10T23:59:59.999Z") }), { from: UTC("2026-08-27T00:00:00.000Z"), to: UTC("2026-09-10T00:00:00.000Z") });
    assert.deepEqual(normalizeReportDateRange({ from: PROD_TO, to: PROD_TO }), { from: UTC("2026-09-10T00:00:00.000Z"), to: UTC("2026-09-10T00:00:00.000Z") });
    // Inversion is judged on the actual parsed instants, BEFORE day normalization:
    // same calendar day, later instant first is a genuinely inverted range.
    assert.throws(
      () => normalizeReportDateRange({ from: "2026-09-10T20:00:00Z", to: "2026-09-10T01:00:00Z" }),
      (e) => e.statusCode === 400 && e.code === "invalid_report_date_range" && /must not be after/.test(e.message),
    );
    // Same instant, or earlier-then-later within one day, is fine.
    assert.doesNotThrow(() => normalizeReportDateRange({ from: "2026-09-10T01:00:00Z", to: "2026-09-10T20:00:00Z" }));
    assert.doesNotThrow(() => normalizeReportDateRange({ from: "2026-09-10T20:00:00Z", to: "2026-09-10T20:00:00Z" }));
    assert.throws(() => normalizeReportDateRange({ from: PROD_TO, to: PROD_FROM }), (e) => e.statusCode === 400 && /must not be after/.test(e.message));
    assert.throws(() => normalizeReportDateRange({ from: PROD_FROM }), (e) => e.statusCode === 400 && /required/.test(e.message));
    assert.throws(() => normalizeReportDateRange({}), (e) => e.statusCode === 400);
  });
});

describe("AggregationService.rebuild — repository receives Dates, never raw strings", () => {
  it("1+2. accepts the production-shaped YYYY-MM-DD from/to and prisma.dailyReport.deleteMany receives Date objects", async () => {
    const { service, client, deleteMany, days, deleteWhere } = harness();

    const result = await service.rebuild({ from: PROD_FROM, to: PROD_TO }, client);

    assert.equal(deleteMany.mock.callCount(), 1);
    const where = deleteWhere();
    assert.ok(where.reportDate.gte instanceof Date, "gte is a Date");
    assert.ok(where.reportDate.lte instanceof Date, "lte is a Date");
    assert.notEqual(typeof where.reportDate.gte, "string", "not the raw string");
    assert.notEqual(typeof where.reportDate.lte, "string", "not the raw string");
    assert.equal(where.reportDate.gte.toISOString(), "2026-08-27T00:00:00.000Z");
    assert.equal(where.reportDate.lte.toISOString(), "2026-09-10T00:00:00.000Z");
    assert.equal(where.clientId, undefined);

    // Every UTC day in the inclusive range is rebuilt, and only those.
    assert.equal(days.length, 15, "27 Aug .. 10 Sep inclusive");
    assert.equal(days[0].toISOString(), "2026-08-27T00:00:00.000Z");
    assert.equal(days.at(-1).toISOString(), "2026-09-10T00:00:00.000Z");
    assert.deepEqual(result, { daysProcessed: 15, rowsUpserted: 15, rowsDeleted: 3, grain: result.grain });
  });

  it("3. an invalid date is rejected with 400 BEFORE any delete or rebuild", async () => {
    for (const bad of ["2026-02-30", "not-a-date", "2026/08/27", "2026-08-27T10:00", new Date("x"), 20260827]) {
      const { service, client, deleteMany, days } = harness();
      await assert.rejects(service.rebuild({ from: bad, to: PROD_TO }, client), (e) => e.statusCode === 400, `from=${JSON.stringify(bad)}`);
      await assert.rejects(service.rebuild({ from: PROD_FROM, to: bad }, client), (e) => e.statusCode === 400, `to=${JSON.stringify(bad)}`);
      assert.equal(deleteMany.mock.callCount(), 0, "no delete issued");
      assert.equal(days.length, 0, "no day rebuilt");
    }
  });

  it("4. an inverted range (from > to) is rejected with 400 BEFORE any delete or rebuild", async () => {
    const { service, client, deleteMany, days } = harness();
    await assert.rejects(service.rebuild({ from: PROD_TO, to: PROD_FROM }, client), (e) => e.statusCode === 400 && /must not be after/.test(e.message));
    await assert.rejects(service.rebuild({ from: UTC("2026-09-11T00:00:00Z"), to: UTC("2026-09-10T00:00:00Z") }, client), (e) => e.statusCode === 400);
    assert.equal(deleteMany.mock.callCount(), 0);
    assert.equal(days.length, 0);
  });

  it("4b. a same-day but genuinely inverted datetime range is rejected with 400 BEFORE any delete or rebuild", async () => {
    const { service, client, deleteMany, days } = harness();
    await assert.rejects(
      service.rebuild({ from: "2026-09-10T20:00:00Z", to: "2026-09-10T01:00:00Z" }, client),
      (e) => e.statusCode === 400 && e.code === "invalid_report_date_range" && /must not be after/.test(e.message),
    );
    assert.equal(deleteMany.mock.callCount(), 0, "deleteMany never called");
    assert.equal(days.length, 0, "no day rebuilt");
  });

  it("5. Date instances remain accepted and are normalized to UTC calendar days", async () => {
    const { service, client, deleteWhere, days } = harness();
    await service.rebuild({ from: UTC("2026-08-27T13:45:00.000Z"), to: UTC("2026-08-29T23:59:59.999Z"), clientId: "client-1" }, client);
    const where = deleteWhere();
    assert.ok(where.reportDate.gte instanceof Date && where.reportDate.lte instanceof Date);
    assert.equal(where.reportDate.gte.toISOString(), "2026-08-27T00:00:00.000Z");
    assert.equal(where.reportDate.lte.toISOString(), "2026-08-29T00:00:00.000Z");
    assert.equal(where.clientId, "client-1", "client scoping preserved");
    assert.deepEqual(days.map((d) => d.toISOString().slice(0, 10)), ["2026-08-27", "2026-08-28", "2026-08-29"]);
  });

  it("6. ISO datetime strings (the JSON round-trip of a zod-coerced Date) remain accepted", async () => {
    const { service, client, deleteWhere, days } = harness();
    await service.rebuild({ from: "2026-08-27T00:00:00.000Z", to: "2026-08-28T15:30:00+02:00" }, client);
    const where = deleteWhere();
    assert.ok(where.reportDate.gte instanceof Date && where.reportDate.lte instanceof Date);
    assert.equal(where.reportDate.gte.toISOString(), "2026-08-27T00:00:00.000Z");
    assert.equal(where.reportDate.lte.toISOString(), "2026-08-28T00:00:00.000Z");
    assert.equal(days.length, 2);
  });

  it("delete window and rebuild loop always cover the same set of days (datetime ends included)", async () => {
    const { service, client, deleteWhere, days } = harness();
    // Previously: delete `lte 10:00 day2` removed day2's midnight row, but the loop
    // cursor started at 15:00 day1 and stopped before day2 — deleted, never rebuilt.
    await service.rebuild({ from: "2026-09-01T15:00:00.000Z", to: "2026-09-02T10:00:00.000Z" }, client);
    assert.equal(deleteWhere().reportDate.gte.toISOString(), "2026-09-01T00:00:00.000Z");
    assert.equal(deleteWhere().reportDate.lte.toISOString(), "2026-09-02T00:00:00.000Z");
    assert.deepEqual(days.map((d) => d.toISOString().slice(0, 10)), ["2026-09-01", "2026-09-02"]);
  });

  it("missing from/to still fails with the existing 400 and no delete", async () => {
    const { service, client, deleteMany } = harness();
    await assert.rejects(service.rebuild({ from: PROD_FROM }, client), (e) => e.statusCode === 400);
    await assert.rejects(service.rebuild({}, client), (e) => e.statusCode === 400);
    assert.equal(deleteMany.mock.callCount(), 0);
  });
});

describe("AggregationService.runForDate — unchanged", () => {
  it("7. runForDate aggregates the UTC day bounds of the given date (string or Date) exactly as before", async () => {
    const service = new AggregationService({
      clickRepo: { findMany: async () => ({ rows: [], total: 0 }) },
      conversionRepo: { findForAggregation: async () => [] },
      dailyReportRepo: { upsertDimension: async (row) => row },
      financeConsumer: { getMode: () => "LEGACY" },
    });
    const ranges = [];
    service.aggregateRange = async (range, client) => {
      ranges.push({ ...range, client });
      return { rowsUpserted: 0 };
    };
    const tx = { marker: "tx" };

    await service.runForDate("2026-08-27", { clientId: "c1" }, tx);
    await service.runForDate(UTC("2026-08-27T18:30:00.000Z"), {}, tx);

    const expected = dayBounds("2026-08-27");
    for (const range of ranges) {
      assert.equal(range.from.toISOString(), "2026-08-27T00:00:00.000Z");
      assert.equal(range.to.toISOString(), "2026-08-27T23:59:59.999Z");
      assert.equal(range.from.getTime(), expected.start.getTime());
      assert.equal(range.to.getTime(), expected.end.getTime());
      assert.equal(range.client, tx);
    }
    assert.equal(ranges[0].clientId, "c1");
    assert.equal(ranges[1].clientId, undefined);
  });
});
