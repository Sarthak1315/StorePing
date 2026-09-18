import { PrismaClient } from "@prisma/client";
import { syncAllDefaultTemplatesToMeta, fetchWabaTemplates } from "./app/utils/meta-whatsapp.server.js";

const db = new PrismaClient();

async function main() {
  const merchant = await db.merchant.findFirst();
  console.log("Syncing all templates for merchant:", merchant?.shop, merchant?.id);
  if (!merchant) return;

  const res = await syncAllDefaultTemplatesToMeta(merchant.id);
  console.log("Sync result:", JSON.stringify(res, null, 2));

  const live = await fetchWabaTemplates(merchant.id);
  console.log("\nLive templates on Meta now:");
  live.forEach(t => {
    console.log("->", t.name, "| status:", t.status, "| category:", t.category, "| id:", t.id);
  });
}

main().catch(console.error).finally(() => db.$disconnect());
