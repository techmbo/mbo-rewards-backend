import { ok } from "../core/apiResponse.js";
import { ConnectionError, NetworkConnectionService } from "../modules/integrations/networkConnection.service.js";
import { UNIT_KINDS } from "../jobs/syncOrchestration.service.js";
import { planScopedSourceUnits } from "../jobs/syncSourcePlan.js";
import { orchestrationServiceFor } from "./sync.controller.js";

/**
 * Network Connections admin API (/ops/admin/network-connections).
 *
 * Responses carry the value-free connection DTO only. No request body can carry a secret, a
 * secret reference or a variable name: each handler's service method refuses unknown fields.
 */

function noStore(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
}

/**
 * The initial sync is the estate's own scoped durable run (the same unit planner and worker as a
 * full run), narrowed to one connection's campaign source. The worker advances it.
 */
function scopedRunStarter(req) {
  return async ({ platform, accountLabel, sourceObject }) => {
    const units = planScopedSourceUnits({ platform, accountLabel, sourceObject }).map((unit) => ({
      kind: UNIT_KINDS.NETWORK,
      ...unit,
    }));
    if (!units.length) {
      throw new ConnectionError(409, "initial_sync_unplannable", `${platform}/${sourceObject} produced no bounded unit.`);
    }
    const orchestration = orchestrationServiceFor(req);
    const options = { fastSync: false, promoteAfter: false, scopeKey: `${platform}:${accountLabel}:${sourceObject}` };
    try {
      const run = await orchestration.getOrCreateRun({ kind: "full", trigger: "api", options, units });
      return { runId: run.id, created: Boolean(run.created), plannerVersion: run.plannerVersion ?? null };
    } catch (error) {
      if (error?.code === "active_run_incompatible") {
        throw new ConnectionError(409, "active_run_incompatible", "Another sync run is already active; wait for it or cancel it first.", {
          activeRunId: error.activeRunId ?? null,
        });
      }
      throw error;
    }
  };
}

export function connectionServiceFor(req) {
  return (
    req?.app?.locals?.networkConnections ??
    new NetworkConnectionService({ startScopedRun: scopedRunStarter(req) })
  );
}

function actorOf(req) {
  return { id: req.user?.id ?? null, email: req.user?.email ?? null };
}

function handle(fn, { status = 200 } = {}) {
  return async (req, res, next) => {
    try {
      noStore(res);
      const result = await fn(connectionServiceFor(req), req);
      res.status(status).json(ok(result));
    } catch (error) {
      if (error instanceof ConnectionError) {
        return res.status(error.status).json({ ok: false, code: error.code, message: error.message, ...error.extra });
      }
      next(error);
    }
  };
}

export const networkConnectionCatalogHandler = handle((service) => service.catalog());
export const listNetworkConnectionsHandler = handle((service) => service.list());
export const getNetworkConnectionHandler = handle((service, req) => service.get(req.params.id));
export const createNetworkConnectionHandler = handle(
  (service, req) => service.create(req.body ?? {}, { actor: actorOf(req) }),
  { status: 201 },
);
export const updateNetworkConnectionHandler = handle((service, req) =>
  service.update(req.params.id, req.body ?? {}, { actor: actorOf(req) }),
);
export const pauseNetworkConnectionHandler = handle((service, req) =>
  service.pause(req.params.id, req.body ?? {}, { actor: actorOf(req) }),
);
export const resumeNetworkConnectionHandler = handle((service, req) =>
  service.resume(req.params.id, req.body ?? {}, { actor: actorOf(req) }),
);
export const testNetworkConnectionHandler = handle((service, req) => service.test(req.params.id, { actor: actorOf(req) }));
export const initialSyncNetworkConnectionHandler = handle(
  (service, req) => service.initialSync(req.params.id, { actor: actorOf(req) }),
  { status: 202 },
);
