import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import db from "../db.server";
import { logInfo, logWarn } from "../utils/logger.server";

/**
 * Meta Webhook Verification Handshake (GET).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const expectedToken = process.env.META_WEBHOOK_VERIFY_TOKEN || "storeping_meta_verify_token_secure_2026";

  if (mode === "subscribe" && token === expectedToken) {
    await logInfo("Meta Webhook challenge verified successfully ✓", { source: "meta-webhook" });
    return new Response(challenge, { status: 200 });
  }

  await logWarn("Meta Webhook challenge verification failed (invalid token)", { source: "meta-webhook" });
  return new Response("Forbidden", { status: 403 });
};

/**
 * Meta WhatsApp Webhook Ingestion (POST).
 * Handles message status receipts (delivered, read, failed) and incoming customer replies (STOP opt-outs).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const body = (await request.json()) as any;

    const entries = body.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value || {};

        // 1. Message Status Updates (sent, delivered, read, failed)
        const statuses = value.statuses || [];
        for (const statusObj of statuses) {
          const metaMessageId = statusObj.id;
          const status = (statusObj.status || "").toUpperCase(); // DELIVERED, READ, FAILED

          if (metaMessageId && status) {
            await db.messageLog.updateMany({
              where: { metaMessageId },
              data: {
                status: status === "DELIVERED" ? "DELIVERED" : status === "READ" ? "READ" : status === "FAILED" ? "FAILED" : "SENT",
                ...(statusObj.errors?.[0]?.message ? { errorMessage: statusObj.errors[0].message } : {}),
              },
            });
          }
        }

        // 2. Incoming Messages from Customer (e.g. STOP / Unsubscribe)
        const messages = value.messages || [];
        for (const msg of messages) {
          const text = (msg.text?.body || "").trim().toUpperCase();
          const fromPhone = msg.from;

          if (text === "STOP" || text === "UNSUBSCRIBE") {
            await logInfo(`Customer requested STOP/Opt-out from ${fromPhone}`, { source: "meta-webhook" });
            // Handle opt-out logic
          }
        }
      }
    }

    return new Response("EVENT_RECEIVED", { status: 200 });
  } catch (err: any) {
    await logWarn(`Meta Webhook processing error: ${err.message}`, { source: "meta-webhook" });
    return new Response("EVENT_RECEIVED", { status: 200 });
  }
};
