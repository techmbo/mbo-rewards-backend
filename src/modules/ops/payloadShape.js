/**
 * Structural summarisation of a supplier payload.
 *
 * The certification probe needs to report what SHAPE a supplier response has — which paths exist,
 * how often they are populated, whether they hold scalars, arrays or objects — without any of the
 * content. This module is the boundary that guarantees it.
 *
 * The guarantee is positional, not filter-based: `summarisePayloads` builds its output from path
 * names and a category derived from each value, and there is no code path that copies a value into
 * the result. Nothing is redacted after the fact, because nothing that could need redacting is ever
 * put in. A denylist would only ever be a second line of defence, and it is used solely to blank
 * the CATEGORY of credential-shaped keys so that even "this key holds a long opaque string" is not
 * reported for them.
 */

/** Structural categories. These are the only value-derived information that leaves this module. */
export const SHAPE_CATEGORIES = Object.freeze([
  "STRING",
  "NUMBER",
  "BOOLEAN",
  "ISO_DATE",
  "URL",
  "CURRENCY_CODE",
  "ID_LIKE",
  "ARRAY",
  "OBJECT",
  "NULL",
  "REDACTED",
]);

/**
 * Key names whose category is suppressed. The path is still reported — knowing a credential field
 * exists in the response is useful — but nothing about its content is, not even its shape.
 */
const CREDENTIAL_KEY_PATTERN =
  /(^|[._-])(api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|secret|secret[_-]?ref|password|passwd|pwd|authorization|auth|signature|sig|hmac|credential|private[_-]?key|session|cookie)([._-]|$)/i;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const URL_PATTERN = /^(https?:|ftp:|sftp:|\/\/)/i;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * camelCase carries no separator, so `sessionId` would slip past a pattern anchored on `_`, `-`
 * or `.`. Inserting a boundary before each capital makes the match spelling-independent.
 */
function withCamelBoundaries(text) {
  return String(text ?? "").replace(/([a-z0-9])([A-Z])/g, "$1_$2");
}

export function isCredentialKey(path) {
  const raw = String(path ?? "");
  const leaf = raw.split(".").pop() ?? "";
  return [leaf, raw, withCamelBoundaries(leaf), withCamelBoundaries(raw)].some((candidate) =>
    CREDENTIAL_KEY_PATTERN.test(candidate),
  );
}

/**
 * The category of a single value. Only the value's SHAPE informs the result; the value itself is
 * never returned, embedded or measured beyond the tests below.
 */
export function categorise(value, path = "") {
  if (isCredentialKey(path)) return "REDACTED";
  if (value === null || value === undefined) return "NULL";
  if (Array.isArray(value)) return "ARRAY";
  if (typeof value === "object") return "OBJECT";
  if (typeof value === "boolean") return "BOOLEAN";
  if (typeof value === "number") return "NUMBER";
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return "STRING";
    if (URL_PATTERN.test(text)) return "URL";
    if (ISO_DATE_PATTERN.test(text)) return "ISO_DATE";
    if (CURRENCY_PATTERN.test(text)) return "CURRENCY_CODE";
    if (ID_PATTERN.test(text) && /\d/.test(text)) return "ID_LIKE";
    return "STRING";
  }
  return "STRING";
}

/**
 * Collects every path in one record.
 *
 * Array indices collapse to `[]` so that a hundred rows of the same array report one path rather
 * than a hundred. Depth and breadth are bounded so a pathological payload cannot hang the probe.
 */
export function collectPaths(record, { maxDepth = 8, maxPaths = 2000 } = {}) {
  const out = new Map();

  const walk = (value, path, depth) => {
    if (out.size >= maxPaths) return;
    const category = categorise(value, path);
    if (path) {
      const existing = out.get(path);
      if (existing) existing.add(category);
      else out.set(path, new Set([category]));
    }
    if (depth >= maxDepth) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 50)) walk(item, path ? `${path}[]` : "[]", depth + 1);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        walk(child, path ? `${path}.${key}` : key, depth + 1);
      }
    }
  };

  walk(record, "", 0);
  return out;
}

/**
 * Field dictionary across a set of records.
 *
 * `presentCount` counts records in which the path exists and is not null, which is what makes
 * "mapped but never seen" answerable. A path seen only as null in every record is reported with
 * nullableObserved true and presentCount 0.
 */
export function summarisePayloads(records, { maxDepth = 8, maxPaths = 2000 } = {}) {
  const rows = Array.isArray(records) ? records : [];
  const acc = new Map();

  for (const record of rows) {
    const paths = collectPaths(record, { maxDepth, maxPaths });
    for (const [path, categories] of paths) {
      let entry = acc.get(path);
      if (!entry) {
        entry = {
          path,
          categories: new Set(),
          presentCount: 0,
          nullCount: 0,
          arrayObserved: false,
          objectObserved: false,
        };
        acc.set(path, entry);
      }
      for (const category of categories) {
        entry.categories.add(category);
        if (category === "ARRAY") entry.arrayObserved = true;
        if (category === "OBJECT") entry.objectObserved = true;
      }
      if (categories.size === 1 && categories.has("NULL")) entry.nullCount += 1;
      else entry.presentCount += 1;
    }
  }

  const sampleCount = rows.length;
  return [...acc.values()]
    .map((entry) => {
      const categories = [...entry.categories];
      const nonNull = categories.filter((c) => c !== "NULL");
      return {
        path: entry.path,
        observedType: nonNull.length === 1 ? nonNull[0] : nonNull.length ? "MIXED" : "NULL",
        exampleCategory: categories.includes("REDACTED") ? "REDACTED" : nonNull[0] || "NULL",
        nullableObserved: entry.nullCount > 0 || entry.presentCount < sampleCount,
        arrayObserved: entry.arrayObserved,
        objectObserved: entry.objectObserved,
        presentCount: entry.presentCount,
        sampleCount,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Compares live paths with paths already present in stored RAW rows.
 *
 * Only path names are compared; no stored value is read into the result.
 */
export function comparePathSets(livePaths = [], rawPaths = []) {
  const live = new Set(livePaths);
  const raw = new Set(rawPaths);
  const all = [...new Set([...live, ...raw])].sort();
  return all.map((path) => ({
    path,
    state: live.has(path) && raw.has(path) ? "LIVE_AND_RAW" : live.has(path) ? "LIVE_ONLY" : "RAW_ONLY",
  }));
}
