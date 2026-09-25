import {
  ENTITY_TYPE_PERMISSIONS,
  getPermissionsForRole,
  roleHasAnyPermission,
  roleHasPermission,
} from "../auth/permissions.js";
import { findUserById, logAccess, verifyAccessToken } from "../modules/auth/auth.service.js";
import { ClientCredentialService } from "../modules/client/services/clientCredential.service.js";
import { ClientRepository } from "../modules/client/repositories/client.repository.js";
import { isApiEndpointEnabled } from "../modules/client/apiEnvironmentConfig.js";

const credentialService = new ClientCredentialService();
const clientRepo = new ClientRepository();

function readBearerToken(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return null;
  }
  return header.slice("Bearer ".length).trim();
}

function sendAuthError(res, status, message) {
  res.status(status).json({ ok: false, message });
}

/** Prefer API-key credentials when the caller presents one; never fall through to JWT. */
function extractPartnerApiKey(req) {
  const apiKeyHeader = req.headers["x-api-key"];
  const bearer = readBearerToken(req);

  if (typeof apiKeyHeader === "string" && apiKeyHeader.trim()) {
    return apiKeyHeader.trim();
  }
  if (bearer && (bearer.startsWith("mbo_live_") || bearer.startsWith("mbo_test_"))) {
    return bearer;
  }
  return null;
}

export async function authenticate(req, res, next) {
  const token = readBearerToken(req);
  if (!token) {
    sendAuthError(res, 401, "Authentication required.");
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    const user = await findUserById(payload.sub);
    if (!user || !user.isActive) {
      sendAuthError(res, 401, "Invalid or expired session.");
      return;
    }

    req.user = user;
    req.permissions = getPermissionsForRole(user.role);
    next();
  } catch {
    sendAuthError(res, 401, "Invalid or expired session.");
  }
}

/**
 * Authenticate partner access via API key (Authorization: Bearer mbo_live_* or X-Api-Key)
 * or CLIENT portal JWT. Sets req.partnerClientId from credentials — clients never pass clientId.
 */
export async function authenticatePartner(req, res, next) {
  const presentedApiKey = extractPartnerApiKey(req);

  if (presentedApiKey != null) {
    if (!presentedApiKey.startsWith("mbo_live_") && !presentedApiKey.startsWith("mbo_test_")) {
      sendAuthError(res, 401, "Authentication required.");
      return;
    }
    try {
      const match = await credentialService.authenticateApiKey(presentedApiKey);
      if (!match) {
        sendAuthError(res, 401, "Authentication required.");
        return;
      }
      req.partnerClientId = match.clientId;
      req.partnerClient = match.client;
      req.partnerAuth = {
        type: "api_key",
        credentialId: match.credentialId,
        environment: match.environment || "PRODUCTION",
      };
      next();
      return;
    } catch {
      sendAuthError(res, 401, "Authentication required.");
      return;
    }
  }

  const bearer = readBearerToken(req);
  if (!bearer) {
    sendAuthError(res, 401, "Authentication required.");
    return;
  }

  try {
    const payload = verifyAccessToken(bearer);
    const user = await findUserById(payload.sub);
    if (!user || !user.isActive) {
      sendAuthError(res, 401, "Authentication required.");
      return;
    }
    if (user.role !== "CLIENT" || !user.clientId) {
      sendAuthError(res, 403, "Client portal access required.");
      return;
    }

    const client = await clientRepo.findById(user.clientId);
    if (!client || client.deletedAt || client.status !== "ACTIVE") {
      sendAuthError(res, 403, "Client account is not active.");
      return;
    }

    req.user = user;
    req.permissions = getPermissionsForRole(user.role);
    req.partnerClientId = user.clientId;
    req.partnerClient = client;
    req.partnerAuth = { type: "portal_user", userId: user.id };
    next();
  } catch {
    sendAuthError(res, 401, "Authentication required.");
  }
}

export const PORTAL_USER_REQUIRED_MESSAGE = "Use the client portal login for this action.";

/**
 * Interactive CLIENT portal session only — composed after `authenticatePartner`.
 *
 * `authenticatePartner` accepts two credentials for the same tenant: an `mbo_live_` /
 * `mbo_test_` API key (machine data access, no `req.user`) and a CLIENT portal JWT. Money and
 * account actions — bank details, withdrawals, settings, support, credential management, team
 * and settings reads — are portal-user actions, so this gate rejects every API key regardless
 * of its environment or the client's delivery method. It is an auth-channel rule, not a
 * permission: API-key requests deliberately carry no `req.user` / `req.permissions`, so a
 * permission check would only block them by accident with the wrong status and message.
 *
 * Passes only when the partner auth type is `portal_user`, `req.user` is a CLIENT and the tenant
 * is resolved. Sets nothing; it only gates.
 */
export function requirePortalUser(req, res, next) {
  const isPortalUser =
    req.partnerAuth?.type === "portal_user" &&
    req.user != null &&
    req.user.role === "CLIENT" &&
    req.partnerClientId != null;

  if (!isPortalUser) {
    sendAuthError(res, 403, PORTAL_USER_REQUIRED_MESSAGE);
    return;
  }

  next();
}

export function requirePermission(...requiredPermissions) {
  return (req, res, next) => {
    if (!req.user) {
      sendAuthError(res, 401, "Authentication required.");
      return;
    }

    if (!roleHasAnyPermission(req.user.role, requiredPermissions)) {
      sendAuthError(res, 403, "You do not have permission to perform this action.");
      return;
    }

    next();
  };
}

/**
 * ADMIN role, not merely a permission an ADMIN happens to hold.
 *
 * Every ops permission is shared with at least one other role — OPERATIONS also carries
 * `ops:manage`, TECH also carries `ops:read` — so a permission check alone cannot express
 * "ADMIN only". Composed after `requirePermission`, this narrows the gate rather than replacing
 * it, and it stays correct if a permission is later granted to another role.
 */
export function requireAdminRole(req, res, next) {
  if (!req.user) {
    sendAuthError(res, 401, "Authentication required.");
    return;
  }

  if (req.user.role !== "ADMIN") {
    sendAuthError(res, 403, "You do not have permission to perform this action.");
    return;
  }

  next();
}

/**
 * The query parameter each guarded route filters its rows on. Most read `type`; GET /fields
 * reads `entity_type`. The type is authorized on the parameter the handler actually uses, so a
 * request cannot pass the check on one name while the handler reads another.
 */
const ENTITY_TYPE_QUERY_PARAM_BY_ROUTE = Object.freeze({ "/fields": "entity_type" });

/**
 * Type-level access for the staged-record routes (GET /entities, /entities/summary, /fields).
 * The entity type is required: without it the handlers return every type, so a missing type is
 * rejected instead of skipping the permission check.
 */
export function requireEntityTypeAccess(req, res, next) {
  if (!req.user) {
    sendAuthError(res, 401, "Authentication required.");
    return;
  }

  const routePath = req.route?.path;
  const param = Object.hasOwn(ENTITY_TYPE_QUERY_PARAM_BY_ROUTE, String(routePath))
    ? ENTITY_TYPE_QUERY_PARAM_BY_ROUTE[routePath]
    : "type";
  const entityType = req.query[param] ? String(req.query[param]) : undefined;
  if (!entityType) {
    sendAuthError(res, 400, `Query parameter '${param}' is required.`);
    return;
  }

  const requiredPermission = Object.hasOwn(ENTITY_TYPE_PERMISSIONS, entityType)
    ? ENTITY_TYPE_PERMISSIONS[entityType]
    : null;
  if (!requiredPermission) {
    sendAuthError(res, 400, `Unsupported entity type: ${entityType}`);
    return;
  }

  if (!roleHasPermission(req.user.role, requiredPermission)) {
    sendAuthError(res, 403, "You do not have permission to view this data.");
    return;
  }

  next();
}

export function auditAction(action, resourceResolver) {
  return (req, res, next) => {
    res.on("finish", () => {
      if (res.statusCode >= 400 || !req.user) {
        return;
      }

      const resource =
        typeof resourceResolver === "function" ? resourceResolver(req) : resourceResolver;

      logAccess({
        userId: req.user.id,
        action,
        resource,
        metadata: {
          method: req.method,
          path: req.originalUrl,
        },
        ipAddress: req.ip,
      });
    });

    next();
  };
}

/** Audit successful partner API usage without logging secrets or Authorization headers. */
export function auditPartnerAccess(action) {
  return (req, res, next) => {
    res.on("finish", () => {
      if (res.statusCode >= 400 || !req.partnerClientId) return;
      logAccess({
        userId: req.user?.id ?? null,
        action,
        resource: `clients:${req.partnerClientId}`,
        metadata: {
          method: req.method,
          path: req.path,
          authType: req.partnerAuth?.type ?? null,
          credentialId: req.partnerAuth?.credentialId ?? null,
        },
        ipAddress: req.ip,
      });
    });
    next();
  };
}

/**
 * §27 Delivery Method — portal vs API channel enforcement.
 * @param {"portal"|"api"} channel
 */
export function requireDeliveryChannel(channel) {
  return (req, res, next) => {
    const method = String(req.partnerClient?.deliveryMethod || "API_AND_PORTAL").toUpperCase();
    const allowed =
      method === "API_AND_PORTAL" ||
      (channel === "portal" && method === "PORTAL_ONLY") ||
      (channel === "api" && method === "API_ONLY");

    if (!allowed) {
      sendAuthError(
        res,
        403,
        channel === "portal"
          ? "Portal access is not enabled for this client."
          : "API access is not enabled for this client.",
      );
      return;
    }
    next();
  };
}

/**
 * Per-environment endpoint toggles on Client.apiEnvironmentConfig.
 * Portal session auth is treated as PRODUCTION.
 * @param {"campaign"|"product"|"reporting"} endpoint
 */
export function requireApiEndpoint(endpoint) {
  return (req, res, next) => {
    // Portal login is not gated by API endpoint toggles.
    if (req.partnerAuth?.type === "portal_user") {
      next();
      return;
    }
    const environment = req.partnerAuth?.environment || "PRODUCTION";
    const enabled = isApiEndpointEnabled(
      req.partnerClient?.apiEnvironmentConfig,
      environment,
      endpoint,
    );
    if (!enabled) {
      sendAuthError(
        res,
        403,
        `The ${endpoint} endpoint is disabled for this client's ${environment === "SANDBOX" ? "Sandbox" : "Production"} environment.`,
      );
      return;
    }
    next();
  };
}
