import { prisma } from "../../src/database/prisma.js";
import { signAccessToken } from "../../src/modules/auth/auth.service.js";

export async function getActiveUserByRole(role) {
  return prisma.user.findFirst({
    where: { role, isActive: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function tokenForRole(role) {
  const user = await getActiveUserByRole(role);
  if (!user) return null;
  return signAccessToken(user);
}

export async function canRunDatabaseIntegrationTests() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Boolean(process.env.JWT_SECRET);
  } catch {
    return false;
  }
}
