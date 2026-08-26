import "dotenv/config";
import { resolveOptimiseCredentials } from "../src/modules/integrations/optimiseCredentials.js";
import { createOptimiseAdapter } from "../src/adapters/optimise.adapter.js";

function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

async function probeEndpoint(name, fn) {
  const startedAt = Date.now();
  try {
    const rows = await fn();
    const count = Array.isArray(rows) ? rows.length : 0;
    console.log(`  OK  ${name}: ${count} rows (${Date.now() - startedAt}ms)`);
    return { ok: true, count };
  } catch (error) {
    const status = error?.response?.status;
    const body = error?.response?.data;
    const message =
      body?.message || body?.error || body?.response?.message || error?.message || "unknown error";
    console.log(`  FAIL ${name}: HTTP ${status || "?"} — ${message} (${Date.now() - startedAt}ms)`);
    return { ok: false, status, message };
  }
}

async function diagnose(region, accountLabel) {
  const credentials = await resolveOptimiseCredentials(region, accountLabel);
  console.log(`\n=== Optimise ${region.toUpperCase()} / ${credentials.accountLabel} ===`);
  console.log("Credential sources:", credentials.sources);
  console.log("agencyId:", credentials.agencyId, `(expected ${credentials.expectedAgencyId})`);
  console.log("contactId:", credentials.contactId);
  console.log("hasMarketplaceAccount:", credentials.hasMarketplaceAccount);
  if (credentials.agencyMismatch) {
    console.log("WARNING: agencyId does not match this region's expected Optimise agency.");
  }
  if (!credentials.apiKey) {
    console.log("ERROR: No API key resolved.");
    return;
  }
  if (!credentials.agencyId || !credentials.contactId) {
    console.log("ERROR: Missing agencyId or contactId.");
    return;
  }

  const adapter = createOptimiseAdapter(credentials);
  const toDate = toISODate(new Date());
  const fromDate = toISODate(new Date(Date.now() - 180 * 24 * 60 * 60 * 1000));

  await probeEndpoint("campaigns", () => adapter.fetchCampaigns());
  await probeEndpoint("conversions", () =>
    adapter.fetchConversions({ fromDate, toDate, targetCurrencyCode: "USD" }),
  );
  await probeEndpoint("reporting", () =>
    adapter.fetchReporting({ fromDate, toDate, targetCurrency: "USD" }),
  );
  await probeEndpoint("payments", () =>
    adapter.fetchPayments({ startDate: fromDate, endDate: toDate }),
  );
  await probeEndpoint("voucherCodes", () => adapter.fetchVoucherCodes());
}

const region = process.argv[2] || "sea";
const accountLabel = process.argv[3] || "clienta";
diagnose(region, accountLabel).finally(() => process.exit(0));
