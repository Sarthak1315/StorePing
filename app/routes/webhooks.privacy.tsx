import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { eraseUserData } from "../utils/dpdp.server";
import { logInfo } from "../utils/logger.server";
import { logShopifyApiCall } from "../utils/shopify-audit.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const startTime = Date.now();
  let shop = "";
  let topic = "GDPR_PRIVACY";

  try {
    const auth = await authenticate.webhook(request);
    shop = auth.shop;
    topic = auth.topic;

    await logInfo(`Shopify GDPR Webhook received: ${topic}`, {
      shop,
      source: "gdpr",
      details: { topic },
    });

    const body = auth.payload as any;

    switch (topic) {
      case "CUSTOMERS_DATA_REQUEST": {
        await logInfo(`Customer data request received for customer ID ${body.customer?.id}`, {
          shop,
          source: "gdpr",
        });
        break;
      }

      case "CUSTOMERS_REDACT": {
        const phone = body.customer?.phone;
        if (phone) {
          await db.messageLog.updateMany({
            where: { recipientPhone: { contains: phone.slice(-4) } },
            data: { customerName: "[REDACTED]", recipientPhone: "[REDACTED]" },
          });
        }
        break;
      }

      case "SHOP_REDACT": {
        await eraseUserData(shop);
        break;
      }

      default:
        break;
    }

    const durationMs = Date.now() - startTime;
    await logShopifyApiCall({
      shop: shop || "unknown",
      topic: topic || "GDPR_PRIVACY",
      apiType: "WEBHOOK",
      httpMethod: "POST",
      statusCode: 200,
      durationMs,
      status: "SUCCESS",
      requestPayload: auth.payload,
      responseBody: { success: true, topic },
      initiatedBy: "SHOPIFY_WEBHOOK",
    });

    return new Response("Webhook processed", { status: 200 });
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    await logShopifyApiCall({
      shop: shop || "unknown",
      topic: topic || "GDPR_PRIVACY",
      apiType: "WEBHOOK",
      httpMethod: "POST",
      statusCode: 500,
      durationMs,
      status: "FAILED",
      errorMessage: err?.message || String(err),
      initiatedBy: "SHOPIFY_WEBHOOK",
    });
    console.warn("Privacy webhook notice:", err);
    return new Response("Privacy webhook handled", { status: 200 });
  }
};
