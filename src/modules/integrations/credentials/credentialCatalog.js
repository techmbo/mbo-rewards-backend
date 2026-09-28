/**
 * The fixed per-network credential allow-list.
 *
 * A Network Connection (MarketplaceAccount) never names a secret itself. Its secretRef names a
 * PROVIDER and a profile; the provider may only read the slots and names listed here for the
 * connection's own platform. A user-supplied value therefore can never reach an arbitrary
 * environment variable or secret: anything not in this catalog is refused before any lookup.
 *
 * Slots are the credential roles the existing sync code already reads from a MarketplaceAccount:
 *   primarySecret    → getMarketplaceApiKey          (API key / access token / Impact account SID)
 *   secondarySecret  → getMarketplaceRefreshToken    (Partnerize user API key, Impact auth token)
 *   accountExternalId→ getMarketplaceExternalId      (publisher id)
 *   contactId        → getMarketplaceAccountIdentifiers().contactId (Optimise contact id)
 *
 * `env` lists the environment variable names the env provider may read for each slot. They are
 * the names production uses today; nothing outside this file may name them.
 */
export const CREDENTIAL_SLOTS = Object.freeze({
  PRIMARY_SECRET: "primarySecret",
  SECONDARY_SECRET: "secondarySecret",
  ACCOUNT_EXTERNAL_ID: "accountExternalId",
  CONTACT_ID: "contactId",
});

/** Slots holding secrets (never returned, logged or stored in plaintext). The rest are identifiers. */
export const SECRET_SLOTS = Object.freeze(new Set([CREDENTIAL_SLOTS.PRIMARY_SECRET, CREDENTIAL_SLOTS.SECONDARY_SECRET]));

const S = CREDENTIAL_SLOTS;

export const NETWORK_CREDENTIAL_CATALOG = Object.freeze({
  optimise_sea: Object.freeze({
    authType: "api_key",
    slots: Object.freeze({
      [S.PRIMARY_SECRET]: Object.freeze({ env: "OPTIMISE_API_KEY", required: true }),
      [S.CONTACT_ID]: Object.freeze({ env: "OPTIMISE_SEA_CONTACT_ID", required: true }),
    }),
  }),
  optimise_mena: Object.freeze({
    authType: "api_key",
    slots: Object.freeze({
      [S.PRIMARY_SECRET]: Object.freeze({ env: "OPTIMISE_MENA_API_KEY", required: true }),
      [S.CONTACT_ID]: Object.freeze({ env: "OPTIMISE_MENA_CONTACT_ID", required: true }),
    }),
  }),
  optimise_uk: Object.freeze({
    authType: "api_key",
    slots: Object.freeze({
      [S.PRIMARY_SECRET]: Object.freeze({ env: "OPTIMISE_UK_API_KEY", required: true }),
      [S.CONTACT_ID]: Object.freeze({ env: "OPTIMISE_UK_CONTACT_ID", required: true }),
    }),
  }),
  boostiny: Object.freeze({
    authType: "api_key",
    slots: Object.freeze({
      [S.PRIMARY_SECRET]: Object.freeze({ env: "BOOSTINY_API_KEY", required: true }),
    }),
  }),
  trackier: Object.freeze({
    authType: "api_key",
    slots: Object.freeze({
      [S.PRIMARY_SECRET]: Object.freeze({ env: "VCOMMISSION_API_KEY", required: true }),
    }),
  }),
  awin: Object.freeze({
    authType: "api_key",
    slots: Object.freeze({
      [S.PRIMARY_SECRET]: Object.freeze({ env: "AWIN_ACCESS_TOKEN", required: true }),
      [S.ACCOUNT_EXTERNAL_ID]: Object.freeze({ env: "AWIN_PUBLISHER_ID", required: true }),
    }),
  }),
  partnerize: Object.freeze({
    authType: "api_key",
    slots: Object.freeze({
      [S.PRIMARY_SECRET]: Object.freeze({ env: "PARTNERIZE_APPLICATION_KEY", required: true }),
      [S.SECONDARY_SECRET]: Object.freeze({ env: "PARTNERIZE_USER_API_KEY", required: true }),
      [S.ACCOUNT_EXTERNAL_ID]: Object.freeze({ env: "PARTNERIZE_PUBLISHER_ID", required: true }),
    }),
  }),
  impact: Object.freeze({
    authType: "api_key",
    slots: Object.freeze({
      [S.PRIMARY_SECRET]: Object.freeze({ env: "IMPACT_ACCOUNT_SID", required: true }),
      [S.SECONDARY_SECRET]: Object.freeze({ env: "IMPACT_AUTH_TOKEN", required: true }),
    }),
  }),
});

export function credentialProfile(platform) {
  const key = String(platform || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(NETWORK_CREDENTIAL_CATALOG, key)
    ? NETWORK_CREDENTIAL_CATALOG[key]
    : null;
}

export function listCredentialPlatforms() {
  return Object.keys(NETWORK_CREDENTIAL_CATALOG);
}
