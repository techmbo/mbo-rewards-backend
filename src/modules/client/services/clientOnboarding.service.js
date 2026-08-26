import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../../../database/prisma.js";
import { fail } from "../../../core/apiResponse.js";
import { runWithConcurrency } from "../../../core/concurrency.js";
import { hashPassword } from "../../auth/auth.service.js";
import { CatalogService } from "../../catalog/services/catalog.service.js";
import { SourceSelectionService } from "../../catalog/services/sourceSelection.service.js";
import { CampaignSourceRepository } from "../../catalog/repositories/campaignSource.repository.js";
import {
  CommissionRuleRepository,
  CouponAssignmentRepository,
  TrackingLinkRepository,
} from "../../commercial/repositories/commercial.repository.js";
import { buildMboTrackingUrl, buildTrackingSlug } from "../../commercial/trackingUrl.js";
import {
  buildAssignedMboTrackingUrl,
  buildAssignedTrackingSlug,
  resolveSupplierCampaignBrandSlug,
} from "../../commercial/supplierCampaignTracking.js";
import {
  destinationFromCouponCmsEntity,
  looksLikeHttpUrl,
  resolveSupplierDestination,
} from "../../commercial/resolveSupplierDestination.js";
import { deriveMboCommission } from "../../commercial/commissionMath.js";
import {
  getCouponCampaignStatus,
  assertCouponAllottable,
} from "../../coupons/couponCms.service.js";
import { isCampaignStatusAllottable } from "../../coupons/couponMerge.js";
import { buildAllotmentDisplayFields } from "../../coupons/allotmentFields.js";
import { ClientRepository } from "../repositories/client.repository.js";
import { ClientCampaignAssignmentRepository } from "../repositories/clientCampaignAssignment.repository.js";
import { ClientAssignmentService } from "./clientAssignment.service.js";
import { ClientCredentialService } from "./clientCredential.service.js";
import { ClientVisibilityService } from "./visibility.service.js";
import { resolveCommercialPreset } from "../constants/commercialModels.js";
import { buildClientSetupProgress, emptyOrderMetrics } from "../setupProgress.js";
import { summarizeAssignmentProvisioning } from "../provisioningStatus.js";
import { toClientCampaignAssignmentDto } from "../dto/client.dto.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Per-assignment TX when catalog/merchant work is already prefetched outside. */
const ALLOT_TX_OPTIONS = {
  maxWait: 10_000,
  timeout: 25_000,
};

/** How many different campaign groups to allot in parallel. */
const ALLOT_GROUP_CONCURRENCY = Number(process.env.ALLOT_GROUP_CONCURRENCY || 8);

/** Onboarding assignment include — merchant + source for activation review (no order metrics). */
const ONBOARDING_ASSIGNMENT_INCLUDE = {
  canonicalCampaign: {
    select: {
      id: true,
      displayName: true,
      status: true,
      visibility: true,
      countries: true,
      defaultCurrency: true,
      merchant: {
        select: { id: true, displayName: true, logoUrl: true, website: true },
      },
    },
  },
  campaignSource: {
    include: {
      supplierCampaign: {
        select: {
          id: true,
          supplier: true,
          supplierCampaignId: true,
          campaignType: true,
          pricingModel: true,
          campaignStatus: true,
          campaignLogoUrl: true,
          deepLinkingEnabled: true,
          currencyCode: true,
          countryCodes: true,
          isJoined: true,
          participationStatus: true,
          merchantNameRaw: true,
        },
      },
    },
  },
  trackingLinks: {
    where: { deletedAt: null },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
    take: 10,
  },
  couponAssignments: {
    where: { status: { in: ["ASSIGNED", "ACTIVE"] } },
    orderBy: [{ createdAt: "desc" }],
    take: 10,
  },
  commissionRules: {
    where: { status: { in: ["DRAFT", "EFFECTIVE"] } },
    orderBy: [{ effectiveFrom: "desc" }],
    take: 10,
  },
};

function hashInviteToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function generateInviteToken() {
  return randomBytes(32).toString("hex");
}

export class ClientOnboardingService {
  constructor(deps = {}) {
    this.clientRepo = deps.clientRepo ?? new ClientRepository();
    this.assignmentRepo = deps.assignmentRepo ?? new ClientCampaignAssignmentRepository();
    this.assignmentService = deps.assignmentService ?? new ClientAssignmentService();
    this.catalogService = deps.catalogService ?? new CatalogService();
    this.sourceRepo = deps.sourceRepo ?? new CampaignSourceRepository();
    this.selection = deps.selection ?? new SourceSelectionService();
    this.trackingRepo = deps.trackingRepo ?? new TrackingLinkRepository();
    this.couponRepo = deps.couponRepo ?? new CouponAssignmentRepository();
    this.commissionRepo = deps.commissionRepo ?? new CommissionRuleRepository();
    this.credentialService = deps.credentialService ?? new ClientCredentialService();
    this.visibility = deps.visibility ?? new ClientVisibilityService();
    this.resolveDestination = deps.resolveDestination ?? resolveSupplierDestination;
    this.runInTransaction =
      deps.runInTransaction ?? ((fn, options) => prisma.$transaction(fn, options));
  }

  async getState(clientId) {
    const client = await this.clientRepo.findById(clientId, { includeRelations: true });
    if (!client) throw fail("Client not found.", 404);

    const [portalUsers, apiKeys, assignments] = await Promise.all([
      this.credentialService.listPortalUsers(clientId),
      this.credentialService.listApiCredentials(clientId),
      this.loadAssignmentsWithCommercial(clientId, { includeOrderMetrics: false }),
    ]);

    const activeAssignments = assignments.filter((a) => a.status !== "REVOKED");
    const hasAssignments = activeAssignments.length > 0;
    const hasPublishedAssignment = activeAssignments.some((a) => a.published === true);
    const allPublished = hasAssignments && activeAssignments.every((a) => a.published);
    const hasAdmin = portalUsers.some((u) => u.isActive);
    const activeKeys = apiKeys.filter((k) => k.isActive);
    const hasSandboxKey = activeKeys.some((k) => k.environment === "SANDBOX");
    const hasProductionKey = activeKeys.some(
      (k) => !k.environment || k.environment === "PRODUCTION",
    );
    const hasApiKey = hasProductionKey || activeKeys.length > 0;

    const progress = buildClientSetupProgress({
      status: client.status,
      commercialModel: client.commercialModel,
      deliveryMethod: client.deliveryMethod,
      agreementStatus: client.agreementStatus,
      hasAssignments,
      hasPublishedAssignment,
      allPublished,
      hasApiKey,
      hasSandboxKey,
      hasProductionKey,
      hasAdmin,
      hasCouponAssignments: activeAssignments.some((a) => (a.couponAssignments?.length ?? 0) > 0),
      hasCommissionRules: activeAssignments.every((a) => (a.commissionRules?.length ?? 0) > 0),
      hasTrackingLinks: activeAssignments.every((a) =>
        (a.trackingLinks || []).some((t) => t.mboTrackingUrl),
      ),
    });

    return {
      client: {
        id: client.id,
        name: client.name,
        slug: client.slug,
        legalName: client.legalName ?? null,
        status: client.status,
        country: client.country,
        industry: client.industry,
        category: client.category,
        subCategory: client.subCategory,
        currency: client.currency,
        timezone: client.timezone,
        commercialModel: client.commercialModel,
        deliveryMethod: client.deliveryMethod ?? "API_AND_PORTAL",
        agreementStatus: client.agreementStatus ?? "NONE",
        agreementEffectiveAt: client.agreementEffectiveAt?.toISOString?.() ?? client.agreementEffectiveAt ?? null,
        agreementRenewalAt: client.agreementRenewalAt?.toISOString?.() ?? client.agreementRenewalAt ?? null,
        agreementDocumentUrl: client.agreementDocumentUrl ?? null,
        paymentCycle: client.paymentCycle ?? null,
        paymentTrigger: client.paymentTrigger ?? null,
        apiEnvironmentConfig: client.apiEnvironmentConfig ?? null,
        clientSharePercent:
          client.clientSharePercent == null || client.clientSharePercent === ""
            ? null
            : Number(client.clientSharePercent),
      },
      commercialModel: client.commercialModel,
      commercialPreset: resolveCommercialPreset(client.commercialModel, client.clientSharePercent),
      clientSharePercent:
        client.clientSharePercent == null || client.clientSharePercent === ""
          ? null
          : Number(client.clientSharePercent),
      deliveryMethod: client.deliveryMethod ?? "API_AND_PORTAL",
      portalUsers,
      apiKeys,
      assignments,
      checklist: progress.checklist,
      activationBlocks: (() => {
        const blocks = [];
        if (!progress.checklist.agreementSigned) blocks.push("Signed agreement");
        if (!progress.checklist.commercialConfigured) blocks.push("Commercial model");
        if (!progress.checklist.campaignsAllotted) blocks.push("Campaign allotment");
        if (!progress.checklist.assignmentsPublished) blocks.push("Published campaigns");
        if (progress.checklist.needsApi && !progress.checklist.apiKeyIssued) {
          blocks.push("Production API key");
        }
        if (progress.checklist.needsPortal && !progress.checklist.administratorConfigured) {
          blocks.push("Portal administrator");
        }
        if (!progress.checklist.provisioned) blocks.push("Provisioning complete");
        return blocks;
      })(),
      activationBlockDetails: (() => {
        const details = [];
        if (!progress.checklist.agreementSigned) {
          details.push({
            code: "AGREEMENT_MISSING",
            message: "A signed agreement is required before activation.",
            severity: "blocked",
          });
        }
        if (!progress.checklist.commercialConfigured) {
          details.push({
            code: "COMMERCIAL_MISSING",
            message: "Commercial model is not configured.",
            severity: "blocked",
          });
        }
        if (!progress.checklist.campaignsAllotted) {
          details.push({
            code: "ALLOTMENT_MISSING",
            message: "No campaigns have been allotted.",
            severity: "blocked",
          });
        }
        if (!progress.checklist.assignmentsPublished) {
          details.push({
            code: "PUBLISH_MISSING",
            message: "At least one campaign must be provisioned and published before activation.",
            severity: "blocked",
          });
        }
        if (progress.checklist.needsApi && !progress.checklist.apiKeyIssued) {
          details.push({
            code: "API_KEY_MISSING",
            message: "A Production API key must be issued before activation for API delivery.",
            severity: "blocked",
          });
        }
        if (progress.checklist.needsApi && !progress.checklist.sandboxConfigured) {
          details.push({
            code: "SANDBOX_RECOMMENDED",
            message: "Sandbox API is recommended for client integration testing before go-live.",
            severity: "needs_review",
          });
        }
        if (progress.checklist.needsPortal && !progress.checklist.administratorConfigured) {
          details.push({
            code: "PORTAL_ADMIN_REQUIRED",
            message: "An active portal administrator is required for portal delivery.",
            severity: "blocked",
          });
        }
        if (!progress.checklist.provisioned) {
          details.push({
            code: "PROVISION_INCOMPLETE",
            message: "Provision the client before activation.",
            severity: "blocked",
          });
        }
        return details;
      })(),
      setupProgress: {
        steps: progress.steps,
        completedSteps: progress.completedSteps,
        totalSteps: progress.totalSteps,
        setupComplete: progress.setupComplete,
      },
      suggestedStep: progress.suggestedStep,
    };
  }

  async setCommercialModel(clientId, { commercialModel, clientSharePercent } = {}) {
    const client = await this.clientRepo.findById(clientId);
    if (!client) throw fail("Client not found.", 404);
    if (client.status === "OFFBOARDED") throw fail("Cannot configure an offboarded client.", 409);
    if (!resolveCommercialPreset(commercialModel)) {
      throw fail("Invalid commercial model.", 400);
    }

    let share = 0;
    if (commercialModel === "OFFERS_ONLY") {
      share = 0;
    } else {
      const raw = clientSharePercent == null || clientSharePercent === "" ? 70 : Number(clientSharePercent);
      if (!Number.isFinite(raw) || raw < 0 || raw > 100) {
        throw fail("Client share percent must be between 0 and 100.", 400);
      }
      share = Math.round(raw * 100) / 100;
    }

    const preset = resolveCommercialPreset(commercialModel, share);
    const updated = await this.clientRepo.update(clientId, {
      commercialModel,
      clientSharePercent: share,
    });

    // Re-sync commission rules for existing draft/active assignments when model changes.
    const assignments = await this.assignmentRepo.findMany(
      { clientId, status: undefined },
      { skip: 0, take: 500 },
    );
    for (const assignment of assignments.rows) {
      if (assignment.status === "REVOKED") continue;
      await this.ensureCommissionRule(assignment.id, commercialModel, null, {
        clientSharePercent: preset.clientSharePercent,
      });
    }

    return updated;
  }

  async inviteAdministrator(clientId, { email, name }) {
    const client = await this.clientRepo.findById(clientId);
    if (!client) throw fail("Client not found.", 404);
    if (client.status === "OFFBOARDED") throw fail("Cannot invite admin for an offboarded client.", 409);

    const existingActive = await prisma.user.findFirst({
      where: { clientId, role: "CLIENT", isActive: true },
    });
    if (existingActive) {
      const inviteActive =
        existingActive.inviteTokenHash &&
        existingActive.inviteExpiresAt &&
        existingActive.inviteExpiresAt > new Date();
      const canRefreshInvite = Boolean(existingActive.inviteTokenHash) || !existingActive.passwordSetAt;

      if (inviteActive || canRefreshInvite) {
        const token = generateInviteToken();
        const inviteTokenHash = hashInviteToken(token);
        const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
        await prisma.user.update({
          where: { id: existingActive.id },
          data: {
            inviteTokenHash,
            inviteExpiresAt: expiresAt,
            name: name?.trim() || existingActive.name,
          },
        });
        return {
          user: {
            id: existingActive.id,
            email: existingActive.email,
            name: name?.trim() || existingActive.name,
            invitePending: true,
          },
          inviteToken: token,
          inviteExpiresAt: expiresAt.toISOString(),
          reused: true,
        };
      }
      throw fail(
        "A portal administrator already exists for this client. Disable the existing user before inviting another.",
        409,
      );
    }

    const normalizedEmail = email.trim().toLowerCase();
    const emailTaken = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (emailTaken) throw fail("An account with this email already exists.", 409);

    const token = generateInviteToken();
    const inviteTokenHash = hashInviteToken(token);
    const placeholderHash = await hashPassword(randomBytes(32).toString("hex"));

    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash: placeholderHash,
        name: name?.trim() || null,
        role: "CLIENT",
        clientId,
        isActive: true,
        inviteTokenHash,
        inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS),
        passwordSetAt: null,
      },
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        invitePending: true,
      },
      inviteToken: token,
      inviteExpiresAt: user.inviteExpiresAt.toISOString(),
      reused: false,
    };
  }

  /**
   * Wave B — allot from CanonicalCampaign + CampaignSource (no Coupon Entity required).
   * Optional couponEntityId only creates ClientCouponAssignment.
   */
  async allotCanonicalCampaigns(clientId, assignments = []) {
    const client = await this.clientRepo.findById(clientId);
    if (!client) throw fail("Client not found.", 404);
    if (client.status === "OFFBOARDED") throw fail("Cannot allot campaigns to an offboarded client.", 409);
    if (!client.commercialModel) {
      throw fail("Select a commercial model before allotting campaigns.", 409);
    }
    if (!Array.isArray(assignments) || assignments.length === 0) {
      throw fail("Select at least one canonical campaign assignment.", 400);
    }
    if (assignments.length > 500) {
      throw fail("Select at most 500 campaigns per allotment request.", 400);
    }

    const results = [];
    const alreadyAssigned = [];
    const failures = [];

    for (const item of assignments) {
      try {
        const outcome = await this.runInTransaction(async (tx) => {
          const assignment = await this.assignmentService.createClientCampaignAssignment(
            {
              clientId: client.id,
              clientRecord: client,
              canonicalCampaignId: item.canonicalCampaignId ?? null,
              campaignSourceId: item.campaignSourceId ?? null,
              supplierCampaignId: item.supplierCampaignId ?? null,
              couponEntityId: item.couponEntityId ?? null,
              publish: false,
            },
            tx,
          );

          if (assignment?._allotmentOutcome === "already_assigned") {
            return {
              outcome: "already_assigned",
              assignmentId: assignment.id,
              canonicalCampaignId: assignment.canonicalCampaignId,
              campaignSourceId: assignment.campaignSourceId ?? null,
              status: assignment.status,
              published: assignment.published,
            };
          }

          await this.ensureCommissionRuleDraft(assignment.id, client.commercialModel, tx, {
            clientSharePercent: client.clientSharePercent,
          });

          const bound = await this.bindCampaignSource(assignment, tx);
          let tracking = null;
          let trackingStatus = "PENDING";
          let trackingIssue = null;
          try {
            tracking = await this.ensureTrackingLink(bound, tx, {
              couponEntityId: item.couponEntityId ?? null,
            });
            trackingStatus = tracking?.mboTrackingUrl ? "READY" : "PENDING";
            if (!tracking?.mboTrackingUrl) {
              trackingIssue = "Publisher tracking URL not confirmed";
            }
          } catch (trackError) {
            // Keep assignment + commission; do not invent a tracking URL.
            trackingStatus = "PENDING";
            trackingIssue =
              trackError?.message || "Publisher tracking URL not confirmed from supplier data";
          }

          return {
            outcome: "assigned",
            assignmentId: assignment.id,
            canonicalCampaignId: assignment.canonicalCampaignId,
            campaignSourceId: bound.campaignSourceId ?? assignment.campaignSourceId ?? null,
            status: assignment.status,
            published: assignment.published,
            couponAssignments: item.couponEntityId ? 1 : 0,
            trackingGenerated: Boolean(tracking?.mboTrackingUrl),
            trackingUrl: tracking?.mboTrackingUrl ?? null,
            trackingStatus,
            trackingIssue,
            commercialRuleStatus: "DRAFT",
            provisioningStatus: tracking?.mboTrackingUrl ? "READY" : "TRACKING_PENDING",
            allotmentPath: "canonical_assignments",
          };
        }, ALLOT_TX_OPTIONS);

        if (outcome.outcome === "already_assigned") {
          alreadyAssigned.push(outcome);
        } else {
          results.push(outcome);
        }
      } catch (error) {
        if (error?.code === "ALREADY_ASSIGNED" || /already exists/i.test(error?.message || "")) {
          alreadyAssigned.push({
            outcome: "already_assigned",
            canonicalCampaignId: item.canonicalCampaignId ?? null,
            campaignSourceId: item.campaignSourceId ?? null,
            assignmentId: error.existingAssignmentId ?? null,
            message: error.message,
          });
          continue;
        }
        failures.push({
          outcome: "blocked",
          canonicalCampaignId: item.canonicalCampaignId,
          campaignSourceId: item.campaignSourceId ?? null,
          supplierCampaignId: item.supplierCampaignId ?? null,
          message: error?.message || "Failed to allot campaign.",
          statusCode: error?.statusCode || 500,
        });
      }
    }

    if (results.length === 0 && alreadyAssigned.length === 0 && failures.length > 0) {
      const first = failures[0];
      throw fail(first.message || "Failed to allot campaigns.", first.statusCode || 500);
    }

    return {
      clientId,
      clientStatus: client.status,
      allotted: results,
      alreadyAssigned,
      failures,
      meta: {
        selected: assignments.length,
        assigned: results.length,
        alreadyAssigned: alreadyAssigned.length,
        blocked: failures.length,
        total: results.length,
        requested: assignments.length,
        failed: failures.length,
        sourceOfTruth: "canonical_campaign_source",
      },
    };
  }

  /**
   * LEGACY / MIGRATION bridge — allot via Coupon CMS Entity ids.
   * Prefer allotCanonicalCampaigns. Still creates CanonicalCampaign + CampaignSource when linked.
   */
  async allotCouponCmsCampaigns(clientId, couponEntityIds = []) {
    const client = await this.clientRepo.findById(clientId);
    if (!client) throw fail("Client not found.", 404);
    if (client.status === "OFFBOARDED") throw fail("Cannot allot campaigns to an offboarded client.", 409);
    if (!client.commercialModel) {
      throw fail("Select a commercial model before allotting campaigns.", 409);
    }
    if (!Array.isArray(couponEntityIds) || couponEntityIds.length === 0) {
      throw fail("Select at least one Coupon CMS campaign.", 400);
    }

    const uniqueIds = [...new Set(couponEntityIds.map(String))];
    if (uniqueIds.length > 500) {
      throw fail("Select at most 500 campaigns per allotment request.", 400);
    }

    // --- Prefetch everything once (avoids N× entity + supplier lookups) ---
    const [entities, supplierCoupons] = await Promise.all([
      prisma.entity.findMany({
        where: { id: { in: uniqueIds }, entityType: "coupon" },
      }),
      prisma.supplierCoupon.findMany({
        where: { entityId: { in: uniqueIds } },
        orderBy: [{ lastSyncedAt: "desc" }, { id: "desc" }],
      }),
    ]);

    const entityById = new Map(entities.map((row) => [row.id, row]));
    const supplierByEntityId = new Map();
    for (const coupon of supplierCoupons) {
      if (!coupon.entityId || supplierByEntityId.has(coupon.entityId)) continue;
      supplierByEntityId.set(coupon.entityId, coupon);
    }

    const missing = uniqueIds.filter((id) => !entityById.has(id));
    if (missing.length) {
      throw fail(`Coupon CMS campaign not found: ${missing[0]}`, 404);
    }

    const prepared = [];
    for (const entityId of uniqueIds) {
      const entity = entityById.get(entityId);
      const status = getCouponCampaignStatus(entity);
      if (!isCampaignStatusAllottable(status)) {
        throw fail(
          `Campaign "${entity.campaignName || entity.entityName || entityId}" is Paused and cannot be newly allotted.`,
          409,
        );
      }

      const couponCms = {
        entity,
        supplierCoupon: supplierByEntityId.get(entityId) ?? null,
        supplierCampaignId: supplierByEntityId.get(entityId)?.supplierCampaignId ?? null,
      };

      // Prefer in-memory destination from coupon fields (no parent campaign scan).
      let destination = destinationFromCouponCmsEntity(entity);
      if (!looksLikeHttpUrl(destination.url) && couponCms.supplierCoupon?.couponLink) {
        destination = {
          url: String(couponCms.supplierCoupon.couponLink).trim(),
          source: "supplierCoupon.couponLink",
        };
      }

      const allotment = buildAllotmentDisplayFields(entity);
      const catalogKey = [
        String(allotment.brandName || entity.advertiserName || "unknown").trim().toLowerCase(),
        String(entity.campaignName || entity.entityName || "").trim().toLowerCase(),
      ].join("::");

      prepared.push({
        entityId,
        entity,
        couponCms,
        destination,
        allotment,
        catalogKey,
      });
    }

    // --- Ensure catalog campaigns once per brand+campaign (not per parallel TX) ---
    const catalogIdByKey = new Map();
    for (const item of prepared) {
      if (catalogIdByKey.has(item.catalogKey)) {
        item.canonicalCampaignId = catalogIdByKey.get(item.catalogKey);
        continue;
      }
      const canonicalCampaignId = await this.catalogService.ensureFromCouponCmsEntity(item.entity, prisma);
      catalogIdByKey.set(item.catalogKey, canonicalCampaignId);
      item.canonicalCampaignId = canonicalCampaignId;
    }

    // Group by catalog campaign so duplicate-brand races stay serial within a group,
    // while different campaigns allot concurrently.
    const groups = new Map();
    for (const item of prepared) {
      const key = item.canonicalCampaignId || item.catalogKey;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }

    const groupResults = await runWithConcurrency(
      [...groups.values()],
      ALLOT_GROUP_CONCURRENCY,
      async (groupItems) => {
        const allotted = [];
        const failures = [];
        for (const item of groupItems) {
          try {
            const result = await this.allotPreparedCouponCms(client, item, {
              commercialModel: client.commercialModel,
              clientSharePercent: client.clientSharePercent,
            });
            allotted.push(result);
          } catch (error) {
            failures.push({
              couponEntityId: item.entityId,
              campaignName: item.entity.campaignName || item.entity.entityName || null,
              message: error?.message || "Failed to allot campaign.",
              statusCode: error?.statusCode || 500,
            });
          }
        }
        return { allotted, failures };
      },
    );

    const results = groupResults.flatMap((chunk) => chunk.allotted);
    const failures = groupResults.flatMap((chunk) => chunk.failures);

    if (results.length === 0 && failures.length > 0) {
      const first = failures[0];
      throw fail(first.message || "Failed to allot campaigns.", first.statusCode || 500);
    }

    return {
      clientId,
      clientStatus: client.status,
      allotted: results,
      failures,
      meta: {
        total: results.length,
        requested: uniqueIds.length,
        failed: failures.length,
      },
    };
  }

  /**
   * Fast path for a prefetched coupon: short TX with pre-resolved catalog + destination.
   */
  async allotPreparedCouponCms(client, item, { commercialModel, clientSharePercent } = {}) {
    const { entityId, couponCms, destination, allotment, canonicalCampaignId } = item;

    return prisma.$transaction(async (tx) => {
      // Resolve CampaignSource when supplier campaign is known (Wave B SoT).
      let campaignSourceId = null;
      if (couponCms.supplierCampaignId) {
        const sources = await this.sourceRepo.findByCanonicalCampaignId(canonicalCampaignId, tx);
        const match = sources.find(
          (s) => s.supplierCampaignId === couponCms.supplierCampaignId && s.isActive,
        );
        campaignSourceId = match?.id ?? sources.find((s) => s.isPrimary)?.id ?? sources[0]?.id ?? null;
      }

      const assignment = await this.assignmentService.createClientCampaignAssignment(
        {
          clientId: client.id,
          // LEGACY couponEntityId retained for coupon assignment + destination resolution.
          couponEntityId: entityId,
          couponCms,
          clientRecord: client,
          canonicalCampaignId,
          campaignSourceId,
          supplierCampaignId: couponCms.supplierCampaignId ?? null,
          publish: false,
        },
        tx,
      );

      await this.ensureCommissionRuleDraft(assignment.id, commercialModel, tx, { clientSharePercent });

      const tracking = await this.ensureTrackingLinkPrepared(assignment, tx, {
        resolvedDestination: destination,
        clientSlug: client.slug,
        brandName: allotment.brandName || couponCms.entity.advertiserName,
        campaignName: couponCms.entity.campaignName || couponCms.entity.entityName,
      });

      return {
        assignmentId: assignment.id,
        canonicalCampaignId: assignment.canonicalCampaignId,
        campaignSourceId: assignment.campaignSourceId ?? campaignSourceId ?? null,
        status: assignment.status,
        published: assignment.published,
        couponAssignments: 1,
        trackingGenerated: Boolean(tracking?.mboTrackingUrl),
        trackingUrl: tracking?.mboTrackingUrl ?? null,
        legacyCouponEntityId: entityId,
      };
    }, ALLOT_TX_OPTIONS);
  }

  /** @deprecated Prefer allotCouponCmsCampaigns bulk path — kept for callers/tests. */
  async allotSingleCouponCms(clientId, couponEntityId, commercialModel, { clientSharePercent } = {}) {
    await assertCouponAllottable(couponEntityId);
    const client = await this.clientRepo.findById(clientId);
    if (!client) throw fail("Client not found.", 404);

    const entity = await prisma.entity.findFirst({
      where: { id: couponEntityId, entityType: "coupon" },
    });
    if (!entity) throw fail("Coupon CMS coupon not found.", 404);

    const supplierCoupon = await prisma.supplierCoupon.findFirst({
      where: { entityId: couponEntityId },
      orderBy: { lastSyncedAt: "desc" },
    });

    const destinationFromFields = destinationFromCouponCmsEntity(entity);
    const destination = looksLikeHttpUrl(destinationFromFields.url)
      ? destinationFromFields
      : await this.resolveDestination(
          { couponEntityId, assignmentId: null, preferPersisted: false },
          prisma,
        );

    const allotment = buildAllotmentDisplayFields(entity);
    const canonicalCampaignId = await this.catalogService.ensureFromCouponCmsEntity(entity, prisma);

    return this.allotPreparedCouponCms(
      { ...client, commercialModel: commercialModel || client.commercialModel },
      {
        entityId: couponEntityId,
        entity,
        couponCms: {
          entity,
          supplierCoupon: supplierCoupon ?? null,
          supplierCampaignId: supplierCoupon?.supplierCampaignId ?? null,
        },
        destination,
        allotment,
        canonicalCampaignId,
      },
      {
        commercialModel: commercialModel || client.commercialModel,
        clientSharePercent: clientSharePercent ?? client.clientSharePercent,
      },
    );
  }

  /**
   * One lookup + create/update for DRAFT commission — no multi-query guarantee dance.
   */
  async ensureCommissionRuleDraft(assignmentId, commercialModel, client = null, { clientSharePercent } = {}) {
    const db = client ?? prisma;
    const preset = resolveCommercialPreset(commercialModel, clientSharePercent);
    if (!preset) throw fail("Invalid commercial model.", 400);

    const mboCommission = deriveMboCommission(preset.grossCommission, preset.clientCommission);
    const existing = await db.clientCommissionRule.findFirst({
      where: { assignmentId, status: { in: ["DRAFT", "EFFECTIVE"] } },
      orderBy: [{ status: "desc" }, { effectiveFrom: "desc" }],
    });

    if (existing) {
      if (
        String(existing.clientCommission) === preset.clientCommission &&
        String(existing.grossCommission) === preset.grossCommission
      ) {
        return existing;
      }
      if (existing.status === "DRAFT") {
        return db.clientCommissionRule.update({
          where: { id: existing.id },
          data: {
            grossCommission: preset.grossCommission,
            clientCommission: preset.clientCommission,
            mboCommission,
            commissionType: preset.commissionType,
          },
        });
      }
      await db.clientCommissionRule.update({
        where: { id: existing.id },
        data: { status: "SUPERSEDED", effectiveUntil: new Date() },
      });
    }

    const effectiveFrom = new Date();
    // Unique (assignmentId, effectiveFrom) — nudge if same-second collision
    try {
      return await db.clientCommissionRule.create({
        data: {
          assignmentId,
          grossCommission: preset.grossCommission,
          clientCommission: preset.clientCommission,
          mboCommission,
          commissionType: preset.commissionType,
          effectiveFrom,
          effectiveUntil: null,
          status: "DRAFT",
        },
      });
    } catch (error) {
      effectiveFrom.setSeconds(effectiveFrom.getSeconds() + 1);
      return db.clientCommissionRule.create({
        data: {
          assignmentId,
          grossCommission: preset.grossCommission,
          clientCommission: preset.clientCommission,
          mboCommission,
          commissionType: preset.commissionType,
          effectiveFrom,
          effectiveUntil: null,
          status: "DRAFT",
        },
      });
    }
  }

  /**
   * Create/update primary tracking using pre-resolved destination and slug parts — no extra JOIN tree.
   */
  async ensureTrackingLinkPrepared(assignment, client = null, options = {}) {
    const {
      resolvedDestination = null,
      clientSlug = null,
      brandName = null,
      campaignName = null,
    } = options;

    const resolved =
      resolvedDestination && looksLikeHttpUrl(resolvedDestination.url)
        ? resolvedDestination
        : await this.resolveDestination(
            {
              assignmentId: assignment.id,
              preferPersisted: false,
            },
            client,
          );

    const existing = await this.trackingRepo.findPrimaryForAssignment(assignment.id, client);
    if (existing) {
      const patch = {};
      if (!looksLikeHttpUrl(existing.supplierTrackingUrl) && resolved.url) {
        patch.supplierTrackingUrl = resolved.url;
      }
      if (Object.keys(patch).length) {
        return this.trackingRepo.update(existing.id, patch, client);
      }
      return existing;
    }

    if (!looksLikeHttpUrl(resolved?.url)) {
      // Still allow assignment without tracking; provision will retry destination resolution.
      return null;
    }

    const brandSlug = resolveSupplierCampaignBrandSlug({
      merchantNameRaw: brandName,
      campaignName,
    });
    const built = buildAssignedMboTrackingUrl({
      brandSlug,
      clientSlug,
    });
    const { slug: linkSlug, subId, mboTrackingUrl } = built;
    await this.trackingRepo.clearPrimaryForAssignment(assignment.id, null, client);

    return this.trackingRepo.create(
      {
        assignmentId: assignment.id,
        campaignSourceId: assignment.campaignSourceId ?? null,
        slug: linkSlug,
        subId,
        supplierTrackingUrl: resolved.url,
        mboTrackingUrl,
        trackingType: "STANDARD",
        status: "GENERATED",
        isPrimary: true,
        expiresAt: null,
      },
      client,
    );
  }

  async bindCampaignSource(assignment, client = null) {
    if (assignment.campaignSourceId) return assignment;

    const sources = await this.sourceRepo.findByCanonicalCampaignId(
      assignment.canonicalCampaignId,
      client,
    );
    const { primary } = this.selection.select(sources);
    const fallback = sources.find((s) => s.isActive) ?? sources[0] ?? null;
    const source = primary ?? fallback;
    // Coupon CMS allotment does not require a CampaignSource / SupplierCampaign.
    if (!source) return assignment;

    return this.assignmentRepo.update(assignment.id, { campaignSourceId: source.id }, client);
  }

  async ensureCommissionRule(assignmentId, commercialModel, client = null, { clientSharePercent } = {}) {
    // Keep full path for commercial model re-sync; bulk allot uses ensureCommissionRuleDraft.
    return this.ensureCommissionRuleDraft(assignmentId, commercialModel, client, { clientSharePercent });
  }

  async ensureTrackingLink(assignment, client = null, options = {}) {
    const { couponEntityId = null, resolvedDestination = null } = options;
    const resolved =
      resolvedDestination && looksLikeHttpUrl(resolvedDestination.url)
        ? resolvedDestination
        : await this.resolveDestination(
            {
              assignmentId: assignment.id,
              couponEntityId,
              preferPersisted: false,
            },
            client,
          );

    const existing = await this.trackingRepo.findPrimaryForAssignment(assignment.id, client);
    if (existing) {
      const patch = {};
      if (!existing.campaignSourceId && assignment.campaignSourceId) {
        patch.campaignSourceId = assignment.campaignSourceId;
      }
      // Backfill destination on historical links that were generated without a supplier URL.
      if (!looksLikeHttpUrl(existing.supplierTrackingUrl) && resolved.url) {
        patch.supplierTrackingUrl = resolved.url;
      }
      if (Object.keys(patch).length) {
        return this.trackingRepo.update(existing.id, patch, client);
      }
      return existing;
    }

    if (!resolved.url) {
      throw fail(
        resolved.reason ||
          "Cannot generate MBO tracking link: supplier tracking URL is missing on the Coupon CMS campaign.",
        409,
      );
    }

    const slug = await this.resolveTrackingSlug(assignment, client);
    const { slug: linkSlug, subId, mboTrackingUrl } = buildMboTrackingUrl({ slug });
    await this.trackingRepo.clearPrimaryForAssignment(assignment.id, null, client);

    return this.trackingRepo.create(
      {
        assignmentId: assignment.id,
        campaignSourceId: assignment.campaignSourceId ?? null,
        slug: linkSlug,
        subId,
        supplierTrackingUrl: resolved.url,
        mboTrackingUrl,
        trackingType: "STANDARD",
        status: "GENERATED",
        isPrimary: true,
        expiresAt: null,
      },
      client,
    );
  }

  async resolveTrackingSlug(assignment, client = null) {
    const db = client ?? prisma;
    const full = await db.clientCampaignAssignment.findUnique({
      where: { id: assignment.id },
      include: {
        client: { select: { slug: true } },
        campaignSource: {
          include: {
            supplierCampaign: {
              include: { merchant: { select: { displayName: true, slug: true } } },
            },
          },
        },
        canonicalCampaign: {
          select: {
            displayName: true,
            merchant: { select: { slug: true, displayName: true } },
          },
        },
      },
    });

    const supplierCampaign = full?.campaignSource?.supplierCampaign ?? null;
    const brandSlug =
      supplierCampaign?.mboTrackingSlug ||
      resolveSupplierCampaignBrandSlug({
        ...supplierCampaign,
        merchant: supplierCampaign?.merchant || full?.canonicalCampaign?.merchant,
      });
    const clientSlug = full?.client?.slug || null;
    const campaignSlug =
      full?.canonicalCampaign?.displayName || supplierCampaign?.campaignName || null;

    if (clientSlug) {
      return buildAssignedTrackingSlug({ brandSlug, clientSlug });
    }

    return buildTrackingSlug({
      merchantSlug: brandSlug,
      campaignSlug,
    });
  }

  /**
   * Resolve supplier destination for an assignment (Coupon CMS tracking URL is preferred).
   */
  async resolveSupplierUrl(assignmentId, client = null, options = {}) {
    const resolved = await this.resolveDestination(
      {
        assignmentId,
        couponEntityId: options.couponEntityId ?? null,
        preferPersisted: false,
      },
      client,
    );
    return resolved.url;
  }

  async provision(clientId, { createdBy } = {}) {
    const state = await this.getState(clientId);
    if (!state.checklist.commercialConfigured) {
      throw fail("Commercial model is required before provisioning.", 409);
    }
    if (!state.checklist.campaignsAllotted) {
      throw fail("Allot at least one campaign before provisioning.", 409);
    }

    const assignments = await prisma.clientCampaignAssignment.findMany({
      where: { clientId, status: { not: "REVOKED" } },
      include: {
        canonicalCampaign: true,
        trackingLinks: { where: { deletedAt: null }, take: 5 },
        commissionRules: { where: { status: { in: ["DRAFT", "EFFECTIVE"] } }, take: 5 },
      },
    });

    const provisioned = [];
    const trackingPending = [];
    const failures = [];

    for (const assignment of assignments) {
      try {
        if (!this.visibility.isCatalogPublishable(assignment.canonicalCampaign)) {
          failures.push({
            assignmentId: assignment.id,
            canonicalCampaignId: assignment.canonicalCampaignId,
            outcome: "blocked",
            message: `Catalog campaign "${assignment.canonicalCampaign?.displayName || assignment.canonicalCampaignId}" must be PUBLISHED before provisioning.`,
          });
          continue;
        }

        // Activate commission rules before publishing so client payable path is valid.
        const draftRules = await prisma.clientCommissionRule.findMany({
          where: { assignmentId: assignment.id, status: "DRAFT" },
          orderBy: { effectiveFrom: "desc" },
        });
        if (draftRules[0]) {
          await prisma.clientCommissionRule.updateMany({
            where: {
              assignmentId: assignment.id,
              status: "EFFECTIVE",
              id: { not: draftRules[0].id },
            },
            data: { status: "SUPERSEDED", effectiveUntil: new Date() },
          });
          await prisma.clientCommissionRule.update({
            where: { id: draftRules[0].id },
            data: { status: "EFFECTIVE" },
          });
        }

        const effectiveRule = await prisma.clientCommissionRule.findFirst({
          where: { assignmentId: assignment.id, status: "EFFECTIVE" },
        });
        if (!effectiveRule) {
          failures.push({
            assignmentId: assignment.id,
            canonicalCampaignId: assignment.canonicalCampaignId,
            outcome: "blocked",
            message:
              "Client commission rule must be EFFECTIVE before an assignment can be published.",
          });
          continue;
        }

        await prisma.clientCouponAssignment.updateMany({
          where: { assignmentId: assignment.id, status: "ASSIGNED" },
          data: { status: "ACTIVE" },
        });

        const activeCoupon = await prisma.clientCouponAssignment.findFirst({
          where: {
            assignmentId: assignment.id,
            status: { in: ["ASSIGNED", "ACTIVE"] },
          },
        });

        let trackingOk = false;
        let trackingIssue = null;
        try {
          const tracking = await this.ensureTrackingLink(assignment, prisma);
          trackingOk = Boolean(tracking?.mboTrackingUrl);
          if (trackingOk) {
            await prisma.trackingLink.updateMany({
              where: {
                assignmentId: assignment.id,
                deletedAt: null,
                status: { in: ["GENERATED", "ACTIVE"] },
              },
              data: { status: "ACTIVE" },
            });
          } else {
            trackingIssue = "Publisher tracking URL not confirmed";
          }
        } catch (trackError) {
          trackingOk = false;
          trackingIssue =
            trackError?.message || "Publisher tracking URL not confirmed from supplier data";
        }

        // Coupon-only assignments may publish without an MBO link when a coupon code is assigned.
        // Link/deeplink channels must have a real MBO tracking URL — never fabricate supplier URLs.
        const couponOnlyOk = Boolean(
          activeCoupon?.clientCouponCode || activeCoupon?.supplierCouponCode,
        );
        if (!trackingOk && !couponOnlyOk) {
          trackingPending.push({
            assignmentId: assignment.id,
            canonicalCampaignId: assignment.canonicalCampaignId,
            outcome: "tracking_pending",
            commercialRuleStatus: "EFFECTIVE",
            trackingStatus: "PENDING",
            published: false,
            message: trackingIssue,
          });
          // Explicitly keep unpublished when gates fail.
          if (assignment.published) {
            await prisma.clientCampaignAssignment.update({
              where: { id: assignment.id },
              data: { published: false, unpublishedAt: new Date() },
            });
          }
          continue;
        }

        if (!assignment.published || assignment.status !== "ACTIVE") {
          await prisma.clientCampaignAssignment.update({
            where: { id: assignment.id },
            data: {
              status: "ACTIVE",
              published: true,
              publishedAt: assignment.publishedAt ?? new Date(),
              unpublishedAt: null,
            },
          });
        }

        provisioned.push({
          assignmentId: assignment.id,
          canonicalCampaignId: assignment.canonicalCampaignId,
          outcome: "provisioned",
          status: "ACTIVE",
          published: true,
          commercialRuleStatus: "EFFECTIVE",
          trackingStatus: trackingOk ? "ACTIVE" : "COUPON_ONLY",
        });
      } catch (error) {
        failures.push({
          assignmentId: assignment.id,
          canonicalCampaignId: assignment.canonicalCampaignId,
          outcome: "failed",
          message: error?.message || "Provisioning failed for this campaign.",
        });
      }
    }

    if (provisioned.length === 0 && trackingPending.length === 0 && failures.length > 0) {
      throw fail(failures[0].message || "Provisioning failed.", 409);
    }

    let newApiCredential = null;
    // Issue Production key when API delivery is required and at least one campaign is provisioned.
    const clientRow = await this.clientRepo.findById(clientId);
    const needsApi = clientRow?.deliveryMethod !== "PORTAL_ONLY";
    if (needsApi && provisioned.length > 0) {
      const existingKey = await prisma.clientApiCredential.findFirst({
        where: { clientId, environment: "PRODUCTION", revokedAt: null },
      });
      if (!existingKey) {
        newApiCredential = await this.credentialService.issueApiCredential(clientId, {
          name: "Production",
          environment: "PRODUCTION",
          createdBy: createdBy ?? null,
        });
      }
    }

    const next = await this.getState(clientId);
    return {
      ...next,
      apiKeyIssued: Boolean(newApiCredential) || Boolean(
        await prisma.clientApiCredential.findFirst({
          where: { clientId, environment: "PRODUCTION", revokedAt: null },
        }),
      ),
      newApiCredential,
      provisionResults: {
        provisioned,
        trackingPending,
        failures,
        meta: {
          selected: assignments.length,
          provisioned: provisioned.length,
          trackingPending: trackingPending.length,
          failed: failures.length,
        },
      },
    };
  }

  async activate(clientId) {
    const state = await this.getState(clientId);
    const blocks = [];
    if (!state.checklist.agreementSigned) {
      blocks.push("A signed agreement is required before activation.");
    }
    if (!state.checklist.commercialConfigured) {
      blocks.push("Commercial model is not configured.");
    }
    if (!state.checklist.campaignsAllotted) {
      blocks.push("No campaigns have been allotted.");
    }
    if (!state.checklist.assignmentsPublished) {
      blocks.push("At least one campaign must be provisioned and published before activation.");
    }
    if (state.checklist.needsApi && !state.checklist.apiKeyIssued) {
      blocks.push("A Production API key must be issued before activation.");
    }
    if (state.checklist.needsPortal && !state.checklist.administratorConfigured) {
      blocks.push("An active portal administrator is required before activation.");
    }
    if (!state.checklist.provisioned) {
      blocks.push("Provision the client before activation.");
    }
    if (blocks.length) {
      const error = fail(blocks.join(" "), 409);
      error.details = {
        activationBlocks: blocks,
        activationBlockDetails: blocks.map((message) => ({
          code: "ACTIVATION_BLOCKED",
          message,
          severity: "blocked",
        })),
        code: "ACTIVATION_BLOCKED",
      };
      throw error;
    }

    const updated = await this.clientRepo.update(clientId, { status: "ACTIVE" });
    return {
      client: updated,
      ...(await this.getState(clientId)),
      activationBlocks: [],
    };
  }

  /**
   * Load assignments with commercial children.
   * Onboarding defaults to a single eager query (fast, consistent checklist).
   * Order metrics intentionally off for setup — they full-scan performance entities.
   */
  async loadAssignmentsWithCommercial(clientId, { includeOrderMetrics = false } = {}) {
    const rows = await prisma.clientCampaignAssignment.findMany({
      where: { clientId },
      take: 200,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: ONBOARDING_ASSIGNMENT_INCLUDE,
    });

    const client = await this.clientRepo.findById(clientId);

    const enriched = rows.map((row) => {
      const base = {
        ...row,
        client: client
          ? {
              id: client.id,
              name: client.name,
              slug: client.slug,
              status: client.status,
              commercialModel: client.commercialModel,
              clientSharePercent: client.clientSharePercent,
              country: client.country,
              currency: client.currency,
            }
          : undefined,
        trackingLinks: row.trackingLinks ?? [],
        couponAssignments: row.couponAssignments ?? [],
        commissionRules: row.commissionRules ?? [],
      };
      const staff = toClientCampaignAssignmentDto(base, { includeStaffCommercial: true }) || {};
      return {
        ...base,
        provisioning: summarizeAssignmentProvisioning(base),
        // Activation review projection fields (Wave 4) — no second lifecycle engine.
        assignmentStatus: staff.assignmentStatus ?? null,
        brand: staff.brand ?? null,
        brandName: staff.brandName ?? null,
        brandLogoLink: staff.brandLogoLink ?? null,
        brandWebsiteLink: staff.brandWebsiteLink ?? null,
        networkSource: staff.networkSource ?? null,
        commercialModel: staff.commercialModel ?? null,
        channelType: staff.channelType ?? null,
        channels: staff.channels ?? null,
        relationshipStatus: staff.relationshipStatus ?? null,
        relationshipLabel: staff.relationshipLabel ?? null,
        commissionRuleStatus: staff.commissionRuleStatus ?? null,
        commissionType: staff.commissionType ?? null,
        commissionRuleId: staff.commissionRuleId ?? null,
        clientCommercialModel: staff.clientCommercialModel ?? null,
        clientSharePercent: staff.clientSharePercent ?? null,
        trackingStatus: staff.trackingStatus ?? null,
        hasTrackingUrl: staff.hasTrackingUrl === true,
        trackingUrl: staff.trackingUrl ?? null,
        trackingLinkId: staff.trackingLinkId ?? null,
        couponStatus: staff.couponStatus ?? null,
        couponAssigned: staff.couponAssigned === true,
        couponCode: staff.couponCode ?? null,
        supplierCampaignId: staff.supplierCampaignId ?? null,
        blocker: staff.blocker ?? null,
        campaignCountries: row.canonicalCampaign?.countries ?? [],
        campaignCurrency:
          row.canonicalCampaign?.defaultCurrency ||
          row.campaignSource?.supplierCampaign?.currencyCode ||
          null,
        campaignStatus:
          row.campaignSource?.supplierCampaign?.campaignStatus ||
          row.canonicalCampaign?.status ||
          null,
        merchantId: row.canonicalCampaign?.merchant?.id ?? null,
      };
    });

    if (!includeOrderMetrics) {
      return enriched.map((row) => ({
        ...row,
        ...emptyOrderMetrics(),
        ordersCurrency: null,
      }));
    }

    const { aggregateOrderMetricsByAssignmentIds } = await import(
      "../../coupons/couponCommercial.service.js"
    );
    const metricsMap = await aggregateOrderMetricsByAssignmentIds(
      enriched.map((row) => row.id),
      enriched,
    );

    return enriched.map((row) => {
      const metrics = metricsMap.get(row.id) || emptyOrderMetrics();
      return {
        ...row,
        grossOrders: metrics.grossOrders,
        netOrders: metrics.netOrders,
        grossOrderValue: metrics.grossOrderValue,
        netOrderValue: metrics.netOrderValue,
        ordersCurrency: metrics.currency,
      };
    });
  }
}

export async function acceptInviteAndSetPassword({ token, password }) {
  if (!token || !password || String(password).length < 8) {
    throw fail("A valid invite token and password (min 8 characters) are required.", 400);
  }

  const inviteTokenHash = hashInviteToken(token);
  const user = await prisma.user.findFirst({
    where: {
      inviteTokenHash,
      role: "CLIENT",
      isActive: true,
    },
  });

  if (!user) throw fail("Invite is invalid or has already been used.", 404);
  if (!user.inviteExpiresAt || user.inviteExpiresAt < new Date()) {
    throw fail("This invite has expired. Ask MBO to send a new invitation.", 410);
  }

  const passwordHash = await hashPassword(password);
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      inviteTokenHash: null,
      inviteExpiresAt: null,
      passwordSetAt: new Date(),
    },
  });

  return {
    id: updated.id,
    email: updated.email,
    name: updated.name,
    role: updated.role,
    clientId: updated.clientId,
  };
}

export async function getInviteStatus(token) {
  if (!token) throw fail("Invite token is required.", 400);
  const inviteTokenHash = hashInviteToken(token);
  const user = await prisma.user.findFirst({
    where: { inviteTokenHash, role: "CLIENT" },
    include: { client: true },
  });
  if (!user) throw fail("Invite is invalid or has already been used.", 404);
  if (!user.inviteExpiresAt || user.inviteExpiresAt < new Date()) {
    throw fail("This invite has expired.", 410);
  }
  return {
    email: user.email,
    name: user.name,
    clientName: user.client?.name ?? null,
    expiresAt: user.inviteExpiresAt.toISOString(),
  };
}
