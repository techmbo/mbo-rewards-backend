import {
  ENTITY_TYPE_PERMISSIONS,
  getPermissionsForRole,
  roleHasAnyPermission,
  roleHasPermission,
} from "../auth/permissions.js";
import { findUserById, logAccess, verifyAccessToken } from "../modules/auth/auth.service.js";
import { ClientCredentialService } from "../modules/client/services/clientCredential.service.js";
import { ClientRepository } from "../modules/client/repositories/client.repository.js";

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

export function requireEntityTypeAccess(req, res, next) {
  if (!req.user) {
    sendAuthError(res, 401, "Authentication required.");
    return;
  }

  const entityType = req.query.type ? String(req.query.type) : undefined;
  if (!entityType) {
    next();
    return;
  }

  const requiredPermission = ENTITY_TYPE_PERMISSIONS[entityType];
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
    const { isApiEndpointEnabled } = require("../modules/client/apiEnvironmentConfig.js");
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
