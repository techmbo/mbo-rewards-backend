import { applyPartnerizeTrackingMigrationHandler } from "../controllers/partnerizeTrackingMigration.controller.js";
import { authenticate, requireAdminRole } from "../middleware/auth.js";
import { requireDatabaseRecoveryToken } from "../middleware/databaseRecoveryToken.js";
import { noStoreHeaders } from "../platform/security/index.js";
import { databaseRecoveryMarker } from "./databaseRecoveryRoute.js";

/**
 * The one-shot Partnerize tracking-link migration route.
 *
 * TEMPORARY. Delete this file, its controller, its service, its tests and the mount in app.js once
 * the migration has been applied and verified.
 *
 * Mounted directly on the app ahead of `app.use("/api", routes)`, for the same reason the recovery
 * diagnostic is: it must not depend on the main router's conventions.
 *
 * The gate is deliberately doubled. The break-glass token proves the caller holds an out-of-band
 * secret; `authenticate` + `requireAdminRole` prove they are a signed-in ADMIN. Either alone would
 * be weaker than the operation deserves — this writes DDL to production — and the two are
 * independent, so compromising one is not enough.
 *
 * ADMIN only. Not widened to TECH.
 *
 * Order matters. The token gate runs BEFORE `authenticate`: without a valid break-glass token the
 * route must be indistinguishable from one that does not exist, and must not consult the database
 * at all. `authenticate` performs a user lookup, so putting it first would let an unauthorised
 * caller reach the database through a route they cannot use.
 */
export const PARTNERIZE_TRACKING_MIGRATION_ROUTE_PATH =
  "/api/ops/diagnostics/apply-partnerize-tracking-migration";

/** Registers exactly one POST and touches nothing else on the app. */
export function registerPartnerizeTrackingMigrationRoute(app) {
  app.post(
    PARTNERIZE_TRACKING_MIGRATION_ROUTE_PATH,
    databaseRecoveryMarker,
    requireDatabaseRecoveryToken,
    authenticate,
    requireAdminRole,
    noStoreHeaders,
    applyPartnerizeTrackingMigrationHandler,
  );
}
