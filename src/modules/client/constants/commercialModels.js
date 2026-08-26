export const COMMERCIAL_MODELS = {
  OFFERS_ONLY: "OFFERS_ONLY",
  OFFERS_PLUS_COMMISSION: "OFFERS_PLUS_COMMISSION",
};

/**
 * Presets stored as ratio bases on ClientCommissionRule.
 * Attribution uses client/gross as a ratio against approved supplier commission.
 */
export const COMMERCIAL_MODEL_PRESETS = {
  OFFERS_ONLY: {
    key: "OFFERS_ONLY",
    label: "Offers Only",
    clientSharePercent: 0,
    mboSharePercent: 100,
    grossCommission: "100.0000",
    clientCommission: "0.0000",
    commissionType: "PERCENT",
  },
  OFFERS_PLUS_COMMISSION: {
    key: "OFFERS_PLUS_COMMISSION",
    label: "Offers + Commission",
    clientSharePercent: 70,
    mboSharePercent: 30,
    grossCommission: "100.0000",
    clientCommission: "70.0000",
    commissionType: "PERCENT",
  },
};

function toShareNumber(value, fallback) {
  if (value == null || value === "") return fallback;
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return num;
}

function formatShare(value) {
  return Number(value).toFixed(4);
}

/**
 * @param {string|null|undefined} model
 * @param {number|string|null|undefined} [clientSharePercent] Override for OFFERS_PLUS_COMMISSION (0–100).
 */
export function resolveCommercialPreset(model, clientSharePercent) {
  const base = COMMERCIAL_MODEL_PRESETS[model];
  if (!base) return null;

  if (model === COMMERCIAL_MODELS.OFFERS_ONLY) {
    return {
      ...base,
      clientSharePercent: 0,
      mboSharePercent: 100,
      clientCommission: "0.0000",
      grossCommission: "100.0000",
    };
  }

  const share = toShareNumber(clientSharePercent, base.clientSharePercent);
  const clamped = Math.min(100, Math.max(0, share));
  const mbo = 100 - clamped;

  return {
    ...base,
    clientSharePercent: clamped,
    mboSharePercent: mbo,
    grossCommission: "100.0000",
    clientCommission: formatShare(clamped),
  };
}
