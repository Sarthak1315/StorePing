import crypto from "crypto";
import db from "../db.server";
import { decryptToken } from "./encryption.server";
import { logInfo, logWarn, logError } from "./logger.server";
import { logMetaApiCall } from "./meta-audit.server";
import { maskPhoneNumber } from "./phone.utils";
import { seedDefaultTemplates, extractTemplateParameters } from "./template.server";

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

  const startTime = Date.now();
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

  const durationMs = Date.now() - startTime;
  const data = (await res.json()) as any;

  await logMetaApiCall({
    endpoint: `POST /${META_GRAPH_VERSION}/${phoneNumberId}/register`,
    httpMethod: "POST",
    statusCode: res.status,
    durationMs,
    status: res.ok ? "SUCCESS" : "FAILED",
    requestPayload: { messaging_product: "whatsapp" },
    responseBody: data,
    initiatedBy: "Phone Number Registration",
    errorMessage: data.error?.message || null,
  });

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
    const startTime = Date.now();
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${plainAccessToken}`,
        "Content-Type": "application/json",
      },
    });

    const durationMs = Date.now() - startTime;
    const data = (await res.json()) as any;

    await logMetaApiCall({
      merchantId,
      endpoint: `POST /${META_GRAPH_VERSION}/${merchant.wabaId}/subscribed_apps`,
      httpMethod: "POST",
      statusCode: res.status,
      durationMs,
      status: res.ok && data.success ? "SUCCESS" : "FAILED",
      requestPayload: { wabaId: merchant.wabaId },
      responseBody: data,
      initiatedBy: "Webhook Subscription",
      errorMessage: data.error?.message || null,
    });

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
 * Strips emojis, formatting characters (*, _, ~, `, #), and newlines as strictly required by Meta for headers and buttons.
 */
export function stripEmojisAndFormatting(rawText: string | null | undefined): string {
  if (!rawText) return "";
  return rawText
    .replace(/[\u{1F600}-\u{1F6FF}|\u{1F300}-\u{1F5FF}|\u{1F680}-\u{1F6FF}|\u{1F1E0}-\u{1F1FF}|\u{2600}-\u{26FF}|\u{2700}-\u{27BF}|\u{FE00}-\u{FE0F}|\u{1F900}-\u{1F9FF}|\u{1F018}-\u{1F0F5}|\u{1F200}-\u{1F2FF}]/gu, "")
    .replace(/[*_~`#]/g, "")
    .replace(/\r?\n|\r/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Converts template text with named variables {{customer_name}} to Meta positional variables {{1}}, {{2}}
 * and generates sample values required by Meta for instant approval.
 */
export function convertToMetaTemplateFormat(rawText: string, isHeader = false) {
  let cleanInput = isHeader ? stripEmojisAndFormatting(rawText).slice(0, 60) : rawText;
  const variableMatches = cleanInput.match(/\{\{([a-zA-Z0-9_]+)\}\}/g) || [];
  let metaText = cleanInput;
  const exampleValues: string[] = [];

  const sampleMap: Record<string, string> = {
    customer_name: "Rahul Sharma",
    order_id: "1024",
    order_name: "1024",
    order_number: "1024",
    store_name: "StorePing Shop",
    total_amount: "2499",
    total_price: "2499",
    currency: "INR",
    cart_items: "Silk Sherwani (x1)",
    items: "Silk Sherwani (x1)",
    shipping_address: "Flat 402, Mumbai, MH, 400001",
    customer_phone: "919876543210",
    tracking_number: "IN9823471029",
    carrier: "Shiprocket",
    tracking_url: "https://track.shiprocket.in",
    checkout_url: "https://myshopify.com/checkout",
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
  buttons?: Array<{ id?: string; text?: string; title?: string; type?: string; url?: string }>;
}) {
  const merchant = await db.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant || !merchant.wabaId || !merchant.waAccessToken) {
    throw new Error("Merchant WhatsApp credentials missing.");
  }

  const plainAccessToken = decryptToken(merchant.waAccessToken);
  const appSecretProof = generateAppSecretProof(plainAccessToken);

  const components: any[] = [];

  // 1. Header (Cleaned of emojis, markdown, and newlines as mandated by Meta)
  if (template.headerType === "TEXT" && template.headerText) {
    const { metaText: headerMetaText, exampleValues: headerExamples, count: headerCount } =
      convertToMetaTemplateFormat(template.headerText, true);
    if (headerMetaText) {
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
  }

  // 2. Body (Emojis & markdown are fully supported by Meta in BODY)
  const { metaText: bodyMetaText, exampleValues: bodyExamples, count: bodyCount } =
    convertToMetaTemplateFormat(template.bodyText, false);
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

  // 3. Footer (Clean static text only - Meta rejects variables in footers)
  if (template.footerText) {
    const cleanFooter = stripEmojisAndFormatting(
      template.footerText.replace(/\{\{[^}]+\}\}/g, merchant.name || merchant.shop.replace(".myshopify.com", ""))
    ).slice(0, 60);
    if (cleanFooter) {
      components.push({
        type: "FOOTER",
        text: cleanFooter,
      });
    }
  }

  // 4. Buttons (Plain text without emojis - max 25 chars per button)
  const templateButtons = template.buttons || [];
  if (templateButtons && Array.isArray(templateButtons) && templateButtons.length > 0) {
    const metaButtons: any[] = [];
    templateButtons.slice(0, 3).forEach((b: any) => {
      const cleanBtnText = stripEmojisAndFormatting(b.text || b.title || "Option").slice(0, 25);
      if (b.type === "CTA_URL" || b.url) {
        metaButtons.push({
          type: "URL",
          text: cleanBtnText || "View",
          url: b.url && b.url.includes("http") ? b.url : `https://${merchant.shop}`,
        });
      } else {
        metaButtons.push({
          type: "QUICK_REPLY",
          text: cleanBtnText || "Reply",
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
    const cleanBtnText = stripEmojisAndFormatting(template.buttonText).slice(0, 25);
    components.push({
      type: "BUTTONS",
      buttons: [
        {
          type: "URL",
          text: cleanBtnText || "View Order",
          url: template.buttonUrl.includes("http") ? template.buttonUrl : `https://${merchant.shop}`,
        },
      ],
    });
  } else if (template.buttonType === "QUICK_REPLY" && template.buttonText) {
    const cleanBtnText = stripEmojisAndFormatting(template.buttonText).slice(0, 25);
    components.push({
      type: "BUTTONS",
      buttons: [
        {
          type: "QUICK_REPLY",
          text: cleanBtnText || "Reply",
        },
      ],
    });
  }

  const cleanMetaName = template.name.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 128);

  const payload = {
    name: cleanMetaName,
    category: template.category || "UTILITY",
    language: template.language || "en_US",
    components,
  };

  const endpoint = `${META_BASE_URL}/${merchant.wabaId}/message_templates?appsecret_proof=${appSecretProof}`;

  const startTime = Date.now();
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${plainAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const durationMs = Date.now() - startTime;
  const data = (await res.json()) as any;

  await logMetaApiCall({
    merchantId,
    endpoint: `POST /${META_GRAPH_VERSION}/${merchant.wabaId}/message_templates`,
    httpMethod: "POST",
    statusCode: res.status,
    durationMs,
    status: res.ok ? "SUCCESS" : "FAILED",
    requestPayload: payload,
    responseBody: data,
    initiatedBy: "Template Sync / Creation",
    errorMessage: data.error?.message || null,
  });

  if (!res.ok || data.error) {
    throw new Error(data.error?.message || "Failed to create template on Meta.");
  }

  return { id: data.id, status: data.status || "APPROVED", name: cleanMetaName };
}

/**
 * Fetches all live message templates from Meta WABA and updates our database.
 */
export async function fetchWabaTemplates(merchantId: string) {
  const merchant = await db.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant || !merchant.wabaId || !merchant.waAccessToken) return [];

  const plainAccessToken = decryptToken(merchant.waAccessToken);
  const appSecretProof = generateAppSecretProof(plainAccessToken);

  try {
    const endpoint = `${META_BASE_URL}/${merchant.wabaId}/message_templates?fields=name,status,category,language,components,id&limit=100&appsecret_proof=${appSecretProof}`;
    const res = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${plainAccessToken}` },
    });
    const data = (await res.json()) as any;
    if (res.ok && data.data) {
      const metaTemplates: Array<{ id: string; name: string; status: string; category: string; language: string }> = data.data;

      for (const mt of metaTemplates) {
        await db.template.updateMany({
          where: {
            merchantId,
            OR: [
              { metaTemplateName: mt.name },
              { name: { contains: mt.name, mode: "insensitive" } },
            ],
          },
          data: {
            metaTemplateId: mt.id,
            metaTemplateName: mt.name,
            metaTemplateStatus: mt.status,
          },
        });
      }
      return metaTemplates;
    }
  } catch (err: any) {
    console.warn("Failed to fetch WABA templates from Meta:", err);
  }
  return [];
}

/**
 * Synchronizes all core StorePing templates to Meta WABA with instant UTILITY/MARKETING approval specs.
 */
export async function syncAllDefaultTemplatesToMeta(merchantId: string) {
  const merchant = await db.merchant.findUnique({
    where: { id: merchantId },
    include: { templates: true },
  });
  if (!merchant || !merchant.wabaId || !merchant.waAccessToken) {
    return { success: false, syncedCount: 0, error: "WhatsApp credentials missing or account not connected." };
  }

  // Ensure default templates exist in DB
  await seedDefaultTemplates(merchant.id);
  const templates = await db.template.findMany({ where: { merchantId } });

  const results: Array<{ eventType: string; name: string; success: boolean; status?: string; error?: string }> = [];

  for (const tpl of templates) {
    const metaTemplateName = (tpl.metaTemplateName || tpl.eventType.toLowerCase().replace(/[^a-z0-9_]/g, "_")).slice(0, 128);
    try {
      const syncResult = await syncTemplateToMeta(merchantId, {
        name: metaTemplateName,
        category: (tpl.category as any) || (tpl.eventType.startsWith("CART_") || tpl.eventType === "WIN_BACK" ? "MARKETING" : "UTILITY"),
        language: tpl.language || "en_US",
        bodyText: tpl.bodyText,
        headerType: tpl.headerType,
        headerText: tpl.headerText,
        footerText: tpl.footerText,
        buttonType: tpl.buttonType,
        buttonText: tpl.buttonText,
        buttonUrl: tpl.buttonUrl,
      });

      await db.template.update({
        where: { id: tpl.id },
        data: {
          metaTemplateId: syncResult?.id || null,
          metaTemplateName,
          metaTemplateStatus: syncResult?.status || "APPROVED",
        },
      });

      results.push({ eventType: tpl.eventType, name: metaTemplateName, success: true, status: syncResult?.status || "APPROVED" });
    } catch (err: any) {
      // If template already exists on Meta, mark it as approved
      if (err.message?.includes("already exists") || err.message?.includes("duplicate")) {
        await db.template.update({
          where: { id: tpl.id },
          data: {
            metaTemplateName,
            metaTemplateStatus: "APPROVED",
          },
        });
        results.push({ eventType: tpl.eventType, name: metaTemplateName, success: true, status: "APPROVED" });
      } else {
        results.push({ eventType: tpl.eventType, name: metaTemplateName, success: false, error: err.message });
      }
    }
  }

  // Refresh live statuses from Meta
  await fetchWabaTemplates(merchantId);

  const syncedCount = results.filter((r) => r.success).length;
  return { success: true, syncedCount, results };
}

export interface SendWhatsAppMessageOptions {
  merchantId: string;
  recipientPhone: string;
  customerName?: string;
  eventType: string;
  bodyText?: string;
  templateVariables?: Record<string, any>;
  orderId?: string;
  orderNumber?: string;
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
  senderRole?: "BOT" | "MERCHANT" | "AGENT";
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
  const blob = new Blob([new Uint8Array(fileBuffer)], { type: mimeType });
  form.append("file", blob, fileName);
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);

  const endpoint = `${META_BASE_URL}/${merchant.phoneNumberId}/media?appsecret_proof=${appSecretProof}`;

  const startTime = Date.now();
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${plainAccessToken}`,
    },
    body: form,
  });

  const durationMs = Date.now() - startTime;
  const data = (await res.json()) as any;

  await logMetaApiCall({
    merchantId,
    endpoint: `POST /${META_GRAPH_VERSION}/${merchant.phoneNumberId}/media`,
    httpMethod: "POST",
    statusCode: res.status,
    durationMs,
    status: res.ok ? "SUCCESS" : "FAILED",
    metaMessageId: data.id || null,
    requestPayload: { fileName, mimeType, byteLength: fileBuffer.length },
    responseBody: data,
    initiatedBy: "Portal User Media Upload",
    errorMessage: data.error?.message || null,
  });

  if (!res.ok || data.error) {
    throw new Error(data.error?.message || "Failed to upload file to WhatsApp Cloud API.");
  }

  return { mediaId: data.id };
}

/**
 * Sends an outbound WhatsApp message via Meta Cloud API using the merchant's connected WABA & Phone Number.
 * Automatically selects Meta Template message (reaches anyone worldwide) outside 24h CSW and Interactive buttons inside 24h CSW.
 */
export async function sendWhatsAppMessage(options: SendWhatsAppMessageOptions) {
  const {
    merchantId,
    recipientPhone,
    customerName,
    eventType,
    bodyText,
    templateVariables,
    orderId,
    orderNumber,
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

  // Determine if customer is within the 24-hour Customer Service Window (CSW)
  const cleanPhone = recipientPhone.replace(/[^0-9]/g, "");
  let isCustomerInsideCSW = options.isInsideCSW ?? false;

  if (options.isInsideCSW === undefined) {
    const existingConv = await db.conversation.findUnique({
      where: {
        merchantId_customerPhone: {
          merchantId,
          customerPhone: cleanPhone,
        },
      },
    });
    if (existingConv?.cswExpiresAt) {
      isCustomerInsideCSW = new Date(existingConv.cswExpiresAt).getTime() > Date.now();
    }
  }

  // Fetch DB template for event if present
  const dbTpl = await db.template.findFirst({
    where: { merchantId, eventType, isActive: true },
  }) || await db.template.findFirst({
    where: { merchantId, eventType },
  });

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
  } else if (templateName || !isCustomerInsideCSW) {
    // ⭐️ Meta WhatsApp Template Message (Guaranteed to deliver to ANY recipient outside 24h CSW)
    const targetMetaTemplateName =
      templateName ||
      dbTpl?.metaTemplateName ||
      eventType.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 128);

    const components: any[] = [];

    // 1. Header component parameters (if text header has variables)
    if (dbTpl?.headerType === "TEXT" && dbTpl.headerText && templateVariables) {
      const headerParams = extractTemplateParameters(dbTpl.headerText, templateVariables);
      if (headerParams.length > 0) {
        components.push({
          type: "header",
          parameters: headerParams.map((text) => ({ type: "text", text })),
        });
      }
    }

    // 2. Body component parameters
    let bodyParamsList: string[] = [];
    if (templateParameters && templateParameters.length > 0) {
      bodyParamsList = templateParameters;
    } else if (templateVariables) {
      bodyParamsList = extractTemplateParameters(dbTpl?.bodyText || bodyText, templateVariables);
    }

    if (bodyParamsList.length > 0) {
      components.push({
        type: "body",
        parameters: bodyParamsList.map((text) => ({ type: "text", text })),
      });
    }

    // 3. Dynamic URL Button component parameters if needed (Static quick replies do not take parameters)
    const rawButtons = (buttons && buttons.length > 0) ? buttons : (dbTpl?.buttons as any[]) || [];
    rawButtons.slice(0, 3).forEach((b: any, idx: number) => {
      if ((b.type === "CTA_URL" || b.type === "URL") && b.url && b.url.includes("{{")) {
        const urlParams = extractTemplateParameters(b.url, templateVariables || {});
        if (urlParams.length > 0) {
          components.push({
            type: "button",
            sub_type: "url",
            index: String(idx),
            parameters: [{ type: "text", text: urlParams[0] }],
          });
        }
      }
    });

    payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipientPhone,
      type: "template",
      template: {
        name: targetMetaTemplateName,
        language: { code: templateLanguage || dbTpl?.language || "en_US" },
        ...(components.length > 0 ? { components } : {}),
      },
    };
  } else if ((buttons && Array.isArray(buttons) && buttons.length > 0) || buttonType === "MULTI_BUTTON") {
    // Inside 24h CSW: Rich interactive buttons
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
    // Non-template Freeform text message (inside 24h CSW)
    const cleanBody = bodyText ? bodyText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim() : "Hello from StorePing!";
    let formattedText = cleanBody;

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

  const phoneNumberId = merchant.phoneNumberId;
  const endpoint = `${META_BASE_URL}/${phoneNumberId}/messages?appsecret_proof=${appSecretProof}`;

  async function executeSend(currentPayload: any): Promise<any> {
    const startTime = Date.now();
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${plainAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(currentPayload),
    });

    const durationMs = Date.now() - startTime;
    const rateLimitHeader = res.headers.get("x-business-use-case-usage") || res.headers.get("x-app-usage") || null;
    const data = (await res.json()) as any;

    await logMetaApiCall({
      merchantId,
      endpoint: `POST /${META_GRAPH_VERSION}/${phoneNumberId}/messages`,
      httpMethod: "POST",
      statusCode: res.status,
      durationMs,
      status: res.ok ? "SUCCESS" : (res.status === 429 || data.error?.code === 130429 || data.error?.code === 131056) ? "RATE_LIMITED" : "FAILED",
      metaMessageId: data.messages?.[0]?.id || null,
      requestPayload: currentPayload,
      responseBody: data,
      rateLimitUsage: rateLimitHeader,
      initiatedBy: options.senderRole === "MERCHANT" ? "Portal Live Support Agent" : `Automation: ${eventType}`,
      errorMessage: data.error?.message || null,
    });

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

    // Auto-Recovery 2: If language code mismatch (#132001), retry the merchant's template with the alternate language code (en_US <-> en)
    if (!ok && (data.error?.code === 132001 || data.error?.message?.includes("does not exist in"))) {
      if (payload.type === "template" && payload.template) {
        const currentLang = payload.template.language?.code || "en_US";
        const altLang = currentLang === "en_US" ? "en" : "en_US";
        const altPayload = {
          ...payload,
          template: {
            ...payload.template,
            language: { code: altLang },
          },
        };
        const altResult = await executeSend(altPayload);
        if (altResult.ok) {
          ok = true;
          data = altResult.data;
        }
      }
    }

    // Auto-Recovery 3: If outside 24h window (#131047) and interactive/text failed, retry with user's approved template
    if (!ok && data.error?.code === 131047 && payload.type !== "template") {
      const targetTplName = templateName || dbTpl?.metaTemplateName || eventType.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 128);
      const components: any[] = [];

      if (dbTpl?.headerType === "TEXT" && dbTpl.headerText && templateVariables) {
        const headerParams = extractTemplateParameters(dbTpl.headerText, templateVariables);
        if (headerParams.length > 0) {
          components.push({
            type: "header",
            parameters: headerParams.map((text) => ({ type: "text", text })),
          });
        }
      }

      let bodyParamsList: string[] = [];
      if (templateVariables) {
        bodyParamsList = extractTemplateParameters(dbTpl?.bodyText || bodyText, templateVariables);
      }
      if (bodyParamsList.length > 0) {
        components.push({
          type: "body",
          parameters: bodyParamsList.map((text) => ({ type: "text", text })),
        });
      }

      const templatePayload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipientPhone,
        type: "template",
        template: {
          name: targetTplName,
          language: { code: templateLanguage || dbTpl?.language || "en_US" },
          ...(components.length > 0 ? { components } : {}),
        },
      };

      let tplResult = await executeSend(templatePayload);
      if (!tplResult.ok && (tplResult.data.error?.code === 132001 || tplResult.data.error?.message?.includes("does not exist in"))) {
        const altLang = templatePayload.template.language.code === "en_US" ? "en" : "en_US";
        templatePayload.template.language.code = altLang;
        tplResult = await executeSend(templatePayload);
      }

      if (tplResult.ok) {
        ok = true;
        data = tplResult.data;
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

      // Update OrderConfirmation record with failure info if order number provided
      if (orderNumber) {
        const fullOrderNum = orderNumber.startsWith("#") ? orderNumber : `#${orderNumber}`;
        await db.orderConfirmation.updateMany({
          where: {
            merchantId,
            orderNumber: fullOrderNum,
          },
          data: {
            status: "FAILED",
            errorMessage: `${errorMessage} (Code ${errorCode})`,
          },
        }).catch(() => {});
      }

      return {
        success: false,
        error: errorMessage,
        errorCode,
        isSandboxRestriction: errorCode === 131030,
      };
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

    // Update OrderConfirmation record with metaMessageId
    if (orderNumber) {
      const fullOrderNum = orderNumber.startsWith("#") ? orderNumber : `#${orderNumber}`;
      await db.orderConfirmation.updateMany({
        where: {
          merchantId,
          orderNumber: fullOrderNum,
        },
        data: {
          metaMessageId: messageId,
          lastSentAt: new Date(),
          status: "PENDING",
          errorMessage: null,
        },
      }).catch(() => {});
    }

    // Record in 2-Way Conversations and Chat Messages
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
          lastOrderNumber: orderNumber || null,
          lastOrderId: orderId || null,
          lastMessageText: displayedBody,
          lastMessageAt: new Date(),
          status: "ACTIVE",
        },
        update: {
          customerName: customerName || undefined,
          lastOrderNumber: orderNumber || undefined,
          lastOrderId: orderId || undefined,
          lastMessageText: displayedBody,
          lastMessageAt: new Date(),
        },
      });

      await db.chatMessage.create({
        data: {
          conversationId: conv.id,
          sender: senderRole,
          messageType: mediaType ? mediaType : (templateName || !isCustomerInsideCSW) ? "TEMPLATE" : buttonType ? "INTERACTIVE" : "TEXT",
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
