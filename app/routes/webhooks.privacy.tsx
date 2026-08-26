import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { eraseUserData } from "../utils/dpdp.server";
import { logInfo } from "../utils/logger.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  await logInfo(`Shopify GDPR Webhook received: ${topic}`, {
    shop,
    source: "gdpr",
    details: { topic },
  });

  const body = payload as any;

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST": {
      // Return 200 acknowledge (customer requested their data)
      await logInfo(`Customer data request received for customer ID ${body.customer?.id}`, {
        shop,
        source: "gdpr",
      });
      return new Response("Customer data request received", { status: 200 });
    }

    case "CUSTOMERS_REDACT": {
      // Redact customer phone / personal data from logs
      const phone = body.customer?.phone;
      if (phone) {
        await db.messageLog.updateMany({
          where: { recipientPhone: { contains: phone.slice(-4) } },
          data: { customerName: "[REDACTED]", recipientPhone: "[REDACTED]" },
        });
      }
      return new Response("Customer data redacted", { status: 200 });
    }

    case "SHOP_REDACT": {
      // 48 hours after app uninstall, wipe all shop data permanently
      await eraseUserData(shop);
      return new Response("Shop data erased", { status: 200 });
    }

    default:
      return new Response("Webhook received", { status: 200 });
  }
};
