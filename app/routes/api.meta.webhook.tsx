import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import db from "../db.server";
import { logInfo, logWarn } from "../utils/logger.server";
import { sendWhatsAppMessage } from "../utils/meta-whatsapp.server";
import { syncOrderUpdateToShopify } from "../utils/shopify-order.server";

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
 * Handles message status receipts (delivered, read, failed), incoming customer replies,
 * and interactive button replies (Order & Address Confirmation, Updates, Support).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const rawBody = await request.text();
    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return new Response("INVALID_JSON", { status: 400 });
    }

    await logInfo(`Incoming Meta Webhook POST: ${rawBody.slice(0, 300)}`, { source: "meta-webhook" });

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

        // 2. Incoming Messages from Customer (2-Way Conversations & Interactive Button Clicks)
        const messages = value.messages || [];
        const contacts = value.contacts || [];

        for (const msg of messages) {
          const rawFromPhone = msg.from; // e.g. "919374626600"
          const profileName = contacts.find((c: any) => c.wa_id === rawFromPhone)?.profile?.name;
          const metaMessageId = msg.id;
          const fromPhone = rawFromPhone.replace(/[^0-9]/g, "");

          const msgType = (msg.type || "text").toUpperCase(); // IMAGE, VIDEO, DOCUMENT, AUDIO, TEXT, INTERACTIVE, BUTTON
          
          let mediaId: string | null = null;
          let mimeType: string | null = null;
          let caption: string | null = null;
          let messageText: string = "";
          let buttonReplyId: string = "";

          if (msg.type === "image") {
            mediaId = msg.image?.id || null;
            mimeType = msg.image?.mime_type || "image/jpeg";
            caption = msg.image?.caption || null;
            messageText = caption || "📷 Photo";
          } else if (msg.type === "video") {
            mediaId = msg.video?.id || null;
            mimeType = msg.video?.mime_type || "video/mp4";
            caption = msg.video?.caption || null;
            messageText = caption || "🎥 Video";
          } else if (msg.type === "document") {
            mediaId = msg.document?.id || null;
            mimeType = msg.document?.mime_type || "application/pdf";
            caption = msg.document?.filename || msg.document?.caption || "Document.pdf";
            messageText = `📄 ${caption}`;
          } else if (msg.type === "audio" || msg.type === "voice") {
            mediaId = msg.audio?.id || msg.voice?.id || null;
            mimeType = msg.audio?.mime_type || "audio/ogg";
            messageText = "🎵 Voice Note";
          } else if (msg.type === "interactive" && msg.interactive?.type === "button_reply") {
            buttonReplyId = msg.interactive.button_reply.id || "";
            messageText = msg.interactive.button_reply.title || "Button Clicked";
          } else if (msg.type === "button") {
            buttonReplyId = msg.button?.payload || "";
            messageText = msg.button?.text || "Button Clicked";
          } else {
            messageText = msg.text?.body || "Message";
          }

          if (merchant) {
            // Calculate 24-hour Customer Service Window (CSW)
            const cswExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

            // Check if this is an interactive button click or text reply relating to an order confirmation
            let relatedOrderNumber: string | null = null;

            // Extract order number from button reply ID if pattern is confirm_order_1002 or update_address_1002
            if (buttonReplyId.startsWith("confirm_order_") || buttonReplyId.startsWith("confirm_cod_")) {
              const rawNum = buttonReplyId.replace("confirm_order_", "").replace("confirm_cod_", "");
              relatedOrderNumber = rawNum.startsWith("#") ? rawNum : `#${rawNum}`;
            } else if (buttonReplyId.startsWith("update_address_")) {
              const rawNum = buttonReplyId.replace("update_address_", "");
              relatedOrderNumber = rawNum.startsWith("#") ? rawNum : `#${rawNum}`;
            }

            // Find matching OrderConfirmation record
            let matchingOrder = relatedOrderNumber
              ? await db.orderConfirmation.findFirst({
                  where: { merchantId: merchant.id, orderNumber: relatedOrderNumber },
                })
              : await db.orderConfirmation.findFirst({
                  where: { merchantId: merchant.id, customerPhone: fromPhone },
                  orderBy: { createdAt: "desc" },
                });

            if (matchingOrder) {
              relatedOrderNumber = matchingOrder.orderNumber;
            }

            // Handle Specific Action Buttons:
            const isConfirmAction =
              buttonReplyId.includes("confirm_order") ||
              buttonReplyId.includes("confirm_cod") ||
              messageText.toLowerCase().includes("confirm address") ||
              messageText.toLowerCase().includes("confirm order");

            const isUpdateAddressAction =
              buttonReplyId.includes("update_address") ||
              messageText.toLowerCase().includes("update address") ||
              messageText.toLowerCase().includes("change address");

            const isSupportAction =
              buttonReplyId.includes("support_query") ||
              buttonReplyId.includes("ask_query") ||
              messageText.toLowerCase().includes("ask query") ||
              messageText.toLowerCase().includes("need help");

            if (isConfirmAction && matchingOrder) {
              // 1. Mark Order as Confirmed in StorePing DB
              await db.orderConfirmation.update({
                where: { id: matchingOrder.id },
                data: {
                  status: "CONFIRMED",
                  confirmedAt: new Date(),
                },
              });

              // 2. Sync Confirmation & Tag directly into Shopify Admin Order!
              syncOrderUpdateToShopify({
                shop: merchant.shop,
                orderId: matchingOrder.orderId,
                orderNumber: matchingOrder.orderNumber,
                status: "CONFIRMED",
              }).catch((err) => console.warn("Shopify order sync notice:", err));

              // Send Automated WhatsApp Confirmation Back to Customer
              const confirmReplyText = `🎉 *Order & Address Verified!*\n\nThank you ${profileName || matchingOrder.customerName || "there"}! Your order *${matchingOrder.orderNumber}* and delivery address have been verified.\n\nOur fulfillment team is now packing your items for dispatch. We will share your live tracking link as soon as your parcel is on its way! 🚚✨`;

              await sendWhatsAppMessage({
                merchantId: merchant.id,
                recipientPhone: fromPhone,
                customerName: profileName || matchingOrder.customerName || "Customer",
                eventType: "ORDER_CONFIRM_REPLY",
                bodyText: confirmReplyText,
                senderRole: "BOT",
              });
            } else if (isUpdateAddressAction && matchingOrder) {
              // 1. Mark Order as Update Requested in StorePing DB
              await db.orderConfirmation.update({
                where: { id: matchingOrder.id },
                data: {
                  status: "UPDATE_REQUESTED",
                },
              });

              // 2. Tag order in Shopify Admin
              syncOrderUpdateToShopify({
                shop: merchant.shop,
                orderId: matchingOrder.orderId,
                orderNumber: matchingOrder.orderNumber,
                status: "UPDATE_REQUESTED",
              }).catch((err) => console.warn("Shopify order sync notice:", err));

              // Send Automated WhatsApp Prompt for New Address
              const promptReplyText = `✏️ *Address Update Request Received for ${matchingOrder.orderNumber}*\n\nPlease reply directly to this chat with your updated complete address and contact phone number. 📍\n\nOur support team will verify and update your delivery details in the system before shipping your order! 📦`;

              await sendWhatsAppMessage({
                merchantId: merchant.id,
                recipientPhone: fromPhone,
                customerName: profileName || matchingOrder.customerName || "Customer",
                eventType: "ADDRESS_UPDATE_PROMPT",
                bodyText: promptReplyText,
                senderRole: "BOT",
              });
            } else if (isSupportAction) {
              const supportReplyText = `💬 *Store Support Team*\n\nHello ${profileName || "there"}! We're here to help you with any questions regarding your order ${relatedOrderNumber || ""}.\n\nPlease tell us how we can assist you and an agent will reply shortly! 😊`;

              await sendWhatsAppMessage({
                merchantId: merchant.id,
                recipientPhone: fromPhone,
                customerName: profileName || "Customer",
                eventType: "SUPPORT_REPLY",
                bodyText: supportReplyText,
                senderRole: "BOT",
              });
            } else if (matchingOrder && matchingOrder.status === "UPDATE_REQUESTED" && msgType === "TEXT") {
              // If customer previously requested update and is now sending their new address text, save notes!
              await db.orderConfirmation.update({
                where: { id: matchingOrder.id },
                data: {
                  customerNotes: messageText,
                },
              });

              // 3. Immediately Push Customer's Address/Mobile Note into Shopify Admin Order!
              await syncOrderUpdateToShopify({
                shop: merchant.shop,
                orderId: matchingOrder.orderId,
                orderNumber: matchingOrder.orderNumber,
                status: "UPDATE_REQUESTED",
                customerNotes: messageText,
              }).catch((err) => console.warn("Shopify order sync note notice:", err));

              // Auto-acknowledge receipt
              const ackText = `✅ *Thank you!*\nWe have received your updated details: \n_"${messageText}"_\n\nOur team has updated this on Order *${matchingOrder.orderNumber}*.`;
              await sendWhatsAppMessage({
                merchantId: merchant.id,
                recipientPhone: fromPhone,
                customerName: profileName || matchingOrder.customerName || "Customer",
                eventType: "ADDRESS_SAVED_ACK",
                bodyText: ackText,
                senderRole: "BOT",
              });
            }

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
                customerName: profileName || matchingOrder?.customerName || null,
                lastOrderNumber: relatedOrderNumber || null,
                lastOrderId: matchingOrder?.orderId || null,
                lastMessageText: messageText,
                lastMessageAt: new Date(),
                unreadCount: 1,
                status: "ACTIVE",
                cswExpiresAt,
              },
              update: {
                customerName: profileName || matchingOrder?.customerName || undefined,
                lastOrderNumber: relatedOrderNumber || undefined,
                lastOrderId: matchingOrder?.orderId || undefined,
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
                messageType: msgType === "INTERACTIVE" || msgType === "BUTTON" ? "INTERACTIVE" : msgType,
                bodyText: messageText,
                mediaId,
                mediaUrl: mediaId ? `/api/meta/media?mediaId=${mediaId}` : null,
                mimeType,
                caption,
                metaMessageId,
                status: "DELIVERED",
              },
            });

            await logInfo(`Incoming WhatsApp ${msgType} from ${fromPhone}: "${messageText}"`, {
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

