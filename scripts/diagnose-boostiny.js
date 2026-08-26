import "dotenv/config";
import { createBoostinyAdapter } from "../src/adapters/boostiny.adapter.js";
import { getMarketplaceApiKey } from "../src/modules/integrations/oauth.service.js";

function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

function getRange() {
  const daysBack = Number(process.env.BOOSTINY_REPORT_DAYS_BACK || 180);
  const to = toISODate(new Date());
  const from = toISODate(new Date(Date.now() - Math.max(daysBack, 1) * 24 * 60 * 60 * 1000));
  return { from, to };
}

function sampleKeys(row) {
  if (!row || typeof row !== "object") return [];
  return Object.keys(row).slice(0, 20);
}

async function diagnoseAccount(accountLabel) {
  const apiKey = await getMarketplaceApiKey("boostiny", accountLabel);
  if (!apiKey) {
    console.log(`[${accountLabel}] No connected Boostiny account. Connect on the Integrations page.`);
    return;
  }

  const adapter = createBoostinyAdapter({
    apiKey,
    baseURL: process.env.BOOSTINY_BASE_URL || "https://api.boostiny.com",
  });

  const { from, to } = getRange();
  console.log(`\n=== Diagnosing boostiny:${accountLabel} (${from} to ${to}) ===`);
  console.log(`BOOSTINY_MIN_INTERVAL_MS=${process.env.BOOSTINY_MIN_INTERVAL_MS || "(default 1000)"}`);

  const startedAt = Date.now();

  try {
    const campaigns = await adapter.fetchCampaigns();
    console.log(`Campaigns: ${campaigns.length}`);
    if (campaigns[0]) {
      console.log(`Sample campaign keys: ${sampleKeys(campaigns[0]).join(", ")}`);
      console.log(`Sample campaign id: ${campaigns[0]?.id}`);
    }

    const performance = await adapter.fetchPerformance({ from, to });
    console.log(`Global performance pages: ${performance.pages.length}`);
    console.log(`Global performance rows: ${performance.rows.length}`);

    if (performance.rows[0]) {
      const row = performance.rows[0];
      console.log(`Sample performance row keys: ${sampleKeys(row).join(", ")}`);
      console.log(
        `Campaign fields: campaign_id=${row?.campaign_id}, campaignId=${row?.campaignId}, campaign_name=${row?.campaign_name}, campaignName=${row?.campaignName}`,
      );
    } else if (performance.pages[0]) {
      console.log(`First performance page top-level keys: ${sampleKeys(performance.pages[0]).join(", ")}`);
      const payload = performance.pages[0]?.payload;
      if (payload) {
        console.log(`Performance payload keys: ${sampleKeys(payload).join(", ")}`);
        if (payload.data?.[0]) {
          console.log(`payload.data[0] keys: ${sampleKeys(payload.data[0]).join(", ")}`);
        }
        if (payload.report?.[0]) {
          console.log(`payload.report[0] keys: ${sampleKeys(payload.report[0]).join(", ")}`);
        }
      }
    }

    const hasDetail = performance.rows.some(
      (row) =>
        row?.campaign_id != null ||
        row?.campaign_name ||
        row?.campaign?.name ||
        row?.campaign?.id != null,
    );
    console.log(`hasCampaignDetailRows (current check): ${hasDetail}`);
    console.log(`Would trigger per-campaign fallback: ${!hasDetail}`);

    if (!hasDetail && campaigns.length > 0) {
      console.log(`WARNING: per-campaign fallback would make ~${campaigns.length}+ extra API calls`);
    }
  } catch (error) {
    const status = error?.response?.status;
    const data = error?.response?.data;
    console.error(`ERROR status=${status}`);
    console.error(`Response body: ${JSON.stringify(data)?.slice(0, 500)}`);
    console.error(`Message: ${error?.message}`);
  }

  console.log(`Elapsed: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

const accountLabel = process.argv[2] || "clienta";
diagnoseAccount(accountLabel).finally(() => process.exit(0));
