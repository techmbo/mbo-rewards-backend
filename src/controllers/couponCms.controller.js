import { getPagination } from "../core/pagination.js";
import { ok } from "../core/apiResponse.js";
import {
  createManualCoupon,
  deleteCoupon,
  getCouponById,
  listCouponsForCms,
  updateCoupon,
} from "../modules/coupons/couponCms.service.js";
import { listCommercialContextForCoupon } from "../modules/coupons/couponCommercial.service.js";
import { applyCommissionRuleAccess } from "../auth/commercialDataAccess.js";

export async function listAdminCoupons(req, res, next) {
  try {
    const { page, pageSize } = getPagination(req.query);
    const result = await listCouponsForCms({
      page,
      pageSize,
      networkSource: req.query.network ? String(req.query.network) : undefined,
      search: req.query.search ? String(req.query.search) : undefined,
      brand: req.query.brand ? String(req.query.brand) : undefined,
      couponKind: req.query.couponKind || req.query.codeType
        ? String(req.query.couponKind || req.query.codeType)
        : undefined,
      status: req.query.status ? String(req.query.status) : undefined,
      campaignStatus: req.query.campaignStatus ? String(req.query.campaignStatus) : undefined,
      allottableOnly: req.query.allottableOnly === "true" || req.query.allottableOnly === "1",
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

export async function getAdminCoupon(req, res, next) {
  try {
    const coupon = await getCouponById(String(req.params.id));
    if (!coupon) {
      res.status(404).json({ error: "Coupon not found" });
      return;
    }
    res.json({ coupon });
  } catch (error) {
    next(error);
  }
}

export async function getAdminCouponCommercial(req, res, next) {
  try {
    const context = await listCommercialContextForCoupon(String(req.params.id));
    const permissions = req.permissions || [];
    res.json(
      ok({
        ...context,
        commissionRules: (context.commissionRules || []).map((row) =>
          applyCommissionRuleAccess(row, permissions),
        ),
      }),
    );
  } catch (error) {
    next(error);
  }
}

export async function createAdminCoupon(req, res, next) {
  try {
    const coupon = await createManualCoupon({
      fields: req.body?.fields || {},
      fieldPolicies: req.body?.fieldPolicies || {},
      fieldTypes: req.body?.fieldTypes || {},
    });
    res.status(201).json({ coupon });
  } catch (error) {
    next(error);
  }
}

export async function patchAdminCoupon(req, res, next) {
  try {
    const coupon = await updateCoupon(String(req.params.id), {
      fields: req.body?.fields,
      fieldPolicies: req.body?.fieldPolicies,
      fieldTypes: req.body?.fieldTypes,
      resolveConflict: req.body?.resolveConflict,
    });
    res.json({ coupon });
  } catch (error) {
    if (error.message === "Coupon not found") {
      res.status(404).json({ error: error.message });
      return;
    }
    next(error);
  }
}

export async function removeAdminCoupon(req, res, next) {
  try {
    await deleteCoupon(String(req.params.id));
    res.json({ ok: true });
  } catch (error) {
    if (error.message === "Coupon not found") {
      res.status(404).json({ error: error.message });
      return;
    }
    next(error);
  }
}
