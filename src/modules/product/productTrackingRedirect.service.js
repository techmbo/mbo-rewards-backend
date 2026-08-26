/**
 * Epic 4 — product tracking redirect reuses Epic 3 param rules + URL builder.
 * Does not invent supplier parameters. Click recorded only when a campaign TrackingLink exists.
 */

import { randomUUID } from "node:crypto";
import { fail } from "../../core/apiResponse.js";
import { prisma } from "../../database/prisma.js";
import { AttributionService } from "../reporting/services/attribution.service.js";
import {
  appendTrackingParams,
  buildAttributionQueryParams,
  resolveSupplierKey,
} from "../tracking/index.js";

export class ProductTrackingRedirectService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.attribution = deps.attribution ?? new AttributionService();
    this.appendParamsFn = deps.appendParamsFn ?? appendTrackingParams;
    this.buildParamsFn = deps.buildParamsFn ?? buildAttributionQueryParams;
  }

  async redirect(token, meta = {}) {
    const link = await this.db.productTrackingLink.findUnique({
      where: { token: String(token || "").trim() },
      include: {
        product: {
          include: {
            sources: { take: 1, orderBy: { updatedAt: "desc" } },
            campaignSource: {
              include: { supplierCampaign: { select: { supplier: true } } },
            },
          },
        },
      },
    });
    if (!link || link.status !== "ACTIVE") {
      throw fail("Product tracking link not found.", 404);
    }

    const supplier =
      link.product?.sources?.[0]?.supplier ||
      link.product?.campaignSource?.supplierCampaign?.supplier ||
      "UNKNOWN";

    let mboClickId = randomUUID();
    if (link.clientCampaignAssignmentId && this.attribution?.recordClick) {
      try {
        const primary = await this.db.trackingLink.findFirst({
          where: {
            assignmentId: link.clientCampaignAssignmentId,
            deletedAt: null,
            status: { in: ["ACTIVE", "GENERATED"] },
          },
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        });
        if (primary) {
          const click = await this.attribution.recordClick({
            trackingLinkId: primary.id,
            subId: link.token,
            ip: meta.ip,
            userAgent: meta.userAgent,
            referrer: meta.referrer,
            metadata: {
              productTrackingLinkId: link.id,
              productId: link.productId,
              kind: "product",
            },
          });
          mboClickId = click.id;
        }
      } catch {
        // keep ephemeral click id for injection only
      }
    }

    const built = this.buildParamsFn({
      supplier: resolveSupplierKey(supplier),
      clientId: link.clientId,
      assignmentId: link.clientCampaignAssignmentId,
      mboClickId,
    });

    let destination = link.supplierProductTrackingUrl;
    let attributionInjection = {
      injected: false,
      params: built.params,
      skippedReason: built.skippedReason,
    };

    if (built.injected) {
      try {
        const appended = this.appendParamsFn(destination, built.params);
        destination = appended.url;
        attributionInjection = {
          injected: true,
          params: built.params,
          applied: appended.applied,
          skippedExisting: appended.skipped,
          skippedReason: null,
        };
      } catch (error) {
        attributionInjection.skippedReason = error.message;
      }
    }

    return {
      destination,
      productTrackingLinkId: link.id,
      productId: link.productId,
      clickId: mboClickId,
      attributionInjection,
    };
  }
}
