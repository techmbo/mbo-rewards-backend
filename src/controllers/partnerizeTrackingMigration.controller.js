/**
 * TEMPORARY ONE-SHOT MIGRATION CONTROLLER — REMOVE AFTER USE.
 *
 * The request carries nothing: no SQL, no migration name, no path, no id, no parameters. A body
 * with any content is rejected outright rather than ignored, so a caller can never believe they
 * influenced what ran.
 *
 * Responses carry counts, booleans and fixed codes only — never a hostname, database name,
 * connection string, username or SQL.
 */
import {
  MIGRATION_NAME,
  MIGRATION_STATUS,
  MigrationPreconditionError,
  MigrationVerificationError,
  applyPartnerizeTrackingMigration,
} from "../modules/ops/partnerizeTrackingMigration.service.js";

/** Shape the safe response. Whitelisted explicitly so a service change cannot widen it. */
function toResponse(result) {
  return {
    ok: true,
    status: result.status,
    writesExecuted: result.writesExecuted,
    migrationName: result.migrationName,
    appliedMigrationCountBefore: result.appliedMigrationCountBefore,
    appliedMigrationCountAfter: result.appliedMigrationCountAfter,
    userCountBefore: result.userCountBefore,
    userCountAfter: result.userCountAfter,
    supplierCampaignCountBefore: result.supplierCampaignCountBefore,
    supplierCampaignCountAfter: result.supplierCampaignCountAfter,
    columnsVerified: result.columnsVerified,
    enumsVerified: result.enumsVerified,
    indexVerified: result.indexVerified,
  };
}

function hasBody(req) {
  const body = req.body;
  if (body === undefined || body === null) return false;
  if (typeof body === "string") return body.trim().length > 0;
  if (Buffer.isBuffer(body)) return body.length > 0;
  if (typeof body === "object") return Object.keys(body).length > 0;
  return true;
}

export async function applyPartnerizeTrackingMigrationHandler(req, res, next) {
  if (hasBody(req)) {
    res.status(400).json({
      ok: false,
      code: "BODY_NOT_ACCEPTED",
      message: "This endpoint takes no request body.",
    });
    return;
  }

  try {
    const result = await applyPartnerizeTrackingMigration();
    res.status(200).json(toResponse(result));
  } catch (error) {
    if (error instanceof MigrationPreconditionError) {
      // Nothing was committed: the whole transaction rolled back.
      res.status(409).json({
        ok: false,
        status: "PRECONDITION_FAILED",
        writesExecuted: 0,
        migrationName: MIGRATION_NAME,
        failedCheck: error.code,
        detail: error.detail ?? undefined,
      });
      return;
    }
    if (error instanceof MigrationVerificationError) {
      res.status(500).json({
        ok: false,
        status: "VERIFICATION_FAILED_ROLLED_BACK",
        writesExecuted: 0,
        migrationName: MIGRATION_NAME,
        failedCheck: error.code,
        detail: error.detail ?? undefined,
      });
      return;
    }
    next(error);
  }
}

export { MIGRATION_STATUS };
