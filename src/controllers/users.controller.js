import { z } from "zod";
import { STAFF_USER_ROLES } from "../auth/permissions.js";
import {
  createUserByAdmin,
  listAccessLogs,
  listUsers,
  logAccess,
  toPublicUser,
  updateUserByAdmin,
} from "../modules/auth/auth.service.js";
import { prisma } from "../database/prisma.js";

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters."),
  name: z.string().trim().min(1).max(120).optional(),
  role: z.enum(STAFF_USER_ROLES),
});

const updateUserSchema = z
  .object({
    role: z.enum(STAFF_USER_ROLES).optional(),
    isActive: z.boolean().optional(),
    name: z.string().trim().min(1).max(120).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided.",
  });

export async function listUsersHandler(_req, res, next) {
  try {
    const users = await listUsers();
    res.json({ ok: true, users });
  } catch (error) {
    next(error);
  }
}

export async function createUserHandler(req, res, next) {
  try {
    const body = createUserSchema.parse(req.body);
    const user = await createUserByAdmin(body);

    await logAccess({
      userId: req.user.id,
      action: "users.create",
      resource: `users:${user.id}`,
      metadata: { role: user.role, email: user.email },
      ipAddress: req.ip,
    });

    res.status(201).json({ ok: true, user: toPublicUser(user) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ ok: false, message: error.issues[0]?.message || "Invalid input." });
      return;
    }
    if (error.statusCode) {
      res.status(error.statusCode).json({ ok: false, message: error.message });
      return;
    }
    next(error);
  }
}

export async function updateUserHandler(req, res, next) {
  try {
    const body = updateUserSchema.parse(req.body);
    const targetId = String(req.params.id);

    if (targetId === req.user.id && body.isActive === false) {
      res.status(400).json({ ok: false, message: "You cannot deactivate your own account." });
      return;
    }

    if (targetId === req.user.id && body.role && body.role !== req.user.role) {
      res.status(400).json({ ok: false, message: "You cannot change your own role." });
      return;
    }

    const existing = await prisma.user.findUnique({ where: { id: targetId } });
    if (!existing) {
      res.status(404).json({ ok: false, message: "User not found." });
      return;
    }

    const user = await updateUserByAdmin(targetId, body);

    await logAccess({
      userId: req.user.id,
      action: "users.update",
      resource: `users:${user.id}`,
      metadata: body,
      ipAddress: req.ip,
    });

    res.json({ ok: true, user: toPublicUser(user) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ ok: false, message: error.issues[0]?.message || "Invalid input." });
      return;
    }
    next(error);
  }
}

export async function listAccessLogsHandler(req, res, next) {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 50, 1), 200);
    const result = await listAccessLogs({ page, pageSize });
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
}
