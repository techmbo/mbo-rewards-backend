import { EventOutboxRepository } from "../../modules/supplier/repositories/eventOutbox.repository.js";
import { buildEventId } from "./domainEvents.js";
import { logger } from "../logging/logger.js";
import { getRequestContext } from "../logging/context.js";

const handlers = new Map();

export class EventDispatcher {
  constructor(deps = {}) {
    this.outboxRepo = deps.outboxRepo ?? new EventOutboxRepository();
    this.handlers = deps.handlers ?? handlers;
  }

  on(eventType, handler) {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, []);
    }
    this.handlers.get(eventType).push(handler);
  }

  async publish({ eventType, aggregateId, payload, eventId, client = null }) {
    const ctx = getRequestContext();
    const resolvedEventId =
      eventId ?? buildEventId([eventType, aggregateId, ctx.traceId, Date.now()]);

    const entry = await this.outboxRepo.create(
      {
        eventId: resolvedEventId,
        eventType,
        aggregateId: aggregateId ?? null,
        payload: {
          ...payload,
          correlationId: ctx.traceId ?? ctx.requestId,
          publishedAt: new Date().toISOString(),
        },
      },
      client,
    );

    if (process.env.EVENT_DISPATCH_INLINE !== "false") {
      await this.dispatchPending({ take: 1, client });
    }

    return entry;
  }

  async dispatchPending({ take = 50, client = null } = {}) {
    const pending = await this.outboxRepo.findPending({ take }, client);
    let processed = 0;

    for (const event of pending) {
      await this.outboxRepo.markProcessing(event.id, client);
      try {
        const eventHandlers = this.handlers.get(event.eventType) ?? [];
        for (const handler of eventHandlers) {
          await handler(event);
        }
        await this.outboxRepo.markCompleted(event.id, client);
        processed += 1;
      } catch (error) {
        logger.error({ eventId: event.eventId, err: error.message }, "event dispatch failed");
        await this.outboxRepo.markFailed(event.id, error.message, client);
      }
    }

    return { processed, pending: pending.length };
  }
}

export const eventDispatcher = new EventDispatcher();
