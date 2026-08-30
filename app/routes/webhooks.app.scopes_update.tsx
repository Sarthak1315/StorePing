import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { logInfo } from "../utils/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { payload, session, topic, shop } = await authenticate.webhook(request);

    await logInfo(`Received app/scopes_update webhook for ${shop}`, {
      shop,
      source: "webhook",
      details: { topic, current: (payload as any).current },
    });

    if (session) {
      await db.session.updateMany({
        where: { shop },
        data: {
          scope: (payload as any).current.join(","),
        },
      });
    }
  } catch (err: any) {
    console.warn("Scopes update webhook notice:", err);
  }

  return new Response("Scopes update handled", { status: 200 });
};
