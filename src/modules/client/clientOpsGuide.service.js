import { prisma } from "../../database/prisma.js";
import {
  CLIENT_CAMPAIGN_06C_KEYS,
  CLIENT_CAMPAIGN_FORBIDDEN_KEYS,
} from "./dto/clientCampaignContract.06c.js";

/** v5 Client Operations guide — client-safe field matrix (maps to 06C partner DTO). */
export const CLIENT_SAFE_FIELD_GUIDE = [
  {
    label: "Campaign ID",
    dtoKey: "assignmentId",
    contractKey: "assignmentId",
    description: "Published client-specific campaign identifier.",
  },
  {
    label: "Brand Name",
    dtoKey: "brandName",
    contractKey: "brandName",
    description: "Canonical MBO brand name.",
  },
  {
    label: "Brand Logo",
    dtoKey: "brandLogoUrl",
    contractKey: "brandLogoUrl",
    description: "MBO Brand Master logo.",
  },
  {
    label: "Campaign Name",
    dtoKey: "campaignName",
    contractKey: "campaignName",
    description: "Final campaign title.",
  },
  {
    label: "Campaign Type",
    dtoKey: "campaignType",
    contractKey: "campaignType",
    description: "Coupon Offer / Affiliate Link / Product Campaign (distribution channel).",
  },
  {
    label: "Customer Offer",
    dtoKey: "discountDisplay",
    contractKey: "discountDisplay",
    description: "Short display value such as 30% Off or No Special Offer.",
  },
  {
    label: "Offer Description",
    dtoKey: "campaignDescription",
    contractKey: "campaignDescription",
    description: "Client-ready explanatory copy.",
  },
  {
    label: "Coupon Code",
    dtoKey: "couponCode",
    contractKey: "couponCode",
    description: "Only when applicable.",
  },
  {
    label: "Terms & Conditions",
    dtoKey: "termsAndConditions",
    contractKey: "termsAndConditions",
    description: "Only when applicable.",
  },
  {
    label: "Valid From",
    dtoKey: "campaignValidity.startDate",
    contractKey: "campaignValidity",
    description: "When available.",
  },
  {
    label: "Expiry",
    dtoKey: "campaignValidity.endDate",
    contractKey: "campaignValidity",
    description: "When available.",
  },
  {
    label: "Valid Countries",
    dtoKey: "primaryCountry",
    contractKey: "primaryCountry",
    description: "Final normalized applicability (primary + secondary countries).",
  },
  {
    label: "MBO Tracking Link",
    dtoKey: "link",
    contractKey: "link",
    description: "Stable client-specific tracking URL.",
  },
  {
    label: "Client Commission",
    dtoKey: "commission",
    contractKey: "commission",
    description: "Final client commission (client share only — never supplier receivable).",
  },
  {
    label: "Campaign Status",
    dtoKey: "campaignStatus",
    contractKey: "campaignStatus",
    description: "Client-safe status (ACTIVE / PAUSED / EXPIRED).",
  },
  {
    label: "Last Updated",
    dtoKey: "addedAt",
    contractKey: "addedAt",
    description: "Final record update timestamp (compatibility field on partner DTO).",
  },
];

const BOUNDARY = {
  title: "Locked Client Operations boundary",
  body:
    "Master Catalog owns approved inventory. Client Campaigns owns distribution to a client: source selection, coupon reservation/allocation, MBO link creation, client commission, review and publish. Client Workspace owns the client's profile, agreement, commercials, delivery method, ongoing API maintenance, portal users, campaign view and activation. The client receives only final client-safe campaign fields after publication.",
};

export class ClientOpsGuideService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
  }

  async getGuide() {
    const [clientsTotal, assignmentsTotal, activationReviewPending] = await Promise.all([
      this.db.client.count({ where: { status: { not: "OFFBOARDED" } } }),
      this.db.clientCampaignAssignment.count({ where: { status: { not: "REVOKED" } } }),
      this.db.client.count({
        where: {
          status: { in: ["PROSPECT", "SUSPENDED"] },
          OR: [
            { commercialModel: { not: null } },
            { agreementStatus: "SIGNED" },
            {
              assignments: {
                some: { status: { not: "REVOKED" } },
              },
            },
          ],
        },
      }),
    ]);

    return {
      boundary: BOUNDARY,
      clientSafeFields: CLIENT_SAFE_FIELD_GUIDE,
      contract: {
        keys: CLIENT_CAMPAIGN_06C_KEYS,
        forbiddenKeys: CLIENT_CAMPAIGN_FORBIDDEN_KEYS,
      },
      navCounts: {
        clients: clientsTotal,
        clientCampaigns: assignmentsTotal,
        activationReview: activationReviewPending,
      },
    };
  }
}
