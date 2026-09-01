import { getPagination, toPagedResponse } from "../core/pagination.js";
import {
  getMappingRegistryRule,
  listMappingRegistry,
  syncMappingRegistry,
} from "../modules/mapping/mappingRegistry.service.js";

export async function listMappingRegistryHandler(req, res, next) {
  try {
    const { page, pageSize } = getPagination(req.query);
    const { rows, total, engineeringDefects } = await listMappingRegistry({
      network: req.query.network || req.query.supplier || undefined,
      sourceObject: req.query.source_object || req.query.sourceObject || undefined,
      mappingStatus: req.query.mapping_status || req.query.status || undefined,
      fieldMappingOutcome:
        req.query.field_mapping_outcome || req.query.fieldMappingOutcome || undefined,
      mboTargetObject: req.query.mbo_target_object || req.query.mboTargetObject || undefined,
      mappingVersion: req.query.mapping_version || undefined,
      page,
      pageSize,
      autoSyncIfEmpty: req.query.sync !== "false",
    });
    res.json(toPagedResponse({ rows, total, page, pageSize, engineeringDefects }));
  } catch (error) {
    next(error);
  }
}

export async function getMappingRegistryRuleHandler(req, res, next) {
  try {
    const row = await getMappingRegistryRule(req.params.id);
    if (!row) {
      return res.status(404).json({ message: "Mapping registry rule not found" });
    }
    res.json(row);
  } catch (error) {
    next(error);
  }
}

export async function syncMappingRegistryHandler(req, res, next) {
  try {
    const includeGaps = req.body?.includeGaps !== false && req.query.include_gaps !== "false";
    const result = await syncMappingRegistry({ includeGaps });
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
}
