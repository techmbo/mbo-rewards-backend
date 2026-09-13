import { databaseRecoveryDiagnosticHandler } from "../controllers/databaseRecoveryDiagnostic.controller.js";
import { requireDatabaseRecoveryToken } from "../middleware/databaseRecoveryToken.js";
import { noStoreHeaders } from "../platform/security/index.js";

/**
 * The emergency diagnostic route, mounted on its own.
 *
 * TEMPORARY. Delete this file, its middleware, its service, its controller and the
 * DB_RECOVERY_DIAGNOSTIC_TOKEN variable once the database is recovered.
 *
 * It lives outside `routes/index.js` and is mounted directly on the app, ahead of
 * `app.use("/api", routes)`. There is no global authentication on `/api` or `/api/ops` today —
 * every route carries its own gate — but "today" is the operative word: this route exists precisely
 * because the normal gate cannot function, and it should not be able to break again because someone
 * later adds a `router.use(authenticate)` to the main router. Mounting it earlier makes that
 * structural rather than a convention.
 *
 * The marker header runs FIRST, before the token gate, so every response the route can produce
 * carries it — 200, 401 and 503 alike. That is the point of it: the break-glass refusal is
 * deliberately byte-identical to `authenticate`'s refusal, so without a marker there is no way to
 * tell from a response which layer answered. The header carries no secret and says nothing about
 * whether a token was presented or was correct.
 */

/** Full path. Absolute, because this is mounted on the app rather than under the /api router. */
export const DATABASE_RECOVERY_ROUTE_PATH = "/api/ops/diagnostics/database-recovery";

export const DATABASE_RECOVERY_MARKER_HEADER = "X-DB-Recovery-Route";
export const DATABASE_RECOVERY_MARKER_VALUE = "break-glass-v1";

/** Identifies which layer answered. Constant, secret-free, and set on every response. */
export function databaseRecoveryMarker(_req, res, next) {
  res.setHeader(DATABASE_RECOVERY_MARKER_HEADER, DATABASE_RECOVERY_MARKER_VALUE);
  next();
}

/**
 * Mounts the one emergency route.
 *
 * Call before the `/api` router. Registers exactly one GET and touches nothing else on the app.
 */
export function registerDatabaseRecoveryRoute(app) {
  app.get(
    DATABASE_RECOVERY_ROUTE_PATH,
    databaseRecoveryMarker,
    requireDatabaseRecoveryToken,
    noStoreHeaders,
    databaseRecoveryDiagnosticHandler,
  );
}
