import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { enqueueJob, cancelCartRecoveryJobs, processPendingJobs } from "../utils/queue.server";
import { normalizePhoneNumber } from "../utils/phone.utils";
import { logInfo, logWarn } from "../utils/logger.server";
import { logShopifyApiCall } from "../utils/shopify-audit.server";
import { action as metaAction, loader as metaLoader } from "./api.meta.webhook";

/**
 * Handles Meta Webhook Verification Handshake if Meta developer portal is pointed to /webhooks
 */
export const loader = async (args: LoaderFunctionArgs) => {
  const url = new URL(args.request.url);
  if (url.searchParams.get("hub.mode") || url.searchParams.get("hub.verify_token")) {
    return metaLoader(args);
  }
  return new Response("Webhook endpoint ready", { status: 200 });
};

export const action = async (args: ActionFunctionArgs) => {
  const { request } = args;

  // Case-insensitive check for Shopify webhook headers
  const isShopify =
    request.headers.get("x-shopify-topic") ||
    request.headers.get("X-Shopify-Topic") ||
    request.headers.get("x-shopify-hmac-sha256") ||
    request.headers.get("X-Shopify-Hmac-Sha256");

  if (!isShopify) {
    return metaAction(args);
  }

  let topic = "UNKNOWN";
  let shop = "";
  let payload: any = {};

  try {
    const auth = await authenticate.webhook(request);
    topic = auth.topic;
    shop = auth.shop;
    payload = auth.payload;
  } catch (authErr: any) {
    await logWarn(`Shopify webhook auth notice: ${authErr.message}`, { source: "webhook" });
    return new Response("OK", { status: 200 });
  }

  if (!shop) {
    return new Response("OK", { status: 200 });
  }

  const normalizedTopic = (topic || "").toUpperCase().replace(/[\/\.]/g, "_");

  let merchant = await db.merchant.findUnique({
    where: { shop },
  });

  if (!merchant) {
    merchant = await db.merchant.create({
      data: {
        shop,
        name: shop.replace(".myshopify.com", ""),
      },
    });
  }

  const startTime = Date.now();
  const webhookId = request.headers.get("x-shopify-webhook-id") || request.headers.get("X-Shopify-Webhook-Id");
  const apiVersion = request.headers.get("x-shopify-api-version") || request.headers.get("X-Shopify-Api-Version") || "2025-01";

  if (!merchant.isWhatsAppConnected) {
    const durationMs = Date.now() - startTime;
    await logShopifyApiCall({
      merchantId: merchant.id,
      shop,
      topic: normalizedTopic,
      apiType: "WEBHOOK",
      httpMethod: "POST",
      statusCode: 200,
      durationMs,
      status: "IGNORED",
      webhookId,
      apiVersion,
      requestPayload: payload,
      responseBody: { status: "IGNORED", reason: "WhatsApp disconnected" },
      initiatedBy: "SHOPIFY_WEBHOOK",
    });
    await logWarn(`Webhook ${normalizedTopic} received for ${shop} but WhatsApp is not connected.`, { shop, source: "webhook" });
    return new Response("Merchant not active or WhatsApp disconnected", { status: 200 });
  }

  const data = payload as any;

  try {
    switch (normalizedTopic) {
      // 🛒 Abandoned Checkout Created / Updated
      case "CHECKOUTS_CREATE":
      case "CHECKOUTS_UPDATE": {
        if (!merchant.cartRecoveryEnabled) break;

        const rawCustomerPhone =
          data.phone ||
          data.customer?.phone ||
          data.shipping_address?.phone ||
          data.billing_address?.phone ||
          data.customer?.default_address?.phone ||
          (Array.isArray(data.customer?.addresses) ? data.customer.addresses.find((a: any) => a?.phone)?.phone : null) ||
          (Array.isArray(data.note_attributes) ? data.note_attributes.find((na: any) => na?.name && /phone|mobile|whatsapp/i.test(na.name))?.value : null) ||
          (Array.isArray(data.custom_attributes) ? data.custom_attributes.find((na: any) => na?.name && /phone|mobile|whatsapp/i.test(na.name))?.value : null);

        const customerPhone = normalizePhoneNumber(rawCustomerPhone);
        if (!customerPhone) break;

        const checkoutToken = data.token;
        if (!checkoutToken) break;

        // Extract cart items summary
        const lineItems = (data.line_items || []).map((item: any) => ({
          title: item.title,
          quantity: item.quantity,
          price: item.price,
          image: item.image_url,
        }));
        const cartItemsSummary = lineItems.map((i: any) => `${i.title} (x${i.quantity})`).join(", ");
        const cartTotal = parseFloat(data.total_price || "0");
        const customerName = data.customer?.first_name || data.shipping_address?.first_name || "there";
        const checkoutUrl = data.abandoned_checkout_url || `https://${shop}/checkout`;

        // Calculate checkout recovery URL with fixed discount if applicable
        const isFixedDiscount = merchant.cartRecoveryStrategy === "FIXED_CODE" && merchant.cartDiscountCode;
        const baseCheckoutUrl = checkoutUrl;
        const fixedDiscountCheckoutUrl = isFixedDiscount
          ? `${baseCheckoutUrl}${baseCheckoutUrl.includes("?") ? "&" : "?"}discount=${encodeURIComponent(merchant.cartDiscountCode!)}`
          : baseCheckoutUrl;

        // Record CartRecovery record
        await db.cartRecovery.upsert({
          where: { checkoutToken },
          create: {
            merchantId: merchant.id,
            checkoutToken,
            shopifyCartId: data.cart_token || null,
            customerName,
            customerPhone,
            cartTotal,
            currency: data.currency || merchant.currency,
            lineItems: lineItems as any,
            checkoutUrl: baseCheckoutUrl,
            discountCode: isFixedDiscount ? merchant.cartDiscountCode : null,
            status: "PENDING",
          },
          update: {
            cartTotal,
            lineItems: lineItems as any,
            checkoutUrl: baseCheckoutUrl,
          },
        });

        // 1. Enqueue Step 1 (Gentle Reminder, e.g. after cartDelay1 = 30 minutes)
        if (merchant.cartStep1Enabled !== false) {
          await enqueueJob(
            merchant.id,
            "CART_RECOVERY",
            {
              recipientPhone: customerPhone,
              customerName,
              eventType: "CART_RECOVERY_1",
              checkoutToken,
              templateVariables: {
                customer_name: customerName,
                cart_items: cartItemsSummary || "Selected items",
                total_amount: cartTotal.toFixed(2),
                currency: data.currency || merchant.currency,
                checkout_url: baseCheckoutUrl,
                store_name: merchant.name || shop.replace(".myshopify.com", ""),
                discount_code: "",
              },
            },
            merchant.cartDelay1 || 30
          );
        }

        // 2. Enqueue Step 2 (Discount Follow-up, e.g. after cartDelay2 = 360 minutes / 6 hours)
        // Only enqueued if strategy is NOT REMINDER_ONLY and Step 2 is enabled
        const shouldEnqueueStep2 =
          merchant.cartRecoveryStrategy !== "REMINDER_ONLY" && merchant.cartStep2Enabled !== false;

        if (shouldEnqueueStep2) {
          await enqueueJob(
            merchant.id,
            "CART_RECOVERY",
            {
              recipientPhone: customerPhone,
              customerName,
              eventType: "CART_RECOVERY_2",
              checkoutToken,
              templateVariables: {
                customer_name: customerName,
                cart_items: cartItemsSummary || "Selected items",
                total_amount: cartTotal.toFixed(2),
                currency: data.currency || merchant.currency,
                checkout_url: fixedDiscountCheckoutUrl,
                store_name: merchant.name || shop.replace(".myshopify.com", ""),
                discount_code: isFixedDiscount ? merchant.cartDiscountCode || "SAVE10" : "10% OFF",
              },
            },
            merchant.cartDelay2 || 360
          );
        }

        await logInfo(
          `Scheduled abandoned cart recovery for checkout ${checkoutToken} (Strategy: ${merchant.cartRecoveryStrategy}, Step 1: ${merchant.cartStep1Enabled !== false ? `${merchant.cartDelay1}m` : "OFF"}, Step 2: ${shouldEnqueueStep2 ? `${merchant.cartDelay2}m` : "OFF"})`,
          {
            shop,
            source: "webhook",
          }
        );
        break;
      }

      // 📦 Order Created -> Cancel cart recovery & Trigger Order / COD Address Confirmation
      case "ORDERS_CREATE": {
        const orderId = String(data.id);
        const rawOrderNum = String(data.order_number || data.name || data.id);
        const orderNumber = rawOrderNum.startsWith("#") ? rawOrderNum : `#${rawOrderNum}`;

        // Cancel any pending cart recoveries for this customer
        const checkoutToken = data.checkout_token || data.token;
        if (checkoutToken) {
          await cancelCartRecoveryJobs(merchant.id, checkoutToken);
        }

        if (!merchant.orderConfirmEnabled) break;

        const rawCustomerPhone =
          data.phone ||
          data.customer?.phone ||
          data.shipping_address?.phone ||
          data.billing_address?.phone ||
          data.customer?.default_address?.phone ||
          (Array.isArray(data.customer?.addresses) ? data.customer.addresses.find((a: any) => a?.phone)?.phone : null) ||
          (Array.isArray(data.note_attributes) ? data.note_attributes.find((na: any) => na?.name && /phone|mobile|whatsapp/i.test(na.name))?.value : null) ||
          (Array.isArray(data.custom_attributes) ? data.custom_attributes.find((na: any) => na?.name && /phone|mobile|whatsapp/i.test(na.name))?.value : null);

        const customerPhone = normalizePhoneNumber(rawCustomerPhone);
        if (!customerPhone) {
          await logWarn(`Order ${orderNumber} created but no valid phone found across order/shipping/billing/note fields.`, { shop, source: "webhook" });
          break;
        }

        const isCOD = (data.payment_gateway_names || []).some(
          (g: string) => /cash|cod|manual/i.test(g)
        ) || data.financial_status === "pending";

        const customerName = data.customer?.first_name || data.shipping_address?.first_name || "Customer";
        const addr = data.shipping_address || data.billing_address || {};
        const addressParts = [
          addr.name || customerName,
          addr.address1,
          addr.address2,
          addr.city,
          addr.province,
          addr.zip,
          addr.country,
        ].filter(Boolean);
        const shippingAddress = addressParts.length > 0 ? addressParts.join(", ") : "Customer Delivery Address";
        const lineItems = (data.line_items || []).map((i: any) => `${i.title} (x${i.quantity})`).join(", ");
        const totalAmount = parseFloat(data.total_price || "0").toFixed(2);

        // Store OrderConfirmation tracking record
        try {
          await db.orderConfirmation.upsert({
            where: {
              merchantId_orderNumber: {
                merchantId: merchant.id,
                orderNumber,
              },
            },
            create: {
              merchantId: merchant.id,
              orderId,
              orderNumber,
              customerPhone,
              customerName,
              totalAmount,
              currency: data.currency || merchant.currency || "INR",
              shippingAddress,
              itemsSummary: lineItems,
              status: "PENDING",
              lastSentAt: new Date(),
            },
            update: {
              orderNumber,
              customerPhone,
              customerName,
              totalAmount,
              currency: data.currency || merchant.currency || "INR",
              shippingAddress,
              itemsSummary: lineItems,
              lastSentAt: new Date(),
            },
          });
        } catch (dbErr: any) {
          console.warn("OrderConfirmation record creation notice:", dbErr);
        }

        // Determine event type: COD vs Prepaid
        const eventType = isCOD && merchant.codVerificationEnabled
          ? "COD_CONFIRM"
          : "ORDER_CONFIRM_ADDRESS";

        await enqueueJob(
          merchant.id,
          "SEND_WHATSAPP",
          {
            eventType,
            recipientPhone: customerPhone,
            customerName,
            orderId,
            orderNumber,
            templateVariables: {
              customer_name: customerName,
              order_number: orderNumber.replace(/^#/, ""),
              order_name: orderNumber,
              total_amount: totalAmount,
              currency: data.currency || merchant.currency || "INR",
              shipping_address: shippingAddress,
              items: lineItems,
              customer_phone: customerPhone,
              store_name: merchant.name || shop.replace(".myshopify.com", ""),
            },
          },
          0 // Immediate 0-delay delivery
        );

        await logInfo(`Enqueued ${eventType} notification for Order ${orderNumber} to +${customerPhone}`, { shop, source: "webhook" });

        // Process pending jobs immediately in background
        try {
          await processPendingJobs(10);
        } catch (procErr: any) {
          console.warn("Immediate order confirmation job processing error:", procErr);
        }
        break;
      }

      // 🚚 Order Shipped / Fulfilled / Tracking Update
      case "ORDERS_FULFILLED":
      case "FULFILLMENTS_CREATE":
      case "FULFILLMENTS_UPDATE": {
        const orderId = String(data.order_id || data.id);
        const orderNumber = String(data.order_number || data.name || `#${orderId}`);

        const rawCustomerPhone =
          data.destination?.phone ||
          data.phone ||
          data.customer?.phone ||
          data.shipping_address?.phone ||
          data.billing_address?.phone ||
          data.customer?.default_address?.phone ||
          (Array.isArray(data.customer?.addresses) ? data.customer.addresses.find((a: any) => a?.phone)?.phone : null);

        let customerPhone = normalizePhoneNumber(rawCustomerPhone);

        // If phone is missing in fulfillment payload, look up in OrderConfirmation record
        if (!customerPhone) {
          const savedOrder = await db.orderConfirmation.findFirst({
            where: { merchantId: merchant.id, orderId },
          });
          if (savedOrder) customerPhone = savedOrder.customerPhone;
        }

        if (!customerPhone) break;

        const customerName = data.destination?.first_name || data.customer?.first_name || data.shipping_address?.first_name || "Customer";
        const trackingCompany = data.tracking_company || (data.tracking_numbers && data.tracking_numbers.length > 0 ? "Courier Partner" : "");
        const trackingNumber = data.tracking_number || (data.tracking_numbers && data.tracking_numbers[0]) || "";
        const trackingUrl = data.tracking_url || (data.tracking_urls && data.tracking_urls[0]) || `https://${shop}/account/orders`;

        const isDelivered = data.shipment_status === "delivered";

        // Check which flow is triggered
        if (isDelivered && !merchant.orderDeliveredEnabled) break;
        if (!isDelivered && !merchant.orderShippedEnabled) break;

        const eventType = isDelivered ? "ORDER_DELIVERED" : "ORDER_SHIPPED";

        await enqueueJob(
          merchant.id,
          "SEND_WHATSAPP",
          {
            eventType,
            recipientPhone: customerPhone,
            customerName,
            orderId,
            orderNumber,
            templateVariables: {
              customer_name: customerName,
              order_number: orderNumber.replace(/^#/, ""),
              order_name: orderNumber,
              tracking_url: trackingUrl,
              tracking_number: trackingNumber || "Live Tracking Available",
              carrier: trackingCompany || "Courier",
              store_name: merchant.name || shop.replace(".myshopify.com", ""),
              discount_code: "VIP10",
            },
          },
          0 // Immediate
        );

        await logInfo(`Enqueued ${eventType} notification for Order #${orderNumber} to +${customerPhone}`, { shop, source: "webhook" });

        // Process immediately for instant customer delivery
        try {
          await processPendingJobs(10);
        } catch (procErr: any) {
          console.warn("Immediate fulfillment job processing error:", procErr);
        }
        break;
      }

      default:
        break;
    }

    const durationMs = Date.now() - startTime;
    await logShopifyApiCall({
      merchantId: merchant.id,
      shop,
      topic: normalizedTopic,
      apiType: "WEBHOOK",
      httpMethod: "POST",
      statusCode: 200,
      durationMs,
      status: "SUCCESS",
      webhookId,
      apiVersion,
      requestPayload: data,
      responseBody: { success: true, topic: normalizedTopic },
      initiatedBy: "SHOPIFY_WEBHOOK",
    });
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    await logShopifyApiCall({
      merchantId: merchant.id,
      shop,
      topic: normalizedTopic,
      apiType: "WEBHOOK",
      httpMethod: "POST",
      statusCode: 500,
      durationMs,
      status: "FAILED",
      webhookId,
      apiVersion,
      requestPayload: data,
      errorMessage: err?.message || String(err),
      initiatedBy: "SHOPIFY_WEBHOOK",
    });
    await logWarn(`Webhook execution error for ${topic}: ${err.message}`, { shop, source: "webhook" });
  }

  return new Response("Webhook processed", { status: 200 });
};
