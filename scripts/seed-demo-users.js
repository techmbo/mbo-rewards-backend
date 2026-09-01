/**
 * Seed demo users for each platform role.
 *
 * Usage: node scripts/seed-demo-users.js
 */
import "dotenv/config";
import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DEMO_PASSWORD = "Demo@12345";
const SALT_ROUNDS = 10;

const DEMO_USERS = [
  {
    email: "admin@mbo.demo",
    name: "Demo Admin",
    role: "ADMIN",
    description: "Full platform access",
  },
  {
    email: "operations@mbo.demo",
    name: "Demo Operations",
    role: "OPERATIONS",
    description: "Day-to-day ops: merchants, catalog, clients, commercial, reporting",
  },
  {
    email: "analyst@mbo.demo",
    name: "Demo Analyst",
    role: "ANALYST",
    description: "Read-only analytics (no commission figures)",
  },
  {
    email: "tech@mbo.demo",
    name: "Demo Tech",
    role: "TECH",
    description: "Integrations, sync, logs, system health",
  },
  {
    email: "support@mbo.demo",
    name: "Demo Support",
    role: "SUPPORT",
    description: "Limited: campaigns + coupons only",
  },
];

async function main() {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, SALT_ROUNDS);

  console.log("Seeding demo users...\n");

  for (const user of DEMO_USERS) {
    const record = await prisma.user.upsert({
      where: { email: user.email },
      update: {
        name: user.name,
        role: user.role,
        passwordHash,
        isActive: true,
      },
      create: {
        email: user.email,
        name: user.name,
        role: user.role,
        passwordHash,
        isActive: true,
      },
    });

    console.log(`✓ ${record.role.padEnd(12)} ${record.email}  (${user.description})`);
  }

  console.log("\n────────────────────────────────────────");
  console.log("Demo password for ALL accounts:");
  console.log(`  ${DEMO_PASSWORD}`);
  console.log("────────────────────────────────────────\n");
}

main()
  .catch((error) => {
    console.error("Seed failed:", error.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
