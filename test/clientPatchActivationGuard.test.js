import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

const {
  createClientBodySchema,
  updateClientBodySchema,
  clientPatchStatusSchema,
  clientStatusSchema,
  setCommercialModelBodySchema,
} = await import("../src/modules/client/validators/schemas.js");
const { ClientService } = await import("../src/modules/client/services/client.service.js");

/**
 * Client onboarding phase 1C — the two confirmed blockers.
 *
 * 1. PATCH /clients/:id accepted {"status":"ACTIVE"} and wrote it straight through, so the seven
 *    activation prerequisites (signed agreement, commercial model, allotted campaigns, a published
 *    assignment, a production API key where API delivery is on, a portal administrator where portal
 *    delivery is on, provisioning) could all be skipped under the same CLIENTS_MANAGE permission.
 *
 * 2. The PATCH schema was non-strict, so commercialModel and clientSharePercent — which it has
 *    never accepted — were silently dropped and the caller got a 200 having written nothing.
 *
 * Nothing about the activation conditions, the commercial-model endpoint, provisioning, API keys,
 * portal invites or create-client behaviour changes here. Both fixes are refusals.
 */

const SERVICE_SRC = readFileSync("src/modules/client/services/client.service.js", "utf8");
const SCHEMA_SRC = readFileSync("src/modules/client/validators/schemas.js", "utf8");
const ONBOARDING_SRC = readFileSync(
  "src/modules/client/services/clientOnboarding.service.js",
  "utf8",
);
const ROUTES_SRC = readFileSync("src/routes/index.js", "utf8");

const CLIENT_ID = "client-placeholder-id";

/** A client repository double that records every write and can be given any starting row. */
function repoSpy(row = {}) {
  const updates = [];
  const current = {
    id: CLIENT_ID,
    name: "PLACEHOLDER_CLIENT",
    slug: "placeholder-client",
    status: "PROSPECT",
    commercialModel: null,
    clientSharePercent: null,
    deliveryMethod: "API_AND_PORTAL",
    agreementStatus: "NONE",
    apiEnvironmentConfig: null,
    deletedAt: null,
    ...row,
  };
  return {
    updates,
    repo: {
      findById: async () => current,
      findBySlugAny: async () => null,
      update: async (id, data) => {
        updates.push({ id, data });
        return { ...current, ...data };
      },
      create: async (data) => {
        updates.push({ id: null, data });
        return { id: CLIENT_ID, ...data };
      },
      softDelete: async () => ({ ...current, status: "OFFBOARDED" }),
    },
  };
}

const serviceWith = (row) => {
  const spy = repoSpy(row);
  return { service: new ClientService({ clientRepo: spy.repo }), spy };
};

const reject = (body) => {
  const result = updateClientBodySchema.safeParse(body);
  assert.equal(result.success, false, `accepted ${JSON.stringify(body)}`);
  return result.error.issues;
};

describe("1 — PATCH cannot set a client ACTIVE", () => {
  it("1a. the request schema refuses status ACTIVE", () => {
    const issues = reject({ status: "ACTIVE" });
    assert.ok(
      issues.some((issue) => issue.path.join(".") === "status"),
      `the rejection does not name status: ${JSON.stringify(issues)}`,
    );
    // A ZodError is a 400 through the app error handler, not a silent no-op.
    assert.match(readFileSync("src/app.js", "utf8"), /err instanceof ZodError/);
  });

  it("1b. the service refuses it too, for any caller that skips the schema", async () => {
    const { service, spy } = serviceWith({ status: "PROSPECT" });
    await assert.rejects(
      () => service.update(CLIENT_ID, { status: "ACTIVE" }),
      (error) => {
        assert.equal(error.statusCode ?? error.status, 409, "not a 409");
        assert.match(String(error.message), /onboarding\/activate/);
        return true;
      },
    );
    assert.deepEqual(spy.updates, [], "a refused activation still wrote to the database");
  });

  it("1c. it is refused even when the client is already ACTIVE — no idempotent back door", async () => {
    const { service, spy } = serviceWith({ status: "ACTIVE" });
    await assert.rejects(() => service.update(CLIENT_ID, { status: "ACTIVE" }), /activate/);
    assert.deepEqual(spy.updates, []);
  });

  it("1d. ACTIVE cannot ride along with otherwise legitimate fields", async () => {
    reject({ agreementStatus: "SIGNED", status: "ACTIVE" });
    const { service, spy } = serviceWith({});
    await assert.rejects(
      () => service.update(CLIENT_ID, { agreementStatus: "SIGNED", status: "ACTIVE" }),
      /activate/,
    );
    assert.deepEqual(spy.updates, [], "a partial write happened before the refusal");
  });
});

describe("2 — PATCH cannot reach the state the activation gate protects", () => {
  it("2a. none of the seven prerequisites is evaluated or writable through PATCH", () => {
    // The gate lives in one place and PATCH does not reach it.
    assert.ok(
      ONBOARDING_SRC.includes("async activate(clientId)"),
      "the activation gate moved",
    );
    for (const block of [
      "agreementSigned",
      "commercialConfigured",
      "campaignsAllotted",
      "assignmentsPublished",
      "apiKeyIssued",
      "administratorConfigured",
      "provisioned",
    ]) {
      assert.ok(ONBOARDING_SRC.includes(block), `${block} is no longer checked at activation`);
      assert.ok(
        !SERVICE_SRC.includes(block),
        `${block} was duplicated into the generic update service`,
      );
    }
  });

  it("2b. the generic service still cannot write ACTIVE by any field name", async () => {
    const { service, spy } = serviceWith({});
    // commercialModel and clientSharePercent are not update fields at all, so even a caller that
    // bypasses the schema cannot drive the client toward activation through this service.
    await service.update(CLIENT_ID, {
      commercialModel: "OFFERS_PLUS_COMMISSION",
      clientSharePercent: 70,
    });
    assert.equal(spy.updates.length, 1);
    assert.deepEqual(spy.updates[0].data, {}, "an unsupported field reached the database");
  });

  it("2c. exactly one place writes ACTIVE, and it is the activation gate", () => {
    const activeWrites = [...ONBOARDING_SRC.matchAll(/status: "ACTIVE"/g)].length;
    assert.ok(activeWrites >= 1, "nothing writes ACTIVE any more");
    assert.match(ONBOARDING_SRC, /this\.clientRepo\.update\(clientId, \{ status: "ACTIVE" \}\)/);
    assert.ok(
      !SERVICE_SRC.includes('status: "ACTIVE"') ||
        SERVICE_SRC.includes('input.status === "ACTIVE"'),
      "the generic service writes ACTIVE",
    );
  });
});

describe("3 — the activation endpoint still sets ACTIVE", () => {
  it("3a. activate() writes ACTIVE through the repository, untouched by this change", () => {
    const activate = ONBOARDING_SRC.slice(
      ONBOARDING_SRC.indexOf("async activate(clientId)"),
      ONBOARDING_SRC.indexOf("async loadAssignmentsWithCommercial("),
    );
    assert.ok(activate.length > 0, "activate() moved");
    assert.match(activate, /this\.clientRepo\.update\(clientId, \{ status: "ACTIVE" \}\)/);
    // It goes to the repository, NOT through the guarded ClientService.update.
    assert.ok(
      !activate.includes("clientService.update"),
      "activation now routes through the guarded generic service",
    );
    for (const block of ["agreementSigned", "commercialConfigured", "provisioned"]) {
      assert.ok(activate.includes(block), `${block} is no longer checked before activating`);
    }
  });

  it("3b. the repository itself accepts ACTIVE — the guard is on the service, not the write", async () => {
    const { repo, updates } = repoSpy({});
    const saved = await repo.update(CLIENT_ID, { status: "ACTIVE" });
    assert.equal(saved.status, "ACTIVE");
    assert.equal(updates.length, 1);
  });

  it("3c. the activation route is unchanged and still admin-gated", () => {
    assert.match(
      ROUTES_SRC,
      /"\/clients\/:id\/onboarding\/activate",\s*\n\s*authenticate,\s*\n\s*requirePermission\(PERMISSIONS\.CLIENTS_MANAGE\)/,
    );
  });
});

describe("4 — legitimate PATCH edits still work", () => {
  const legitimate = {
    agreementStatus: "SIGNED",
    agreementEffectiveAt: "2026-01-01T00:00:00.000Z",
    agreementRenewalAt: "2027-01-01T00:00:00.000Z",
    paymentCycle: "MONTHLY",
    paymentTrigger: "AFTER_NETWORK_PAYMENT",
    deliveryMethod: "API_AND_PORTAL",
  };

  it("4a. every named field parses and survives to the database", async () => {
    const parsed = updateClientBodySchema.parse(legitimate);
    assert.deepEqual(Object.keys(parsed).sort(), Object.keys(legitimate).sort());

    const { service, spy } = serviceWith({});
    await service.update(CLIENT_ID, parsed);
    assert.equal(spy.updates.length, 1);
    const written = spy.updates[0].data;
    assert.equal(written.agreementStatus, "SIGNED");
    assert.equal(written.paymentCycle, "MONTHLY");
    assert.equal(written.paymentTrigger, "AFTER_NETWORK_PAYMENT");
    assert.equal(written.deliveryMethod, "API_AND_PORTAL");
    assert.ok(written.agreementEffectiveAt instanceof Date);
    assert.ok(written.agreementRenewalAt instanceof Date);
  });

  it("4b. the other client fields are still editable", () => {
    const parsed = updateClientBodySchema.parse({
      name: "PLACEHOLDER_RENAMED",
      legalName: "PLACEHOLDER_LEGAL",
      industry: "PLACEHOLDER_INDUSTRY",
      category: "PLACEHOLDER_CATEGORY",
      subCategory: "PLACEHOLDER_SUBCATEGORY",
      country: "AE",
      currency: "AED",
      timezone: "Asia/Dubai",
      logoUrl: "https://placeholder.example/logo.png",
      agreementDocumentUrl: "https://placeholder.example/agreement.pdf",
      apiEnvironmentConfig: { PRODUCTION: { status: "ACTIVE" } },
    });
    assert.equal(parsed.country, "AE");
    assert.equal(parsed.apiEnvironmentConfig.PRODUCTION.status, "ACTIVE");
  });

  it("4c. the non-ACTIVE statuses are still settable, and reach the database", async () => {
    for (const status of ["PROSPECT", "SUSPENDED", "OFFBOARDED"]) {
      assert.equal(updateClientBodySchema.parse({ status }).status, status, status);
      const { service, spy } = serviceWith({});
      // eslint-disable-next-line no-await-in-loop
      await service.update(CLIENT_ID, { status });
      assert.deepEqual(spy.updates[0].data, { status }, status);
    }
    assert.deepEqual([...clientPatchStatusSchema.options].sort(), [
      "OFFBOARDED",
      "PROSPECT",
      "SUSPENDED",
    ]);
  });

  it("4d. an empty PATCH is still valid and writes nothing", async () => {
    assert.deepEqual(updateClientBodySchema.parse({}), {});
    const { service, spy } = serviceWith({});
    await service.update(CLIENT_ID, {});
    assert.deepEqual(spy.updates[0].data, {});
  });
});

describe("5/6/7 — unsupported fields are refused, never stripped", () => {
  it("5. commercialModel is refused by name", () => {
    const issues = reject({ commercialModel: "OFFERS_PLUS_COMMISSION" });
    assert.ok(
      issues.some(
        (issue) =>
          issue.code === "unrecognized_keys" && (issue.keys || []).includes("commercialModel"),
      ),
      `the error does not name commercialModel: ${JSON.stringify(issues)}`,
    );
  });

  it("6. clientSharePercent is refused by name", () => {
    const issues = reject({ clientSharePercent: 70 });
    assert.ok(
      issues.some(
        (issue) =>
          issue.code === "unrecognized_keys" && (issue.keys || []).includes("clientSharePercent"),
      ),
      `the error does not name clientSharePercent: ${JSON.stringify(issues)}`,
    );
  });

  it("7a. any unknown field is refused", () => {
    for (const key of [
      "agreementSignedAt",
      "agreementStartDate",
      "agreementEndDate",
      "slug",
      "id",
      "deletedAt",
      "createdAt",
      "portalPreferences",
      "zzmadeupfieldzz",
    ]) {
      const issues = reject({ [key]: "PLACEHOLDER" });
      assert.ok(
        issues.some((issue) => (issue.keys || []).includes(key)),
        `${key} was not named in the rejection`,
      );
    }
  });

  it("7b. one unknown field poisons an otherwise valid body — no partial write", async () => {
    reject({ agreementStatus: "SIGNED", commercialModel: "OFFERS_ONLY" });
    // And nothing reaches the service, because the controller parses before it calls.
    const controller = readFileSync("src/controllers/clients.controller.js", "utf8");
    const handler = controller.slice(
      controller.indexOf("export async function updateClientHandler"),
      controller.indexOf("export async function deleteClientHandler"),
    );
    assert.ok(handler.includes("updateClientBodySchema.parse(req.body ?? {})"));
    assert.ok(
      handler.indexOf("updateClientBodySchema.parse") < handler.indexOf("clientService.update"),
      "the body is not validated before the service is called",
    );
  });

  it("7c. the schema is strict by construction, not by a hand-written key list", () => {
    assert.match(SCHEMA_SRC, /updateClientBodySchema = createClientBodySchema\s*\n?\s*\.omit\(\{ slug: true \}\)\s*\n?\s*\.partial\(\)[\s\S]{0,200}\.strict\(\)/);
  });
});

describe("8 — create-client behaviour is unchanged", () => {
  it("8a. create still accepts exactly the same keys, including slug", () => {
    assert.deepEqual(Object.keys(createClientBodySchema.shape).sort(), [
      "agreementDocumentUrl",
      "agreementEffectiveAt",
      "agreementRenewalAt",
      "agreementStatus",
      "apiEnvironmentConfig",
      "category",
      "country",
      "currency",
      "deliveryMethod",
      "industry",
      "legalName",
      "logoUrl",
      "name",
      "paymentCycle",
      "paymentTrigger",
      "slug",
      "status",
      "subCategory",
      "timezone",
    ]);
  });

  it("8b. create is still NON-strict — this phase did not tighten it", () => {
    const parsed = createClientBodySchema.parse({
      name: "PLACEHOLDER_CLIENT",
      zzunknownfieldzz: "ignored",
    });
    assert.equal(parsed.name, "PLACEHOLDER_CLIENT");
    assert.ok(!("zzunknownfieldzz" in parsed), "create began echoing unknown keys");
  });

  it("8c. create still accepts status ACTIVE — only the PATCH surface narrowed", () => {
    // Deliberate and reported: narrowing create is a separate decision, not this blocker.
    assert.equal(createClientBodySchema.parse({ name: "X", status: "ACTIVE" }).status, "ACTIVE");
    assert.deepEqual([...clientStatusSchema.options].sort(), [
      "ACTIVE",
      "OFFBOARDED",
      "PROSPECT",
      "SUSPENDED",
    ]);
  });

  it("8d. the create service path is untouched", async () => {
    const { service, spy } = serviceWith({});
    await service.create({ name: "PLACEHOLDER_CLIENT", slug: "placeholder-client" });
    assert.equal(spy.updates.length, 1);
    const written = spy.updates[0].data;
    assert.equal(written.status, "PROSPECT", "the create default changed");
    assert.equal(written.deliveryMethod, "API_AND_PORTAL");
    assert.equal(written.agreementStatus, "NONE");
  });
});

describe("9 — commercial model remains a single-endpoint concern", () => {
  it("9a. its own schema still accepts both fields", () => {
    const parsed = setCommercialModelBodySchema.parse({
      commercialModel: "OFFERS_PLUS_COMMISSION",
      clientSharePercent: 70,
    });
    assert.equal(parsed.commercialModel, "OFFERS_PLUS_COMMISSION");
    assert.equal(parsed.clientSharePercent, 70);
    assert.equal(
      setCommercialModelBodySchema.parse({ commercialModel: "OFFERS_ONLY" }).commercialModel,
      "OFFERS_ONLY",
    );
  });

  it("9b. exactly one service writes commercialModel, and it is the onboarding one", () => {
    assert.match(ONBOARDING_SRC, /commercialModel,\s*\n\s*clientSharePercent: share,/);
    assert.ok(
      !SERVICE_SRC.includes("commercialModel"),
      "the generic client service now writes commercialModel",
    );
    assert.ok(
      !SERVICE_SRC.includes("clientSharePercent"),
      "the generic client service now writes clientSharePercent",
    );
  });

  it("9c. its route is unchanged and still admin-gated", () => {
    assert.match(
      ROUTES_SRC,
      /"\/clients\/:id\/onboarding\/commercial-model",\s*\n\s*authenticate,\s*\n\s*requirePermission\(PERMISSIONS\.CLIENTS_MANAGE\)/,
    );
  });
});

describe("10/11 — permissions and schema are untouched", () => {
  it("10. PATCH, activate and commercial-model all still require CLIENTS_MANAGE", () => {
    const patchBlock = ROUTES_SRC.slice(ROUTES_SRC.indexOf('router.patch(\n  "/clients/:id"')).slice(
      0,
      400,
    );
    assert.match(patchBlock, /authenticate,/);
    assert.match(patchBlock, /requirePermission\(PERMISSIONS\.CLIENTS_MANAGE\)/);
    assert.match(patchBlock, /auditAction\("clients\.update"/);
    // Unchanged count: this phase added and removed no client route. Both fixes are refusals
    // inside existing handlers, so the route table must be byte-for-byte what it was.
    assert.equal((ROUTES_SRC.match(/router\.(get|post|put|patch|delete)\(\s*\n?\s*"\/clients/g) || []).length, 18);
  });

  it("11. no schema migration is implied — no Prisma model or enum changed", () => {
    const prismaSchema = readFileSync("prisma/schema.prisma", "utf8");
    // ClientStatus keeps all four values: the database still stores ACTIVE, which activation writes.
    assert.match(prismaSchema, /enum ClientStatus \{\s*\n\s*PROSPECT\s*\n\s*ACTIVE\s*\n\s*SUSPENDED\s*\n\s*OFFBOARDED\s*\n\}/);
    assert.match(prismaSchema, /status\s+ClientStatus\s+@default\(PROSPECT\)/);
    // The narrowing is a request-validation concern only; it names no Prisma type.
    assert.ok(!SCHEMA_SRC.includes("prisma"), "the validator reaches for Prisma");
  });
});
