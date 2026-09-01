import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { ClientService } from "../src/modules/client/services/client.service.js";

describe("ClientService", () => {
  it("creates client with generated slug", async () => {
    const clientRepo = {
      findBySlugAny: mock.fn(async () => null),
      create: mock.fn(async (data) => data),
    };

    const service = new ClientService({ clientRepo });
    const created = await service.create({ name: "Acme Media" });

    assert.equal(created.name, "Acme Media");
    assert.equal(created.slug, "acme-media");
    assert.equal(created.status, "PROSPECT");
  });

  it("rejects duplicate slug", async () => {
    const clientRepo = {
      findBySlugAny: mock.fn(async () => ({ id: "existing", deletedAt: null })),
      create: mock.fn(async () => ({})),
    };

    const service = new ClientService({ clientRepo });

    await assert.rejects(
      () => service.create({ name: "Acme Media", slug: "acme-media" }),
      (error) => error.statusCode === 409 && /already in use/i.test(error.message),
    );
  });

  it("rejects slug held by a soft-deleted client with a clear message", async () => {
    const clientRepo = {
      findBySlugAny: mock.fn(async () => ({ id: "gone", deletedAt: new Date() })),
      create: mock.fn(async () => ({})),
    };

    const service = new ClientService({ clientRepo });

    await assert.rejects(
      () => service.create({ name: "The Cosmic Stack", slug: "tcs" }),
      (error) => error.statusCode === 409 && /deleted client/i.test(error.message),
    );
  });
});
