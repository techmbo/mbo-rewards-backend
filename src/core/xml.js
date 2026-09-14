/**
 * Minimal XML reading primitives shared by the supplier adapters that speak XML.
 *
 * Lifted VERBATIM out of cj.adapter.js, where they were private, when Rakuten's Link Locator
 * became the second XML surface in the integration. Behaviour is unchanged by the move — CJ's
 * existing tests are the proof, and they pass untouched.
 *
 * These are deliberately regex primitives rather than a DOM parser. They read known, documented
 * element names out of known, documented envelopes; they do not attempt to be a general XML
 * implementation, and nothing here should be extended into one. Each adapter keeps its own row
 * extractor on top of these, because a <return> block and an <advertiser> block are different
 * contracts even when the reading mechanics are identical.
 */

/** Unwraps CDATA and the five predefined entities. &amp; is decoded LAST so an escaped entity
 *  such as &amp;lt; survives as literal text rather than being decoded twice. */
export function decodeXml(value) {
  return String(value ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * The text of the FIRST matching element, decoded and trimmed.
 *
 * Returns null for an empty element and for the literal string "null", which suppliers use
 * interchangeably with an absent value. The tag is regex-escaped, so an element name is never
 * interpreted as a pattern.
 */
export function tagText(xml, tag) {
  const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(xml ?? "").match(
    new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i"),
  );
  if (!match) return null;
  const value = decodeXml(match[1]).trim();
  return value === "" || value.toLowerCase() === "null" ? null : value;
}

/** The inner content of EVERY matching element, in document order and undecoded, so a caller can
 *  read fields out of each block in turn. */
export function tagBlocks(xml, tag) {
  const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "gi");
  const blocks = [];
  let match;
  while ((match = regex.exec(String(xml ?? ""))) !== null) blocks.push(match[1]);
  return blocks;
}
