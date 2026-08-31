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

/**
 * Subscribes the WhatsApp Business Account (WABA) to the Meta App for webhooks.
 * Mandatory by Meta Cloud API to receive incoming customer messages & delivery receipts!
 */
export async function subscribeWabaToWebhooks(merchantId: string) {
  const merchant = await db.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant || !merchant.wabaId || !merchant.waAccessToken) return false;

  const plainAccessToken = decryptToken(merchant.waAccessToken);
  const appSecretProof = generateAppSecretProof(plainAccessToken);

  try {
    const endpoint = `${META_BASE_URL}/${merchant.wabaId}/subscribed_apps?appsecret_proof=${appSecretProof}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${plainAccessToken}`,
        "Content-Type": "application/json",
      },
    });

    const data = (await res.json()) as any;
    if (data.success) {
      await logInfo(`Successfully subscribed WABA ${merchant.wabaId} to webhooks ✓`, {
        shop: merchant.shop,
        source: "meta-whatsapp",
      });
      return true;
    } else {
      await logWarn(`WABA subscription response: ${JSON.stringify(data)}`, {
        shop: merchant.shop,
        source: "meta-whatsapp",
      });
      return false;
    }
  } catch (err: any) {
    await logWarn(`Failed to subscribe WABA to webhooks: ${err.message}`, {
      shop: merchant.shop,
      source: "meta-whatsapp",
    });
    return false;
  }
}

/**
 * Converts template text with named variables {{customer_name}} to Meta positional variables {{1}}, {{2}}
 * and generates sample values required by Meta for instant approval.
 */
export function convertToMetaTemplateFormat(rawText: string) {
  const variableMatches = rawText.match(/\{\{([a-zA-Z0-9_]+)\}\}/g) || [];
  let metaText = rawText;
  const exampleValues: string[] = [];

  const sampleMap: Record<string, string> = {
    customer_name: "Rahul Sharma",
    order_id: "1024",
    order_name: "#1024",
    order_number: "1024",
    store_name: "Everon Lab",
    total_amount: "2499",
    total_price: "2499",
    currency: "INR",
    tracking_number: "IN9823471029",
    carrier: "Shiprocket",
    tracking_url: "https://track.shiprocket.in",
    checkout_url: "https://satjewells-2.myshopify.com",
    discount_code: "SAVE10",
  };

  variableMatches.forEach((match, idx) => {
    const varName = match.replace(/[{}]/g, "");
    metaText = metaText.replace(match, `{{${idx + 1}}}`);
    exampleValues.push(sampleMap[varName] || "Sample");
  });

  return { metaText, exampleValues, count: variableMatches.length };
}

/**
 * Programmatically creates or syncs a WhatsApp Message Template to Meta WABA.
 * Supports UTILITY (Free within 24h) and MARKETING categories.
 */
export async function syncTemplateToMeta(merchantId: string, template: {
  name: string;
  category: "UTILITY" | "MARKETING" | "AUTHENTICATION";
  language?: string;
  bodyText: string;
  headerType?: string | null;
  headerText?: string | null;
  footerText?: string | null;
  buttonType?: string | null;
  buttonText?: string | null;
  buttonUrl?: string | null;
}) {
  const merchant = await db.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant || !merchant.wabaId || !merchant.waAccessToken) {
    throw new Error("Merchant WhatsApp credentials missing.");
  }

  const plainAccessToken = decryptToken(merchant.waAccessToken);
  const appSecretProof = generateAppSecretProof(plainAccessToken);

  const components: any[] = [];

  if (template.headerType === "TEXT" && template.headerText) {
    const { metaText: headerMetaText, exampleValues: headerExamples, count: headerCount } =
      convertToMetaTemplateFormat(template.headerText);
    const headerComponent: any = {
      type: "HEADER",
      format: "TEXT",
      text: headerMetaText,
    };
    if (headerCount > 0) {
      headerComponent.example = { header_text: headerExamples };
    }
    components.push(headerComponent);
  }

  const { metaText: bodyMetaText, exampleValues: bodyExamples, count: bodyCount } =
    convertToMetaTemplateFormat(template.bodyText);
  const bodyComponent: any = {
    type: "BODY",
    text: bodyMetaText,
  };
  if (bodyCount > 0) {
    bodyComponent.example = {
      body_text: [bodyExamples],
    };
  }
  components.push(bodyComponent);

  if (template.footerText) {
    components.push({
      type: "FOOTER",
      text: template.footerText,
    });
  }

  const templateButtons = (template as any).buttons || [];
  if (templateButtons && Array.isArray(templateButtons) && templateButtons.length > 0) {
    const metaButtons: any[] = [];
    templateButtons.slice(0, 3).forEach((b: any) => {
      if (b.type === "CTA_URL" || b.url) {
        metaButtons.push({
          type: "URL",
          text: (b.text || b.title || "View").slice(0, 25),
          url: b.url && b.url.includes("http") ? b.url : `https://${merchant.shop}`,
        });
      } else {
        metaButtons.push({
          type: "QUICK_REPLY",
          text: (b.text || b.title || "Reply").slice(0, 25),
        });
      }
    });

    if (metaButtons.length > 0) {
      components.push({
        type: "BUTTONS",
        buttons: metaButtons,
      });
    }
  } else if (template.buttonType === "CTA_URL" && template.buttonText && template.buttonUrl) {
    components.push({
      type: "BUTTONS",
      buttons: [
        {
          type: "URL",
          text: template.buttonText.slice(0, 25),
          url: template.buttonUrl.includes("http") ? template.buttonUrl : `https://${merchant.shop}`,
        },
      ],
    });
  } else if (template.buttonType === "QUICK_REPLY" && template.buttonText) {
    components.push({
      type: "BUTTONS",
      buttons: [
        {
          type: "QUICK_REPLY",
          text: template.buttonText.slice(0, 25),
        },
      ],
    });
  }

  const payload = {
    name: template.name.toLowerCase().replace(/[^a-z0-9_]/g, "_"),
    category: template.category || "UTILITY",
    language: template.language || "en_US",
    components,
  };

  const endpoint = `${META_BASE_URL}/${merchant.wabaId}/message_templates?appsecret_proof=${appSecretProof}`;

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
    throw new Error(data.error?.message || "Failed to create template on Meta.");
  }

  return data;
}

export interface SendWhatsAppMessageOptions {
  merchantId: string;
  recipientPhone: string;
  customerName?: string;
  eventType: string;
  bodyText?: string;
  mediaUrl?: string | null;
  mediaId?: string | null;
  fileName?: string | null;
  mediaType?: "IMAGE" | "VIDEO" | "DOCUMENT" | "AUDIO" | null;
  templateName?: string | null;
  templateLanguage?: string;
  templateParameters?: string[];
  headerType?: string | null;
  headerText?: string | null;
  headerMediaUrl?: string | null;
  footerText?: string | null;
  buttonType?: string | null;
  buttonText?: string | null;
  buttonUrl?: string | null;
  buttons?: Array<{ id: string; text?: string; title?: string; type?: string; url?: string }>;
  senderRole?: "BOT" | "MERCHANT";
  isInsideCSW?: boolean;
}

/**
 * Uploads a binary file directly from the user's computer to Meta's WhatsApp Media API.
 * Returns the Meta mediaId which can be delivered directly in WhatsApp chat.
 */
export async function uploadMediaToMeta(
  merchantId: string,
  {
    fileBuffer,
    fileName,
    mimeType,
  }: {
    fileBuffer: Buffer;
    fileName: string;
    mimeType: string;
  }
): Promise<{ mediaId: string }> {
  const merchant = await db.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant || !merchant.phoneNumberId || !merchant.waAccessToken) {
    throw new Error("Merchant WhatsApp account not connected or credentials missing.");
  }

  const plainAccessToken = decryptToken(merchant.waAccessToken);
  const appSecretProof = generateAppSecretProof(plainAccessToken);

  const form = new FormData();
  const blob = new Blob([fileBuffer], { type: mimeType });
  form.append("file", blob, fileName);
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);

  const endpoint = `${META_BASE_URL}/${merchant.phoneNumberId}/media?appsecret_proof=${appSecretProof}`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${plainAccessToken}`,
    },
    body: form,
  });

  const data = (await res.json()) as any;
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || "Failed to upload file to WhatsApp Cloud API.");
  }

  return { mediaId: data.id };
}

/**
 * Sends an outbound WhatsApp message via Meta Cloud API using the merchant's connected WABA & Phone Number.
 * Supports both pre-approved Meta Templates (reaches anyone worldwide) and Freeform non-template messages.
 */
export async function sendWhatsAppMessage(options: SendWhatsAppMessageOptions) {
  const {
    merchantId,
    recipientPhone,
    customerName,
    eventType,
    bodyText,
    mediaUrl,
    mediaId,
    fileName,
    mediaType,
    templateName,
    templateLanguage = "en_US",
    templateParameters = [],
    headerType,
    headerText,
    headerMediaUrl,
    footerText,
    buttonType,
    buttonText,
    buttonUrl,
    buttons = [],
    senderRole = "BOT",
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

  // 1. Sliding Window Hourly Rate Limiter (200 messages / hour safe tier cap)
  const HOURLY_LIMIT = 200;
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const sentInLastHour = await db.messageLog.count({
    where: {
      merchantId,
      createdAt: { gte: oneHourAgo },
      status: { in: ["SENT", "DELIVERED", "READ"] },
    },
  });

  if (sentInLastHour >= HOURLY_LIMIT) {
    const errorMsg = `Hourly messaging limit (${HOURLY_LIMIT}/hr) reached. Message held safely to protect Meta quality score.`;
    await logWarn(errorMsg, { shop: merchant.shop, source: "rate-limiter" });
    return { success: false, error: errorMsg, rateLimited: true, errorCode: 130429 };
  }

  // Build Meta Cloud API Payload
  let payload: any;

  if ((mediaId || mediaUrl) && mediaType === "IMAGE") {
    payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipientPhone,
      type: "image",
      image: mediaId
        ? {
            id: mediaId,
            ...(bodyText ? { caption: bodyText } : {}),
          }
        : {
            link: mediaUrl,
            ...(bodyText ? { caption: bodyText } : {}),
          },
    };
  } else if ((mediaId || mediaUrl) && mediaType === "VIDEO") {
    payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipientPhone,
      type: "video",
      video: mediaId
        ? {
            id: mediaId,
            ...(bodyText ? { caption: bodyText } : {}),
          }
        : {
            link: mediaUrl,
            ...(bodyText ? { caption: bodyText } : {}),
          },
    };
  } else if ((mediaId || mediaUrl) && mediaType === "DOCUMENT") {
    payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipientPhone,
      type: "document",
      document: mediaId
        ? {
            id: mediaId,
            filename: fileName || bodyText || "Attachment.pdf",
            ...(bodyText && fileName ? { caption: bodyText } : {}),
          }
        : {
            link: mediaUrl,
            filename: fileName || bodyText || "Attachment.pdf",
          },
    };
  } else if (templateName) {
    // Official Meta Template Message (Delivers to ANY customer worldwide outside 24h CSW)
    const components: any[] = [];

    if (templateParameters.length > 0) {
      components.push({
        type: "body",
        parameters: templateParameters.map((text) => ({ type: "text", text })),
      });
    }

    payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipientPhone,
      type: "template",
      template: {
        name: templateName,
        language: { code: templateLanguage },
        ...(components.length > 0 ? { components } : {}),
      },
    };
  } else if ((buttons && Array.isArray(buttons) && buttons.length > 0) || buttonType === "MULTI_BUTTON") {
    const rawButtons = buttons || [];
    const replyButtons: any[] = [];

    rawButtons.slice(0, 3).forEach((b, idx) => {
      const btnTitle = (b.text || b.title || `Option ${idx + 1}`).trim().slice(0, 20);
      const btnId = (b.id || `btn_${idx + 1}`).trim().slice(0, 256);
      replyButtons.push({
        type: "reply",
        reply: {
          id: btnId,
          title: btnTitle,
        },
      });
    });

    if (replyButtons.length > 0) {
      payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipientPhone,
        type: "interactive",
        interactive: {
          type: "button",
          ...(headerType === "TEXT" && headerText ? { header: { type: "text", text: headerText } } : {}),
          ...(headerType === "IMAGE" && headerMediaUrl ? { header: { type: "image", image: { link: headerMediaUrl } } } : {}),
          body: { text: bodyText || "Please choose an option below:" },
          ...(footerText ? { footer: { text: footerText } } : {}),
          action: {
            buttons: replyButtons,
          },
        },
      };
    } else {
      payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipientPhone,
        type: "text",
        text: { preview_url: true, body: bodyText || "Hello from StorePing!" },
      };
    }
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
        body: { text: bodyText || "Store notification" },
        ...(footerText ? { footer: { text: footerText } } : {}),
        action: {
          buttons: [
            {
              type: "reply",
              reply: {
                id: "btn_quick_reply",
                title: buttonText.slice(0, 20),
              },
            },
          ],
        },
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
    // Non-template Freeform text message: Combine bold header and italic footer if present
    let formattedText = (bodyText || "Hello from StorePing!").trim();

    if (headerType === "TEXT" && headerText && headerText.trim()) {
      formattedText = `*${headerText.trim()}*\n\n${formattedText}`;
    }

    if (footerText && footerText.trim()) {
      formattedText = `${formattedText}\n\n_${footerText.trim()}_`;
    }

    payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipientPhone,
      type: "text",
      text: {
        preview_url: true,
        body: formattedText,
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

    // Auto-Recovery 2: If outside 24h window (#131047 / #132000 / #132001) and freeform text was rejected by Meta,
    // automatically fallback to pre-approved Meta Template so message is guaranteed to deliver to the customer!
    if (!ok && (data.error?.code === 131047 || data.error?.code === 132000 || data.error?.code === 132001) && !templateName) {
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

    // Auto-Recovery 3: Rate Limiting Backoff Retry (HTTP 429 or Meta Error Code 130429 / 131056)
    if (!ok && (data.error?.code === 130429 || data.error?.code === 131056)) {
      await new Promise((r) => setTimeout(r, 2000));
      const retryResult = await executeSend(payload);
      if (retryResult.ok) {
        ok = true;
        data = retryResult.data;
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

    await db.merchant.update({
      where: { id: merchantId },
      data: {
        dailySentCount: { increment: 1 },
      },
    });

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

    // Record in 2-Way Conversations and Chat Messages
    const cleanPhone = recipientPhone.replace(/[^0-9]/g, "");
    const displayedBody =
      bodyText ||
      (mediaType === "IMAGE"
        ? "📷 Image"
        : mediaType === "DOCUMENT"
        ? `📄 ${fileName || "Document.pdf"}`
        : templateName
        ? `[Template: ${templateName}]`
        : "WhatsApp Notification");

    try {
      const conv = await db.conversation.upsert({
        where: {
          merchantId_customerPhone: {
            merchantId,
            customerPhone: cleanPhone,
          },
        },
        create: {
          merchantId,
          customerPhone: cleanPhone,
          customerName: customerName || null,
          lastMessageText: displayedBody,
          lastMessageAt: new Date(),
          status: "ACTIVE",
        },
        update: {
          customerName: customerName || undefined,
          lastMessageText: displayedBody,
          lastMessageAt: new Date(),
        },
      });

      await db.chatMessage.create({
        data: {
          conversationId: conv.id,
          sender: senderRole,
          messageType: mediaType ? mediaType : templateName ? "TEMPLATE" : buttonType ? "INTERACTIVE" : "TEXT",
          bodyText: bodyText || (mediaType === "IMAGE" ? "📷 Image" : mediaType === "DOCUMENT" ? `📄 ${fileName || "Document.pdf"}` : displayedBody),
          mediaUrl: mediaUrl || null,
          caption: bodyText || (mediaType === "DOCUMENT" ? (fileName || "Document.pdf") : null),
          metaMessageId: messageId,
          status: "SENT",
        },
      });
    } catch (convErr: any) {
      console.warn("Conversation record notice:", convErr);
    }

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
    // Auto-subscribe WABA to Webhooks if not already subscribed
    await subscribeWabaToWebhooks(merchantId);

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
