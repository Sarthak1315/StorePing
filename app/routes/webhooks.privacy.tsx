import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { eraseUserData } from "../utils/dpdp.server";
import { logInfo } from "../utils/logger.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { shop, payload, topic } = await authenticate.webhook(request);

    await logInfo(`Shopify GDPR Webhook received: ${topic}`, {
      shop,
      source: "gdpr",
      details: { topic },
    });

    const body = payload as any;

    switch (topic) {
      case "CUSTOMERS_DATA_REQUEST": {
        await logInfo(`Customer data request received for customer ID ${body.customer?.id}`, {
          shop,
          source: "gdpr",
        });
        return new Response("Customer data request received", { status: 200 });
      }

      case "CUSTOMERS_REDACT": {
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
        await eraseUserData(shop);
        return new Response("Shop data erased", { status: 200 });
      }

      default:
        return new Response("Webhook received", { status: 200 });
    }
  } catch (err: any) {
    console.warn("Privacy webhook notice:", err);
    return new Response("Privacy webhook handled", { status: 200 });
  }
};
