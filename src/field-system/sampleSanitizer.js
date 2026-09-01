const SENSITIVE_KEY =
  /password|secret|token|api[_-]?key|authorization|access[_-]?key|refresh[_-]?token|credential|private[_-]?key/i;

const MAX_SAMPLE_LENGTH = 240;

function isSensitivePath(path) {
  if (!path) return false;
  return String(path)
    .split(".")
    .some((segment) => SENSITIVE_KEY.test(segment.replace(/\[\]$/, "")));
}

/**
 * Sanitized sample for registry display — no secrets, truncated primitives.
 */
export function sanitizeSampleValue(value, { fieldPath = "" } = {}) {
  if (isSensitivePath(fieldPath)) return "[redacted]";
  if (value === null) return "null";
  if (value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (value.length <= MAX_SAMPLE_LENGTH) return value;
    return `${value.slice(0, MAX_SAMPLE_LENGTH - 3)}...`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${value.length} items]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((k) => !SENSITIVE_KEY.test(k)).slice(0, 6);
    if (!keys.length) return "{...}";
    const suffix = Object.keys(value).length > keys.length ? ", ..." : "";
    return `{${keys.join(", ")}${suffix}}`;
  }
  return String(value);
}
