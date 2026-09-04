// Backend-owned client API path contract. Previously these tests imported CLIENT_API from the
// sibling frontend repository, which does not exist inside this backend repository. The canonical
// paths are the ones the backend router actually registers (src/routes/index.js), so the contract is
// asserted against the live route table instead of a foreign module.
import router from "../../src/routes/index.js";

export const CLIENT_API = Object.freeze({
  campaigns: "/v1/client/campaigns",
  performance: "/v1/client/performance",
  payments: "/v1/client/payments",
  products: "/v1/client/products",
});

/** Every path registered on the backend router (route layers only). */
export function registeredRoutePaths() {
  return new Set(
    (router.stack || [])
      .filter((layer) => layer?.route?.path)
      .flatMap((layer) => (Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path])),
  );
}

export function assertBackendRegisters(path) {
  const paths = registeredRoutePaths();
  if (!paths.has(path)) throw new Error(`backend router does not register ${path}`);
  return true;
}
