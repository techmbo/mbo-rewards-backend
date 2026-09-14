import { prisma } from "../../database/prisma.js";
import { auditService } from "../../platform/audit/audit.service.js";
import { assertManualChangeAudited } from "../networkOps/manualChangeAuditControl.contract.js";
import {
  SUPPLIER_TRACKING_LINK_PROVENANCE,
  SUPPLIER_TRACKING_LINK_STATE,
  SupplierTrackingLinkValidationError,
  classifyTrackingUrlForAudit,
  validateSupplierTrackingUrl,
} from "./supplierTrackingLink.contract.js";

export const SUPPLIER_TRACKING_LINK_AGGREGATE = "supplier_campaign";
export const SUPPLIER_TRACKING_LINK_AUDIT_ACTION = "supplier_campaign.tracking_link.set";
export const SUPPLIER_TRACKING_LINK_FIELD = "trackingUrl";
export const MAX_WORK_QUEUE_PAGE_SIZE = 100;
export const DEFAULT_WORK_QUEUE_PAGE_SIZE = 25;

/** Operator-settable states. TRACKING_LINK_AVAILABLE is only reachable by storing a URL. */
export const OPERATOR_SETTABLE_STATES = Object.freeze([
  SUPPLIER_TRACKING_LINK_STATE.NEEDS_REVIEW,
  SUPPLIER_TRACKING_LINK_STATE.REVOKED,
]);

/** Only these columns ever leave this service. rawPayload/normalizedPayload are never exposed. */
const WORK_QUEUE_SELECT = Object.freeze({
  id: true,
  supplier: true,
  supplierRegion: true,
  supplierCampaignId: true,
  campaignName: true,
  merchantNameRaw: true,
  campaignStatus: true,
  participationStatus: true,
  isJoined: true,
  destinationUrl: true,
  trackingUrl: true,
  supplierTrackingLinkState: true,
  supplierTrackingLinkProvenance: true,
  supplierTrackingLinkUpdatedAt: true,
  supplierTrackingLinkUpdatedBy: true,
  updatedAt: true,
});

function toRow(record) {
  return {
    id: record.id,
    supplier: record.supplier,
    supplierRegion: record.supplierRegion,
    supplierCampaignId: record.supplierCampaignId,
    campaignName: record.campaignName,
    merchantNameRaw: record.merchantNameRaw,
    campaignStatus: record.campaignStatus,
    participationStatus: record.participationStatus,
    isJoined: record.isJoined,
    // Reference only — never a tracking-link candidate, never prefilled into the paste field.
    destinationUrl: record.destinationUrl,
    hasSupplierTrackingUrl: Boolean(record.trackingUrl && record.trackingUrl.trim()),
    supplierTrackingUrlHost: classifyTrackingUrlForAudit(record.trackingUrl),
    supplierTrackingLinkState: record.supplierTrackingLinkState,
    supplierTrackingLinkProvenance: record.supplierTrackingLinkProvenance,
    supplierTrackingLinkUpdatedAt: record.supplierTrackingLinkUpdatedAt,
    supplierTrackingLinkUpdatedBy: record.supplierTrackingLinkUpdatedBy,
    updatedAt: record.updatedAt,
  };
}

export class SupplierTrackingLinkService {
  constructor(deps = {}) {
    this.db = deps.db ?? prisma;
    this.audit = deps.audit ?? auditService;
  }

  /**
   * Work queue: campaigns needing a manually generated supplier tracking link.
   * Read-only and paginated. Defaults to joined/approved campaigns only — an unjoined campaign
   * is not actionable, so TRACKING_LINK_NOT_GENERATED must not be presented as work there.
   */
  async listWorkQueue({
    supplier = "PARTNERIZE",
    // null/undefined means "every state". The `if (state)` guard below is unchanged; only this
    // default moved, so an omitted filter no longer silently becomes NOT_GENERATED.
    state = null,
    joinedOnly = true,
    page = 1,
    pageSize = DEFAULT_WORK_QUEUE_PAGE_SIZE,
  } = {}) {
    const take = Math.max(1, Math.min(Number(pageSize) || DEFAULT_WORK_QUEUE_PAGE_SIZE, MAX_WORK_QUEUE_PAGE_SIZE));
    const currentPage = Math.max(1, Number(page) || 1);
    const skip = (currentPage - 1) * take;

    const where = {
      supplier: String(supplier).trim().toUpperCase(),
      archivedAt: null,
    };
    if (state) where.supplierTrackingLinkState = state;
    if (joinedOnly) {
      where.OR = [{ isJoined: true }, { participationStatus: "JOINED" }];
    }

    const [rows, total] = await Promise.all([
      this.db.supplierCampaign.findMany({
        where,
        select: WORK_QUEUE_SELECT,
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        skip,
        take,
      }),
      this.db.supplierCampaign.count({ where }),
    ]);

    return {
      rows: rows.map(toRow),
      pagination: { page: currentPage, pageSize: take, total },
    };
  }

  async #load(supplierCampaignId) {
    const record = await this.db.supplierCampaign.findUnique({
      where: { id: String(supplierCampaignId) },
      select: WORK_QUEUE_SELECT,
    });
    if (!record) {
      throw new SupplierTrackingLinkValidationError("Supplier campaign not found.", {
        code: "SUPPLIER_CAMPAIGN_NOT_FOUND",
      });
    }
    return record;
  }

  /**
   * A manual change with no identifiable actor cannot produce a complete audit entry, so it is
   * refused outright rather than written unattributed.
   */
  static assertActor(actor) {
    if (!actor?.id && !actor?.email) {
      throw new SupplierTrackingLinkValidationError(
        "An authenticated actor is required for a manual supplier tracking-link change.",
        { code: "ACTOR_REQUIRED" },
      );
    }
  }

  async #recordAudit({ record, before, after, reason, actor }) {
    const entry = {
      aggregateType: SUPPLIER_TRACKING_LINK_AGGREGATE,
      aggregateId: record.id,
      action: SUPPLIER_TRACKING_LINK_AUDIT_ACTION,
      actorId: actor?.id ?? null,
      actorEmail: actor?.email ?? null,
      before,
      after,
      reason,
      metadata: { field: SUPPLIER_TRACKING_LINK_FIELD, supplier: record.supplier },
    };
    // Manual changes to a campaign relationship must carry a complete audit entry. occurredAt
    // satisfies the contract's timestamp requirement; AuditEvent.createdAt is the persisted value.
    assertManualChangeAudited({
      category: "campaign_relationship",
      auditEntry: { ...entry, occurredAt: new Date() },
    });
    await this.audit.record(entry);
  }

  /**
   * Store or replace the supplier tracking link an operator generated in the supplier portal.
   * The caller supplies only the campaign id and the URL — never the supplier, publisher id,
   * campaign id override, destination URL or provenance. The server sets those.
   */
  async setSupplierTrackingLink({ supplierCampaignId, supplierTrackingUrl, actor = null, reason = null } = {}) {
    SupplierTrackingLinkService.assertActor(actor);
    const record = await this.#load(supplierCampaignId);
    const validated = validateSupplierTrackingUrl(supplierTrackingUrl, { supplier: record.supplier });

    const before = {
      supplierTrackingUrlHost: classifyTrackingUrlForAudit(record.trackingUrl),
      supplierTrackingLinkState: record.supplierTrackingLinkState,
      supplierTrackingLinkProvenance: record.supplierTrackingLinkProvenance,
    };
    const after = {
      supplierTrackingUrlHost: validated.hostname,
      supplierTrackingLinkState: SUPPLIER_TRACKING_LINK_STATE.AVAILABLE,
      supplierTrackingLinkProvenance: SUPPLIER_TRACKING_LINK_PROVENANCE.MANUAL_ADMIN,
    };

    const updated = await this.db.supplierCampaign.update({
      where: { id: record.id },
      data: {
        trackingUrl: validated.url,
        supplierTrackingLinkState: SUPPLIER_TRACKING_LINK_STATE.AVAILABLE,
        supplierTrackingLinkProvenance: SUPPLIER_TRACKING_LINK_PROVENANCE.MANUAL_ADMIN,
        supplierTrackingLinkUpdatedAt: new Date(),
        supplierTrackingLinkUpdatedBy: actor?.id ?? null,
      },
      select: WORK_QUEUE_SELECT,
    });

    await this.#recordAudit({
      record,
      before,
      after,
      reason: reason || "Manual supplier tracking link stored by operator.",
      actor,
    });

    return toRow(updated);
  }

  /** Mark an existing link NEEDS_REVIEW or REVOKED. The stored URL is retained for evidence. */
  async setSupplierTrackingLinkState({ supplierCampaignId, state, actor = null, reason = null } = {}) {
    SupplierTrackingLinkService.assertActor(actor);
    const next = String(state ?? "").trim().toUpperCase();
    if (!OPERATOR_SETTABLE_STATES.includes(next)) {
      throw new SupplierTrackingLinkValidationError(
        "State is not operator-settable; store a tracking link to reach TRACKING_LINK_AVAILABLE.",
        { code: "STATE_NOT_OPERATOR_SETTABLE", details: { allowed: [...OPERATOR_SETTABLE_STATES] } },
      );
    }
    const record = await this.#load(supplierCampaignId);

    const updated = await this.db.supplierCampaign.update({
      where: { id: record.id },
      data: {
        supplierTrackingLinkState: next,
        supplierTrackingLinkUpdatedAt: new Date(),
        supplierTrackingLinkUpdatedBy: actor?.id ?? null,
      },
      select: WORK_QUEUE_SELECT,
    });

    await this.#recordAudit({
      record,
      before: { supplierTrackingLinkState: record.supplierTrackingLinkState },
      after: { supplierTrackingLinkState: next },
      reason: reason || `Operator set supplier tracking link state to ${next}.`,
      actor,
    });

    return toRow(updated);
  }
}

export const supplierTrackingLinkService = new SupplierTrackingLinkService();
