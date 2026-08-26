import { randomBytes } from "node:crypto";

/** Ambiguity-safe alphabet for short public tokens (no 0/O/1/I). */
const TOKEN_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/**
 * Canonical public base for MBO tracking links.
 * Prefer TRACKING_BASE_URL; fall back to BACKEND_URL.
 * No hardcoded localhost ports — configuration must be explicit.
 */
export function getTrackingBaseUrl() {
  const configured = process.env.TRACKING_BASE_URL || process.env.BACKEND_URL;
  if (!configured || !String(configured).trim()) {
    throw new Error(
      "TRACKING_BASE_URL (or BACKEND_URL) must be configured for MBO tracking link generation.",
    );
  }
  return String(configured).trim().replace(/\/+$/, "");
}

/** Origin (protocol + host[:port]) of the canonical tracking base. */
export function getTrackingBaseOrigin(baseUrl = getTrackingBaseUrl()) {
  return new URL(baseUrl).origin;
}

/**
 * Rewrite only the origin of an MBO tracking URL onto the canonical base.
 * Preserves pathname, query, and hash (slug/token/params unchanged).
 * Returns null when the URL is invalid or already on the canonical origin.
 */
export function rewriteTrackingUrlOrigin(mboTrackingUrl, canonicalBase = getTrackingBaseUrl()) {
  if (!mboTrackingUrl || typeof mboTrackingUrl !== "string") return null;
  let current;
  let base;
  try {
    current = new URL(mboTrackingUrl.trim());
    base = new URL(canonicalBase);
  } catch {
    return null;
  }
  if (current.protocol !== "http:" && current.protocol !== "https:") return null;
  if (current.origin === base.origin) return null;
  return `${base.origin}${current.pathname}${current.search}${current.hash}`;
}

export function slugifyTrackingPart(value) {
  if (!value) return "";
  return (
    String(value)
      .trim()
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || ""
  );
}

/**
 * Preferred slug: client-slug + merchant-slug (+ optional campaign-slug).
 * Slug is human-readable only — uniqueness is enforced by the token (subId).
 */
export function buildTrackingSlug({ clientSlug, merchantSlug, campaignSlug } = {}) {
  const parts = [clientSlug, merchantSlug, campaignSlug]
    .map((part) => slugifyTrackingPart(part))
    .filter(Boolean);

  // Drop campaign segment when it duplicates the merchant slug.
  if (parts.length >= 3 && parts[2] === parts[1]) {
    parts.pop();
  }

  return parts.join("-") || "link";
}

/** Secure unique public token (e.g. 7HF82KLM). */
export function generateTrackingToken(length = 8) {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  }
  return out;
}

/**
 * Build an MBO-owned tracking URL.
 * New format: /r/{slug}/{token}
 * Legacy callers may pass only a token string as the first argument.
 *
 * @param {string|{slug?: string, token?: string, subId?: string}} optionsOrToken
 */
export function buildMboTrackingUrl(optionsOrToken) {
  let slug = "link";
  let token = null;

  if (typeof optionsOrToken === "string") {
    token = String(optionsOrToken).trim();
  } else if (optionsOrToken && typeof optionsOrToken === "object") {
    slug = slugifyTrackingPart(optionsOrToken.slug) || "link";
    token = String(optionsOrToken.token || optionsOrToken.subId || "").trim() || null;
  }

  if (!token) token = generateTrackingToken();

  const encodedSlug = encodeURIComponent(slug);
  const encodedToken = encodeURIComponent(token);
  return {
    slug,
    subId: token,
    token,
    mboTrackingUrl: `${getTrackingBaseUrl()}/r/${encodedSlug}/${encodedToken}`,
  };
}
