import { prisma } from "../database/prisma.js";
import { encryptText } from "../core/crypto.js";

const SUPPORTED_PLATFORMS = new Set([
  "boostiny",
  "optimise_sea",
  "optimise_mena",
  "optimise_uk",
  "trackier",
  "partnerize",
  "impact",
]);

function maskApiKey(apiKey) {
  const key = String(apiKey);
  if (key.length <= 8) return `${"*".repeat(Math.max(0, key.length - 2))}${key.slice(-2)}`;
  return `${key.slice(0, 4)}***${key.slice(-4)}`;
}

function normalizeAccountLabel(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "default";
  return raw.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_-]/g, "").slice(0, 40) || "default";
}

export async function connectMarketplaceAccount(req, res, next) {
  try {
    const { platform } = req.params;
    if (!SUPPORTED_PLATFORMS.has(platform)) {
      return res.status(400).json({ ok: false, message: `Unsupported platform: ${platform}` });
    }

    const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
    let applicationKey =
      typeof req.body?.applicationKey === "string" ? req.body.applicationKey.trim() : "";
    let userApiKey = typeof req.body?.userApiKey === "string" ? req.body.userApiKey.trim() : "";
    const agencyId = req.body?.agencyId;
    const contactId = req.body?.contactId;
    const accountLabel = normalizeAccountLabel(req.body?.accountLabel);

    const publisherId =
      typeof req.body?.publisherId === "string" ? req.body.publisherId.trim() : "";

    const isOptimise = platform.startsWith("optimise_");
    const isPartnerize = platform === "partnerize";
    const trimmedAgencyId = typeof agencyId === "string" ? agencyId.trim() : "";
    const trimmedContactId = typeof contactId === "string" ? contactId.trim() : "";
    if (isOptimise && (!trimmedAgencyId || !trimmedContactId)) {
      return res.status(400).json({
        ok: false,
        message: `Missing optimise agencyId/contactId for ${platform}`,
      });
    }

    if (isPartnerize) {
      if ((!applicationKey || !userApiKey) && apiKey.includes(":")) {
        const idx = apiKey.indexOf(":");
        applicationKey = applicationKey || apiKey.slice(0, idx);
        userApiKey = userApiKey || apiKey.slice(idx + 1);
      }
      if (!applicationKey || !userApiKey) {
        return res.status(400).json({
          ok: false,
          message:
            "Partnerize requires both User Application Key (username) and User API Key (password).",
        });
      }
    } else if (!apiKey) {
      return res.status(400).json({ ok: false, message: "Missing apiKey" });
    }

    const primarySecret = isPartnerize ? applicationKey : apiKey;
    const secondarySecret = isPartnerize ? userApiKey : null;
    const maskedKey = isPartnerize
      ? `${maskApiKey(applicationKey)} / ${maskApiKey(userApiKey)}`
      : maskApiKey(apiKey);
    const now = new Date();

    const result = await prisma.marketplaceAccount.upsert({
      where: { platform_accountLabel: { platform, accountLabel } },
      update: {
        accountLabel,
        authType: "api_key",
        encryptedAccessToken: encryptText(primarySecret),
        encryptedRefreshToken: secondarySecret ? encryptText(secondarySecret) : null,
        tokenExpiresAt: null,
        scope: null,
        accountExternalId: isPartnerize ? publisherId || null : null,
        agencyId: isOptimise ? trimmedAgencyId : null,
        contactId: isOptimise ? trimmedContactId : null,
        maskedApiKey: maskedKey,
        connectedAt: now,
      },
      create: {
        platform,
        accountLabel,
        authType: "api_key",
        encryptedAccessToken: encryptText(primarySecret),
        encryptedRefreshToken: secondarySecret ? encryptText(secondarySecret) : null,
        tokenExpiresAt: null,
        scope: null,
        accountExternalId: isPartnerize ? publisherId || null : null,
        agencyId: isOptimise ? trimmedAgencyId : null,
        contactId: isOptimise ? trimmedContactId : null,
        maskedApiKey: maskedKey,
        connectedAt: now,
      },
    });

    return res.json({
      ok: true,
      result: {
        platform: result.platform,
        accountLabel: result.accountLabel,
        connected: true,
        authMethod: result.authType,
        connectedAt: result.connectedAt,
        maskedKey: result.maskedApiKey,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function disconnectMarketplaceAccount(req, res, next) {
  try {
    const { platform, accountLabel } = req.params;
    if (!SUPPORTED_PLATFORMS.has(platform)) {
      return res.status(400).json({ ok: false, message: `Unsupported platform: ${platform}` });
    }

    const normalizedLabel = normalizeAccountLabel(accountLabel);
    const deleted = await prisma.marketplaceAccount.deleteMany({
      where: { platform, accountLabel: normalizedLabel },
    });

    if (deleted.count === 0) {
      return res.status(404).json({ ok: false, message: "Account not connected" });
    }

    return res.json({
      ok: true,
      result: { platform, accountLabel: normalizedLabel, connected: false },
    });
  } catch (error) {
    next(error);
  }
}

