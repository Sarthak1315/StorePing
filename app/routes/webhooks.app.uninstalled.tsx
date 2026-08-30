import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { logInfo, logWarn } from "../utils/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { shop, session, topic } = await authenticate.webhook(request);

    await logInfo(`Received app/uninstalled webhook for ${shop}`, { shop, source: "webhook", details: { topic } });

    if (session) {
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
  } catch (err: any) {
    await logWarn(`app/uninstalled webhook error: ${err.message}`, { source: "webhook" });
  }

  return new Response("App uninstalled handled", { status: 200 });
};
