import crypto from "crypto";
import db from "../db.server";
import { decryptToken } from "./encryption.server";
import { logInfo, logWarn, logError } from "./logger.server";
import { maskPhoneNumber } from "./phone.utils";

const META_GRAPH_VERSION = "v21.0";
const META_BASE_URL = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

/**
 * Computes the required HMAC-SHA256 appsecret_proof for Meta Graph API calls.
 */
export function generateAppSecretProof(accessToken: string): string {
  const secret = process.env.META_APP_SECRET || "";
  return crypto.createHmac("sha256", secret).update(accessToken).digest("hex");
}

export interface SendWhatsAppMessageOptions {
  merchantId: string;
  recipientPhone: string;
  customerName?: string;
  eventType: string;
  bodyText: string;
  headerType?: string | null;
  headerText?: string | null;
  headerMediaUrl?: string | null;
  footerText?: string | null;
  buttonType?: string | null;
  buttonText?: string | null;
  buttonUrl?: string | null;
}

/**
 * Sends an outbound WhatsApp message via Meta Cloud API using the merchant's connected WABA & Phone Number.
 * Automatically catches limits, rate limits, and payment required errors, triggering dashboard alert banners.
 */
export async function sendWhatsAppMessage(options: SendWhatsAppMessageOptions) {
  const {
    merchantId,
    recipientPhone,
    customerName,
    eventType,
    bodyText,
    headerType,
    headerText,
    headerMediaUrl,
    footerText,
    buttonType,
    buttonText,
    buttonUrl,
  } = options;

  const merchant = await db.merchant.findUnique({
    where: { id: merchantId },
  });

  if (!merchant || !merchant.isWhatsAppConnected || !merchant.phoneNumberId || !merchant.waAccessToken) {
    const errorMsg = "Merchant WhatsApp account is not connected or missing credentials.";
    await logWarn(errorMsg, { shop: merchant?.shop, source: "meta-whatsapp" });
    return { success: false, error: errorMsg };
  }

  const plainAccessToken = decryptToken(merchant.waAccessToken);
  const appSecretProof = generateAppSecretProof(plainAccessToken);

  // Check rolling 24-hour limit count
  const now = new Date();
  const resetTime = new Date(merchant.dailyLimitResetAt);
  let currentDailyCount = merchant.dailySentCount;

  // Reset daily counter if 24 hours have elapsed
  if (now.getTime() - resetTime.getTime() > 24 * 60 * 60 * 1000) {
    currentDailyCount = 0;
    await db.merchant.update({
      where: { id: merchantId },
      data: {
        dailySentCount: 0,
        dailyLimitResetAt: now,
        alertType: merchant.alertType === "LIMIT_EXCEEDED" ? "NONE" : merchant.alertType,
        alertMessage: merchant.alertType === "LIMIT_EXCEEDED" ? null : merchant.alertMessage,
      },
    });
  }

  // Build Meta Cloud API Payload
  let payload: any = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipientPhone,
    type: "text",
    text: {
      preview_url: true,
      body: bodyText,
    },
  };

  // If interactive button or media is provided
  if (buttonType === "CTA_URL" && buttonUrl && buttonText) {
    payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipientPhone,
      type: "interactive",
      interactive: {
        type: "cta_url",
        ...(headerType === "TEXT" && headerText ? { header: { type: "text", text: headerText } } : {}),
        ...(headerType === "IMAGE" && headerMediaUrl ? { header: { type: "image", image: { link: headerMediaUrl } } } : {}),
        body: { text: bodyText },
        ...(footerText ? { footer: { text: footerText } } : {}),
        action: {
          name: "cta_url",
          parameters: {
            display_text: buttonText.slice(0, 20),
            url: buttonUrl,
          },
        },
      },
    };
  } else if (buttonType === "QUICK_REPLY" && buttonText) {
    payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipientPhone,
      type: "interactive",
      interactive: {
        type: "button",
        ...(headerType === "TEXT" && headerText ? { header: { type: "text", text: headerText } } : {}),
        ...(headerType === "IMAGE" && headerMediaUrl ? { header: { type: "image", image: { link: headerMediaUrl } } } : {}),
        body: { text: bodyText },
        ...(footerText ? { footer: { text: footerText } } : {}),
        action: {
          buttons: [
            {
              type: "reply",
              reply: {
                id: `qr_${eventType.toLowerCase()}`,
                title: buttonText.slice(0, 20),
              },
            },
          ],
        },
      },
    };
  }

  const endpoint = `${META_BASE_URL}/${merchant.phoneNumberId}/messages?appsecret_proof=${appSecretProof}`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${plainAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = (await res.json()) as any;

    if (!res.ok || data.error) {
      const errorCode = data.error?.code;
      const errorSubcode = data.error?.error_subcode;
      const errorMessage = data.error?.message || "Unknown Meta API error";

      await logError(`Meta WhatsApp send failed [Error ${errorCode}]: ${errorMessage}`, {
        shop: merchant.shop,
        source: "meta-whatsapp",
        details: { errorCode, errorSubcode, recipient: maskPhoneNumber(recipientPhone) },
      });

      // Handle Meta Messaging Limits & Payment Required Errors
      let detectedAlert: string | null = null;
      let alertMsg: string | null = null;

      if (errorCode === 131048 || errorSubcode === 2494010) {
        // Payment required in Meta Business Manager
        detectedAlert = "PAYMENT_REQUIRED";
        alertMsg = "Your Meta WhatsApp Business account requires a valid payment method. Please add a credit/debit card in your Meta Business Portfolio to continue sending messages.";
      } else if (errorCode === 130429 || errorCode === 131056 || errorSubcode === 2494008) {
        // Daily Tier limit reached
        detectedAlert = "LIMIT_EXCEEDED";
        alertMsg = `You have reached your 24-hour WhatsApp messaging tier limit (${merchant.messagingLimit}). Messages will resume once your rolling limit resets.`;
      }

      if (detectedAlert) {
        await db.merchant.update({
          where: { id: merchantId },
          data: {
            alertType: detectedAlert,
            alertMessage: alertMsg,
          },
        });
      }

      // Log failure in MessageLog
      await db.messageLog.create({
        data: {
          merchantId,
          recipientPhone: maskPhoneNumber(recipientPhone),
          customerName: customerName || null,
          eventType,
          status: "FAILED",
          errorMessage: `${errorMessage} (Code ${errorCode})`,
        },
      });

      return { success: false, error: errorMessage, errorCode };
    }

    const messageId = data.messages?.[0]?.id;

    // Increment daily sent count
    await db.merchant.update({
      where: { id: merchantId },
      data: {
        dailySentCount: { increment: 1 },
      },
    });

    // Record success in MessageLog
    await db.messageLog.create({
      data: {
        merchantId,
        recipientPhone: maskPhoneNumber(recipientPhone),
        customerName: customerName || null,
        eventType,
        metaMessageId: messageId,
        status: "SENT",
      },
    });

    await logInfo(`WhatsApp message dispatched successfully to ${maskPhoneNumber(recipientPhone)}`, {
      shop: merchant.shop,
      source: "meta-whatsapp",
      details: { messageId, eventType },
    });

    return { success: true, messageId };
  } catch (err: any) {
    await logError(`Exception during Meta WhatsApp message dispatch: ${err.message}`, {
      shop: merchant.shop,
      source: "meta-whatsapp",
    });

    return { success: false, error: err.message };
  }
}

/**
 * Queries Meta Graph API to fetch live WABA health, quality rating, and messaging limits.
 */
export async function refreshWabaHealth(merchantId: string) {
  const merchant = await db.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant || !merchant.phoneNumberId || !merchant.waAccessToken) return null;

  const plainAccessToken = decryptToken(merchant.waAccessToken);
  const appSecretProof = generateAppSecretProof(plainAccessToken);

  try {
    const res = await fetch(
      `${META_BASE_URL}/${merchant.phoneNumberId}?fields=verified_name,display_phone_number,quality_rating,messaging_limit_tier&appsecret_proof=${appSecretProof}`,
      {
        headers: { Authorization: `Bearer ${plainAccessToken}` },
      }
    );

    const data = (await res.json()) as any;
    if (res.ok && !data.error) {
      const qualityRating = data.quality_rating || "UNKNOWN";
      const messagingLimit = data.messaging_limit_tier || "TIER_250";

      let alertType = merchant.alertType;
      let alertMessage = merchant.alertMessage;

      if (qualityRating === "RED") {
        alertType = "QUALITY_FLAGGED";
        alertMessage = "Your WhatsApp Business number quality rating is flagged as RED by Meta. High customer blocks or spam reports may suspend your account.";
      } else if (alertType === "QUALITY_FLAGGED") {
        alertType = "NONE";
        alertMessage = null;
      }

      await db.merchant.update({
        where: { id: merchantId },
        data: {
          qualityRating,
          messagingLimit,
          alertType,
          alertMessage,
        },
      });

      return { qualityRating, messagingLimit };
    }
  } catch (err: any) {
    await logWarn(`Failed to refresh WABA health: ${err.message}`, { shop: merchant.shop, source: "meta-whatsapp" });
  }

  return null;
}
