/**
 * The client delivery boundary.
 *
 * A client may only see a grant MBO has actually published: published === true, assignment
 * ACTIVE, on a PUBLISHED, non-hidden, non-deleted catalog campaign, for their own tenant. The
 * boundary used to be relaxable by the caller (`includeInactive`, `published=false`,
 * `status=ASSIGNED|PAUSED`), and one client surface forwards req.query without validating it, so
 * these tests pin that no request shape can widen it — and that the redirect refuses anything the
 * list refuses to show.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PartnerCampaignService } from "../src/modules/client/services/partnerCampaign.service.js";
import { ClientCampaignAssignmentRepository } from "../src/modules/client/repositories/clientCampaignAssignment.repository.js";
import { partnerCampaignListQuerySchema } from "../src/modules/client/validators/schemas.js";
import { TrackingRedirectService } from "../src/modules/reporting/services/trackingRedirect.service.js";

/* --------------------------------------------------------------------------------- fixtures */

const CLIENT_A = { id: "client-a", status: "ACTIVE", deletedAt: null, name: "Client A" };

function buildAssignment({ id = "a1", clientId = "client-a", published = true, status = "ACTIVE" } = {}) {
  return {
    id,
    clientId,
    status,
    published,
    channel: "WEB",
    startDate: new Date("2026-01-01"),
    endDate: null,
    createdAt: new Date("2026-01-01"),
    canonicalCampaign: {
      id: "cc1",
      merchantId: "m1",
      displayName: "Ubuy Global",
      description: null,
      status: "PUBLISHED",
      visibility: "ASSIGNABLE",
      deletedAt: null,
      category: "Electronics",
      countries: ["AE"],
      defaultCurrency: "USD",
      merchant: { id: "m1", displayName: "Ubuy" },
    },
    trackingLinks: [
      {
        isPrimary: true,
        status: "ACTIVE",
        slug: "a-ubuy",
        subId: "7HF82KLM",
        mboTrackingUrl: "https://go.mbo.example/r/a-ubuy/7HF82KLM",
        supplierTrackingUrl: "https://supplier.example/track",
      },
    ],
    couponAssignments: [],
  };
}

/** A service whose repository records the filters it was handed and returns fixed rows. */
function serviceWith(rows) {
  const seen = [];
  const service = new PartnerCampaignService({
    clientRepo: { findById: async () => CLIENT_A },
    assignmentRepo: {
      findManyForPartner: async (filters) => {
        seen.push(filters);
        return { rows, total: rows.length };
      },
      findManyCursorForPartner: async (filters) => {
        seen.push(filters);
        return { rows, hasMore: false };
      },
    },
  });
  return { service, seen };
}

/** The repository's real where-clause, captured from a stubbed prisma delegate. */
async function whereFor(filters) {
  let captured = null;
  const repo = new ClientCampaignAssignmentRepository();
  const db = {
    clientCampaignAssignment: {
      findMany: async (args) => {
        captured = args.where;
        return [];
      },
      count: async () => 0,
    },
  };
  await repo.findManyForPartner(filters, { skip: 0, take: 20 }, db);
  return captured;
}

/** Every shape a caller could use to try to widen the boundary. */
const HOSTILE = [
  { label: "includeInactive=true", query: { includeInactive: true } },
  { label: "published=false", query: { published: false } },
  { label: "status=ASSIGNED", query: { status: "ASSIGNED" } },
  { label: "status=PAUSED", query: { status: "PAUSED" } },
  { label: "all of them at once", query: { includeInactive: true, published: false, status: "ASSIGNED" } },
];

/* ------------------------------------------------------------------ the flag is gone upstream */

describe("client delivery boundary — includeInactive is not a client input", () => {
  it("the client campaign list schema drops includeInactive", () => {
    const parsed = partnerCampaignListQuerySchema.parse({ includeInactive: "true" });
    assert.ok(!("includeInactive" in parsed), "includeInactive must not survive validation");
  });

  it("the schema still accepts the narrowing filters", () => {
    const parsed = partnerCampaignListQuerySchema.parse({
      search: "ubuy",
      category: "Electronics",
      brand: "Ubuy",
      country: "ae",
    });
    assert.equal(parsed.search, "ubuy");
    assert.equal(parsed.category, "Electronics");
    assert.equal(parsed.brand, "Ubuy");
    assert.equal(parsed.country, "AE");
  });
});

/* ------------------------------------------------------- the service refuses to pass it along */

describe("client delivery boundary — the service ignores widening input", () => {
  for (const { label, query } of HOSTILE) {
    it(`does not forward ${label} to the repository`, async () => {
      const { service, seen } = serviceWith([]);
      await service.listCampaigns("client-a", query);

      assert.equal(seen.length, 1);
      const filters = seen[0];
      for (const key of ["includeInactive", "published", "status", "requirePublished"]) {
        assert.ok(!(key in filters), `${key} must not reach the repository (via ${label})`);
      }
      assert.equal(filters.clientId, "client-a", "tenant scoping must survive");
    });
  }

  it("still forwards the narrowing filters", async () => {
    const { service, seen } = serviceWith([]);
    await service.listCampaigns("client-a", {
      search: "ubuy",
      category: "Electronics",
      brand: "Ubuy",
      country: "AE",
    });
    assert.equal(seen[0].search, "ubuy");
    assert.equal(seen[0].category, "Electronics");
    assert.equal(seen[0].brand, "Ubuy");
    assert.equal(seen[0].country, "AE");
  });
});

/* -------------------------------------------------------------- unpublished never projects out */

describe("client delivery boundary — unpublished grants are not listed", () => {
  it("drops an unpublished assignment even when includeInactive is requested", async () => {
    const { service } = serviceWith([buildAssignment({ published: false })]);
    const payload = await service.listCampaigns("client-a", { includeInactive: true });
    assert.equal(payload.campaigns.length, 0, "an unpublished grant must not reach the client");
  });

  it("drops a merely-ASSIGNED assignment even when its status is requested", async () => {
    const { service } = serviceWith([buildAssignment({ published: false, status: "ASSIGNED" })]);
    const payload = await service.listCampaigns("client-a", { status: "ASSIGNED" });
    assert.equal(payload.campaigns.length, 0);
  });

  it("still lists a published ACTIVE assignment normally", async () => {
    const { service } = serviceWith([buildAssignment({ published: true, status: "ACTIVE" })]);
    const payload = await service.listCampaigns("client-a", {});
    assert.equal(payload.campaigns.length, 1, "a published ACTIVE grant must still be delivered");
  });

  it("lists a published ACTIVE assignment on the cursor path too", async () => {
    const { service } = serviceWith([buildAssignment({ published: true, status: "ACTIVE" })]);
    const payload = await service.listCampaigns("client-a", { cursor: null, pageSize: 10 });
    assert.equal(payload.campaigns.length, 1);
  });
});

/* ---------------------------------------------------- the where clause is unconditionally safe */

describe("client delivery boundary — the repository where clause", () => {
  it("pins published ACTIVE on a PUBLISHED, visible, undeleted campaign", async () => {
    const where = await whereFor({ clientId: "client-a" });
    assert.equal(where.clientId, "client-a");
    assert.equal(where.status, "ACTIVE");
    assert.equal(where.published, true);
    assert.equal(where.canonicalCampaign.status, "PUBLISHED");
    assert.equal(where.canonicalCampaign.deletedAt, null);
    assert.deepEqual(where.canonicalCampaign.visibility, { not: "HIDDEN" });
  });

  for (const { label, query } of HOSTILE) {
    it(`is unchanged by ${label}`, async () => {
      const where = await whereFor({ clientId: "client-a", ...query, requirePublished: false });
      assert.equal(where.status, "ACTIVE", `${label} must not widen assignment status`);
      assert.equal(where.published, true, `${label} must not surface unpublished grants`);
      assert.equal(where.canonicalCampaign.status, "PUBLISHED", `${label} must not widen catalog status`);
    });
  }

  it("refuses to build an unscoped query", async () => {
    await assert.rejects(
      () => whereFor({}),
      /require clientId/,
      "a partner query without a tenant must throw, never run unscoped",
    );
  });

  it("scopes to the requested tenant and no other", async () => {
    const a = await whereFor({ clientId: "client-a" });
    const b = await whereFor({ clientId: "client-b" });
    assert.equal(a.clientId, "client-a");
    assert.equal(b.clientId, "client-b");
  });
});

/* ------------------------------------------------------------- the redirect refuses the same set */

describe("client delivery boundary — the redirect refuses what the list hides", () => {
  const linkFor = (assignment) => ({
    id: "tl1",
    assignmentId: assignment.id,
    status: "ACTIVE",
    deletedAt: null,
    subId: "7HF82KLM",
    assignment: {
      ...assignment,
      client: CLIENT_A,
      canonicalCampaign: assignment.canonicalCampaign,
    },
  });

  const redirectWith = (assignment) =>
    new TrackingRedirectService({
      trackingRepo: { findBySubId: async () => linkFor(assignment) },
      attribution: { recordClick: async () => ({}) },
      resolveDestinationFn: async () => ({ url: "https://supplier.example/landing", source: "PERSISTED" }),
    });

  it("refuses an unpublished assignment", async () => {
    const service = redirectWith(buildAssignment({ published: false }));
    await assert.rejects(() => service.redirect("7HF82KLM"), /not live|unpublished|inactive/i);
  });

  it("refuses a merely-ASSIGNED assignment", async () => {
    const service = redirectWith(buildAssignment({ published: false, status: "ASSIGNED" }));
    await assert.rejects(() => service.redirect("7HF82KLM"), /not live|unpublished|inactive/i);
  });

  it("refuses a PAUSED assignment even when published", async () => {
    const service = redirectWith(buildAssignment({ published: true, status: "PAUSED" }));
    await assert.rejects(() => service.redirect("7HF82KLM"), /not live|unpublished|inactive/i);
  });

  it("refuses a REVOKED assignment", async () => {
    const service = redirectWith(buildAssignment({ published: true, status: "REVOKED" }));
    await assert.rejects(() => service.redirect("7HF82KLM"), /revoked/i);
  });
});
