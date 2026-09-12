import { ok, fail } from "../core/apiResponse.js";
import { prisma } from "../database/prisma.js";
import { ProductFeedService, ClientProductService } from "../modules/product/productFeed.service.js";
import { toAdminProductFeedDto } from "../modules/ops/adminContract.dto.js";

const feeds = new ProductFeedService();
const clientProducts = new ClientProductService();

/**
 * Legacy feed listing, kept for existing clients but no longer raw.
 *
 * It previously returned Prisma rows straight out of findMany, which exposed feedUrl (where FTP
 * and signed-URL credentials live), the metadata blob, compressedLocation, aid and the raw
 * lastError text. It now maps through the same safe DTO as the admin route.
 *
 * `total` was also the length of the page rather than a count, so a caller paging through this
 * endpoint was told the wrong size; it is now a real count. Prefer GET /ops/admin/product-feeds,
 * which is paginated. This route is deprecated and the header says so.
 */
export async function listProductFeedsHandler(req, res, next) {
  try {
    const take = Math.min(Number(req.query.limit) || 50, 200);
    const [rows, total] = await Promise.all([
      prisma.productFeed.findMany({
        orderBy: { updatedAt: "desc" },
        take,
        include: {
          _count: { select: { feedItems: true, products: true } },
          campaignSource: { select: { id: true, canonicalCampaignId: true } },
        },
      }),
      prisma.productFeed.count(),
    ]);
    res.setHeader("Deprecation", "true");
    res.setHeader("Link", '</ops/admin/product-feeds>; rel="successor-version"');
    res.json(ok({ items: rows.map(toAdminProductFeedDto), total, contract: "epic4-product-feed-admin" }));
  } catch (error) {
    next(error);
  }
}

export async function ingestProductFeedHandler(req, res, next) {
  try {
    const body = req.body || {};
    if (!body.supplier || !Array.isArray(body.rows)) {
      throw fail("supplier and rows[] are required.", 400);
    }
    const result = await feeds.ingestFeedBatch({
      supplier: String(body.supplier).toUpperCase(),
      sourceAccountLabel: body.sourceAccountLabel || "default",
      campaignSourceId: body.campaignSourceId || null,
      feedExternalId: body.feedExternalId || "default",
      feedName: body.feedName || null,
      feedUrl: body.feedUrl || null,
      feedFormat: body.feedFormat || "JSON",
      aid: body.aid || null,
      compressedLocation: body.compressedLocation || null,
      creativeId: body.creativeId || null,
      countryHint: body.countryHint || null,
      merchantId: body.merchantId || null,
      rows: body.rows,
    });
    res.status(201).json(ok(result));
  } catch (error) {
    next(error);
  }
}

export async function assignClientProductHandler(req, res, next) {
  try {
    const { clientId, productId, clientCampaignAssignmentId, status } = req.body || {};
    if (!clientId || !productId) throw fail("clientId and productId are required.", 400);
    const result = await clientProducts.assignProductToClient({
      clientId,
      productId,
      clientCampaignAssignmentId: clientCampaignAssignmentId || null,
      status: status || "ACTIVE",
    });
    if (!result.ok) throw fail(result.reason || "assign_failed", 409);
    res.status(201).json(ok(result));
  } catch (error) {
    next(error);
  }
}
