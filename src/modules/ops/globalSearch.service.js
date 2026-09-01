/**
 * Staff global search — permission-gated federated lookup across ops surfaces.
 */
import { prisma } from "../../database/prisma.js";
import { PERMISSIONS } from "../../auth/permissions.js";

const CATEGORY_LIMIT = 5;
const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 120;

const TYPE_LABELS = Object.freeze({
  client: "Client",
  brand: "Brand",
  campaign: "Master Campaign",
  network: "Network Account",
  network_record: "Network Data",
  exception: "Exception",
});

function normalizeQuery(value) {
  return String(value || "")
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

function can(permissions, permission) {
  return permissions.includes(permission);
}

function toResult({ type, id, label, subtitle, href }) {
  return {
    type,
    id,
    label,
    subtitle: subtitle || null,
    href,
    typeLabel: TYPE_LABELS[type] || type,
  };
}

async function searchClients(q, permissions, limit) {
  if (!can(permissions, PERMISSIONS.CLIENTS_READ)) return [];
  const rows = await prisma.client.findMany({
    where: {
      deletedAt: null,
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { slug: { contains: q, mode: "insensitive" } },
        { country: { contains: q, mode: "insensitive" } },
      ],
    },
    take: limit,
    orderBy: [{ name: "asc" }],
    select: { id: true, name: true, status: true, country: true },
  });
  return rows.map((row) =>
    toResult({
      type: "client",
      id: row.id,
      label: row.name,
      subtitle: [row.status, row.country].filter(Boolean).join(" · "),
      href: `/clients/${row.id}/setup`,
    }),
  );
}

async function searchBrands(q, permissions, limit) {
  if (!can(permissions, PERMISSIONS.MERCHANTS_READ) && !can(permissions, PERMISSIONS.CATALOG_READ)) {
    return [];
  }
  const rows = await prisma.merchant.findMany({
    where: {
      deletedAt: null,
      status: { not: "MERGED" },
      OR: [
        { displayName: { contains: q, mode: "insensitive" } },
        { normalizedName: { contains: q, mode: "insensitive" } },
        { slug: { contains: q, mode: "insensitive" } },
      ],
    },
    take: limit,
    orderBy: [{ displayName: "asc" }],
    select: { id: true, displayName: true, status: true, country: true },
  });
  return rows.map((row) =>
    toResult({
      type: "brand",
      id: row.id,
      label: row.displayName,
      subtitle: [row.status, row.country].filter(Boolean).join(" · "),
      href: `/master/brands/${encodeURIComponent(row.id)}`,
    }),
  );
}

async function searchCampaigns(q, permissions, limit) {
  if (!can(permissions, PERMISSIONS.CATALOG_READ) && !can(permissions, PERMISSIONS.CAMPAIGNS_READ)) {
    return [];
  }
  const rows = await prisma.canonicalCampaign.findMany({
    where: {
      deletedAt: null,
      displayName: { contains: q, mode: "insensitive" },
    },
    take: limit,
    orderBy: [{ displayName: "asc" }],
    select: {
      id: true,
      displayName: true,
      status: true,
      merchantId: true,
      merchant: { select: { displayName: true } },
    },
  });
  return rows.map((row) =>
    toResult({
      type: "campaign",
      id: row.id,
      label: row.displayName,
      subtitle: [row.merchant?.displayName, row.status].filter(Boolean).join(" · "),
      href: row.merchantId
        ? `/master/brands/${encodeURIComponent(row.merchantId)}`
        : "/master/campaigns",
    }),
  );
}

async function searchNetworkAccounts(q, permissions, limit) {
  if (!can(permissions, PERMISSIONS.INTEGRATIONS_READ) && !can(permissions, PERMISSIONS.CAMPAIGNS_READ)) {
    return [];
  }
  const rows = await prisma.marketplaceAccount.findMany({
    where: {
      OR: [
        { platform: { contains: q, mode: "insensitive" } },
        { accountLabel: { contains: q, mode: "insensitive" } },
        { accountExternalId: { contains: q, mode: "insensitive" } },
      ],
    },
    take: limit,
    orderBy: [{ platform: "asc" }, { accountLabel: "asc" }],
    select: { id: true, platform: true, accountLabel: true, environment: true },
  });
  return rows.map((row) =>
    toResult({
      type: "network",
      id: row.id,
      label: `${row.platform} — ${row.accountLabel}`,
      subtitle: row.environment,
      href: "/suppliers",
    }),
  );
}

async function searchNetworkRecords(q, permissions, limit) {
  if (!can(permissions, PERMISSIONS.CAMPAIGNS_READ)) return [];
  const rows = await prisma.entity.findMany({
    where: {
      OR: [
        { externalId: { contains: q, mode: "insensitive" } },
        { entityName: { contains: q, mode: "insensitive" } },
        { campaignName: { contains: q, mode: "insensitive" } },
        { advertiserName: { contains: q, mode: "insensitive" } },
        { networkSource: { contains: q, mode: "insensitive" } },
        { code: { contains: q, mode: "insensitive" } },
      ],
    },
    take: limit,
    orderBy: [{ updatedAt: "desc" }],
    select: {
      id: true,
      entityType: true,
      networkSource: true,
      campaignName: true,
      advertiserName: true,
      entityName: true,
      externalId: true,
    },
  });
  return rows.map((row) => {
    const label =
      row.campaignName ||
      row.advertiserName ||
      row.entityName ||
      row.externalId ||
      row.id;
    return toResult({
      type: "network_record",
      id: row.id,
      label,
      subtitle: [row.networkSource, row.entityType].filter(Boolean).join(" · "),
      href: `/ops/network/all-data?search=${encodeURIComponent(q)}`,
    });
  });
}

async function searchExceptions(q, permissions, limit) {
  if (!can(permissions, PERMISSIONS.EXCEPTIONS_READ)) return [];
  const rows = await prisma.exceptionCase.findMany({
    where: {
      status: { in: ["OPEN", "ACKNOWLEDGED"] },
      OR: [
        { reason: { contains: q, mode: "insensitive" } },
        { dedupeKey: { contains: q, mode: "insensitive" } },
      ],
    },
    take: limit,
    orderBy: [{ detectedAt: "desc" }],
    select: {
      id: true,
      type: true,
      severity: true,
      reason: true,
      supplier: true,
    },
  });
  return rows.map((row) =>
    toResult({
      type: "exception",
      id: row.id,
      label: row.reason || row.type,
      subtitle: [row.severity, row.supplier].filter(Boolean).join(" · "),
      href: "/ops/exceptions",
    }),
  );
}

export class GlobalSearchService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
  }

  async search(query, { permissions = [], limit = CATEGORY_LIMIT } = {}) {
    const q = normalizeQuery(query);
    if (q.length < MIN_QUERY_LENGTH) {
      return {
        query: q,
        results: [],
        groups: [],
        total: 0,
        minQueryLength: MIN_QUERY_LENGTH,
      };
    }

    const perCategory = Math.min(Math.max(Number(limit) || CATEGORY_LIMIT, 1), 10);

    const [clients, brands, campaigns, networks, networkRecords, exceptions] = await Promise.all([
      searchClients(q, permissions, perCategory),
      searchBrands(q, permissions, perCategory),
      searchCampaigns(q, permissions, perCategory),
      searchNetworkAccounts(q, permissions, perCategory),
      searchNetworkRecords(q, permissions, perCategory),
      searchExceptions(q, permissions, perCategory),
    ]);

    const groups = [
      { key: "client", label: TYPE_LABELS.client, items: clients },
      { key: "brand", label: TYPE_LABELS.brand, items: brands },
      { key: "campaign", label: TYPE_LABELS.campaign, items: campaigns },
      { key: "network", label: TYPE_LABELS.network, items: networks },
      { key: "network_record", label: TYPE_LABELS.network_record, items: networkRecords },
      { key: "exception", label: TYPE_LABELS.exception, items: exceptions },
    ].filter((group) => group.items.length > 0);

    const results = groups.flatMap((group) => group.items);

    return {
      query: q,
      results,
      groups,
      total: results.length,
      minQueryLength: MIN_QUERY_LENGTH,
    };
  }
}
