/**
 * Canonical brand identity projection (v15 03A/03G / 06A/06C).
 * Prefer Merchant master for name/logo; never invent URLs.
 *
 * brandWebsiteUrl / websiteUrl (P1.7 Wave 1 / TSV 03E/03G):
 *   1. Merchant.website (Brand Master)
 *   2. SupplierCampaign.destinationUrl / landing / preview (official landing — not tracking)
 * Never SupplierCampaign.trackingUrl.
 */

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function asHttpUrl(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return trimmed;
  } catch {
    return null;
  }
}

/** Host label from a real landing URL (e.g. https://www.klook.com/ → klook.com). Not invented. */
export function brandLabelFromLandingUrl(url) {
  const href = asHttpUrl(url);
  if (!href) return null;
  try {
    const host = new URL(href).hostname.replace(/^www\./i, "").trim();
    if (!host || !host.includes(".")) return null;
    return host;
  } catch {
    return null;
  }
}

/**
 * Extract a brand label from a campaign title when advertiser name is absent.
 * e.g. "DAZN FRANCE Partners (RETIRED)" → "DAZN FRANCE", "Passware | Password Recovery" → "Passware"
 */
export function extractBrandFromCampaignName(campaignName) {
  if (!campaignName || typeof campaignName !== "string") return null;
  const name = campaignName.trim().replace(/\s*\([^)]*\)\s*$/g, "").trim();
  const pipePart = name.split("|")[0].trim();
  if (pipePart && pipePart !== name) return pipePart;
  const keywordMatch = name.match(/^(.+?)\s+(?:Partners?|Affiliates?|Programme|Program|Network)\b/i);
  if (keywordMatch) return keywordMatch[1].trim();
  const regionMatch = name.match(
    /^(.+?)\s+(?:Germany|Spain|Singapore|France|Italy|Brazil|Portugal|Belgium|Switzerland|Austria|Luxembourg|Netherlands|Poland|Sweden|Norway|Denmark|Finland|Ireland|Canada|Mexico|Australia|Japan|Korea|India|UAE|KSA|MENA|DACH|SEA|APAC|Europe|Global|US|USA|UK)\b/i,
  );
  if (regionMatch) return regionMatch[1].trim();
  return null;
}

/** Turn a host/domain label into a readable brand name (ticombo.com → Ticombo). */
export function humanizeBrandFromDomain(domainOrHost) {
  if (!domainOrHost || typeof domainOrHost !== "string") return null;
  const host = domainOrHost.trim().toLowerCase().replace(/^www\./, "");
  const root = host.split(".")[0]?.replace(/[-_]+/g, " ").trim();
  if (!root || root.length < 2) return null;
  if (/^[a-z0-9]+$/.test(root) && root.length <= 5) return root.toUpperCase();
  return root
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isDomainLikeName(value) {
  if (!value || typeof value !== "string") return false;
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(value.trim());
}

function resolveBrandDisplayName(merchantDisplayName, merchantNameRaw, landingUrl) {
  const fromCampaign = merchantNameRaw && !isDomainLikeName(merchantNameRaw) ? merchantNameRaw : null;
  const domainLabel = brandLabelFromLandingUrl(landingUrl);
  const fromDomain = humanizeBrandFromDomain(domainLabel || (isDomainLikeName(merchantNameRaw) ? merchantNameRaw : null));
  return firstPresent(merchantDisplayName, fromCampaign, fromDomain, merchantNameRaw, domainLabel, null);
}

/**
 * @param {object|null} merchant
 * @param {object|null} supplierCampaign
 * @returns {{ id: string|null, name: string|null, logoUrl: string|null, websiteUrl: string|null }}
 */
export function projectBrandIdentity(merchant = null, supplierCampaign = null) {
  const landingUrl = asHttpUrl(supplierCampaign?.destinationUrl ?? null);
  const resolved = resolveBrandDisplayName(
    merchant?.displayName ?? null,
    supplierCampaign?.merchantNameRaw ?? null,
    landingUrl,
  );
  const name = resolved != null ? String(resolved).trim() || null : null;

  return {
    id: merchant?.id ?? null,
    name,
    logoUrl: asHttpUrl(
      firstPresent(merchant?.logoUrl, supplierCampaign?.campaignLogoUrl),
    ),
    // Brand Master first; landing/preview fallback per TSV — never tracking URL.
    websiteUrl: asHttpUrl(merchant?.website ?? null) || landingUrl,
  };
}

/** Flat admin/03G keys preserved for backward compatibility. */
export function brandIdentityToAdminLinks(brand) {
  return {
    brandName: brand?.name ?? null,
    brandLogoLink: brand?.logoUrl ?? null,
    brandWebsiteLink: brand?.websiteUrl ?? null,
  };
}

/** Flat client/06C keys. */
export function brandIdentityToClientLinks(brand) {
  return {
    brandName: brand?.name ?? null,
    brandLogoUrl: brand?.logoUrl ?? null,
    brandWebsiteUrl: brand?.websiteUrl ?? null,
  };
}
