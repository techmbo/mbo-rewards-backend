import { prisma } from "../../../database/prisma.js";
import {
  buildAwinCampaignExternalId,
  upsertManyRawEntities,
} from "../../raw/raw.service.js";
import { AWIN_MATERIALIZATION_PAGE_SIZE } from "../../../jobs/awinParentMaterializationUnit.js";

/**
 * Awin advertiser parents, materialized from the offers already staged.
 *
 * Awin's programmes endpoint returns nothing, so no Awin SupplierCampaign exists and every offer
 * fails parent resolution. The advertiser itself is not missing, though: each promotion row
 * carries a nested `advertiser` object, and production shows 1,418 distinct ids across 5,011
 * offers with no missing id, no missing name and no id whose name disagrees between rows.
 *
 * This turns that evidence into ONE campaign Entity per advertiser and stops. It does not write
 * SupplierCampaign: the existing promotion pipeline stays the only canonical writer, so the
 * derived parents go through the same mapper, the same outbox events, the same merchant matching
 * and normalization, and the same tracking-link merge as any other campaign. Nothing here calls a
 * supplier, so the offers already on disk become promotable without a refetch.
 *
 * What it deliberately does NOT do is invent. A promotion row is evidence of an advertiser's
 * IDENTITY and nothing else — not its status, participation, countries, currency, commission,
 * cookie window or tracking links — so the derived payload carries the id, the name and its own
 * provenance, and lets the mappers' existing fail-closed defaults handle the rest.
 */

export const AWIN_NETWORK_SOURCE = "awin";
export const AWIN_COUPON_ENTITY_TYPE = "coupon";
export const AWIN_CAMPAIGN_ENTITY_TYPE = "campaign";

/** The provenance marker. A parent carrying this was derived from offers, never from programmes. */
export const AWIN_DERIVED_RECORD_SOURCE = "advertiser_from_offer";
export const AWIN_DERIVED_SOURCE_OBJECT = "offers";

const SCAN_PAGE_SIZE = AWIN_MATERIALIZATION_PAGE_SIZE;

/**
 * The advertiser a staged CAMPAIGN row is about.
 *
 * Deliberately the same id priority as buildAwinCampaignExternalId, because this decides which
 * advertisers are already programme-backed and that has to agree, key for key, with the id the
 * two rows would converge on. A programme row carries its advertiser as a bare `id`, which the
 * offer-shaped reader below does not look at.
 */
export function awinCampaignAdvertiserId(rawData) {
  const id = rawData?.id ?? rawData?.advertiserId ?? rawData?.advertiser?.id ?? null;
  const value = id == null ? "" : String(id).trim();
  return value || null;
}

/** The advertiser an Awin OFFER row points at. Nested first — that is where Awin actually puts it. */
export function awinAdvertiserIdentity(rawData) {
  const rawId = rawData?.advertiser?.id ?? rawData?.advertiserId ?? null;
  const advertiserId = rawId == null ? "" : String(rawId).trim();
  if (!advertiserId) return null;

  const rawName = rawData?.advertiser?.name ?? rawData?.advertiserName ?? null;
  const advertiserName = rawName == null ? "" : String(rawName).trim();
  return { advertiserId, advertiserName: advertiserName || null };
}

/**
 * Whether a staged Awin campaign payload is one of ours.
 *
 * This is the guard that makes the derived pass safe to re-run forever. Entity staging is an
 * unconditional `rawData = EXCLUDED.rawData` on conflict, so a thin derived payload restaged over
 * a real programme payload would erase it. Real evidence is therefore never overwritten: an
 * advertiser whose campaign Entity is NOT marked derived is skipped entirely, and the programme
 * data stands. The reverse direction is allowed and wanted — a programme row restaged over a
 * derived one is the enrichment this whole mechanism is waiting for.
 */
export function isDerivedAwinCampaignRaw(rawData) {
  return rawData?.record_source === AWIN_DERIVED_RECORD_SOURCE;
}

/**
 * The derived campaign payload for one advertiser.
 *
 * `id` is set so every id-resolver in the staging path — the generic one included — agrees with
 * buildAwinCampaignExternalId about which advertiser this row is.
 *
 * `_mboDerivedFrom` carries the advertiser id and how many offer Entities voted for it. It does
 * NOT carry the promotion ids: there are thousands, they are already on the offer rows, and a list
 * that grows with the catalogue is not provenance, it is a copy.
 */
export function buildDerivedAwinCampaignRow({ advertiserId, advertiserName, offerEntityCount }) {
  return {
    id: advertiserId,
    advertiserId,
    advertiser: { id: advertiserId, name: advertiserName ?? null },
    // campaignName/name are what buildCampaignBaseFromEntity reads for the canonical campaign
    // name; advertiser.name is already what it reads for merchantNameRaw.
    campaignName: advertiserName ?? null,
    name: advertiserName ?? null,
    record_source: AWIN_DERIVED_RECORD_SOURCE,
    _mboSourceObject: AWIN_DERIVED_SOURCE_OBJECT,
    _mboDerivedFrom: { advertiserId, offerEntityCount },
  };
}

function emptySummary() {
  return {
    offersScanned: 0,
    advertisersFound: 0,
    parentsStaged: 0,
    skippedProgrammeBacked: 0,
    offersWithoutAdvertiser: 0,
    advertiserIds: [],
    stagedAdvertiserIds: [],
    skippedAdvertiserIds: [],
  };
}

/** The bounded page a durable unit runs. Exported so the unit can call it without the class. */
export async function materializeAwinAdvertiserParentPage(input = {}, deps = {}) {
  return new AwinAdvertiserParentService(deps).materializePage(input);
}

export class AwinAdvertiserParentService {
  constructor(deps = {}) {
    this.db = deps.db ?? prisma;
    this.stageEntities = deps.stageEntities ?? upsertManyRawEntities;
    this.pageSize = deps.pageSize ?? SCAN_PAGE_SIZE;
  }

  /**
   * Which of THESE advertisers already hold real programme evidence.
   *
   * Scoped to the advertisers a single page found, never the whole Awin estate: the previous shape
   * was one findMany with no take and no cursor that selected rawData for every Awin campaign
   * Entity, which grows with the advertiser catalogue forever and has no place inside a bounded
   * unit. The candidate list is at most one page wide, so this is bounded by construction.
   *
   * rawData is still selected, because `record_source` — the only thing that distinguishes
   * programme evidence from our own derived evidence — lives inside it and nowhere else. It is
   * read for at most one page's advertisers rather than for the catalogue.
   *
   * Both externalId shapes are matched: the canonical `awin-campaign-{id}` this repo now mints,
   * and a bare id, which is what the generic resolver would have produced for a programme row
   * staged before buildAwinCampaignExternalId existed.
   */
  async programmeBackedAdvertiserIds(advertiserIds = []) {
    const ids = [...new Set((advertiserIds ?? []).filter(Boolean).map(String))];
    if (!ids.length) return new Set();

    const rows = await this.db.entity.findMany({
      where: {
        networkSource: AWIN_NETWORK_SOURCE,
        entityType: AWIN_CAMPAIGN_ENTITY_TYPE,
        externalId: { in: [...ids.map((id) => `awin-campaign-${id}`), ...ids] },
      },
      select: { externalId: true, rawData: true },
    });

    const candidates = new Set(ids);
    const backed = new Set();
    for (const row of rows) {
      if (isDerivedAwinCampaignRaw(row.rawData)) continue;
      const advertiserId = awinCampaignAdvertiserId(row.rawData);
      if (advertiserId && candidates.has(advertiserId)) backed.add(advertiserId);
    }
    return backed;
  }

  /**
   * ONE bounded page of staged Awin offers → the parents its advertisers need.
   *
   * This is what a durable unit executes. It reads one keyset page, stages the parents that page's
   * advertisers need, and stops: no drain, no recursion, no supplier call. The continuation is a
   * separate durable unit.
   *
   * An advertiser whose offers straddle a page boundary is staged on each page that sees it, and
   * that is correct rather than merely tolerable: the Entity externalId is a pure function of the
   * advertiser id, so the second write lands on the same Entity as the first and the whole walk
   * still yields one Entity and one SupplierCampaign.
   */
  async materializePage({ cursorId = null, pageSize = AWIN_MATERIALIZATION_PAGE_SIZE } = {}) {
    const summary = emptySummary();
    summary.lastCursor = null;
    summary.hasMore = false;

    const page = await this.db.entity.findMany({
      where: {
        networkSource: AWIN_NETWORK_SOURCE,
        entityType: AWIN_COUPON_ENTITY_TYPE,
        ...(cursorId ? { id: { gt: cursorId } } : {}),
      },
      orderBy: { id: "asc" },
      take: pageSize,
      select: { id: true, rawData: true },
    });

    if (!page.length) return summary;

    const advertisers = new Map();
    for (const row of page) {
      summary.offersScanned += 1;
      const identity = awinAdvertiserIdentity(row.rawData);
      if (!identity) {
        summary.offersWithoutAdvertiser += 1;
        continue;
      }
      const existing = advertisers.get(identity.advertiserId);
      if (existing) {
        existing.offerEntityCount += 1;
        existing.advertiserName = existing.advertiserName ?? identity.advertiserName;
      } else {
        advertisers.set(identity.advertiserId, {
          advertiserId: identity.advertiserId,
          advertiserName: identity.advertiserName,
          offerEntityCount: 1,
        });
      }
    }

    summary.advertisersFound = advertisers.size;
    // The ids themselves, so a caller spanning several pages can count DISTINCT advertisers rather
    // than adding per-page totals — an advertiser whose offers straddle a boundary appears on both
    // pages. Counts only ever reach a durable unit's stored outcome; these do not.
    summary.advertiserIds = [...advertisers.keys()];
    // The cursor is this page's last PRIMARY KEY, which is immutable, so a row re-staged between
    // two invocations cannot move the boundary. hasMore is a full page, exactly as a promotion
    // page decides it.
    summary.lastCursor = page[page.length - 1].id;
    summary.hasMore = page.length >= pageSize;

    if (!advertisers.size) return summary;

    const programmeBacked = await this.programmeBackedAdvertiserIds([...advertisers.keys()]);

    const rows = [];
    for (const advertiser of advertisers.values()) {
      if (programmeBacked.has(advertiser.advertiserId)) {
        summary.skippedProgrammeBacked += 1;
        summary.skippedAdvertiserIds.push(advertiser.advertiserId);
        continue;
      }
      rows.push(buildDerivedAwinCampaignRow(advertiser));
      summary.stagedAdvertiserIds.push(advertiser.advertiserId);
    }

    if (!rows.length) return summary;

    await this.stageParents(rows);
    summary.parentsStaged = rows.length;
    return summary;
  }

  /** The one staging call, shared by the paged unit and the drain below. */
  async stageParents(rows) {
    return this.stageEntities({
      networkSource: AWIN_NETWORK_SOURCE,
      entityType: AWIN_CAMPAIGN_ENTITY_TYPE,
      rows,
      externalIdPrefix: "awin-campaign",
      sourceAccountKey: null,
      // An offer says nothing about a programme's commission terms, so the campaign-summary
      // fan-out is refused outright rather than left to find nothing. Awin commission groups have
      // their own evidenced path, keyed on this same advertiser id.
      commissionRuleFanOutDisabled: true,
      // These rows are derived from staged evidence, not from a supplier fetch, so they must not
      // resolve any NetworkSyncRun's verdict.
      finalizeSyncRun: false,
    });
  }

  /**
   * Drain every page. TEST AND OPS ONLY — this is NOT the production path.
   *
   * Production materializes through bounded durable units, one page per invocation, because the
   * whole estate does not fit in a 300s invocation. This is kept because it is the same work
   * composed of the same pages, which makes it a faithful stand-in when a test wants the finished
   * state rather than one step of it. Nothing in src/ calls it.
   */
  async materialize() {
    const total = emptySummary();
    let cursorId = null;
    let pages = 0;

    // DISTINCT across pages. An advertiser whose offers straddle a page boundary is seen by both,
    // and both stage it — onto the same Entity, because the externalId is a pure function of the
    // advertiser id. Summing per-page totals would report that one advertiser twice.
    const seen = new Set();
    const staged = new Set();
    const skipped = new Set();

    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const page = await this.materializePage({ cursorId, pageSize: this.pageSize });
      pages += 1;
      total.offersScanned += page.offersScanned;
      total.offersWithoutAdvertiser += page.offersWithoutAdvertiser;
      for (const id of page.advertiserIds) seen.add(id);
      for (const id of page.stagedAdvertiserIds) staged.add(id);
      for (const id of page.skippedAdvertiserIds) skipped.add(id);
      if (!page.hasMore || !page.lastCursor) break;
      cursorId = page.lastCursor;
    }

    total.advertisersFound = seen.size;
    total.parentsStaged = staged.size;
    total.skippedProgrammeBacked = skipped.size;
    total.advertiserIds = [...seen];
    total.stagedAdvertiserIds = [...staged];
    total.skippedAdvertiserIds = [...skipped];
    total.pages = pages;
    return total;
  }
}

/** The seam the promotion job calls. Kept as a function so it can be stubbed wholesale. */
export async function materializeAwinAdvertiserParents(options = {}) {
  return new AwinAdvertiserParentService(options).materialize();
}

/** Derived externalId for one advertiser, exported so tests can assert convergence directly. */
export function derivedAwinCampaignExternalId(advertiserId) {
  return buildAwinCampaignExternalId({ id: advertiserId });
}
