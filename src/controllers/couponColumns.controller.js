import {
  createCouponColumn,
  deleteCouponColumn,
  listCouponColumns,
  replaceCouponColumns,
  resetCouponColumns,
  updateCouponColumn,
} from "../modules/coupons/couponColumns.service.js";

export async function getCouponColumns(req, res, next) {
  try {
    const includeHidden = req.query.include_hidden !== "false";
    const columns = await listCouponColumns({ includeHidden });
    res.json({ columns });
  } catch (error) {
    next(error);
  }
}

export async function postCouponColumn(req, res, next) {
  try {
    const column = await createCouponColumn(req.body || {});
    res.status(201).json({ column });
  } catch (error) {
    next(error);
  }
}

export async function patchCouponColumn(req, res, next) {
  try {
    const column = await updateCouponColumn(String(req.params.key), req.body || {});
    res.json({ column });
  } catch (error) {
    next(error);
  }
}

export async function removeCouponColumn(req, res, next) {
  try {
    await deleteCouponColumn(String(req.params.key));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
}

export async function putCouponColumns(req, res, next) {
  try {
    const columns = await replaceCouponColumns(req.body?.columns || []);
    res.json({ columns });
  } catch (error) {
    next(error);
  }
}

export async function resetCouponColumnsHandler(req, res, next) {
  try {
    const columns = await resetCouponColumns();
    res.json({ columns });
  } catch (error) {
    next(error);
  }
}
