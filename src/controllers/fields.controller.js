import { getPagination, toPagedResponse } from "../core/pagination.js";
import { listFields } from "../field-system/fieldRegistry.service.js";

export async function getFields(req, res, next) {
  try {
    const { page, pageSize } = getPagination(req.query);
    const { rows, total } = await listFields({
      entityType: req.query.entity_type ? String(req.query.entity_type) : undefined,
      source: req.query.network ? String(req.query.network) : undefined,
      sourceObject: req.query.source_object ? String(req.query.source_object) : undefined,
      mappingStatus: req.query.mapping_status || req.query.mappingStatus || undefined,
      page,
      pageSize,
    });

    res.json(toPagedResponse({ rows, total, page, pageSize }));
  } catch (error) {
    next(error);
  }
}
