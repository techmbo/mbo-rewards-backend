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
});
