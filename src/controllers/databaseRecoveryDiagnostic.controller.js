import { ok } from "../core/apiResponse.js";
import { runDatabaseRecoveryDiagnostic } from "../modules/ops/databaseRecoveryDiagnostic.service.js";

/**
 * GET /ops/diagnostics/database-recovery
 *
 * Temporary incident diagnostic. Reports whether DIRECT_URL still names this application's
 * database, using structure and counts only.
 *
 * A GET is safe here precisely because the operation is read-only in both directions: it takes no
 * parameters, writes nothing, and initiates no outbound request other than one Postgres connection
 * to an address the server already holds. A caller cannot influence where it connects.
 *
 * The service never throws and never returns any part of the URL, so this handler has nothing to
 * sanitise — it forwards the result as-is. That is deliberate: sanitising here would imply the
 * service might emit something unsafe, and the guarantee belongs in one place.
 */
export async function databaseRecoveryDiagnosticHandler(_req, res, next) {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.json(ok(await runDatabaseRecoveryDiagnostic()));
  } catch (error) {
    next(error);
  }
}
