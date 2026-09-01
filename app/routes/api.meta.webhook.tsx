import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import db from "../db.server";
import { logInfo, logWarn } from "../utils/logger.server";
import { logMetaApiCall } from "../utils/meta-audit.server";
import { sendWhatsAppMessage } from "../utils/meta-whatsapp.server";
import { syncOrderUpdateToShopify } from "../utils/shopify-order.server";
import { calculateMessageCost, checkAndTriggerSpendAlerts } from "../utils/meta-pricing.server";
import { interpolateVariables } from "../utils/template.shared";

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
  const webhookStartTime = Date.now();
  let rawBody = "";
  let lastMerchantId: string | null = null;

  try {
    rawBody = await request.text();
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

        if (merchant) {
          lastMerchantId = merchant.id;
        }

        // 1. Message Status Updates (sent, delivered, read, failed) & Pricing Telemetry
        const statuses = value.statuses || [];
        for (const statusObj of statuses) {
          const metaMessageId = statusObj.id;
          const status = (statusObj.status || "").toUpperCase(); // DELIVERED, READ, FAILED
          const pricingObj = statusObj.pricing; // e.g. { billable: true, pricing_model: "PMP", category: "marketing" }
          const recipientId = statusObj.recipient_id || "";

          // Detect Meta Card / Payment Failure Error Codes
          const errorCode = statusObj.errors?.[0]?.code;
          const errorMessage = statusObj.errors?.[0]?.message || "";

          if (merchant && (errorCode === 131042 || errorCode === 131045 || errorMessage.toLowerCase().includes("payment"))) {
            await db.merchant.update({
              where: { id: merchant.id },
              data: {
                alertType: "PAYMENT_REQUIRED",
                alertMessage: "⚠️ Your payment method on Meta was declined. Please update your card in Meta Business Suite to avoid message delivery pauses.",
              },
            });
          }

          if (metaMessageId && status) {
            // Determine pricing category & cost
            let pricingCategory = pricingObj?.category ? pricingObj.category.toUpperCase() : "UTILITY";
            let isBillable = pricingObj?.billable ?? (status === "DELIVERED" || status === "READ");
            
            const costCalc = calculateMessageCost(
              recipientId,
              pricingCategory,
              false,
              merchant?.billingCurrency || "INR"
            );

            const estimatedCost = isBillable ? costCalc.estimatedCost : 0.0;

            await db.messageLog.updateMany({
              where: { metaMessageId },
              data: {
                status: status === "DELIVERED" ? "DELIVERED" : status === "READ" ? "READ" : status === "FAILED" ? "FAILED" : "SENT",
                pricingCategory,
                isBillable,
                estimatedCost,
                ...(errorMessage ? { errorMessage } : {}),
              },
            });

            await db.chatMessage.updateMany({
              where: { metaMessageId },
              data: {
                status: status === "DELIVERED" ? "DELIVERED" : status === "READ" ? "READ" : status === "FAILED" ? "FAILED" : "SENT",
                ...(errorMessage ? { errorMessage } : {}),
              },
            });

            // Update merchant current month spend & evaluate budget alerts if delivered
            if (merchant && isBillable && (status === "DELIVERED" || status === "READ")) {
              const updated = await db.merchant.update({
                where: { id: merchant.id },
                data: {
                  currentMonthSpend: { increment: estimatedCost },
                },
                select: { id: true, currentMonthSpend: true },
              });
              await checkAndTriggerSpendAlerts(merchant.id, updated.currentMonthSpend);
            }
          }
        }

        // 2. Incoming Messages from Customer (2-Way Conversations & Interactive Button Clicks)
        const messages = value.messages || [];
        const contacts = value.contacts || [];

        for (const msg of messages) {
          const rawFromPhone = msg.from; // e.g. "919876543210"
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
            const isInteractiveOrButton = msgType === "INTERACTIVE" || msgType === "BUTTON";
            const lowerText = messageText.trim().toLowerCase();
            const cleanButtonId = buttonReplyId.trim();

            // Extract order number from button reply ID if pattern is confirm_order_1002, update_address_1002, etc.
            if (cleanButtonId.startsWith("confirm_order_")) {
              const rawNum = decodeURIComponent(cleanButtonId.replace("confirm_order_", ""));
              relatedOrderNumber = rawNum.startsWith("#") ? rawNum : `#${rawNum}`;
            } else if (cleanButtonId.startsWith("confirm_cod_")) {
              const rawNum = decodeURIComponent(cleanButtonId.replace("confirm_cod_", ""));
              relatedOrderNumber = rawNum.startsWith("#") ? rawNum : `#${rawNum}`;
            } else if (cleanButtonId.startsWith("confirm_address_")) {
              const rawNum = decodeURIComponent(cleanButtonId.replace("confirm_address_", ""));
              relatedOrderNumber = rawNum.startsWith("#") ? rawNum : `#${rawNum}`;
            } else if (cleanButtonId.startsWith("update_address_")) {
              const rawNum = decodeURIComponent(cleanButtonId.replace("update_address_", ""));
              relatedOrderNumber = rawNum.startsWith("#") ? rawNum : `#${rawNum}`;
            } else if (cleanButtonId.startsWith("support_query_") || cleanButtonId.startsWith("ask_query_")) {
              const rawNum = decodeURIComponent(cleanButtonId.replace("support_query_", "").replace("ask_query_", ""));
              relatedOrderNumber = rawNum.startsWith("#") ? rawNum : `#${rawNum}`;
            } else if (cleanButtonId.startsWith("cancel_cod_") || cleanButtonId.startsWith("cancel_order_")) {
              const rawNum = decodeURIComponent(cleanButtonId.replace("cancel_cod_", "").replace("cancel_order_", ""));
              relatedOrderNumber = rawNum.startsWith("#") ? rawNum : `#${rawNum}`;
            }

            // Strip emojis, punctuation and clean string for intent detection
            const cleanText = messageText.replace(/[\u{1F300}-\u{1FAD6}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, "").trim().toLowerCase();
            const cleanBtnId = buttonReplyId.replace(/[\u{1F300}-\u{1FAD6}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, "").trim().toLowerCase();

            // Handle Action Detection:
            const isConfirmAction =
              cleanBtnId.includes("confirm_order") ||
              cleanBtnId.includes("confirm_cod") ||
              cleanBtnId.includes("confirm_address") ||
              cleanBtnId.includes("confirm address") ||
              cleanBtnId.includes("confirm order") ||
              cleanText.includes("confirm address") ||
              cleanText.includes("confirm order") ||
              cleanText.includes("confirm my order") ||
              cleanText.includes("order confirmed") ||
              cleanText.includes("verify address") ||
              cleanText === "confirm" ||
              cleanText === "yes confirm" ||
              cleanText === "yes" ||
              lowerText === "✅ confirm address" ||
              lowerText === "✅ confirm cod order";

            const isUpdateAddressAction =
              cleanBtnId.includes("update_address") ||
              cleanBtnId.includes("update_addr") ||
              cleanBtnId.includes("change_address") ||
              cleanBtnId.includes("update address") ||
              cleanBtnId.includes("change address") ||
              cleanText.includes("update address") ||
              cleanText.includes("change address") ||
              cleanText.includes("edit address") ||
              cleanText.includes("wrong address") ||
              cleanText.includes("update delivery") ||
              cleanText.includes("change delivery") ||
              cleanText.includes("update mobile") ||
              cleanText.includes("new address") ||
              cleanText === "update" ||
              lowerText.includes("update address") ||
              lowerText.includes("change address");

            const isSupportAction =
              cleanBtnId.includes("support_query") ||
              cleanBtnId.includes("ask_query") ||
              cleanBtnId.includes("support") ||
              cleanBtnId.includes("help") ||
              cleanText.includes("ask query") ||
              cleanText.includes("need help") ||
              cleanText.includes("contact support") ||
              cleanText.includes("talk to agent") ||
              cleanText.includes("human support") ||
              cleanText === "query" ||
              cleanText === "help" ||
              lowerText.includes("ask query") ||
              lowerText.includes("need help");

            const isCancelAction =
              cleanBtnId.includes("cancel_cod") ||
              cleanBtnId.includes("cancel_order") ||
              cleanBtnId.includes("cancel") ||
              cleanText.includes("cancel order") ||
              cleanText.includes("cancel my order") ||
              cleanText === "cancel" ||
              lowerText.includes("cancel order");

            // Find matching OrderConfirmation record with exhaustive multi-tiered fallback
            let matchingOrder: any = null;

            if (relatedOrderNumber) {
              const rawNum = relatedOrderNumber.trim();
              const withHash = rawNum.startsWith("#") ? rawNum : `#${rawNum}`;
              const withoutHash = rawNum.replace(/^#/, "");

              // A. Exact match with/without hash
              matchingOrder = await db.orderConfirmation.findFirst({
                where: {
                  merchantId: merchant.id,
                  OR: [
                    { orderNumber: rawNum },
                    { orderNumber: withHash },
                    { orderNumber: withoutHash },
                  ],
                },
                orderBy: { createdAt: "desc" },
              });

              // B. Alphanumeric match (handles stripped hyphens e.g. TEST1277 matching #TEST-1277)
              if (!matchingOrder) {
                const alphaOnly = rawNum.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
                if (alphaOnly) {
                  const recentOrders = await db.orderConfirmation.findMany({
                    where: { merchantId: merchant.id, customerPhone: fromPhone },
                    orderBy: { createdAt: "desc" },
                    take: 10,
                  });
                  matchingOrder = recentOrders.find(
                    (o) => o.orderNumber.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() === alphaOnly
                  ) || null;
                }
              }
            }

            // C. Fallback: Find most relevant order for this customer phone
            if (!matchingOrder) {
              // Prioritize actionable orders (PENDING or UPDATE_REQUESTED)
              matchingOrder = await db.orderConfirmation.findFirst({
                where: {
                  merchantId: merchant.id,
                  customerPhone: fromPhone,
                  status: { in: ["PENDING", "UPDATE_REQUESTED", "QUERY_REQUESTED"] },
                },
                orderBy: { createdAt: "desc" },
              });

              // If no pending, look for most recent order
              if (!matchingOrder) {
                matchingOrder = await db.orderConfirmation.findFirst({
                  where: { merchantId: merchant.id, customerPhone: fromPhone },
                  orderBy: { createdAt: "desc" },
                });
              }

              // Also check with last 10 digits for country code variations (e.g. 919328335600 vs 9328335600)
              if (!matchingOrder && fromPhone.length >= 10) {
                const shortPhone = fromPhone.slice(-10);
                matchingOrder = await db.orderConfirmation.findFirst({
                  where: {
                    merchantId: merchant.id,
                    customerPhone: { contains: shortPhone },
                  },
                  orderBy: { createdAt: "desc" },
                });
              }
            }

            if (matchingOrder && !relatedOrderNumber) {
              relatedOrderNumber = matchingOrder.orderNumber;
            }

            // Check if there is an active order specifically waiting for the customer to type their new address
            const shortPhone = fromPhone.length >= 10 ? fromPhone.slice(-10) : fromPhone;
            const awaitingAddressOrder = await db.orderConfirmation.findFirst({
              where: {
                merchantId: merchant.id,
                OR: [
                  { customerPhone: fromPhone },
                  { customerPhone: { contains: shortPhone } },
                ],
                status: "UPDATE_REQUESTED",
              },
              orderBy: { updatedAt: "desc" },
            });

            let handledSpecificAction = false;

            if (isConfirmAction && matchingOrder) {
              handledSpecificAction = true;
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
              handledSpecificAction = true;
              // 1. Mark Order as UPDATE_REQUESTED (awaiting customer address input)
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
              handledSpecificAction = true;
              if (matchingOrder && matchingOrder.status === "PENDING") {
                await db.orderConfirmation.update({
                  where: { id: matchingOrder.id },
                  data: { status: "QUERY_REQUESTED" },
                });
                syncOrderUpdateToShopify({
                  shop: merchant.shop,
                  orderId: matchingOrder.orderId,
                  orderNumber: matchingOrder.orderNumber,
                  status: "QUERY_REQUESTED",
                }).catch((err) => console.warn("Shopify order sync notice:", err));
              }

              const supportReplyText = `💬 *Support Request Received${matchingOrder ? ` for ${matchingOrder.orderNumber}` : ""}*\n\nOur customer support team has been notified and will assist you right here in chat. Please reply with any questions or details you need help with! 😊`;

              await sendWhatsAppMessage({
                merchantId: merchant.id,
                recipientPhone: fromPhone,
                customerName: profileName || matchingOrder?.customerName || "Customer",
                eventType: "SUPPORT_AUTO_REPLY",
                bodyText: supportReplyText,
                senderRole: "BOT",
              });
            } else if (isCancelAction && matchingOrder) {
              handledSpecificAction = true;
              await db.orderConfirmation.update({
                where: { id: matchingOrder.id },
                data: { status: "CANCELLED" },
              });
              syncOrderUpdateToShopify({
                shop: merchant.shop,
                orderId: matchingOrder.orderId,
                orderNumber: matchingOrder.orderNumber,
                status: "CANCELLED",
              }).catch((err) => console.warn("Shopify order sync notice:", err));

              const cancelReplyText = `❌ *Cancellation Request Received for ${matchingOrder.orderNumber}*\n\nWe have recorded your request to cancel order *${matchingOrder.orderNumber}*. Our support team has been notified and will update your order status shortly.`;

              await sendWhatsAppMessage({
                merchantId: merchant.id,
                recipientPhone: fromPhone,
                customerName: profileName || matchingOrder.customerName || "Customer",
                eventType: "ORDER_CONFIRM_REPLY",
                bodyText: cancelReplyText,
                senderRole: "BOT",
              });
            } else if (awaitingAddressOrder && !isInteractiveOrButton && (msgType === "TEXT" || msgType === "text" || !buttonReplyId)) {
              // Customer previously requested an address update and has now replied with their new address text!
              handledSpecificAction = true;

              // 1. Save customer's updated address notes and CLOSE the address update state -> ADDRESS_UPDATED
              await db.orderConfirmation.update({
                where: { id: awaitingAddressOrder.id },
                data: {
                  customerNotes: messageText,
                  status: "ADDRESS_UPDATED", // Flow is now COMPLETED / CLOSED!
                },
              });

              // 2. Immediately Push Customer's Address/Mobile Note into Shopify Admin Order!
              await syncOrderUpdateToShopify({
                shop: merchant.shop,
                orderId: awaitingAddressOrder.orderId,
                orderNumber: awaitingAddressOrder.orderNumber,
                status: "ADDRESS_UPDATED",
                customerNotes: messageText,
              }).catch((err) => console.warn("Shopify order sync note notice:", err));

              // 3. Auto-acknowledge receipt and close the update prompt flow
              const ackText = `✅ *Thank you!*\n\nWe have received your updated details:\n_"${messageText}"_\n\nOur team has updated this on Order *${awaitingAddressOrder.orderNumber}*. If you have any further questions, feel free to ask! 😊`;
              await sendWhatsAppMessage({
                merchantId: merchant.id,
                recipientPhone: fromPhone,
                customerName: profileName || awaitingAddressOrder.customerName || "Customer",
                eventType: "ADDRESS_SAVED_ACK",
                bodyText: ackText,
                senderRole: "BOT",
              });
            }

            // Upsert Conversation in Live Inbox & Set Support Queue Status
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
                status: "NEEDS_REPLY", // Added to Support Queue
                cswExpiresAt,
              },
              update: {
                customerName: profileName || matchingOrder?.customerName || undefined,
                lastOrderNumber: relatedOrderNumber || undefined,
                lastOrderId: matchingOrder?.orderId || undefined,
                lastMessageText: messageText,
                lastMessageAt: new Date(),
                unreadCount: { increment: 1 },
                status: "NEEDS_REPLY", // Flagged for Agent Attention
                cswExpiresAt,
              },
            });

            // Insert Customer ChatMessage into database
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

            // 🤖 Automatic Support Greeting Flow (Flow 7)
            if (!handledSpecificAction && (merchant.supportChatEnabled ?? true)) {
              // Check if a bot auto-reply was sent recently (last 15 minutes) to avoid spamming multiple fast messages
              const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);
              const recentBotMessage = await db.chatMessage.findFirst({
                where: {
                  conversationId: conversation.id,
                  sender: "BOT",
                  createdAt: { gte: fifteenMinAgo },
                },
              });

              if (!recentBotMessage) {
                // Find or fallback to SUPPORT_AUTO_REPLY template
                let tpl = await db.template.findFirst({
                  where: { merchantId: merchant.id, eventType: "SUPPORT_AUTO_REPLY", isActive: true },
                });

                const storeDisplayName = merchant.name || merchant.shop.replace(".myshopify.com", "");
                const validProfileName = (profileName && profileName.trim() !== "." && profileName.trim() !== "-") ? profileName.trim() : null;
                const rawCustomerName = validProfileName || matchingOrder?.customerName || null;
                const customerDisplayName = rawCustomerName || "there";
                const knownOrder = matchingOrder?.orderNumber ? matchingOrder : null;

                let greetingBody: string;
                let greetingHeader = `👋 Welcome to ${storeDisplayName} Support`;
                let greetingFooter = `${storeDisplayName} Live Support`;

                if (tpl) {
                  greetingBody = interpolateVariables(tpl.bodyText, {
                    customer_name: customerDisplayName,
                    store_name: storeDisplayName,
                    order_number: relatedOrderNumber ? relatedOrderNumber.replace(/^#/, "") : "",
                    order_name: relatedOrderNumber || "",
                  });
                  if (tpl.headerText) {
                    greetingHeader = interpolateVariables(tpl.headerText, {
                      customer_name: customerDisplayName,
                      store_name: storeDisplayName,
                    });
                  }
                  if (tpl.footerText) {
                    greetingFooter = interpolateVariables(tpl.footerText, {
                      store_name: storeDisplayName,
                    });
                  }
                } else {
                  // Dynamic Adaptive Default Greeting based on available customer context
                  if (knownOrder) {
                    // Scenario 1: Customer has an existing Order on file
                    if (rawCustomerName) {
                      greetingBody = `Hi ${rawCustomerName}! 👋 Thank you for reaching out to *${storeDisplayName}* support. 😊\n\nOur customer support team has received your message regarding Order *${knownOrder.orderNumber}* and an agent will connect with you shortly.\n\n_How can we assist you today?_`;
                    } else {
                      greetingBody = `Hello! 👋 Thank you for reaching out to *${storeDisplayName}* support. 😊\n\nOur customer support team has received your message regarding Order *${knownOrder.orderNumber}* and an agent will connect with you shortly.\n\n_How can we assist you today?_`;
                    }
                  } else if (rawCustomerName) {
                    // Scenario 2: Known Customer Name (from WhatsApp profile), but no order
                    greetingBody = `Hi ${rawCustomerName}! 👋 Welcome to *${storeDisplayName}*. 😊\n\nOur customer support team has received your message and an agent will connect with you shortly.\n\n_How can we help you today?_`;
                  } else {
                    // Scenario 3: Simple, Clean Message for New / Unknown Customer (No Order & No Profile Name)
                    greetingBody = `Hello! 👋 Welcome to *${storeDisplayName}*. 😊\n\nOur customer support team has received your message and an agent will connect with you shortly.\n\n_How can we help you today?_`;
                  }
                }

                // Dispatch WhatsApp Greeting
                const botSendRes = await sendWhatsAppMessage({
                  merchantId: merchant.id,
                  recipientPhone: fromPhone,
                  customerName: customerDisplayName,
                  eventType: "SUPPORT_AUTO_REPLY",
                  bodyText: greetingBody,
                  headerType: "TEXT",
                  headerText: greetingHeader,
                  footerText: greetingFooter,
                  senderRole: "BOT",
                });

                if (botSendRes.success) {
                  // Save Bot's message in Chat history
                  await db.chatMessage.create({
                    data: {
                      conversationId: conversation.id,
                      sender: "BOT",
                      messageType: "TEXT",
                      bodyText: greetingBody,
                      metaMessageId: botSendRes.messageId || null,
                      status: "DELIVERED",
                    },
                  });

                  // Record Job in Queue so Automations tab shows the completed event
                  await db.job.create({
                    data: {
                      merchantId: merchant.id,
                      jobType: "SEND_WHATSAPP",
                      status: "COMPLETED",
                      processedAt: new Date(),
                      payload: {
                        eventType: "SUPPORT_AUTO_REPLY",
                        recipientPhone: fromPhone,
                        customerName: customerDisplayName,
                      },
                    },
                  }).catch(() => {});
                }
              }
            }

            await logInfo(`Incoming WhatsApp message from +${fromPhone}: "${messageText.slice(0, 100)}" (Status: NEEDS_REPLY)`, {
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

    const durationMs = Date.now() - webhookStartTime;
    await logMetaApiCall({
      merchantId: lastMerchantId,
      endpoint: "WEBHOOK: /api/meta/webhook",
      httpMethod: "POST",
      statusCode: 200,
      durationMs,
      status: "SUCCESS",
      requestPayload: rawBody,
      responseBody: { status: "EVENT_RECEIVED" },
      initiatedBy: "META_WEBHOOK",
    });

    return new Response("EVENT_RECEIVED", { status: 200 });
  } catch (err: any) {
    const durationMs = Date.now() - webhookStartTime;
    await logMetaApiCall({
      merchantId: lastMerchantId,
      endpoint: "WEBHOOK: /api/meta/webhook",
      httpMethod: "POST",
      statusCode: 500,
      durationMs,
      status: "FAILED",
      requestPayload: rawBody,
      errorMessage: err?.message || String(err),
      initiatedBy: "META_WEBHOOK",
    });
    await logWarn(`Meta Webhook processing error: ${err.message}`, { source: "meta-webhook" });
    return new Response("EVENT_RECEIVED", { status: 200 });
  }
};
