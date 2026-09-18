/**
 * Phase 9A.0b-v1 — move existing Awin coupon Entities onto the canonical identity.
 *
 * Awin promotion rows carry no top-level id or code, so every staged Awin coupon took the
 * positional `awin-coupon-${index}` fallback — remapped by any change in supplier ordering — or,
 * where a flat code was assumed, the bare voucher code, which two advertisers can share. The
 * canonical identity is `awin-coupon-<advertiser.id>-<promotionId>`; see buildAwinCouponExternalId.
 *
 * WHY IN PLACE, AND WHY THAT IS SAFE
 * No foreign key anywhere targets Entity.externalId — RawPayload, SupplierCoupon, SupplierCampaign
 * and MapperError all reference Entity.id, which this never touches. SupplierCoupon promotion
 * resolves its row by findByEntityId() before any natural key, so an updated externalId updates
 * the existing coupon rather than creating a second one. Create-new-and-delete-old would have
 * orphaned every one of those references; an UPDATE orphans nothing.
 *
 * WHAT IS DELIBERATELY NOT TOUCHED
 * RawPayload.externalId is immutable source-evidence lineage ("never rewritten by mapping") and
 * keeps the identity it was written with. Nothing reads it to find an Entity — findLatestRawPayload
 * ForEntity keys on entityId — so leaving it is both correct and inert. Nothing is ever deleted.
 *
 * Usage:
 *   node scripts/migrate-awin-coupon-identity.mjs              # dry run, writes nothing
 *   node scripts/migrate-awin-coupon-identity.mjs --apply      # performs the updates
 *
 * Idempotent: a row already on its canonical id is skipped, so re-running is a no-op.
 */
import "dotenv/config";
import { prisma } from "../src/database/prisma.js";
import { buildAwinCouponExternalId } from "../src/modules/raw/raw.service.js";

export const AWIN_NETWORK_SOURCE = "awin";
export const AWIN_COUPON_ENTITY_TYPE = "coupon";

/**
 * An account-scoped id keeps its `label:` prefix: withAccountScopedExternalId adds it at staging
 * time and the canonical id has to carry it too, or a non-default account would migrate onto an
 * id the next sync would not produce.
 */
export function splitAccountLabel(externalId) {
  const value = String(externalId ?? "");
  const colon = value.indexOf(":");
  if (colon > 0) return { prefix: value.slice(0, colon + 1), local: value.slice(colon + 1) };
  return { prefix: "", local: value };
}

/**
 * Decide one row's outcome without touching the database. Pure, so the decision table is testable
 * without a migration run.
 */
export function planRow(entity) {
  const canonicalLocal = buildAwinCouponExternalId(entity?.rawData ?? {});
  if (!canonicalLocal) {
    return { action: "skipped", reason: "missing_identifiers", entityId: entity?.id ?? null };
  }
  const { prefix, local } = splitAccountLabel(entity?.externalId);
  const canonical = `${prefix}${canonicalLocal}`;
  if (local === canonicalLocal) {
    return { action: "skipped", reason: "already_canonical", entityId: entity.id, canonical };
  }
  return { action: "update", entityId: entity.id, canonical };
}

export async function migrateAwinCouponIdentity({ apply = false, client = prisma } = {}) {
  const entities = await client.entity.findMany({
    where: { networkSource: AWIN_NETWORK_SOURCE, entityType: AWIN_COUPON_ENTITY_TYPE },
    select: { id: true, externalId: true, rawData: true },
  });

  const summary = {
    mode: apply ? "apply" : "dry-run",
    scanned: entities.length,
    updated: 0,
    alreadyCanonical: 0,
    missingIdentifiers: 0,
    conflicts: [],
  };

  for (const entity of entities) {
    const plan = planRow(entity);

    if (plan.action === "skipped") {
      if (plan.reason === "already_canonical") summary.alreadyCanonical += 1;
      else summary.missingIdentifiers += 1;
      continue;
    }

    // The unique key is (externalId, networkSource, entityType). Two legacy rows can map onto one
    // canonical id — a positional row and a code-keyed row for the same promotion, say. Detected
    // BEFORE the write, reported, and left alone: neither row is overwritten and neither is
    // deleted, because deciding which of two real rows to lose is not a migration's call.
    // eslint-disable-next-line no-await-in-loop
    const holder = await client.entity.findUnique({
      where: {
        externalId_networkSource_entityType: {
          externalId: plan.canonical,
          networkSource: AWIN_NETWORK_SOURCE,
          entityType: AWIN_COUPON_ENTITY_TYPE,
        },
      },
      select: { id: true },
    });
    if (holder && holder.id !== entity.id) {
      summary.conflicts.push({ entityId: entity.id, heldBy: holder.id });
      continue;
    }

    if (!apply) {
      summary.updated += 1;
      continue;
    }

    // externalId ONLY. id, createdAt, rawData, normalizedData and every relation are untouched.
    // eslint-disable-next-line no-await-in-loop
    await client.entity.update({ where: { id: entity.id }, data: { externalId: plan.canonical } });
    summary.updated += 1;
  }

  return summary;
}

const invokedDirectly =
  process.argv[1] && process.argv[1].endsWith("migrate-awin-coupon-identity.mjs");

if (invokedDirectly) {
  const apply = process.argv.includes("--apply");
  migrateAwinCouponIdentity({ apply })
    .then((summary) => {
      // Counts and entity UUIDs only: no externalId, no voucher code, no advertiser, no raw row.
      console.log(JSON.stringify(summary, null, 2));
      if (summary.conflicts.length) {
        console.log(`${summary.conflicts.length} conflict(s) left untouched — resolve before re-running.`);
      }
      if (!apply) console.log("dry run — nothing was written. Re-run with --apply.");
    })
    .catch((error) => {
      console.log(JSON.stringify({ ok: false, reason: "MIGRATION_FAILED", message: error?.message ?? null }, null, 2));
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect().catch(() => {});
    });
}
