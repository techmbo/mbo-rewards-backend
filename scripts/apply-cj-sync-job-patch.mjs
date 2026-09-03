import fs from "node:fs";

const path = "src/jobs/sync.job.js";
let source = fs.readFileSync(path, "utf8");

function replaceOnce(before, after, label) {
  if (source.includes(after)) return;
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one match, found ${count}`);
  source = source.replace(before, after);
}

replaceOnce(
  'import { syncRakutenAccount } from "./rakutenSupplierSync.js";\n',
  'import { syncRakutenAccount } from "./rakutenSupplierSync.js";\nimport { syncCjAccount } from "./cjSupplierSync.js";\n',
  "CJ import",
);

replaceOnce(
  '  const rakutenAccounts = await listMarketplaceAccounts("rakuten");\n  let total =\n',
  '  const rakutenAccounts = await listMarketplaceAccounts("rakuten");\n  const cjAccounts = await listMarketplaceAccounts("cj");\n  let total =\n',
  "CJ account count declaration",
);

replaceOnce(
  '    admitadAccounts.length +\n    rakutenAccounts.length;\n',
  '    admitadAccounts.length +\n    rakutenAccounts.length +\n    cjAccounts.length;\n',
  "CJ total account count",
);

replaceOnce(
  '  if (["impact", "partnerize", "awin", "admitad", "rakuten"].includes(platform)) {\n',
  '  if (["impact", "partnerize", "awin", "admitad", "rakuten", "cj"].includes(platform)) {\n',
  "CJ platform account count",
);

replaceOnce(
  '    } else if (platform === "rakuten") {\n      const accountResult = await syncRakutenAccount(accountLabel || "default");\n',
  '    } else if (platform === "cj") {\n      const accountResult = await syncCjAccount(accountLabel || "default");\n      recordAccountSyncComplete({\n        success: !accountResult?.failed && !accountResult?.skipped,\n      });\n      result = { [accountLabel || "default"]: accountResult };\n    } else if (platform === "rakuten") {\n      const accountResult = await syncRakutenAccount(accountLabel || "default");\n',
  "CJ platform dispatch",
);

replaceOnce(
  '      setSyncStage("rakuten");\n      jobTimer.start("rakutenMs");\n      const rakuten = await syncRakutenAccount("default");\n      jobTimer.end("rakutenMs");\n\n      const result = { boostiny, optimise, trackier, impact, partnerize, awin, admitad, rakuten };\n',
  '      setSyncStage("rakuten");\n      jobTimer.start("rakutenMs");\n      const rakuten = await syncRakutenAccount("default");\n      jobTimer.end("rakutenMs");\n\n      setSyncStage("cj");\n      jobTimer.start("cjMs");\n      const cj = await syncCjAccount("default");\n      jobTimer.end("cjMs");\n\n      const result = { boostiny, optimise, trackier, impact, partnerize, awin, admitad, rakuten, cj };\n',
  "CJ syncAll dispatch",
);

fs.writeFileSync(path, source);
console.log("CJ sync job integration patch applied.");
