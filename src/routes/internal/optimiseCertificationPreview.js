/**
 * TEMPORARY — Preview-only Optimise live certification endpoint.
 *
 * REMOVE THIS FILE AND ITS ROUTE REGISTRATION once the live Optimise
 * certification has been captured. It exists only because Vercel will not
 * export Sensitive Preview/Production environment variables, so the live run
 * must happen inside a Preview runtime where those variables already exist.
 *
 * Guarantees:
 *   - Serves ONLY when process.env.VERCEL_ENV === "preview". Anything else 404s.
 *   - Requires a temporary CERTIFICATION_TOKEN via the x-certification-token
 *     header, compared in constant time. The token is never logged or echoed.
 *   - Region and sample size are FORCED (sea, 1 campaign). Request input is
 *     ignored entirely, so the caller cannot widen the supplier footprint.
 *   - Read-only: the reviewed certification core issues GET /campaigns,
 *     GET /campaigns/{id} and GET /campaigns/{id}/commission-groups only.
 *   - No database writes, no persistence, nothing written to disk.
 *   - The response passes through the reviewed sanitizer before serialization.
 *
 * All certification logic — Optimise mapping, commission mapping, sanitization,
 * field certification — is the already-reviewed code. Nothing is duplicated here.
 */

import crypto from "node:crypto";

/** Temporary route path, mounted under the app's /api prefix. */
export const PREVIEW_CERTIFICATION_ROUTE = "/internal/certification/optimise";

/** The first live run is deliberately one campaign in one region. */
export const FORCED_REGION = "sea";
export const FORCED_MAX_CAMPAIGNS = 1;
export const FORCED_ACCOUNT_LABEL = "default";
export const CERTIFICATION_TOKEN_HEADER = "x-certification-token";

/** Preview runtime only. Production and development are indistinguishable from absent. */
export function isPreviewRuntime(env = process.env) {
  return env?.VERCEL_ENV === "preview";
}

/**
 * Constant-time token comparison over SHA-256 digests, so neither the token
 * value nor its length leaks through timing.
 */
export function tokenMatches(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  if (provided.length === 0 || expected.length === 0) return false;
  const providedDigest = crypto.createHash("sha256").update(provided, "utf8").digest();
  const expectedDigest = crypto.createHash("sha256").update(expected, "utf8").digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}

/** Uniform "this route does not exist" reply. Never distinguishes why. */
function notFound(res) {
  return res.status(404).json({ ok: false, message: "Not found." });
}

/**
 * Re-scrub failure messages on the way out.
 *
 * sanitizeDeep deliberately does not rewrite free text, and the core already
 * produces scrubbed messages via safeRequestFailure — this is the second layer,
 * so a supplier message that echoes a query-string credential cannot leave the
 * runtime even if it reached meta by another path.
 */
function scrubFailures(failures = [], sanitizeErrorMessage) {
  if (!Array.isArray(failures) || typeof sanitizeErrorMessage !== "function") return [];
  return failures.map((failure) => ({
    campaignId: failure?.campaignId ?? null,
    httpStatus: typeof failure?.httpStatus === "number" ? failure.httpStatus : null,
    code: failure?.code ? sanitizeErrorMessage(failure.code, { maxLength: 60 }) : null,
    message: sanitizeErrorMessage(failure?.message ?? ""),
  }));
}

async function loadDefaultDependencies() {
  const [certificationCore, adapterModule, credentialsModule, syncModule, httpModule] = await Promise.all([
    import("../../../scripts/lib/optimiseCertification.mjs"),
    import("../../adapters/optimise.adapter.js"),
    import("../../modules/integrations/optimiseCredentials.js"),
    import("../../jobs/optimiseCommissionGroupSync.js"),
    import("../../core/httpClient.js"),
  ]);

  return {
    runCertification: certificationCore.runCertification,
    renderSummaryMarkdown: certificationCore.renderSummaryMarkdown,
    sanitizeDeep: certificationCore.sanitizeDeep,
    sanitizeErrorMessage: certificationCore.sanitizeErrorMessage,
    createOptimiseAdapter: adapterModule.createOptimiseAdapter,
    resolveOptimiseCredentials: credentialsModule.resolveOptimiseCredentials,
    selectOptimiseCommissionGroupCampaigns: syncModule.selectOptimiseCommissionGroupCampaigns,
    createHttpClient: httpModule.createHttpClient,
  };
}

/**
 * Build the handler. Dependencies are injectable so the gate can be tested
 * without a supplier, a database or a Vercel runtime.
 */
export function createOptimiseCertificationPreviewHandler({
  env = process.env,
  loadDependencies = loadDefaultDependencies,
} = {}) {
  return async function optimiseCertificationPreviewHandler(req, res, next) {
    // Gate 1: preview runtime only.
    if (!isPreviewRuntime(env)) return notFound(res);

    // Gate 2: a configured token, and a matching header. A missing token, a
    // missing header and a wrong header are all indistinguishable from the
    // route not existing.
    const expectedToken = env.CERTIFICATION_TOKEN;
    if (typeof expectedToken !== "string" || expectedToken.length === 0) return notFound(res);
    const providedToken = req?.headers?.[CERTIFICATION_TOKEN_HEADER];
    if (!tokenMatches(typeof providedToken === "string" ? providedToken : "", expectedToken)) {
      return notFound(res);
    }

    try {
      const {
        runCertification,
        renderSummaryMarkdown,
        sanitizeDeep,
        sanitizeErrorMessage,
        createOptimiseAdapter,
        resolveOptimiseCredentials,
        selectOptimiseCommissionGroupCampaigns,
        createHttpClient,
      } = await loadDependencies();

      const credentials = await resolveOptimiseCredentials(FORCED_REGION, FORCED_ACCOUNT_LABEL);

      // Report only the NAMES of what is missing. No value is ever read out.
      const missing = [];
      if (!credentials?.apiKey) missing.push("apiKey");
      if (!credentials?.agencyId) missing.push("agencyId");
      if (!credentials?.contactId) missing.push("contactId");
      if (missing.length > 0) {
        return res.status(503).json({
          ok: false,
          message: "Optimise credentials are incomplete in this Preview runtime.",
          missingCredentials: missing,
        });
      }
      if (credentials.agencyMismatch) {
        return res.status(503).json({
          ok: false,
          message: `Configured agencyId does not match the documented agency for region "${FORCED_REGION}".`,
        });
      }

      // One client, built exactly as the adapter builds its own, shared with
      // the adapter so detail and commission-group calls keep production semantics.
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

      // Region and sample size are forced; nothing from the request is used.
      const certification = await runCertification({
        httpClient,
        adapter,
        region: FORCED_REGION,
        accountLabel: FORCED_ACCOUNT_LABEL,
        scope: "joined",
        maxCampaigns: FORCED_MAX_CAMPAIGNS,
        selectCampaigns: selectOptimiseCommissionGroupCampaigns,
      });

      // Raw and normalized supplier payloads are deliberately NOT returned:
      // only the certification verdicts and the summary leave the runtime.
      const body = {
        fieldCertificationReport: certification.fieldReport,
        summary: renderSummaryMarkdown(certification),
        meta: {
          region: FORCED_REGION,
          campaignsCertified: certification.meta.campaignsCertified,
          generatedAt: new Date().toISOString(),
          campaignListPages: certification.meta.campaignListPages,
          campaignListRequests: certification.meta.campaignListRequests,
          campaignDetailsFetched: certification.meta.campaignDetailsFetched,
          commissionGroupsFetched: certification.meta.commissionGroupsFetched,
          normalizedRuleCount: certification.meta.normalizedRuleCount,
          detailRequestFailures: scrubFailures(certification.meta.detailRequestFailures, sanitizeErrorMessage),
          commissionRequestFailures: scrubFailures(certification.meta.commissionRequestFailures, sanitizeErrorMessage),
          writesPerformed: certification.meta.writesPerformed,
          supplierMutations: certification.meta.supplierMutations,
        },
      };

      // Second pass with the reviewed sanitizer immediately before serialization.
      const { value: sanitized } = sanitizeDeep(body);
      return res.json(sanitized);
    } catch (error) {
      return next(error);
    }
  };
}

export const optimiseCertificationPreviewHandler = createOptimiseCertificationPreviewHandler();
