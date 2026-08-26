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

/**
 * Registers the WhatsApp Business Phone Number with Meta Cloud API.
 * Required by Meta before sending any messages (Fixes #133010 Account not registered).
 */
export async function registerPhoneNumber(phoneNumberId: string, accessToken: string, pin: string = "123456") {
  const appSecretProof = generateAppSecretProof(accessToken);
  const endpoint = `${META_BASE_URL}/${phoneNumberId}/register?appsecret_proof=${appSecretProof}`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      pin,
    }),
  });

  const data = (await res.json()) as any;
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || "Failed to register WhatsApp phone number with Meta Cloud API.");
  }

  return data;
}

export interface SendWhatsAppMessageOptions {
  merchantId: string;
  recipientPhone: string;
  customerName?: string;
  eventType: string;
  bodyText?: string;
  templateName?: string;
  templateLanguage?: string;
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
 * Automatically handles #133010 registration, templates, limits, and payment error detection.
 */
export async function sendWhatsAppMessage(options: SendWhatsAppMessageOptions) {
  const {
    merchantId,
    recipientPhone,
    customerName,
    eventType,
    bodyText,
    templateName,
    templateLanguage = "en_US",
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
  let payload: any;

  if (templateName) {
    // Template Message (Mandatory for first business-initiated message outside 24h window)
    payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipientPhone,
      type: "template",
      template: {
        name: templateName,
        language: { code: templateLanguage },
      },
    };
  } else if (buttonType === "CTA_URL" && buttonUrl && buttonText) {
    payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipientPhone,
      type: "interactive",
      interactive: {
        type: "cta_url",
        ...(headerType === "TEXT" && headerText ? { header: { type: "text", text: headerText } } : {}),
        ...(headerType === "IMAGE" && headerMediaUrl ? { header: { type: "image", image: { link: headerMediaUrl } } } : {}),
        body: { text: bodyText || "Store notification" },
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
  } else {
    payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipientPhone,
      type: "text",
      text: {
        preview_url: true,
        body: bodyText || "Hello from StorePing!",
      },
    };
  }

  const endpoint = `${META_BASE_URL}/${merchant.phoneNumberId}/messages?appsecret_proof=${appSecretProof}`;

  async function executeSend(currentPayload: any): Promise<any> {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${plainAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(currentPayload),
    });

    const data = (await res.json()) as any;
    return { ok: res.ok, status: res.status, data };
  }

  try {
    let { ok, data } = await executeSend(payload);

    // Auto-Recovery 1: If phone number is not registered (#133010), auto-register and retry!
    if (!ok && data.error?.code === 133010) {
      try {
        await registerPhoneNumber(merchant.phoneNumberId, plainAccessToken);
        const retryResult = await executeSend(payload);
        ok = retryResult.ok;
        data = retryResult.data;
      } catch (regErr: any) {
        console.warn("Auto-registration attempt error:", regErr);
      }
    }

    // Auto-Recovery 2: If outside 24h window (#131047) or freeform text rejected, fallback to pre-approved hello_world template
    if (!ok && (data.error?.code === 131047 || data.error?.code === 132000 || data.error?.code === 132001 || !templateName)) {
      const templateFallbackPayload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipientPhone,
        type: "template",
        template: {
          name: "hello_world",
          language: { code: "en_US" },
        },
      };

      const fallbackResult = await executeSend(templateFallbackPayload);
      if (fallbackResult.ok) {
        ok = true;
        data = fallbackResult.data;
      }
    }

    if (!ok || data.error) {
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
        detectedAlert = "PAYMENT_REQUIRED";
        alertMsg = "Your Meta WhatsApp Business account requires a valid payment method. Please add a payment method in your Meta Business Portfolio to continue sending messages.";
      } else if (errorCode === 130429 || errorCode === 131056 || errorSubcode === 2494008) {
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
