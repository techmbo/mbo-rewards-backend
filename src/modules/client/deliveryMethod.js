/**
 * Delivery method channel requirements (§27 / Client Operations HTML).
 */

export const DELIVERY_METHODS = {
  PORTAL_ONLY: "PORTAL_ONLY",
  API_ONLY: "API_ONLY",
  API_AND_PORTAL: "API_AND_PORTAL",
};

/**
 * @param {string} [deliveryMethod]
 * @returns {{ needsApi: boolean, needsPortal: boolean, label: string }}
 */
export function deliveryChannelRequirements(deliveryMethod = "API_AND_PORTAL") {
  const method = DELIVERY_METHODS[deliveryMethod] ? deliveryMethod : "API_AND_PORTAL";
  return {
    needsApi: method !== "PORTAL_ONLY",
    needsPortal: method !== "API_ONLY",
    label:
      method === "PORTAL_ONLY"
        ? "Portal Only"
        : method === "API_ONLY"
          ? "API Only"
          : "API + Portal",
  };
}
