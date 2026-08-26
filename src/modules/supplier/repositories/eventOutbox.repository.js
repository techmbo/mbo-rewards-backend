import { prisma } from "../../../database/prisma.js";

function resolveClient(tx) {
  return tx ?? prisma;
}

export class EventOutboxRepository {
  async create(entry, client = null) {
    const db = resolveClient(client);
    return db.eventOutbox.create({ data: entry });
  }

  async findPending({ take = 50 } = {}, client = null) {
    const db = resolveClient(client);
    return db.eventOutbox.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
      take,
    });
  }

  async markProcessing(id, client = null) {
    const db = resolveClient(client);
    return db.eventOutbox.update({
      where: { id },
      data: { status: "PROCESSING", attempts: { increment: 1 } },
    });
  }

  async markCompleted(id, client = null) {
    const db = resolveClient(client);
    return db.eventOutbox.update({
      where: { id },
      data: { status: "COMPLETED", processedAt: new Date(), lastError: null },
    });
  }

  async markFailed(id, lastError, client = null) {
    const db = resolveClient(client);
    return db.eventOutbox.update({
      where: { id },
      data: { status: "FAILED", lastError: String(lastError).slice(0, 2000) },
    });
  }
}
