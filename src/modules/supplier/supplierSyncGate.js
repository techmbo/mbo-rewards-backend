/**
 * Supplier gating for scheduled and full-run syncs. STRICT and registry-only:
 *
 *   ENABLED row in `suppliers`         → eligible for full / scheduled syncs
 *   PLANNED (or any other status) row  → excluded
 *   no row in the registry             → excluded (UNREGISTERED)
 *   registry cannot be read            → everything excluded (REGISTRY_UNAVAILABLE)
 *
 * Code seeds never decide eligibility: only a row an operator can see and audit does. Explicit,
 * per-network admin actions (a manual /sync/:platform, a scoped unit, Test Connection) are NOT
 * gated — that is how a PLANNED network is validated before it is enabled.
 */

export const SUPPLIER_GATE_EXCLUSION_REASON = "supplier_not_enabled";
export const SUPPLIER_GATE_STATUS = Object.freeze({
  ENABLED: "ENABLED",
  UNREGISTERED: "UNREGISTERED",
  REGISTRY_UNAVAILABLE: "REGISTRY_UNAVAILABLE",
});

/** Sync platform key → SupplierKey. */
export function supplierKeyForPlatform(platform) {
  const p = String(platform || "").trim().toLowerCase();
  if (p.startsWith("optimise")) return "OPTIMISE";
  const map = {
    boostiny: "BOOSTINY",
    trackier: "TRACKIER",
    awin: "AWIN",
    partnerize: "PARTNERIZE",
    impact: "IMPACT",
    admitad: "ADMITAD",
    cj: "CJ",
    rakuten: "RAKUTEN",
  };
  return map[p] ?? null;
}

/** Build a gate from supplier rows ({ key, status }[]). Only an ENABLED row allows a platform. */
export function buildSupplierSyncGate(rows) {
  if (!Array.isArray(rows)) return unavailableSupplierSyncGate;
  const byKey = new Map(rows.map((row) => [row.key, row.status]));
  return (platform) => {
    const supplierKey = supplierKeyForPlatform(platform);
    const status = (supplierKey && byKey.get(supplierKey)) || SUPPLIER_GATE_STATUS.UNREGISTERED;
    return { allowed: status === SUPPLIER_GATE_STATUS.ENABLED, status, supplierKey };
  };
}

/** Fail-closed gate used when the registry cannot be read: nothing joins a full run. */
export function unavailableSupplierSyncGate(platform) {
  return { allowed: false, status: SUPPLIER_GATE_STATUS.REGISTRY_UNAVAILABLE, supplierKey: supplierKeyForPlatform(platform) };
}

/** Load the gate from the registry; an unreadable registry excludes every supplier. */
export async function loadSupplierSyncGate({ db } = {}) {
  try {
    if (!db?.supplier?.findMany) return unavailableSupplierSyncGate;
    return buildSupplierSyncGate(await db.supplier.findMany({ select: { key: true, status: true } }));
  } catch {
    return unavailableSupplierSyncGate;
  }
}
