import fs from "node:fs";

const path = "src/jobs/sync.job.js";
let source = fs.readFileSync(path, "utf8");
let changed = false;

const importAnchor = `import { syncImpactAccount, syncPartnerizeAccount, syncAwinAccount } from "./waveESupplierSync.js";`;
if (!source.includes(`from "./admitadSupplierSync.js"`)) {
  if (!source.includes(importAnchor)) throw new Error("Could not find Wave E sync import anchor.");
  source = source.replace(
    importAnchor,
    `${importAnchor}\nimport { syncAdmitadAccount } from "./admitadSupplierSync.js";`,
  );
  changed = true;
}

const countAllAnchor = `  const boostinyAccounts = await listMarketplaceAccounts("boostiny");\n  const trackierAccounts = await listMarketplaceAccounts("trackier");\n  let total = boostinyAccounts.length + trackierAccounts.length;`;
if (!source.includes(`const admitadAccounts = await listMarketplaceAccounts("admitad")`)) {
  if (!source.includes(countAllAnchor)) throw new Error("Could not find countAllSyncAccounts anchor.");
  source = source.replace(
    countAllAnchor,
    `  const boostinyAccounts = await listMarketplaceAccounts("boostiny");\n  const trackierAccounts = await listMarketplaceAccounts("trackier");\n  const impactAccounts = await listMarketplaceAccounts("impact");\n  const partnerizeAccounts = await listMarketplaceAccounts("partnerize");\n  const awinAccounts = await listMarketplaceAccounts("awin");\n  const admitadAccounts = await listMarketplaceAccounts("admitad");\n  let total =\n    boostinyAccounts.length +\n    trackierAccounts.length +\n    impactAccounts.length +\n    partnerizeAccounts.length +\n    awinAccounts.length +\n    admitadAccounts.length;`,
  );
  changed = true;
}

const countPlatformAnchor = `  if (platform === "trackier") {\n    const accounts = await listMarketplaceAccounts("trackier");\n    return [...new Set(accounts.map((acc) => acc.accountLabel).filter(Boolean))].length;\n  }\n\n  return 0;`;
if (!source.includes(`platform === "admitad"`)) {
  if (!source.includes(countPlatformAnchor)) throw new Error("Could not find platform account-count anchor.");
  source = source.replace(
    countPlatformAnchor,
    `  if (platform === "trackier") {\n    const accounts = await listMarketplaceAccounts("trackier");\n    return [...new Set(accounts.map((acc) => acc.accountLabel).filter(Boolean))].length;\n  }\n\n  if (["impact", "partnerize", "awin", "admitad"].includes(platform)) {\n    const accounts = await listMarketplaceAccounts(platform);\n    return [...new Set(accounts.map((acc) => acc.accountLabel).filter(Boolean))].length;\n  }\n\n  return 0;`,
  );
  changed = true;
}

const platformAnchor = `    } else if (platform === "awin") {\n      const accountResult = await syncAwinAccount(accountLabel || "default");\n      recordAccountSyncComplete({\n        success: !accountResult?.failed && !accountResult?.skipped,\n      });\n      result = { [accountLabel || "default"]: accountResult };\n    } else {`;
if (!source.includes(`syncAdmitadAccount(accountLabel || "default")`)) {
  if (!source.includes(platformAnchor)) throw new Error("Could not find syncPlatformAccount Awin anchor.");
  source = source.replace(
    platformAnchor,
    `    } else if (platform === "awin") {\n      const accountResult = await syncAwinAccount(accountLabel || "default");\n      recordAccountSyncComplete({\n        success: !accountResult?.failed && !accountResult?.skipped,\n      });\n      result = { [accountLabel || "default"]: accountResult };\n    } else if (platform === "admitad") {\n      const accountResult = await syncAdmitadAccount(accountLabel || "default");\n      recordAccountSyncComplete({\n        success: !accountResult?.failed && !accountResult?.skipped,\n      });\n      result = { [accountLabel || "default"]: accountResult };\n    } else {`,
  );
  changed = true;
}

const allAnchor = `      setSyncStage("awin");\n      jobTimer.start("awinMs");\n      const awin = await syncAwinAccount("default");\n      jobTimer.end("awinMs");\n\n      const result = { boostiny, optimise, trackier, impact, partnerize, awin };`;
if (!source.includes(`const admitad = await syncAdmitadAccount("default")`)) {
  if (!source.includes(allAnchor)) throw new Error("Could not find syncAll Awin anchor.");
  source = source.replace(
    allAnchor,
    `      setSyncStage("awin");\n      jobTimer.start("awinMs");\n      const awin = await syncAwinAccount("default");\n      jobTimer.end("awinMs");\n\n      setSyncStage("admitad");\n      jobTimer.start("admitadMs");\n      const admitad = await syncAdmitadAccount("default");\n      jobTimer.end("admitadMs");\n\n      const result = { boostiny, optimise, trackier, impact, partnerize, awin, admitad };`,
  );
  changed = true;
}

if (!changed) {
  console.log("Admitad sync wiring already applied.");
  process.exit(0);
}

fs.writeFileSync(path, source);
console.log("Admitad sync wiring patch applied.");
