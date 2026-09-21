import { prisma } from "../../../database/prisma.js";
import {
  buildAwinCampaignExternalId,
  upsertManyRawEntities,
} from "../../raw/raw.service.js";

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

const SCAN_PAGE_SIZE = 500;

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
  };
}

export class AwinAdvertiserParentService {
  constructor(deps = {}) {
    this.db = deps.db ?? prisma;
    this.stageEntities = deps.stageEntities ?? upsertManyRawEntities;
    this.pageSize = deps.pageSize ?? SCAN_PAGE_SIZE;
  }

  /** Advertiser ids whose campaign Entity already holds real programme evidence. */
  async programmeBackedAdvertiserIds() {
    const rows = await this.db.entity.findMany({
      where: { networkSource: AWIN_NETWORK_SOURCE, entityType: AWIN_CAMPAIGN_ENTITY_TYPE },
      select: { externalId: true, rawData: true },
    });

    const backed = new Set();
    for (const row of rows) {
      if (isDerivedAwinCampaignRaw(row.rawData)) continue;
      const advertiserId = awinCampaignAdvertiserId(row.rawData);
      if (advertiserId) backed.add(advertiserId);
    }
    return backed;
  }

  /**
   * Group staged Awin offers by advertiser.
   *
   * Paged by primary key and accumulating only the id, the name and a count — the payloads
   * themselves are dropped as each page is consumed, so 5,011 offers cost 1,418 small entries
   * rather than 5,011 payloads held at once.
   */
  async collectAdvertisers() {
    const advertisers = new Map();
    let offersScanned = 0;
    let offersWithoutAdvertiser = 0;
    let cursorId = undefined;

    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const page = await this.db.entity.findMany({
        where: {
          networkSource: AWIN_NETWORK_SOURCE,
          entityType: AWIN_COUPON_ENTITY_TYPE,
          ...(cursorId ? { id: { gt: cursorId } } : {}),
        },
        orderBy: { id: "asc" },
        take: this.pageSize,
        select: { id: true, rawData: true },
      });
      if (!page.length) break;

      for (const row of page) {
        offersScanned += 1;
        const identity = awinAdvertiserIdentity(row.rawData);
        if (!identity) {
          offersWithoutAdvertiser += 1;
          continue;
        }
        const existing = advertisers.get(identity.advertiserId);
        if (existing) {
          existing.offerEntityCount += 1;
          // First non-empty name wins. Production shows no advertiser id whose rows disagree, so
          // this settles a case that does not arise rather than choosing between rival names.
          existing.advertiserName = existing.advertiserName ?? identity.advertiserName;
        } else {
          advertisers.set(identity.advertiserId, {
            advertiserId: identity.advertiserId,
            advertiserName: identity.advertiserName,
            offerEntityCount: 1,
          });
        }
      }

      cursorId = page[page.length - 1].id;
      if (page.length < this.pageSize) break;
    }

    return { advertisers, offersScanned, offersWithoutAdvertiser };
  }

  /**
   * Derive one campaign Entity per advertiser from the offers already staged.
   *
   * Idempotent: the externalId is a pure function of the advertiser id, so a second run restages
   * the same rows onto the same Entities rather than creating more.
   */
  async materialize() {
    const summary = emptySummary();

    const { advertisers, offersScanned, offersWithoutAdvertiser } = await this.collectAdvertisers();
    summary.offersScanned = offersScanned;
    summary.offersWithoutAdvertiser = offersWithoutAdvertiser;
    summary.advertisersFound = advertisers.size;

    if (!advertisers.size) return summary;

    const programmeBacked = await this.programmeBackedAdvertiserIds();

    const rows = [];
    for (const advertiser of advertisers.values()) {
      if (programmeBacked.has(advertiser.advertiserId)) {
        summary.skippedProgrammeBacked += 1;
        continue;
      }
      rows.push(buildDerivedAwinCampaignRow(advertiser));
    }

    if (!rows.length) return summary;

    await this.stageEntities({
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

    summary.parentsStaged = rows.length;
    return summary;
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
