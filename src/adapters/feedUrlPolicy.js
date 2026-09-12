/**
 * Which URLs a supplier feed download is allowed to reach.
 *
 * Feed URLs arrive inside a supplier API response. That makes them untrusted input on the same
 * footing as a request body: whoever controls the response controls where we make an outbound
 * request from inside our own network. Without a policy, a feed row is an SSRF primitive.
 *
 * The policy is an exact-host allowlist rather than a suffix or pattern match. A suffix check on
 * "optimisemedia.com" would accept `product-feeds.optimisemedia.com.attacker.test`, which is a
 * different domain entirely; a substring check would accept an attacker host carrying the string in
 * its path or query. Only an exact hostname comparison rejects both.
 *
 * This module is shared by the certification probe and the production sync downloader so the two
 * cannot drift apart — a hardening applied in one place should never leave the other exposed.
 */

/**
 * Hostnames a product feed may be downloaded from.
 *
 * Only one host is listed because only one is evidenced. A repo-wide search finds four Optimise
 * hostnames: `product-feeds.optimisemedia.com` (the feed CDN, used to build every download URL),
 * `public.api.optimisemedia.com` (the JSON API, never a feed host), and `docs.` / `www.`, which
 * appear solely in documentation prose. Nothing is added on the assumption that it might be valid.
 */
export const ALLOWED_FEED_HOSTS = Object.freeze(["product-feeds.optimisemedia.com"]);

/** Maximum redirect hops a feed download may follow. Each hop is revalidated against the policy. */
export const MAX_FEED_REDIRECTS = 3;

/** Fixed reason codes. A reason never contains the rejected URL, a host, or any response content. */
export const FEED_URL_REJECTION_REASONS = Object.freeze([
  "MALFORMED_URL",
  "NOT_HTTPS",
  "USERINFO_PRESENT",
  "LOCALHOST_HOST",
  "IP_LITERAL_HOST",
  "HOST_NOT_ALLOWED",
  "TOO_MANY_REDIRECTS",
]);

/**
 * Raised when a feed URL is refused.
 *
 * Deliberately carries no URL and no response body. A rejected URL may be attacker-chosen and a
 * rejected response may be internal, so neither belongs in an error that reaches a log line or an
 * admin API response.
 */
export class FeedUrlNotAllowedError extends Error {
  constructor(reason) {
    super(`Feed URL rejected by policy: ${reason}`);
    this.name = "FeedUrlNotAllowedError";
    this.feedUrlRejected = true;
    this.reason = reason;
  }
}

const LOCAL_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);

/**
 * Whether a hostname is an IP literal rather than a name.
 *
 * The URL parser normalises the exotic spellings — `http://2130706433/` and `http://0x7f.1/` both
 * come back as `127.0.0.1` — so a dotted-quad test after parsing catches them all. IPv6 literals
 * keep their brackets in `hostname`.
 */
function isIpLiteral(hostname) {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Parses and validates one feed URL against the policy.
 *
 * Returns the parsed URL so callers cannot accidentally validate one string and then fetch another.
 * Throws FeedUrlNotAllowedError otherwise — the call always fails closed, never falls back.
 */
export function assertAllowedFeedUrl(candidate) {
  let url;
  try {
    url = new URL(String(candidate));
  } catch {
    throw new FeedUrlNotAllowedError("MALFORMED_URL");
  }

  if (url.protocol !== "https:") throw new FeedUrlNotAllowedError("NOT_HTTPS");
  // Userinfo can disguise the real host to a careless reader and can carry credentials upstream.
  if (url.username || url.password) throw new FeedUrlNotAllowedError("USERINFO_PRESENT");

  const hostname = url.hostname.toLowerCase();
  if (LOCAL_HOSTNAMES.has(hostname)) throw new FeedUrlNotAllowedError("LOCALHOST_HOST");
  // Redundant against the allowlist below, but it names the specific danger — link-local metadata
  // endpoints and loopback services — rather than reporting a generic host mismatch.
  if (isIpLiteral(hostname)) throw new FeedUrlNotAllowedError("IP_LITERAL_HOST");
  if (!ALLOWED_FEED_HOSTS.includes(hostname)) throw new FeedUrlNotAllowedError("HOST_NOT_ALLOWED");

  return url;
}

/** Whether a URL satisfies the policy, without throwing. For filtering candidate lists. */
export function isAllowedFeedUrl(candidate) {
  try {
    assertAllowedFeedUrl(candidate);
    return true;
  } catch {
    return false;
  }
}
