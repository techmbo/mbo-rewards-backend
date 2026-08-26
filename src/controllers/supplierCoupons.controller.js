import { SupplierCouponQueryService } from "../modules/supplier/services/query/supplierCouponQuery.service.js";
import { supplierCouponListQuerySchema } from "../modules/supplier/validators/schemas.js";

const couponQuery = new SupplierCouponQueryService();

export async function listSupplierCouponsHandler(req, res, next) {
  try {
    const query = supplierCouponListQuerySchema.parse(req.query);
    const response = await couponQuery.list(query, req.permissions || []);
    res.json(response);
  } catch (error) {
    next(error);
  }
}
