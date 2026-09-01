import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "../../../database/prisma.js";
import { fail } from "../../../core/apiResponse.js";
import { createUserByAdmin, hashPassword } from "../../auth/auth.service.js";
import { ClientRepository } from "../repositories/client.repository.js";
import { ClientVisibilityService } from "./visibility.service.js";
import { PartnerCampaignService } from "./partnerCampaign.service.js";

const LIVE_PREFIX = "mbo_live_";
const TEST_PREFIX = "mbo_test_";

export function hashApiKey(rawKey) {
  return createHash("sha256").update(String(rawKey)).digest("hex");
}

function normalizeEnvironment(environment) {
  return environment === "SANDBOX" ? "SANDBOX" : "PRODUCTION";
}

function keyPrefixForEnvironment(environment) {
  return normalizeEnvironment(environment) === "SANDBOX" ? TEST_PREFIX : LIVE_PREFIX;
}

function generateApiKey(environment = "PRODUCTION") {
  const prefix = keyPrefixForEnvironment(environment);
  const secret = randomBytes(24).toString("hex");
  const rawKey = `${prefix}${secret}`;
  return {
    rawKey,
    keyPrefix: rawKey.slice(0, 16),
    keyHash: hashApiKey(rawKey),
  };
}

/** Constant-time hex digest comparison. */
export function apiKeyHashesEqual(storedHash, candidateHash) {
  if (!storedHash || !candidateHash) return false;
  try {
    const a = Buffer.from(String(storedHash), "hex");
    const b = Buffer.from(String(candidateHash), "hex");
    if (a.length !== b.length || a.length === 0) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function toCredentialMeta(row) {
  return {
    id: row.id,
    name: row.name,
    environment: row.environment || "PRODUCTION",
    keyPrefix: row.keyPrefix,
    createdBy: row.createdBy ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString?.() ?? row.lastUsedAt ?? null,
    revokedAt: row.revokedAt?.toISOString?.() ?? row.revokedAt ?? null,
    createdAt: row.createdAt?.toISOString?.() ?? row.createdAt,
    isActive: !row.revokedAt,
  };
}

export class ClientCredentialService {
  constructor(deps = {}) {
    this.clientRepo = deps.clientRepo ?? new ClientRepository();
    this.visibility = deps.visibility ?? new ClientVisibilityService();
    this.partnerCampaigns =
      deps.partnerCampaigns ??
      new PartnerCampaignService({
        clientRepo: this.clientRepo,
        visibility: this.visibility,
      });
  }

  async assertActiveClient(clientId) {
    const client = await this.clientRepo.findById(clientId);
    if (!client) throw fail("Client not found.", 404);
    if (client.status === "OFFBOARDED") throw fail("Cannot issue credentials for an offboarded client.", 409);
    return client;
  }

  async listPortalUsers(clientId) {
    await this.assertActiveClient(clientId);
    const rows = await prisma.user.findMany({
      where: { clientId, role: "CLIENT" },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        inviteTokenHash: true,
        createdAt: true,
      },
    });
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      isActive: row.isActive,
      invitePending: Boolean(row.inviteTokenHash),
      createdAt: row.createdAt?.toISOString?.() ?? row.createdAt,
    }));
  }

  async createPortalUser(clientId, { email, password, name }) {
    await this.assertActiveClient(clientId);

    const normalizedEmail = String(email || "")
      .trim()
      .toLowerCase();
    if (!normalizedEmail) throw fail("Email is required.", 400);
    if (!password || String(password).length < 8) {
      throw fail("Password must be at least 8 characters.", 400);
    }

    const existingForClient = await prisma.user.findFirst({
      where: { clientId, role: "CLIENT", isActive: true },
    });

    if (existingForClient) {
      if (existingForClient.email !== normalizedEmail) {
        throw fail(
          `A portal login already exists for ${existingForClient.email}. Use that email to reset the password, or disable the existing user first.`,
          409,
        );
      }

      const passwordHash = await hashPassword(password);
      const updated = await prisma.user.update({
        where: { id: existingForClient.id },
        data: {
          passwordHash,
          name: name?.trim() || existingForClient.name,
          inviteTokenHash: null,
          inviteExpiresAt: null,
          passwordSetAt: new Date(),
          isActive: true,
        },
      });
      return { user: updated, created: false };
    }

    const emailTaken = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (emailTaken) throw fail("An account with this email already exists.", 409);

    const user = await createUserByAdmin({
      email: normalizedEmail,
      password,
      name,
      role: "CLIENT",
      clientId,
    });

    const finalized = await prisma.user.update({
      where: { id: user.id },
      data: {
        inviteTokenHash: null,
        inviteExpiresAt: null,
        passwordSetAt: new Date(),
      },
    });

    return { user: finalized, created: true };
  }

  /** Staff/admin metadata only — never returns the secret. */
  async listApiCredentials(clientId) {
    await this.assertActiveClient(clientId);
    const rows = await prisma.clientApiCredential.findMany({
      where: { clientId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toCredentialMeta);
  }

  /**
   * Client portal metadata only.
   * Raw secrets are never recoverable after creation (hash-only storage).
   */
  async listPortalApiCredentials(clientId) {
    await this.assertActiveClient(clientId);
    const rows = await prisma.clientApiCredential.findMany({
      where: { clientId },
      orderBy: { createdAt: "desc" },
    });

    return rows.map((row) => ({
      ...toCredentialMeta(row),
      note: row.revokedAt
        ? "This key was revoked."
        : "The full API key is shown only once at creation or rotate. It cannot be recovered.",
    }));
  }

  /**
   * Portal rotate: revoke active keys in the given environment and issue a fresh key.
   */
  async rotatePortalApiCredential(clientId, { createdBy, name, environment = "PRODUCTION" } = {}) {
    await this.assertActiveClient(clientId);
    const env = normalizeEnvironment(environment);
    const active = await prisma.clientApiCredential.findMany({
      where: { clientId, environment: env, revokedAt: null },
    });
    for (const row of active) {
      await prisma.clientApiCredential.update({
        where: { id: row.id },
        data: { revokedAt: new Date() },
      });
    }
    return this.issueApiCredential(clientId, {
      name: name || (env === "SANDBOX" ? "Sandbox" : "Production"),
      createdBy: createdBy ?? null,
      environment: env,
    });
  }

  async issueApiCredential(clientId, { name, createdBy, environment = "PRODUCTION" } = {}) {
    await this.assertActiveClient(clientId);
    const env = normalizeEnvironment(environment);

    const activeKey = await prisma.clientApiCredential.findFirst({
      where: { clientId, environment: env, revokedAt: null },
    });
    if (activeKey) {
      throw fail(
        `An active ${env === "SANDBOX" ? "Sandbox" : "Production"} API key already exists for this client. Revoke or rotate it before creating another.`,
        409,
      );
    }

    const generated = generateApiKey(env);
    const record = await prisma.clientApiCredential.create({
      data: {
        clientId,
        name: name?.trim() || (env === "SANDBOX" ? "Sandbox" : "Production"),
        environment: env,
        keyPrefix: generated.keyPrefix,
        keyHash: generated.keyHash,
        keyEnc: null,
        createdBy: createdBy ?? null,
      },
    });

    return {
      id: record.id,
      name: record.name,
      environment: record.environment,
      keyPrefix: record.keyPrefix,
      apiKey: generated.rawKey,
      createdAt: record.createdAt.toISOString(),
      warning:
        "Copy this API key now. It will not be shown again. Store it securely — MBO cannot recover the secret. Sandbox and Production keys are never interchangeable.",
    };
  }

  async revokeApiCredential(clientId, credentialId) {
    const record = await prisma.clientApiCredential.findFirst({
      where: { id: credentialId, clientId },
    });
    if (!record) throw fail("API credential not found.", 404);
    if (record.revokedAt) return record;

    return prisma.clientApiCredential.update({
      where: { id: credentialId },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Authenticate a partner API key.
   * Production keys require ACTIVE clients. Sandbox keys allow PROSPECT for pre-launch testing.
   */
  async authenticateApiKey(rawKey) {
    const trimmed = String(rawKey || "").trim();
    if (!trimmed.startsWith(LIVE_PREFIX) && !trimmed.startsWith(TEST_PREFIX)) return null;
    const keyHash = hashApiKey(trimmed);
    const prefix = trimmed.slice(0, 16);

    const candidates = await prisma.clientApiCredential.findMany({
      where: { keyPrefix: prefix, revokedAt: null },
      include: { client: true },
    });

    const match = candidates.find((row) => apiKeyHashesEqual(row.keyHash, keyHash));
    if (!match) return null;
    if (!match.client || match.client.deletedAt) return null;
    if (match.client.status === "OFFBOARDED" || match.client.status === "SUSPENDED") return null;

    const env = match.environment || "PRODUCTION";
    if (env === "PRODUCTION" && match.client.status !== "ACTIVE") return null;
    if (env === "SANDBOX" && match.client.status !== "ACTIVE" && match.client.status !== "PROSPECT") {
      return null;
    }

    await prisma.clientApiCredential.update({
      where: { id: match.id },
      data: { lastUsedAt: new Date() },
    });

    return {
      credentialId: match.id,
      clientId: match.clientId,
      client: match.client,
      environment: env,
    };
  }

  /** Delegates to PartnerCampaignService — kept for callers that still use this name. */
  async listVisibleCampaigns(clientId, query = {}) {
    return this.partnerCampaigns.listCampaigns(clientId, query);
  }
}
