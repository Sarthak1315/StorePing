import db from "../app/db.server";
import { hashPassword } from "../app/utils/portal-auth.server";

async function seedSuperAdmin() {
  const superAdminEmail = (process.env.SUPER_ADMIN_EMAIL || "admin@everonlab.in").toLowerCase().trim();
  const superAdminPassword = process.env.SUPER_ADMIN_PASSWORD || "SuperAdmin@2026";
  const superAdminName = "Everon Super Admin";

  console.log(`[Seed] Checking for existing Super Admin with email: ${superAdminEmail}...`);

  const existing = await db.user.findUnique({
    where: { email: superAdminEmail },
  });

  if (existing) {
    console.log(`[Seed] Super Admin already exists with ID: ${existing.id}. Updating role to SUPER_ADMIN...`);
    const updated = await db.user.update({
      where: { id: existing.id },
      data: {
        role: "SUPER_ADMIN",
        isActive: true,
        passwordHash: hashPassword(superAdminPassword),
      },
    });
    console.log(`[Seed] Super Admin password reset to default: ${superAdminPassword}`);
    return updated;
  }

  // Find any merchant to associate or leave null
  const firstMerchant = await db.merchant.findFirst();

  const superAdmin = await db.user.create({
    data: {
      email: superAdminEmail,
      name: superAdminName,
      role: "SUPER_ADMIN",
      passwordHash: hashPassword(superAdminPassword),
      merchantId: firstMerchant?.id || null,
      isActive: true,
    },
  });

  console.log(`✅ [Seed] Successfully created Super Admin!`);
  console.log(`- Email: ${superAdminEmail}`);
  console.log(`- Password: ${superAdminPassword}`);
  console.log(`- Role: SUPER_ADMIN (Has access to ALL platform stores, WABAs, and inboxes)`);
  return superAdmin;
}

seedSuperAdmin()
  .then(() => {
    console.log("[Seed] Completed successfully.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("[Seed] Error seeding Super Admin:", err);
    process.exit(1);
  });
