import { prisma } from "../../database/prisma.js";
import { parseNetworkSource, parseSourceAccountLabel } from "../supplier/entityIdentity.js";
import { ProductService } from "./product.service.js";
import { mapPayload } from "../mapping/engine.js";

/**
 * Promote Entity(raw product) → Product + ProductSource via mapping engine.
 */
export class ProductPromotionService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.products = deps.products ?? new ProductService({ prisma: this.db });
  }

  isPromotableEntity(entity) {
    return entity?.entityType === "product" && entity?.rawData;
  }

  async promoteEntity(entity, client = null) {
    const db = client ?? this.db;
    if (!this.isPromotableEntity(entity)) {
      return { ok: false, reason: "not_promotable" };
    }
    const { supplier } = parseNetworkSource(entity.networkSource);
    if (supplier === "UNKNOWN") {
      return { ok: false, reason: "unknown_supplier" };
    }
    const { sourceAccountLabel } = parseSourceAccountLabel(entity.externalId);
    const mapped = mapPayload({
      supplier,
      resourceKey: "products",
      payload: entity.rawData,
    });
    if (!mapped.success) {
      return { ok: false, reason: "mapping_failed", errors: mapped.errors };
    }

    const result = await this.products.ingestMappedProduct(
      {
        supplier,
        sourceAccountLabel,
        mapped,
        rawPayloadId: entity.rawPayloadId ?? null,
        mapperVersion: mapped.mappingVersion,
      },
      db,
    );

    if (result.ok && entity.id) {
      try {
        await db.rawPayload.updateMany({
          where: { entityId: entity.id, resourceKey: "products" },
          data: { processingStatus: "PROMOTED" },
        });
      } catch {
        // best-effort
      }
    }

    return result;
  }

  async promoteBatch({ networkSource, limit = 200 } = {}, client = null) {
    const db = client ?? this.db;
    const entities = await db.entity.findMany({
      where: {
        entityType: "product",
        ...(networkSource ? { networkSource } : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: limit,
    });

    const summary = { processed: 0, created: 0, updated: 0, failed: 0, errors: [] };
    for (const entity of entities) {
      summary.processed += 1;
      try {
        const out = await this.promoteEntity(entity, db);
        if (!out.ok) {
          summary.failed += 1;
          summary.errors.push({ entityId: entity.id, reason: out.reason });
        } else if (out.created) {
          summary.created += 1;
        } else {
          summary.updated += 1;
        }
      } catch (error) {
        summary.failed += 1;
        summary.errors.push({ entityId: entity.id, reason: error.message });
      }
    }
    return summary;
  }
}
