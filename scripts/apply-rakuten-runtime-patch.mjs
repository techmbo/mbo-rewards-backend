import fs from "node:fs";

function replaceOnce(source, needle, replacement, label) {
  if (source.includes(replacement)) return source;
  if (!source.includes(needle)) throw new Error(`Rakuten patch anchor missing: ${label}`);
  return source.replace(needle, replacement);
}

const syncPath = "src/jobs/sync.job.js";
let sync = fs.readFileSync(syncPath, "utf8");

sync = replaceOnce(
  sync,
  'import { syncAdmitadAccount } from "./admitadSupplierSync.js";\n',
  'import { syncAdmitadAccount } from "./admitadSupplierSync.js";\nimport { syncRakutenAccount } from "./rakutenSupplierSync.js";\n',
  "sync import",
);

sync = replaceOnce(
  sync,
  '  const admitadAccounts = await listMarketplaceAccounts("admitad");\n  let total =\n',
  '  const admitadAccounts = await listMarketplaceAccounts("admitad");\n  const rakutenAccounts = await listMarketplaceAccounts("rakuten");\n  let total =\n',
  "count all account declaration",
);

sync = replaceOnce(
  sync,
  '    awinAccounts.length +\n    admitadAccounts.length;\n',
  '    awinAccounts.length +\n    admitadAccounts.length +\n    rakutenAccounts.length;\n',
  "count all account total",
);

sync = replaceOnce(
  sync,
  '  if (["impact", "partnerize", "awin", "admitad"].includes(platform)) {\n',
  '  if (["impact", "partnerize", "awin", "admitad", "rakuten"].includes(platform)) {\n',
  "platform account count",
);

const admitadBranch = `    } else if (platform === "admitad") {\n      const accountResult = await syncAdmitadAccount(accountLabel || "default");\n      recordAccountSyncComplete({\n        success: !accountResult?.failed && !accountResult?.skipped,\n      });\n      result = { [accountLabel || "default"]: accountResult };\n`;
const rakutenBranch = `${admitadBranch}    } else if (platform === "rakuten") {\n      const accountResult = await syncRakutenAccount(accountLabel || "default");\n      recordAccountSyncComplete({\n        success: !accountResult?.failed && !accountResult?.skipped,\n      });\n      result = { [accountLabel || "default"]: accountResult };\n`;
sync = replaceOnce(sync, admitadBranch, rakutenBranch, "syncPlatformAccount branch");

const syncAllAwin = `      setSyncStage("awin");\n      jobTimer.start("awinMs");\n      const awin = await syncAwinAccount("default");\n      jobTimer.end("awinMs");\n\n      setSyncStage("admitad");\n      jobTimer.start("admitadMs");\n      const admitad = await syncAdmitadAccount("default");\n      jobTimer.end("admitadMs");\n\n      const result = { boostiny, optimise, trackier, impact, partnerize, awin, admitad };\n`;
const syncAllRakuten = `      setSyncStage("awin");\n      jobTimer.start("awinMs");\n      const awin = await syncAwinAccount("default");\n      jobTimer.end("awinMs");\n\n      setSyncStage("admitad");\n      jobTimer.start("admitadMs");\n      const admitad = await syncAdmitadAccount("default");\n      jobTimer.end("admitadMs");\n\n      setSyncStage("rakuten");\n      jobTimer.start("rakutenMs");\n      const rakuten = await syncRakutenAccount("default");\n      jobTimer.end("rakutenMs");\n\n      const result = { boostiny, optimise, trackier, impact, partnerize, awin, admitad, rakuten };\n`;
sync = replaceOnce(sync, syncAllAwin, syncAllRakuten, "syncAll Rakuten stage");

fs.writeFileSync(syncPath, sync);

const conversionPath = "src/modules/order/orderConversionIngestion.contract.js";
let conversion = fs.readFileSync(conversionPath, "utf8");
conversion = replaceOnce(
  conversion,
  '    raw.action_id,\n    raw.advertiserConversionId,\n',
  '    raw.action_id,\n    raw.etransaction_id,\n    raw.networkConversionComponentId,\n    raw.advertiserConversionId,\n',
  "Rakuten event component conversion identity",
);
fs.writeFileSync(conversionPath, conversion);

console.log("Rakuten runtime patch applied.");
