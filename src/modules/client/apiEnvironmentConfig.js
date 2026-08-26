/**
 * Default + normalize Client.apiEnvironmentConfig (Sandbox / Production endpoint toggles).
 */

export const DEFAULT_ENV_CONFIG = {
  SANDBOX: {
    status: "ACTIVE",
    campaignEndpoint: true,
    productEndpoint: true,
    reportingEndpoint: true,
  },
  PRODUCTION: {
    status: "ACTIVE",
    campaignEndpoint: true,
    productEndpoint: true,
    reportingEndpoint: true,
  },
};

function normalizeEnvBlock(input = {}, fallback = DEFAULT_ENV_CONFIG.PRODUCTION) {
  return {
    status: input.status === "DISABLED" ? "DISABLED" : "ACTIVE",
    campaignEndpoint: input.campaignEndpoint !== false,
    productEndpoint: input.productEndpoint !== false,
    reportingEndpoint: input.reportingEndpoint !== false,
  };
}

export function normalizeApiEnvironmentConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    SANDBOX: normalizeEnvBlock(src.SANDBOX || src.sandbox, DEFAULT_ENV_CONFIG.SANDBOX),
    PRODUCTION: normalizeEnvBlock(src.PRODUCTION || src.production, DEFAULT_ENV_CONFIG.PRODUCTION),
  };
}

/**
 * @param {object|null} config
 * @param {'SANDBOX'|'PRODUCTION'} environment
 * @param {'campaign'|'product'|'reporting'} endpoint
 */
export function isApiEndpointEnabled(config, environment, endpoint) {
  const normalized = normalizeApiEnvironmentConfig(config);
  const env = environment === "SANDBOX" ? "SANDBOX" : "PRODUCTION";
  const block = normalized[env];
  if (block.status === "DISABLED") return false;
  if (endpoint === "campaign") return block.campaignEndpoint !== false;
  if (endpoint === "product") return block.productEndpoint !== false;
  if (endpoint === "reporting") return block.reportingEndpoint !== false;
  return true;
}
