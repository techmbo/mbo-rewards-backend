/**
 * Wipe all application data and keep admin user(s) only.
 *
 * Usage:
 *   node scripts/reset-database.js --confirm
 *   node scripts/reset-database.js --confirm --email=admin@mbo.demo
 *
 * Uses DIRECT_URL when set (recommended for Supabase truncate).
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const args = process.argv.slice(2);
const confirmed = args.includes("--confirm");
const emailArg = args.find((a) => a.startsWith("--email="));
const keepEmail = emailArg ? emailArg.split("=")[1]?.trim().toLowerCase() : null;

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL },
  },
});

async function listTables() {
  const rows = await prisma.$queryRaw`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename <> '_prisma_migrations'
    ORDER BY tablename
  `;
  return rows.map((r) => r.tablename);
}

async function main() {
  if (!confirmed) {
    console.error("Refusing to run without --confirm");
    console.error("Example: node scripts/reset-database.js --confirm");
    process.exit(1);
  }

  const adminWhere = keepEmail
    ? { email: keepEmail, role: "ADMIN" }
    : { role: "ADMIN" };

  const admins = await prisma.user.findMany({ where: adminWhere });

  if (!admins.length) {
    throw new Error(
      keepEmail
        ? `No ADMIN user found with email ${keepEmail}`
        : "No ADMIN users found — aborting to avoid locking you out.",
    );
  }

  console.log("Keeping admin user(s):");
  for (const u of admins) {
    console.log(`  • ${u.email} (${u.name || u.id})`);
  }

  const tables = await listTables();
  console.log(`\nTruncating ${tables.length} tables (preserving _prisma_migrations)…`);

  const quoted = tables.map((t) => `"${t}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);

  console.log("Restoring admin user(s)…");
  for (const admin of admins) {
    await prisma.user.create({
      data: {
        id: admin.id,
        email: admin.email,
        passwordHash: admin.passwordHash,
        name: admin.name,
        role: admin.role,
        isActive: admin.isActive,
        clientId: null,
        inviteTokenHash: admin.inviteTokenHash,
        inviteExpiresAt: admin.inviteExpiresAt,
        passwordSetAt: admin.passwordSetAt,
        createdAt: admin.createdAt,
        updatedAt: admin.updatedAt,
      },
    });
  }

  const userCount = await prisma.user.count();
  const entityCount = await prisma.entity.count();
  const clientCount = await prisma.client.count();
  const supplierCampaignCount = await prisma.supplierCampaign.count();

  console.log("\nDone.");
  console.log(`  Users:              ${userCount}`);
  console.log(`  Entities:           ${entityCount}`);
  console.log(`  Clients:            ${clientCount}`);
  console.log(`  Supplier campaigns: ${supplierCampaignCount}`);
  console.log("\nDatabase is empty except admin login(s). Re-sync suppliers from the UI when ready.");
}

main()
  .catch((error) => {
    console.error("Reset failed:", error.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
