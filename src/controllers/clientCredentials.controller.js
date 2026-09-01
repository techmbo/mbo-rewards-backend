import { ok } from "../core/apiResponse.js";
import { toPublicUser } from "../modules/auth/auth.service.js";
import { ClientCredentialService } from "../modules/client/services/clientCredential.service.js";
import {
  apiCredentialParamsSchema,
  clientParamsSchema,
  createApiCredentialBodySchema,
  createPortalUserBodySchema,
} from "../modules/client/validators/schemas.js";

const credentialService = new ClientCredentialService();

export async function createPortalUserHandler(req, res, next) {
  try {
    const params = clientParamsSchema.parse(req.params);
    const body = createPortalUserBodySchema.parse(req.body ?? {});
    const result = await credentialService.createPortalUser(params.id, body);
    const user = result.user ?? result;
    res.status(result.created === false ? 200 : 201).json(
      ok({
        user: toPublicUser(user),
        created: result.created !== false,
        message: "Portal login ready. Share the email and password with the client securely — the password is shown once.",
        credentials: {
          email: user.email,
          password: body.password,
        },
      }),
    );
  } catch (error) {
    next(error);
  }
}

export async function listPortalUsersHandler(req, res, next) {
  try {
    const params = clientParamsSchema.parse(req.params);
    const rows = await credentialService.listPortalUsers(params.id);
    res.json(ok(rows));
  } catch (error) {
    next(error);
  }
}

export async function listApiCredentialsHandler(req, res, next) {
  try {
    const params = clientParamsSchema.parse(req.params);
    const rows = await credentialService.listApiCredentials(params.id);
    res.json(ok(rows));
  } catch (error) {
    next(error);
  }
}

export async function createApiCredentialHandler(req, res, next) {
  try {
    const params = clientParamsSchema.parse(req.params);
    const body = createApiCredentialBodySchema.parse(req.body ?? {});
    const credential = await credentialService.issueApiCredential(params.id, {
      name: body.name,
      environment: body.environment,
      createdBy: req.user?.id ?? null,
    });
    res.status(201).json(ok(credential));
  } catch (error) {
    next(error);
  }
}

export async function revokeApiCredentialHandler(req, res, next) {
  try {
    const params = apiCredentialParamsSchema.parse(req.params);
    await credentialService.revokeApiCredential(params.id, params.credentialId);
    res.json(ok({ revoked: true }));
  } catch (error) {
    next(error);
  }
}
