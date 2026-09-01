import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { logInfo, logWarn } from "../utils/logger.server";
import { logShopifyApiCall } from "../utils/shopify-audit.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const startTime = Date.now();
  let shop = "";
  let topic = "APP_UNINSTALLED";

  try {
    const auth = await authenticate.webhook(request);
    shop = auth.shop;
    topic = auth.topic;

    await logInfo(`Received app/uninstalled webhook for ${shop}`, { shop, source: "webhook", details: { topic } });

    if (auth.session) {
      await db.session.deleteMany({ where: { shop } });
    }

    // Deactivate WhatsApp connection for uninstalled shop
    await db.merchant.updateMany({
      where: { shop },
      data: {
        isWhatsAppConnected: false,
        alertType: "NONE",
        alertMessage: null,
      },
    });

    const durationMs = Date.now() - startTime;
    await logShopifyApiCall({
      shop: shop || "unknown",
      topic: topic || "APP_UNINSTALLED",
      apiType: "WEBHOOK",
      httpMethod: "POST",
      statusCode: 200,
      durationMs,
      status: "SUCCESS",
      requestPayload: auth.payload,
      responseBody: { success: true, action: "uninstalled" },
      initiatedBy: "SHOPIFY_WEBHOOK",
    });
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    await logShopifyApiCall({
      shop: shop || "unknown",
      topic: topic || "APP_UNINSTALLED",
      apiType: "WEBHOOK",
      httpMethod: "POST",
      statusCode: 500,
      durationMs,
      status: "FAILED",
      errorMessage: err?.message || String(err),
      initiatedBy: "SHOPIFY_WEBHOOK",
    });
    await logWarn(`app/uninstalled webhook error: ${err.message}`, { source: "webhook" });
  }

  return new Response("App uninstalled handled", { status: 200 });
};
