import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const merchant = await db.merchant.findFirst();
  console.log("Merchant:", merchant?.shop, "wabaId:", merchant?.wabaId, "phoneId:", merchant?.phoneNumberId);

  const logs = await db.metaApiLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  console.log("\nRecent Meta API Logs (Count: " + logs.length + "):");
  logs.forEach(l => {
    console.log("---", l.createdAt, l.endpoint, l.statusCode, l.status, l.errorMessage);
    console.log("Payload:", JSON.stringify(l.requestPayload));
    console.log("Response:", JSON.stringify(l.responseBody));
  });

  const templates = await db.template.findMany({
    where: { merchantId: merchant?.id },
  });
  console.log("\nTemplates in DB:");
  templates.forEach(t => {
    console.log(t.eventType, "| name:", t.metaTemplateName, "| status:", t.metaTemplateStatus, "| id:", t.metaTemplateId);
  });
  
  const confirmations = await db.orderConfirmation.findMany({
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  console.log("\nRecent Order Confirmations:");
  confirmations.forEach(c => {
    console.log(c.orderNumber, "| status:", c.status, "| phone:", c.customerPhone, "| err:", c.errorMessage, "| metaMsgId:", c.metaMessageId);
  });
}

main().catch(console.error).finally(() => db.$disconnect());
