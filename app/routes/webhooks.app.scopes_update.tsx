import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { logInfo } from "../utils/logger.server";
import { logShopifyApiCall } from "../utils/shopify-audit.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const startTime = Date.now();
  let shop = "";
  let topic = "APP_SCOPES_UPDATE";

  try {
    const auth = await authenticate.webhook(request);
    shop = auth.shop;
    topic = auth.topic;

    await logInfo(`Received app/scopes_update webhook for ${shop}`, {
      shop,
      source: "webhook",
      details: { topic, current: (auth.payload as any).current },
    });

    if (auth.session) {
      await db.session.updateMany({
        where: { shop },
        data: {
          scope: (auth.payload as any).current.join(","),
        },
      });
    }

    const durationMs = Date.now() - startTime;
    await logShopifyApiCall({
      shop: shop || "unknown",
      topic: topic || "APP_SCOPES_UPDATE",
      apiType: "WEBHOOK",
      httpMethod: "POST",
      statusCode: 200,
      durationMs,
      status: "SUCCESS",
      requestPayload: auth.payload,
      responseBody: { success: true, topic },
      initiatedBy: "SHOPIFY_WEBHOOK",
    });
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    await logShopifyApiCall({
      shop: shop || "unknown",
      topic: topic || "APP_SCOPES_UPDATE",
      apiType: "WEBHOOK",
      httpMethod: "POST",
      statusCode: 500,
      durationMs,
      status: "FAILED",
      errorMessage: err?.message || String(err),
      initiatedBy: "SHOPIFY_WEBHOOK",
    });
    console.warn("Scopes update webhook notice:", err);
  }

  return new Response("Scopes update handled", { status: 200 });
};
