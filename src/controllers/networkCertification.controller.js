import { ok, fail } from "../core/apiResponse.js";
import { NetworkCertificationService, listProbeSourceObjects } from "../modules/ops/networkCertification.service.js";

const service = new NetworkCertificationService();

/** Certification responses are never cached: each one reflects a supplier call made just now. */
function noStore(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
}

/**
 * GET /ops/admin/network-certification
 *
 * The catalog of probeable networks and source objects. Pure metadata: it resolves no credential
 * and makes no supplier call, which is what makes it safe to serve on a GET.
 */
export async function networkCertificationCatalogHandler(_req, res, next) {
  try {
    noStore(res);
    res.json(
      ok({
        networks: ["optimise"].map((network) => ({ network, sourceObjects: listProbeSourceObjects(network) })),
        execution: {
          method: "POST",
          path: "/ops/admin/network-certification/:network/run",
          note: "Execution is a POST because it initiates outbound supplier requests with stored credentials.",
        },
      }),
    );
  } catch (error) {
    next(error);
  }
}

/**
 * Validates the request body.
 *
 * Only four keys are accepted, and none of them can describe a supplier endpoint, path, query or
 * body: `sourceObjects` selects from the server-side registry by name, and the rest are scoping
 * strings. An unknown key is rejected rather than ignored, so a caller cannot smuggle a field in
 * on the assumption that some later version might read it.
 */
export function parseRunBody(body = {}) {
  const input = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const allowed = new Set(["sourceObjects", "region", "accountLabel", "compareRaw"]);
  const unexpected = Object.keys(input).filter((key) => !allowed.has(key));
  if (unexpected.length) {
    throw fail(`Unsupported field(s) in request body: ${unexpected.join(", ")}`, 400);
  }

  const { sourceObjects, region, accountLabel, compareRaw } = input;

  if (sourceObjects !== undefined) {
    if (!Array.isArray(sourceObjects) || sourceObjects.some((s) => typeof s !== "string")) {
      throw fail("sourceObjects must be an array of strings.", 400);
    }
  }
  for (const [name, value] of [
    ["region", region],
    ["accountLabel", accountLabel],
  ]) {
    if (value !== undefined && (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value))) {
      throw fail(`${name} must be a short alphanumeric identifier.`, 400);
    }
  }
  if (compareRaw !== undefined && typeof compareRaw !== "boolean") {
    throw fail("compareRaw must be a boolean.", 400);
  }

  return {
    sourceObjects: sourceObjects?.length ? sourceObjects : null,
    region: region || "sea",
    accountLabel: accountLabel || "default",
    // Default FALSE: the stored-RAW comparison is an extra database read and is opt-in.
    compareRaw: compareRaw === true,
  };
}

/**
 * POST /ops/admin/network-certification/:network/run
 *
 * Executes the probe. A POST rather than a GET because it actively initiates outbound supplier
 * requests using stored production credentials — it must not be reachable by a browser refresh,
 * a prefetch, a crawler, a proxy replay or an ordinary GET retry.
 */
export async function networkCertificationRunHandler(req, res, next) {
  try {
    noStore(res);
    const options = parseRunBody(req.body);
    const result = await service.certify(String(req.params.network || ""), options);
    res.json(ok(result));
  } catch (error) {
    next(error);
  }
}
