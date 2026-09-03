import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SupplierCommissionRuleService } from "../src/modules/commercial/services/supplierCommissionRule.service.js";

function createRuleDb() {
  const rows = [];
  let sequence = 0;

  const materializeConditions = (nested) => {
    if (!nested) return undefined;
    if (Array.isArray(nested.create)) return nested.create.map((row, index) => ({ id: `cond-${index + 1}`, ...row }));
    return [];
  };

  const model = {
    async findMany({ where }) {
      return rows
        .filter(
          (row) =>
            row.supplier === where.supplier &&
            row.sourceAccountLabel === where.sourceAccountLabel &&
            row.outcomeKey === where.outcomeKey,
        )
        .sort((a, b) => new Date(b.effectiveFrom) - new Date(a.effectiveFrom))
        .map((row) => ({ ...row, conditions: [...(row.conditions || [])] }));
    },
    async create({ data }) {
      sequence += 1;
      const row = {
        id: `rule-${sequence}`,
        createdAt: new Date(`2026-01-0${sequence}T00:00:00.000Z`),
        ...data,
        conditions: materializeConditions(data.conditions),
      };
      rows.push(row);
      return { ...row };
    },
    async update({ where, data }) {
      const index = rows.findIndex((row) => row.id === where.id);
      assert.notEqual(index, -1, `missing mock rule ${where.id}`);
      const next = { ...rows[index], ...data };
      if (data.conditions) next.conditions = materializeConditions(data.conditions);
      rows[index] = next;
      return { ...next };
    },
  };

  return {
    rows,
    db: {
      supplierCommissionRule: model,
      async $transaction(callback) {
        return callback({ supplierCommissionRule: model });
      },
    },
  };
}

function baseInput(overrides = {}) {
  return {
    supplier: "IMPACT",
    sourceAccountLabel: "default",
    campaignSourceId: "cs-1",
    supplierCampaignId: "sc-1",
    sourceRuleId: "network-rule-1",
    outcomeKey: "campaign-1::campaigns::commission::network-rule-1::PERCENT::PERCENT_OF_SALE::::slot:1::",
    supplierRuleType: "PERCENT",
    basis: "PERCENT_OF_SALE",
    ratePercent: 10,
    conditions: [{ conditionType: "COUNTRY", operator: "EQ", value: "AE" }],
    sourceEvidenceAt: new Date("2026-09-01T10:00:00.000Z"),
    ...overrides,
  };
}

describe("SupplierCommissionRuleService history and idempotency", () => {
  it("reuses an identical open version when the supplier does not provide effectiveFrom", async () => {
    const { rows, db } = createRuleDb();
    const service = new SupplierCommissionRuleService({ prisma: db });

    const first = await service.upsertNormalizedFact(baseInput());
    const second = await service.upsertNormalizedFact(
      baseInput({ sourceEvidenceAt: new Date("2026-09-02T10:00:00.000Z") }),
    );

    assert.equal(first.id, second.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ratePercent, 10);
    assert.equal(new Date(rows[0].effectiveFrom).toISOString(), "2026-09-01T10:00:00.000Z");
  });

  it("creates a successor and closes the predecessor when economics change", async () => {
    const { rows, db } = createRuleDb();
    const service = new SupplierCommissionRuleService({ prisma: db });

    const previous = await service.upsertNormalizedFact(baseInput());
    const successor = await service.upsertNormalizedFact(
      baseInput({
        ratePercent: 12,
        sourceEvidenceAt: new Date("2026-09-15T00:00:00.000Z"),
      }),
    );

    assert.notEqual(previous.id, successor.id);
    assert.equal(rows.length, 2);
    const oldRow = rows.find((row) => row.id === previous.id);
    const newRow = rows.find((row) => row.id === successor.id);
    assert.equal(oldRow.ratePercent, 10);
    assert.equal(newRow.ratePercent, 12);
    assert.equal(new Date(oldRow.effectiveUntil).toISOString(), "2026-09-15T00:00:00.000Z");
    assert.equal(newRow.effectiveUntil, null);
  });

  it("respects supplier-provided effectiveFrom and remains idempotent for that version", async () => {
    const { rows, db } = createRuleDb();
    const service = new SupplierCommissionRuleService({ prisma: db });
    const effectiveFrom = new Date("2026-10-01T00:00:00.000Z");

    const first = await service.upsertNormalizedFact(baseInput({ ratePercent: 12, effectiveFrom }));
    const second = await service.upsertNormalizedFact(
      baseInput({
        ratePercent: 12,
        effectiveFrom,
        sourceEvidenceAt: new Date("2026-10-05T00:00:00.000Z"),
      }),
    );

    assert.equal(first.id, second.id);
    assert.equal(rows.length, 1);
    assert.equal(new Date(rows[0].effectiveFrom).toISOString(), "2026-10-01T00:00:00.000Z");
  });

  describe("explicit zero commission versioning", () => {
    it("closes the 10% version and opens a 0% successor when the supplier drops to 0%", async () => {
      const { rows, db } = createRuleDb();
      const service = new SupplierCommissionRuleService({ prisma: db });

      const previous = await service.upsertNormalizedFact(baseInput({ ratePercent: 10 }));
      const successor = await service.upsertNormalizedFact(
        baseInput({ ratePercent: 0, sourceEvidenceAt: new Date("2026-09-15T00:00:00.000Z") }),
      );

      assert.notEqual(previous.id, successor.id);
      assert.equal(rows.length, 2);
      const oldRow = rows.find((row) => row.id === previous.id);
      const newRow = rows.find((row) => row.id === successor.id);
      assert.equal(oldRow.ratePercent, 10);
      assert.equal(new Date(oldRow.effectiveUntil).toISOString(), "2026-09-15T00:00:00.000Z");
      assert.equal(newRow.ratePercent, 0);
      assert.equal(newRow.effectiveUntil, null);
    });

    it("re-syncing an identical 0% rule is idempotent and creates no new version", async () => {
      const { rows, db } = createRuleDb();
      const service = new SupplierCommissionRuleService({ prisma: db });

      const first = await service.upsertNormalizedFact(baseInput({ ratePercent: 0 }));
      const second = await service.upsertNormalizedFact(
        baseInput({ ratePercent: 0, sourceEvidenceAt: new Date("2026-09-20T00:00:00.000Z") }),
      );
      const third = await service.upsertNormalizedFact(
        baseInput({ ratePercent: "0", sourceEvidenceAt: new Date("2026-09-25T00:00:00.000Z") }),
      );

      assert.equal(first.id, second.id);
      assert.equal(first.id, third.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].effectiveUntil, null);
    });

    it("closes the 0% version and opens a 10% successor when the supplier restores payout", async () => {
      const { rows, db } = createRuleDb();
      const service = new SupplierCommissionRuleService({ prisma: db });

      const zero = await service.upsertNormalizedFact(baseInput({ ratePercent: 0 }));
      const restored = await service.upsertNormalizedFact(
        baseInput({ ratePercent: 10, sourceEvidenceAt: new Date("2026-10-01T00:00:00.000Z") }),
      );

      assert.notEqual(zero.id, restored.id);
      assert.equal(rows.length, 2);
      const zeroRow = rows.find((row) => row.id === zero.id);
      assert.equal(zeroRow.ratePercent, 0);
      assert.equal(new Date(zeroRow.effectiveUntil).toISOString(), "2026-10-01T00:00:00.000Z");
      assert.equal(rows.find((row) => row.id === restored.id).ratePercent, 10);
    });

    it("treats a fixed zero and a missing fixed amount as different economics", async () => {
      const { rows, db } = createRuleDb();
      const service = new SupplierCommissionRuleService({ prisma: db });
      const fixedInput = (overrides = {}) =>
        baseInput({
          supplierRuleType: "FIXED",
          basis: "FIXED_PER_ORDER",
          ratePercent: null,
          fixedAmount: 0,
          currency: "USD",
          outcomeKey: "campaign-1::campaigns::commission::network-rule-2::FIXED::FIXED_PER_ORDER::USD::slot:1::",
          ...overrides,
        });

      const zero = await service.upsertNormalizedFact(fixedInput());
      const again = await service.upsertNormalizedFact(
        fixedInput({ sourceEvidenceAt: new Date("2026-09-10T00:00:00.000Z") }),
      );
      assert.equal(zero.id, again.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].fixedAmount, 0);
    });
  });
});
