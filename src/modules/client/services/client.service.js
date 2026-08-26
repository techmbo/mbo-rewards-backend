import { fail } from "../../../core/apiResponse.js";
import { isPrismaUniqueViolation } from "../../../core/prismaErrors.js";
import { slugifyClientName } from "../normalizeSlug.js";
import { ClientRepository } from "../repositories/client.repository.js";
import { normalizeApiEnvironmentConfig } from "../apiEnvironmentConfig.js";

function uniqueSlug(base, attempt = 0) {
  if (!attempt) return base;
  return `${base}-${attempt}`;
}

function coerceDate(value) {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export class ClientService {
  constructor(deps = {}) {
    this.clientRepo = deps.clientRepo ?? new ClientRepository();
  }

  async resolveUniqueSlug(name, client = null) {
    const base = slugifyClientName(name);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const slug = uniqueSlug(base, attempt);
      const existing = await this.clientRepo.findBySlugAny(slug, client);
      if (!existing) return slug;
    }
    throw fail("Unable to generate unique client slug.", 409);
  }

  async create(input, client = null) {
    const slugInput = input.slug?.trim();
    const slug = slugInput
      ? slugifyClientName(slugInput)
      : await this.resolveUniqueSlug(input.name, client);

    if (!slug) throw fail("Client slug is required.", 400);

    const existing = await this.clientRepo.findBySlugAny(slug, client);
    if (existing) {
      if (existing.deletedAt) {
        throw fail(
          `Slug "${slug}" is reserved by a deleted client. Choose a different slug.`,
          409,
        );
      }
      throw fail(
        `Slug "${slug}" is already in use by another client. Choose a different slug.`,
        409,
      );
    }

    try {
      return await this.clientRepo.create(
        {
          name: input.name.trim(),
          slug,
          legalName: input.legalName ?? null,
          industry: input.industry ?? null,
          category: input.category ?? null,
          subCategory: input.subCategory ?? null,
          country: input.country ?? null,
          currency: input.currency ?? null,
          timezone: input.timezone ?? null,
          logoUrl: input.logoUrl ?? null,
          status: input.status ?? "PROSPECT",
          deliveryMethod: input.deliveryMethod ?? "API_AND_PORTAL",
          agreementStatus: input.agreementStatus ?? "NONE",
          agreementEffectiveAt: coerceDate(input.agreementEffectiveAt),
          agreementRenewalAt: coerceDate(input.agreementRenewalAt),
          agreementDocumentUrl: input.agreementDocumentUrl ?? null,
          paymentCycle: input.paymentCycle ?? null,
          paymentTrigger: input.paymentTrigger ?? null,
          apiEnvironmentConfig: normalizeApiEnvironmentConfig(input.apiEnvironmentConfig),
        },
        client,
      );
    } catch (error) {
      if (isPrismaUniqueViolation(error)) {
        throw fail(`Slug "${slug}" is already in use.`, 409);
      }
      throw error;
    }
  }

  async update(id, input, client = null) {
    const record = await this.clientRepo.findById(id, {}, client);
    if (!record) throw fail("Client not found.", 404);

    const data = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.legalName !== undefined) data.legalName = input.legalName;
    if (input.industry !== undefined) data.industry = input.industry;
    if (input.category !== undefined) data.category = input.category;
    if (input.subCategory !== undefined) data.subCategory = input.subCategory;
    if (input.country !== undefined) data.country = input.country;
    if (input.currency !== undefined) data.currency = input.currency;
    if (input.timezone !== undefined) data.timezone = input.timezone;
    if (input.logoUrl !== undefined) data.logoUrl = input.logoUrl;
    if (input.status !== undefined) data.status = input.status;
    if (input.deliveryMethod !== undefined) data.deliveryMethod = input.deliveryMethod;
    if (input.agreementStatus !== undefined) data.agreementStatus = input.agreementStatus;
    if (input.agreementEffectiveAt !== undefined) {
      data.agreementEffectiveAt = coerceDate(input.agreementEffectiveAt);
    }
    if (input.agreementRenewalAt !== undefined) {
      data.agreementRenewalAt = coerceDate(input.agreementRenewalAt);
    }
    if (input.agreementDocumentUrl !== undefined) {
      data.agreementDocumentUrl = input.agreementDocumentUrl;
    }
    if (input.paymentCycle !== undefined) data.paymentCycle = input.paymentCycle;
    if (input.paymentTrigger !== undefined) data.paymentTrigger = input.paymentTrigger;
    if (input.apiEnvironmentConfig !== undefined) {
      data.apiEnvironmentConfig = normalizeApiEnvironmentConfig({
        ...normalizeApiEnvironmentConfig(record.apiEnvironmentConfig),
        ...input.apiEnvironmentConfig,
        SANDBOX: {
          ...normalizeApiEnvironmentConfig(record.apiEnvironmentConfig).SANDBOX,
          ...(input.apiEnvironmentConfig.SANDBOX || input.apiEnvironmentConfig.sandbox || {}),
        },
        PRODUCTION: {
          ...normalizeApiEnvironmentConfig(record.apiEnvironmentConfig).PRODUCTION,
          ...(input.apiEnvironmentConfig.PRODUCTION ||
            input.apiEnvironmentConfig.production ||
            {}),
        },
      });
    }

    return this.clientRepo.update(id, data, client);
  }

  async remove(id, client = null) {
    const record = await this.clientRepo.findById(id, {}, client);
    if (!record) throw fail("Client not found.", 404);
    return this.clientRepo.softDelete(id, client);
  }
}
