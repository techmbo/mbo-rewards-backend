import { ok, fail } from "../core/apiResponse.js";
import { prisma } from "../database/prisma.js";
import { ProductFeedService, ClientProductService } from "../modules/product/productFeed.service.js";

const feeds = new ProductFeedService();
const clientProducts = new ClientProductService();

export async function listProductFeedsHandler(req, res, next) {
  try {
    const take = Math.min(Number(req.query.limit) || 50, 200);
    const rows = await prisma.productFeed.findMany({
      orderBy: { updatedAt: "desc" },
      take,
      include: {
        _count: { select: { feedItems: true, products: true } },
        campaignSource: { select: { id: true, canonicalCampaignId: true } },
      },
    });
    res.json(ok({ items: rows, total: rows.length }));
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
