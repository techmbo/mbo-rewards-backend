import test from "node:test";
import assert from "node:assert/strict";
import {
  FinanceConsumerService,
  getFinanceConsumerMode,
  FINANCE_CONSUMER_MODES,
  COMPARISON_STATUS,
} from "../src/modules/finance/financeConsumer.service.js";

test("Wave F — finance consumer migration", async (t) => {
  const originalMode = process.env.FINANCE_CONSUMER_MODE;
  t.after(() => {
    if (originalMode === undefined) delete process.env.FINANCE_CONSUMER_MODE;
    else process.env.FINANCE_CONSUMER_MODE = originalMode;
  });

  await t.test("default mode is LEGACY", () => {
    delete process.env.FINANCE_CONSUMER_MODE;
    assert.equal(getFinanceConsumerMode(), FINANCE_CONSUMER_MODES.LEGACY);
  });

  await t.test("legacy and FT match when no adjustments", () => {
    const svc = new FinanceConsumerService();
    const legacy = svc.sumLegacyClientCommission([
      { status: "APPROVED", clientCommission: "70" },
      { status: "PENDING", clientCommission: "10" },
    ]);
    const finance = svc.sumFinanceClientPayable([
      { clientPayable: "70", supplierReceivable: "100", mboMargin: "30", originalCurrency: "USD" },
    ]);
    const cmp = svc.compareAmounts(legacy.approved, finance.net);
    assert.equal(cmp.status, COMPARISON_STATUS.MATCH);
  });

  await t.test("reversal yields net zero FT", () => {
    const svc = new FinanceConsumerService();
    const finance = svc.sumFinanceClientPayable([
      { clientPayable: "700", supplierReceivable: "1000", mboMargin: "300", originalCurrency: "INR" },
      { clientPayable: "-700", supplierReceivable: "-1000", mboMargin: "-300", originalCurrency: "INR" },
    ]);
    assert.equal(finance.net, 0);
  });

  await t.test("adjustment changes net amount", () => {
    const svc = new FinanceConsumerService();
    const finance = svc.sumFinanceClientPayable([
      { clientPayable: "700", supplierReceivable: "1000", mboMargin: "300", originalCurrency: "INR" },
      { clientPayable: "-140", supplierReceivable: "-200", mboMargin: "-60", originalCurrency: "INR" },
    ]);
    assert.equal(finance.net, 560);
  });

  await t.test("FINANCE mode uses FT for display", () => {
    process.env.FINANCE_CONSUMER_MODE = "FINANCE";
    const svc = new FinanceConsumerService();
    const display = svc.resolveDisplayCommission({
      legacyApproved: 700,
      legacyPending: 100,
      financeNet: 560,
    });
    assert.equal(display.approvedCommission, 560);
    assert.equal(display.source, "financial_transaction");
    assert.equal(display.authoritative, true);
  });

  await t.test("LEGACY mode keeps conversion snapshot", () => {
    process.env.FINANCE_CONSUMER_MODE = "LEGACY";
    const svc = new FinanceConsumerService();
    const display = svc.resolveDisplayCommission({
      legacyApproved: 700,
      legacyPending: 100,
      financeNet: 560,
    });
    assert.equal(display.approvedCommission, 700);
    assert.equal(display.pendingCommission, 100);
    assert.equal(display.source, "conversion_snapshot");
  });

  await t.test("SHADOW mode keeps legacy display values", () => {
    process.env.FINANCE_CONSUMER_MODE = "SHADOW";
    const svc = new FinanceConsumerService();
    const display = svc.resolveDisplayCommission({
      legacyApproved: 700,
      legacyPending: 50,
      financeNet: 560,
    });
    assert.equal(display.approvedCommission, 700);
    assert.equal(display.authoritative, false);
  });

  await t.test("detects LEGACY_ONLY and FINANCE_ONLY", () => {
    const svc = new FinanceConsumerService();
    assert.equal(svc.compareAmounts(100, 0).status, COMPARISON_STATUS.LEGACY_ONLY);
    assert.equal(svc.compareAmounts(0, 50).status, COMPARISON_STATUS.FINANCE_ONLY);
  });

  await t.test("detects DIFFERENCE", () => {
    const svc = new FinanceConsumerService();
    assert.equal(svc.compareAmounts(700, 560).status, COMPARISON_STATUS.DIFFERENCE);
  });

  await t.test("late rejection net zero not missing history", () => {
    const svc = new FinanceConsumerService();
    const finance = svc.sumFinanceClientPayable([
      { clientPayable: "560", supplierReceivable: "800", mboMargin: "240", originalCurrency: "USD" },
      { clientPayable: "-560", supplierReceivable: "-800", mboMargin: "-240", originalCurrency: "USD" },
    ]);
    assert.equal(finance.net, 0);
    assert.equal(finance.count, 2);
  });

  await t.test("tenant-scoped FT query requires clientId", async () => {
    const calls = [];
    const db = {
      financialTransaction: {
        findMany: async ({ where }) => {
          calls.push(where);
          return [];
        },
      },
      clientCampaignAssignment: {
        findMany: async () => [{ id: "a1" }],
      },
      conversion: { findMany: async () => [] },
    };
    const svc = new FinanceConsumerService({ prisma: db });
    await svc.compareClientEarnings("client-a", {});
    assert.equal(calls[0].clientId, "client-a");
  });

  await t.test("coverage detects missing FT", async () => {
    const db = {
      conversion: { count: async () => 10 },
      financialTransaction: { count: async () => 3 },
    };
    const svc = new FinanceConsumerService({ prisma: db });
    const cov = await svc.getFinancialCoverage({ clientId: "c1" });
    assert.equal(cov.eligibleApprovedConversions, 10);
    assert.equal(cov.financiallyRecognized, 3);
    assert.equal(cov.complete, false);
    assert.ok(cov.coveragePercent < 100);
  });

  await t.test("does not sum mixed currencies without conversion", () => {
    const svc = new FinanceConsumerService();
    const finance = svc.sumFinanceClientPayable(
      [
        { clientPayable: "10", reportingClientPayable: "10", reportingCurrency: "USD", originalCurrency: "USD" },
        { clientPayable: "20", reportingClientPayable: null, originalCurrency: "INR" },
      ],
      { useReporting: true, reportingCurrency: "USD" },
    );
    assert.equal(finance.net, 10);
  });
});
