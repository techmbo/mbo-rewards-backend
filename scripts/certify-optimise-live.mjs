#!/usr/bin/env node
/**
 * Optimise LIVE supplier data certification — READ-ONLY.
 *
 * Proves how real Optimise API data flows through the existing adapter and the
 * existing production normalization into the MBO canonical representation.
 *
 *   node scripts/certify-optimise-live.mjs sea
 *   node scripts/certify-optimise-live.mjs mena default
 *   node scripts/certify-optimise-live.mjs uk default --scope all --max-campaigns 3
 *
 * Guarantees:
 *   - GET requests only (adapter fetchCampaigns / fetchCommissionGroups).
 *   - At most 5 campaigns are certified; commission-group requests are capped
 *     by the same production selector the sync job uses.
 *   - No database writes, no supplier mutations, no persistence of any kind.
 *   - No api key, token, authorization header, database URL or other secret is
 *     ever printed or written to the evidence files.
 *
 * Output: certification-output/optimise/<region>/<timestamp>/ (gitignored).
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  MAX_CERTIFIED_CAMPAIGNS,
  REGIONS,
  renderSummaryMarkdown,
  runCertification,
} from "./lib/optimiseCertification.mjs";

/** Environment variable NAMES per region. Values are never read for display. */
export const REGION_ENV_NAMES = Object.freeze({
  sea: { apiKey: "OPTIMISE_API_KEY", contactId: "OPTIMISE_SEA_CONTACT_ID" },
  mena: { apiKey: "OPTIMISE_MENA_API_KEY", contactId: "OPTIMISE_MENA_CONTACT_ID" },
  uk: { apiKey: "OPTIMISE_UK_API_KEY", contactId: "OPTIMISE_UK_CONTACT_ID" },
});

/**
 * Production modules are loaded lazily: importing the adapter pulls the app's
 * shared config, which requires BACKEND_URL / FRONTEND_URL. Loading it inside
 * main lets the runner report that as a clear prerequisite instead of dying
 * with an import-time stack trace, and keeps this module importable by tests.
 */
async function loadProductionModules() {
  try {
    const [adapterModule, credentialsModule, httpModule] = await Promise.all([
      import("../src/adapters/optimise.adapter.js"),
      import("../src/modules/integrations/optimiseCredentials.js"),
      import("../src/core/httpClient.js"),
    ]);
    return {
      createOptimiseAdapter: adapterModule.createOptimiseAdapter,
      resolveOptimiseCredentials: credentialsModule.resolveOptimiseCredentials,
      createHttpClient: httpModule.createHttpClient,
    };
  } catch (error) {
    const missing = /Missing required environment variable: (\w+)/.exec(String(error?.message ?? ""));
    if (missing) {
      throw new Error(
        `${missing[1]} must be set before the runner can load the Optimise adapter. ` +
          "Required application configuration: BACKEND_URL, FRONTEND_URL, JWT_SECRET, " +
          "OAUTH_TOKEN_ENCRYPTION_KEY, DATABASE_URL, DIRECT_URL.",
      );
    }
    throw error;
  }
}

export function parseArgs(argv = []) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const [name, inlineValue] = token.slice(2).split("=");
      flags[name] = inlineValue ?? (argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : "true");
      continue;
    }
    positional.push(token);
  }

  const region = String(positional[0] ?? "").toLowerCase();
  const accountLabel = positional[1] ? String(positional[1]) : "default";
  const scope = flags.scope === "all" ? "all" : "joined";
  const requestedMax = Number(flags["max-campaigns"] ?? MAX_CERTIFIED_CAMPAIGNS);
  const maxCampaigns = Number.isFinite(requestedMax) && requestedMax > 0
    ? Math.min(Math.floor(requestedMax), MAX_CERTIFIED_CAMPAIGNS)
    : MAX_CERTIFIED_CAMPAIGNS;

  return { region, accountLabel, scope, maxCampaigns, outDir: flags.out ?? null };
}

/** Safe label for display — never echoes anything credential-shaped. */
export function safeAccountLabel(value) {
  return String(value ?? "default").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "default";
}

export function hostOf(baseUrl) {
  try {
    return new URL(String(baseUrl)).host;
  } catch {
    return "(unparseable base URL)";
  }
}

/**
 * PRESENT/MISSING only. This function must never return a secret value.
 */
export function credentialReport(credentials, region) {
  const envNames = REGION_ENV_NAMES[region] ?? {};
  const apiKeyPresent = Boolean(credentials?.apiKey);
  const agencyIdPresent = Boolean(credentials?.agencyId);
  const contactIdPresent = Boolean(credentials?.contactId);
  const fromDatabase = String(credentials?.sources?.apiKey ?? "").startsWith("marketplace_account");

  const missing = [];
  if (!apiKeyPresent) {
    missing.push(`apiKey — set env ${envNames.apiKey ?? "OPTIMISE_<REGION>_API_KEY"} or configure a MarketplaceAccount for platform "optimise_${region}"`);
  }
  if (!agencyIdPresent) {
    missing.push(`agencyId — set MarketplaceAccount.agencyId for platform "optimise_${region}" (documented defaults: sea 118, mena 172, uk 1)`);
  }
  if (!contactIdPresent) {
    missing.push(`contactId — set env ${envNames.contactId ?? "OPTIMISE_<REGION>_CONTACT_ID"} or MarketplaceAccount.contactId`);
  }

  return {
    lines: [
      "OPTIMISE LIVE CONFIG",
      `region: ${region}`,
      `accountLabel: ${safeAccountLabel(credentials?.accountLabel)}`,
      `apiKey: ${apiKeyPresent ? "PRESENT" : "MISSING"}`,
      `agencyId: ${agencyIdPresent ? "PRESENT" : "MISSING"}`,
      `contactId: ${contactIdPresent ? "PRESENT" : "MISSING"}`,
      `database credential source available: ${fromDatabase ? "YES" : "NO"}`,
      `base URL host: ${hostOf(credentials?.baseURL)}`,
    ],
    complete: apiKeyPresent && agencyIdPresent && contactIdPresent,
    missing,
    agencyMismatch: Boolean(credentials?.agencyMismatch),
  };
}

/** Repo root, derived from this file's location rather than the caller's cwd. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The only directory supplier evidence may ever be written into. */
export const EVIDENCE_ROOT = path.join(REPO_ROOT, "certification-output");

export function outputDirFor({ region, startedAt, root = REPO_ROOT }) {
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  return path.join(root, "certification-output", "optimise", region, stamp);
}

/**
 * Confine evidence to <repo>/certification-output/.
 *
 * --out is operator input; without this, a typo or a stray path could scatter
 * raw supplier payloads into a tracked directory or anywhere on the disk.
 * Rejects traversal and symlink-style escapes by comparing resolved paths.
 */
export function resolveOutputDir(requested, { evidenceRoot = EVIDENCE_ROOT } = {}) {
  const resolved = path.resolve(requested);
  const rootWithSep = evidenceRoot.endsWith(path.sep) ? evidenceRoot : `${evidenceRoot}${path.sep}`;
  if (resolved !== evidenceRoot && !resolved.startsWith(rootWithSep)) {
    throw new Error(
      `Refusing to write supplier evidence outside ${evidenceRoot}. --out must name a directory inside it (got: ${resolved}).`,
    );
  }
  return resolved;
}

/** Add the ignore rule only if certification output is not already ignored. */
export async function ensureGitignored(root = REPO_ROOT) {
  const gitignorePath = path.join(root, ".gitignore");
  let current = "";
  try {
    current = await fs.readFile(gitignorePath, "utf8");
  } catch {
    current = "";
  }
  if (/^certification-output\/?$/m.test(current)) return { changed: false, gitignorePath };
  const suffix = current.endsWith("\n") || current === "" ? "" : "\n";
  await fs.writeFile(
    gitignorePath,
    `${current}${suffix}\n# Live supplier certification evidence (never committed)\ncertification-output/\n`,
    "utf8",
  );
  return { changed: true, gitignorePath };
}

export async function writeArtifacts(dir, report) {
  await fs.mkdir(dir, { recursive: true });
  const files = [
    ["01-campaigns-raw.sanitized.json", { meta: report.meta, campaigns: report.campaignsRaw }],
    ["02-campaign-details-raw.sanitized.json", { meta: report.meta, campaignDetails: report.campaignDetailsRaw }],
    ["03-campaigns-mbo-normalized.json", { meta: report.meta, campaigns: report.campaignsNormalized }],
    ["04-commission-groups-raw.sanitized.json", { meta: report.meta, commissionGroups: report.groupsRaw }],
    ["05-commission-rules-mbo-normalized.json", { meta: report.meta, campaigns: report.rulesNormalized }],
    ["06-field-certification-report.json", { meta: report.meta, ...report.fieldReport }],
  ];

  for (const [name, payload] of files) {
    await fs.writeFile(path.join(dir, name), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
  await fs.writeFile(path.join(dir, "07-summary.md"), renderSummaryMarkdown(report), "utf8");
  return [...files.map(([name]) => name), "07-summary.md"];
}

export async function main(argv = process.argv.slice(2)) {
  const { region, accountLabel, scope, maxCampaigns, outDir } = parseArgs(argv);

  if (!REGIONS.includes(region)) {
    console.error(`Usage: node scripts/certify-optimise-live.mjs <${REGIONS.join("|")}> [accountLabel] [--scope joined|all] [--max-campaigns 1-${MAX_CERTIFIED_CAMPAIGNS}]`);
    return 2;
  }

  // Validate the output location BEFORE any supplier call, so an unusable
  // --out is never discovered only after evidence has been fetched.
  let requestedOutDir = null;
  if (outDir) {
    try {
      requestedOutDir = resolveOutputDir(outDir);
    } catch (error) {
      console.error(error.message);
      return 2;
    }
  }

  const { createOptimiseAdapter, createHttpClient, resolveOptimiseCredentials } = await loadProductionModules();

  const credentials = await resolveOptimiseCredentials(region, accountLabel);
  const report = credentialReport(credentials, region);
  console.log(report.lines.join("\n"));
  console.log("");

  if (!report.complete) {
    console.error("Incomplete Optimise credentials. Missing:");
    for (const item of report.missing) console.error(`  - ${item}`);
    console.error("\nNo supplier call was attempted.");
    return 1;
  }
  if (report.agencyMismatch) {
    console.error(`Refusing to run: configured agencyId does not match the documented agency for region "${region}".`);
    return 1;
  }

  // One shared client, built exactly as createOptimiseAdapter builds its own
  // (Authorization + apikey + x-agency-id + x-contact-id). The adapter is given
  // this same instance, so campaign detail and commission-group calls keep
  // production semantics while the campaign LIST goes through the capped,
  // single-request certification path.
  const httpClient = createHttpClient({
    baseURL: credentials.baseURL,
    apiKey: credentials.apiKey,
    headers: {
      apikey: String(credentials.apiKey),
      "x-agency-id": String(credentials.agencyId),
      "x-contact-id": String(credentials.contactId),
    },
  });

  const adapter = createOptimiseAdapter({
    apiKey: credentials.apiKey,
    baseURL: credentials.baseURL,
    agencyId: credentials.agencyId,
    contactId: credentials.contactId,
    httpClient,
  });
  adapter.agencyId = credentials.agencyId;
  adapter.contactId = credentials.contactId;

  const startedAt = new Date();
  const certification = await runCertification({
    httpClient,
    adapter,
    region,
    accountLabel: safeAccountLabel(credentials.accountLabel),
    scope,
    maxCampaigns,
  });

  const ignore = await ensureGitignored();
  if (ignore.changed) console.log(`Added certification-output/ to ${ignore.gitignorePath}`);

  const dir = requestedOutDir ?? outputDirFor({ region, startedAt });
  const written = await writeArtifacts(dir, certification);

  const counts = certification.fieldReport.statusCounts;
  console.log(`Campaign-list pages: ${certification.meta.campaignListPages} (pagination disabled)`);
  console.log(`Outbound GET /campaigns requests, retries included: ${certification.meta.campaignListRequests}`);
  console.log(`Campaign rows returned by that page: ${certification.meta.campaignListPage.rowsReturnedBySupplier} (limit ${certification.meta.campaignListPage.requestedLimit})`);
  console.log(`Campaigns certified: ${certification.meta.campaignsCertified}`);
  console.log(
    `Campaign detail requests issued: ${certification.meta.detailRequestsIssued} · responses succeeded: ${certification.meta.campaignDetailResponsesSucceeded}`,
  );
  console.log(
    `Campaign rows with detail evidence: ${certification.meta.campaignRowsWithDetailEvidence} (reused cached: ${certification.meta.rowsReusingCachedDetail})`,
  );
  console.log(`Commission groups fetched: ${certification.meta.commissionGroupsFetched}`);
  console.log(`Normalized SupplierCommissionRule records: ${certification.meta.normalizedRuleCount}`);
  console.log(`Values redacted: ${certification.meta.redactionCount}`);
  console.log("");
  for (const [status, count] of Object.entries(counts)) console.log(`${status}: ${count}`);
  console.log("");
  console.log(`MAPPING_GAP entries: ${certification.fieldReport.mappingGaps.length}`);
  console.log(`New supplier concepts: ${certification.fieldReport.newSupplierConcepts.length}`);
  console.log("");
  console.log(`Evidence written to ${dir}`);
  for (const name of written) console.log(`  - ${name}`);
  console.log("\nRead-only: 0 database writes, 0 supplier mutations. Do not commit the evidence directory.");

  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`Certification failed: ${error?.message ?? error}`);
      process.exit(1);
    });
}
