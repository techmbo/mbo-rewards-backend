/**
 * Request schemas for the two direct product-write APIs:
 *
 *   POST /ops/product-feeds/ingest    → productIngestBodySchema
 *   POST /ops/client-products/assign  → clientProductAssignBodySchema
 *
 * Both handlers previously forwarded req.body fields to the services unchecked: rows[] had no
 * cap, the supplier was any string (an unknown value reached the Prisma enum and surfaced as a
 * 500), optional feed fields accepted objects and unbounded strings, and an assignment status
 * outside the Prisma enum also surfaced as a 500. These schemas make the controllers reject bad
 * input with 400 before any service or database work.
 *
 * The supplier allow-list is not hand-written: it is derived from the product mapping
 * definitions that `mapPayload({ resourceKey: "products" })` can actually load
 * (network-mappings/<supplier>/products*.mapping.json). A supplier without a products mapping
 * cannot ingest a single row, so rejecting it up front only removes a guaranteed failure path.
 */
import { existsSync, readdirSync } from "node:fs";
import { z } from "zod";
import { fail } from "../../core/apiResponse.js";
import { NETWORK_MAPPINGS_ROOT, listMappingFiles } from "../mapping/loader.js";

/** Hard cap on rows per ingest request. Larger batches are rejected, never sliced. */
export const PRODUCT_INGEST_MAX_ROWS = 500;

/** Mirrors Prisma enum ProductFeedFormat. */
export const PRODUCT_FEED_FORMATS = Object.freeze(["CSV", "XML", "JSON", "GOOGLE_SHOPPING", "UNKNOWN"]);

/** Mirrors Prisma enum ClientProductAssignmentStatus. */
export const CLIENT_PRODUCT_ASSIGNMENT_STATUSES = Object.freeze(["ACTIVE", "PAUSED", "EXPIRED"]);

const PRODUCTS_MAPPING_FILE = /^products(\.v\d+|@[^.]+)?\.mapping\.json$/;

/**
 * Suppliers with a loadable products mapping definition, upper-cased and sorted.
 * @param {{ root?: string }} [options]
 * @returns {string[]}
 */
export function discoverProductMappedSuppliers({ root = NETWORK_MAPPINGS_ROOT } = {}) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((supplier) => listMappingFiles(supplier, { root }).some((file) => PRODUCTS_MAPPING_FILE.test(file)))
    .map((supplier) => supplier.toUpperCase())
    .sort();
}

export const PRODUCT_INGEST_SUPPLIERS = Object.freeze(discoverProductMappedSuppliers());

const MAX = Object.freeze({
  supplier: 32,
  sourceAccountLabel: 64,
  campaignSourceId: 64,
  feedExternalId: 128,
  feedName: 256,
  feedUrl: 2048,
  aid: 64,
  compressedLocation: 2048,
  creativeId: 64,
  countryHint: 8,
  merchantId: 64,
  clientId: 64,
  productId: 64,
  clientCampaignAssignmentId: 64,
});

/** Optional string field: absent or null keeps today's "not provided" meaning; anything else must be a bounded string. */
const optionalString = (max) => z.string().max(max, `must be at most ${max} characters`).nullable().optional();

const requiredId = (max) => z.string().trim().min(1, "is required").max(max, `must be at most ${max} characters`);

const feedRowSchema = z.custom(
  (value) => value != null && typeof value === "object" && !Array.isArray(value),
  "each row must be an object",
);

export const productIngestBodySchema = z.object({
  supplier: z
    .string()
    .trim()
    .min(1, "is required")
    .max(MAX.supplier, `must be at most ${MAX.supplier} characters`)
    .transform((value) => value.toUpperCase())
    .refine((value) => PRODUCT_INGEST_SUPPLIERS.includes(value), {
      message: `must be one of ${PRODUCT_INGEST_SUPPLIERS.join(", ")}`,
    }),
  rows: z
    .array(feedRowSchema, "must be an array of rows")
    .min(1, "must contain at least 1 row")
    .max(PRODUCT_INGEST_MAX_ROWS, `must contain at most ${PRODUCT_INGEST_MAX_ROWS} rows`),
  sourceAccountLabel: optionalString(MAX.sourceAccountLabel),
  campaignSourceId: optionalString(MAX.campaignSourceId),
  feedExternalId: optionalString(MAX.feedExternalId),
  feedName: optionalString(MAX.feedName),
  feedUrl: optionalString(MAX.feedUrl),
  feedFormat: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.enum(PRODUCT_FEED_FORMATS, `must be one of ${PRODUCT_FEED_FORMATS.join(", ")}`))
    .nullable()
    .optional(),
  aid: optionalString(MAX.aid),
  compressedLocation: optionalString(MAX.compressedLocation),
  creativeId: optionalString(MAX.creativeId),
  countryHint: optionalString(MAX.countryHint),
  merchantId: optionalString(MAX.merchantId),
});

export const clientProductAssignBodySchema = z.object({
  clientId: requiredId(MAX.clientId),
  productId: requiredId(MAX.productId),
  clientCampaignAssignmentId: z
    .string()
    .trim()
    .min(1, "must not be empty")
    .max(MAX.clientCampaignAssignmentId, `must be at most ${MAX.clientCampaignAssignmentId} characters`)
    .nullable()
    .optional(),
  status: z
    .enum(CLIENT_PRODUCT_ASSIGNMENT_STATUSES, `must be one of ${CLIENT_PRODUCT_ASSIGNMENT_STATUSES.join(", ")}`)
    .optional()
    .default("ACTIVE"),
});

/**
 * Parse a request body or throw the project's `fail(message, 400)` error. The message names the
 * first offending field and the rule it broke; Zod issue objects never reach the response.
 */
export function parseProductWriteBody(schema, body) {
  const result = schema.safeParse(body != null && typeof body === "object" && !Array.isArray(body) ? body : {});
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue?.path?.length ? issue.path.map(String).join(".") : "body";
  throw fail(`Invalid request body: ${field} ${issue?.message || "is invalid"}`, 400);
}

export function parseProductIngestBody(body) {
  return parseProductWriteBody(productIngestBodySchema, body);
}

export function parseClientProductAssignBody(body) {
  return parseProductWriteBody(clientProductAssignBodySchema, body);
}
