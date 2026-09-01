import "dotenv/config";
import { syncAll } from "../src/jobs/sync.job.js";
import {
  getActiveSyncPromise,
  getSyncStatus,
  isSyncRunning,
  runSyncInBackground,
} from "../src/jobs/syncState.js";
import { prisma } from "../src/database/prisma.js";

const fast = ["1", "true", "yes"].includes(String(process.env.FAST_SYNC || "").trim().toLowerCase());

if (isSyncRunning()) {
  console.error("A sync is already in progress in this process. Aborting.");
  process.exit(1);
}

const launch = runSyncInBackground(
  "cliSyncAll",
  () =>
    syncAll({
      fastSync: fast,
      promoteAfter: process.env.AUTO_PROMOTE_AFTER_SYNC !== "false",
    }),
  { trigger: "cli" },
);

if (!launch.started) {
  console.error(launch.reason || "Could not start sync");
  console.error(JSON.stringify(launch.status, null, 2));
  process.exit(1);
}

try {
  const promise = getActiveSyncPromise();
  if (promise) await promise;
  const status = getSyncStatus();
  console.log(JSON.stringify(status.result ?? status, null, 2));
  if (status.status === "failed") process.exit(1);
} finally {
  await prisma.$disconnect();
}
