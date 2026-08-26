import { TrackingRedirectService } from "../modules/reporting/services/trackingRedirect.service.js";

const redirectService = new TrackingRedirectService();

function redirectMeta(req) {
  return {
    ip: req.ip,
    userAgent: req.get("user-agent"),
    referrer: req.get("referer") || req.get("referrer"),
  };
}

/** Preferred: GET /r/:slug/:token */
export async function publicTrackingRedirectHandler(req, res, next) {
  try {
    const slug = String(req.params.slug || "");
    const token = String(req.params.token || "");
    const result = await redirectService.redirect({ slug, token }, redirectMeta(req));
    res.redirect(302, result.destination);
  } catch (error) {
    next(error);
  }
}

/** Legacy: GET /r/:token — historical manually-created links. */
export async function publicTrackingRedirectLegacyHandler(req, res, next) {
  try {
    const token = String(req.params.token || "");
    const result = await redirectService.redirect({ token }, redirectMeta(req));
    res.redirect(302, result.destination);
  } catch (error) {
    next(error);
  }
}

/** Epic 4: GET /t/product/:token */
export async function publicProductTrackingRedirectHandler(req, res, next) {
  try {
    const { ProductTrackingRedirectService } = await import(
      "../modules/product/productTrackingRedirect.service.js"
    );
    const service = new ProductTrackingRedirectService();
    const result = await service.redirect(req.params.token, redirectMeta(req));
    res.redirect(302, result.destination);
  } catch (error) {
    next(error);
  }
}
