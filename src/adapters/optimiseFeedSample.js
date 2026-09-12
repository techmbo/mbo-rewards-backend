/**
 * Bounded product-item sampling for certification.
 *
 * Optimise exposes product ITEMS nowhere on its API. The API (public.api.optimisemedia.com/v1)
 * serves /product-feeds/, which lists feed METADATA — feedId, feedUrl, itemCount and so on. The
 * items themselves live on a separate CDN host as one whole CSV or XML file with no row-limit,
 * offset or cursor parameter. There is no request that asks Optimise for "one product".
 *
 * So the bound cannot come from the supplier; it has to be imposed by us, on the wire. This module
 * asks for a small byte window and stops reading at it, then parses the first COMPLETE record out
 * of that window. If no complete record fits, it says so rather than widening the window.
 *
 * Two properties this module exists to guarantee:
 *
 *  - The URL is never caller-controlled. It is derived from the sampled feed row and checked
 *    against a host allowlist, so a tampered or unexpected supplier response cannot redirect the
 *    fetch at some other host.
 *  - The parse is SHAPE-PRESERVING. The sync parsers deliberately normalise supplier rows onto our
 *    own field names (parseOptimiseFeedXml builds a fixed row of ProductSKU/ProductName/... whatever
 *    the feed actually contains). Reusing them for certification would report OUR schema back to us
 *    and certify nothing. The parsers here report the supplier's own header names and tag names.
 */

/** The only hosts a certification feed sample may be fetched from. */
export const ALLOWED_FEED_HOSTS = Object.freeze(["product-feeds.optimisemedia.com"]);

/** Raised when a bounded single-record sample cannot be taken. Never carries feed content. */
export class FeedItemSampleNotBoundedError extends Error {
  constructor(reason) {
    super("A bounded single product-item sample could not be taken");
    this.name = "FeedItemSampleNotBoundedError";
    this.productItemSampleNotBounded = true;
    // A short fixed reason code, chosen from the set below. Never supplier text.
    this.reason = reason;
  }
}

export const NOT_BOUNDED_REASONS = Object.freeze([
  "NO_FEED_URL",
  "DISALLOWED_HOST",
  "NO_COMPLETE_RECORD_IN_WINDOW",
  "UNRECOGNISED_FEED_FORMAT",
]);

/**
 * The one URL a certification item sample may fetch.
 *
 * Built from the sampled feed row, never from caller input. The host must already be allowlisted
 * — a supplier response is external data, and following an arbitrary URL out of one would make the
 * probe an SSRF primitive.
 */
export function buildBoundedFeedUrl(feedRow = {}, { aid, format = "csv" } = {}) {
  const raw = feedRow?.feedUrl || feedRow?.experimentalFeedUrl || null;
  const feedId = feedRow?.feedId ?? feedRow?.id ?? null;

  let url = null;
  if (raw) {
    try {
      url = new URL(String(raw));
    } catch {
      url = null;
    }
  }
  if (!url && feedId && aid) {
    url = new URL(
      `https://product-feeds.optimisemedia.com/feeds/${encodeURIComponent(String(feedId))}`,
    );
    url.searchParams.set("aid", String(aid));
  }
  if (!url) throw new FeedItemSampleNotBoundedError("NO_FEED_URL");

  if (url.protocol !== "https:" || !ALLOWED_FEED_HOSTS.includes(url.hostname)) {
    throw new FeedItemSampleNotBoundedError("DISALLOWED_HOST");
  }

  // The CDN is case-sensitive on query keys and rejects uppercase AID.
  const aidValue = url.searchParams.get("aid") || url.searchParams.get("AID") || aid;
  url.searchParams.delete("AID");
  if (aidValue) url.searchParams.set("aid", String(aidValue));
  url.searchParams.delete("Format");
  url.searchParams.set("format", String(format));
  return url.toString();
}

/**
 * The first complete CSV record, keyed by the feed's own header names.
 *
 * When the body was truncated mid-stream the final line may be a partial record, which would
 * under-report which fields the supplier sends. It is dropped rather than parsed.
 */
export function parseFirstCsvRecord(text, { truncated = false } = {}) {
  const raw = String(text || "").replace(/^﻿/, "");
  const lines = raw.split(/\r?\n/);
  if (truncated) lines.pop();

  const populated = lines.filter((line) => line.trim().length);
  if (populated.length < 2) return null;

  const delim = populated[0].includes("\t") ? "\t" : ",";
  const headers = splitDelimited(populated[0], delim).map((h) => h.trim().replace(/^"|"$/g, ""));
  if (!headers.some((h) => h)) return null;

  const cells = splitDelimited(populated[1], delim).map((c) => c.trim().replace(/^"|"$/g, ""));
  const record = {};
  headers.forEach((header, index) => {
    if (!header) return;
    record[header] = cells[index] ?? null;
  });
  return Object.keys(record).length ? record : null;
}

function splitDelimited(line, delim) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === delim && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * The first complete XML record, keyed by the feed's own tag names.
 *
 * The block regex requires a closing tag, so a record cut off by the byte window simply does not
 * match and truncation needs no special handling. Namespace prefixes are kept (`g:price` stays
 * `g:price`) because whether a feed uses them is part of the shape being certified.
 */
export function parseFirstXmlRecord(text) {
  const raw = String(text || "");
  const block =
    raw.match(/<item[\s>][\s\S]*?<\/item>/i)?.[0] ||
    raw.match(/<product[\s>][\s\S]*?<\/product>/i)?.[0] ||
    raw.match(/<entry[\s>][\s\S]*?<\/entry>/i)?.[0] ||
    null;
  if (!block) return null;

  const record = {};
  // Leaf tags only: the inner content may not contain another element. Matching containers too
  // would consume their children's spans and hide exactly the fields being certified.
  const tagPattern = /<([A-Za-z_][\w.:-]*)\b[^>]*>((?:(?!<[A-Za-z_/])[\s\S])*?)<\/\1\s*>/g;
  let match = tagPattern.exec(block);
  while (match) {
    const [, tag, inner] = match;
    const value = inner
      .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();
    record[tag] = value === "" ? null : value;
    match = tagPattern.exec(block);
  }
  return Object.keys(record).length ? record : null;
}

/**
 * The first complete record in a partial feed body, whatever format it is in.
 *
 * Returns `{ record, feedFormat }`. Throws FeedItemSampleNotBoundedError when the byte window held
 * no complete record — a feed whose single record is larger than the window, or a body that is
 * neither CSV nor a recognised XML item list. Widening the window is deliberately not an option:
 * the bound is the point.
 */
export function parseFirstFeedRecord(text, { truncated = false } = {}) {
  const raw = String(text || "");
  const looksXml = raw.trimStart().startsWith("<") || /<(item|product|entry)[\s>]/i.test(raw);

  if (looksXml) {
    const record = parseFirstXmlRecord(raw);
    if (record) return { record, feedFormat: "XML" };
    throw new FeedItemSampleNotBoundedError("NO_COMPLETE_RECORD_IN_WINDOW");
  }

  const record = parseFirstCsvRecord(raw, { truncated });
  if (record) return { record, feedFormat: "CSV" };
  if (!raw.trim()) throw new FeedItemSampleNotBoundedError("UNRECOGNISED_FEED_FORMAT");
  throw new FeedItemSampleNotBoundedError("NO_COMPLETE_RECORD_IN_WINDOW");
}
