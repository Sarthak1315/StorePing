import db from "./app/db.server";
import { syncAllDefaultTemplatesToMeta, fetchWabaTemplates } from "./app/utils/meta-whatsapp.server";

async function main() {
  const merchant = await db.merchant.findFirst();
  console.log("Syncing all templates for merchant:", merchant?.shop, merchant?.id);
  if (!merchant) return;

  const res = await syncAllDefaultTemplatesToMeta(merchant.id);
  console.log("Sync result:\n", JSON.stringify(res, null, 2));

  const live = await fetchWabaTemplates(merchant.id);
  console.log("\nLive templates on Meta now count:", live.length);
  live.forEach(t => {
    console.log("->", t.name, "| status:", t.status, "| category:", t.category, "| id:", t.id);
  });
}

main().catch(console.error).finally(() => db.$disconnect());
