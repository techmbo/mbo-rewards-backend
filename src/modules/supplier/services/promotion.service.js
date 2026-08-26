import { randomUUID } from "node:crypto";
import { prisma } from "../../../database/prisma.js";
import { DOMAIN_EVENTS, buildEventId } from "../events/types.js";
import {
  EventOutboxRepository,
  MapperErrorRepository,
  SupplierCampaignRepository,
  SupplierCouponRepository,
  SupplierRepository,
} from "../repositories/index.js";

export class OutboxWriter {
  constructor(eventOutboxRepo = new EventOutboxRepository()) {
    this.eventOutboxRepo = eventOutboxRepo;
  }

  async append(tx, { eventType, aggregateId, payload }) {
    const eventId = buildEventId(eventType, aggregateId, randomUUID());
    const entry = await this.eventOutboxRepo.create(
      {
        eventId,
        eventType,
        aggregateId: aggregateId ?? null,
        payload,
        status: "PENDING",
      },
      tx,
    );

    await this.eventOutboxRepo.create(
      {
        eventId: buildEventId(DOMAIN_EVENTS.EVENT_OUTBOX_CREATED, entry.id),
        eventType: DOMAIN_EVENTS.EVENT_OUTBOX_CREATED,
        aggregateId: entry.id,
        payload: { outboxId: entry.id, eventType },
        status: "PENDING",
      },
      tx,
    );

    return entry;
  }
}

export class PromotionService {
  constructor(deps = {}) {
    this.supplierRepo = deps.supplierRepo ?? new SupplierRepository();
    this.campaignRepo = deps.campaignRepo ?? new SupplierCampaignRepository();
    this.couponRepo = deps.couponRepo ?? new SupplierCouponRepository();
    this.mapperErrorRepo = deps.mapperErrorRepo ?? new MapperErrorRepository();
    this.outboxWriter = deps.outboxWriter ?? new OutboxWriter();
  }

  async ensureSuppliersSeeded() {
    await this.supplierRepo.upsertSeeds();
  }

  async recordMapperFailure(entity, error, client = null) {
    const db = client ?? prisma;
    const existing = await this.mapperErrorRepo.findOpenByEntityId(entity.id, db);

    const data = {
      entityId: entity.id,
      supplier: error.supplier ?? null,
      entityType: entity.entityType,
      errorCode: error.code ?? "MAPPER_FAILED",
      message: error.message ?? "Unknown mapper error",
      stackTrace: error.stack ?? null,
      mapperVersion: error.mapperVersion ?? null,
      status: "OPEN",
    };

    if (existing) {
      return this.mapperErrorRepo.updateStatus(
        existing.id,
        "OPEN",
        { message: data.message, attempts: { increment: 1 } },
        db,
      );
    }

    const record = await this.mapperErrorRepo.create(data, db);

    await this.outboxWriter.append(db, {
      eventType: DOMAIN_EVENTS.MAPPER_FAILED,
      aggregateId: record.id,
      payload: {
        mapperErrorId: record.id,
        entityId: entity.id,
        errorCode: data.errorCode,
        message: data.message,
      },
    });

    return record;
  }
}
