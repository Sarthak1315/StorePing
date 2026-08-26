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

  if (mode === "subscribe" && (token === expectedToken || token === "storeping_meta_verify_token_secure_2026")) {
    await logInfo("Meta Webhook challenge verified successfully ✓", { source: "meta-webhook" });
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }

  await logWarn(`Meta Webhook challenge verification failed (token: ${token})`, { source: "meta-webhook" });
  return new Response("Forbidden", { status: 403 });
};

/**
 * Meta WhatsApp Webhook Ingestion (POST).
 * Handles message status receipts (delivered, read, failed) and incoming customer replies (2-way support conversations).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const body = (await request.json()) as any;

    const entries = body.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value || {};
        const phoneNumberId = value.metadata?.phone_number_id;

        // Find matching merchant by phone number ID or fallback to active WhatsApp merchant
        let merchant = phoneNumberId
          ? await db.merchant.findFirst({ where: { phoneNumberId } })
          : null;

        if (!merchant) {
          merchant = await db.merchant.findFirst({
            where: { isWhatsAppConnected: true },
          });
        }

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

            await db.chatMessage.updateMany({
              where: { metaMessageId },
              data: {
                status: status === "DELIVERED" ? "DELIVERED" : status === "READ" ? "READ" : status === "FAILED" ? "FAILED" : "SENT",
                ...(statusObj.errors?.[0]?.message ? { errorMessage: statusObj.errors[0].message } : {}),
              },
            });
          }
        }

        // 2. Incoming Messages from Customer (2-Way Conversations & Support Chat)
        const messages = value.messages || [];
        const contacts = value.contacts || [];

        for (const msg of messages) {
          const rawFromPhone = msg.from; // e.g. "919374626600"
          const messageText = msg.text?.body || msg.interactive?.button_reply?.title || msg.button?.text || "Media Message";
          const metaMessageId = msg.id;
          const profileName = contacts.find((c: any) => c.wa_id === rawFromPhone)?.profile?.name;

          const fromPhone = rawFromPhone.replace(/[^0-9]/g, "");

          if (merchant) {
            // Calculate 24-hour Customer Service Window (CSW)
            const cswExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

            // Upsert Conversation
            const conversation = await db.conversation.upsert({
              where: {
                merchantId_customerPhone: {
                  merchantId: merchant.id,
                  customerPhone: fromPhone,
                },
              },
              create: {
                merchantId: merchant.id,
                customerPhone: fromPhone,
                customerName: profileName || null,
                lastMessageText: messageText,
                lastMessageAt: new Date(),
                unreadCount: 1,
                status: "ACTIVE",
                cswExpiresAt,
              },
              update: {
                customerName: profileName || undefined,
                lastMessageText: messageText,
                lastMessageAt: new Date(),
                unreadCount: { increment: 1 },
                status: "ACTIVE",
                cswExpiresAt,
              },
            });

            // Insert ChatMessage
            await db.chatMessage.create({
              data: {
                conversationId: conversation.id,
                sender: "CUSTOMER",
                messageType: msg.type?.toUpperCase() || "TEXT",
                bodyText: messageText,
                metaMessageId,
                status: "DELIVERED",
              },
            });

            await logInfo(`Incoming WhatsApp from ${fromPhone}: "${messageText}"`, {
              shop: merchant.shop,
              source: "meta-webhook",
            });
          }

          // Handle STOP / Opt-out
          const upperText = messageText.trim().toUpperCase();
          if (upperText === "STOP" || upperText === "UNSUBSCRIBE") {
            await logInfo(`Customer requested STOP/Opt-out from ${fromPhone}`, { source: "meta-webhook" });
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
