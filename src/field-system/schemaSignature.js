/**
 * Structural fingerprint of raw JSON for validation/extraction caching.
 * Uses key paths and value types — not literal values — so identical API shapes reuse work.
 */
function detectType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function computeSchemaSignature(rawData) {
  const parts = [];

  function visit(value, path) {
    const dataType = detectType(value);

    if (path) {
      parts.push(`${path}:${dataType}`);
    }

    if (Array.isArray(value)) {
      if (value.length > 0 && value[0] !== null && typeof value[0] === "object") {
        visit(value[0], path ? `${path}[]` : "[]");
      } else if (path) {
        parts.push(`${path}[]:empty`);
      }
      return;
    }

    if (value && typeof value === "object") {
      const keys = Object.keys(value).sort();
      for (const key of keys) {
        const nextPath = path ? `${path}.${key}` : key;
        visit(value[key], nextPath);
      }
    }
  }

  visit(rawData, "");
  return parts.join("|");
}
