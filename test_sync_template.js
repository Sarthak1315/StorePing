import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const db = new PrismaClient();

const SECRET_STRING =
  process.env.ENCRYPTION_SECRET ||
  process.env.SHOPIFY_API_SECRET ||
  "storeping_fallback_secret_32bytes!!";
const ENCRYPTION_KEY = crypto.createHash("sha256").update(SECRET_STRING).digest();
const ALGORITHM = "aes-256-gcm";

function decryptToken(cipherText) {
  if (!cipherText || typeof cipherText !== "string") return cipherText;
  if (!cipherText.startsWith("enc:gcm:")) return cipherText;

  try {
    const parts = cipherText.split(":");
    if (parts.length !== 5) return cipherText;

    const iv = Buffer.from(parts[2], "hex");
    const authTag = Buffer.from(parts[3], "hex");
    const encryptedText = parts[4];

    const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedText, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (err) {
    return cipherText;
  }
}

function generateAppSecretProof(accessToken) {
  const secret = process.env.META_APP_SECRET || "";
  return crypto.createHmac("sha256", secret).update(accessToken).digest("hex");
}

function stripEmojisAndFormatting(rawText) {
  if (!rawText) return "";
  return rawText
    .replace(/[\u{1F600}-\u{1F6FF}|\u{1F300}-\u{1F5FF}|\u{1F680}-\u{1F6FF}|\u{1F1E0}-\u{1F1FF}|\u{2600}-\u{26FF}|\u{2700}-\u{27BF}|\u{FE00}-\u{FE0F}|\u{1F900}-\u{1F9FF}|\u{1F018}-\u{1F0F5}|\u{1F200}-\u{1F2FF}]/gu, "")
    .replace(/[*_~`#]/g, "")
    .replace(/\r?\n|\r/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function convertToMetaTemplateFormat(rawText, isHeader = false) {
  let cleanInput = isHeader ? stripEmojisAndFormatting(rawText).slice(0, 60) : rawText;
  const variableMatches = cleanInput.match(/\{\{([a-zA-Z0-9_]+)\}\}/g) || [];
  let metaText = cleanInput;
  const exampleValues = [];

  const sampleMap = {
    customer_name: "Rahul Sharma",
    order_id: "1024",
    order_name: "1024",
    order_number: "1024",
    store_name: "Everon Lab",
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

async function main() {
  const merchant = await db.merchant.findFirst();
  console.log("Merchant:", merchant?.shop, "wabaId:", merchant?.wabaId);
  if (!merchant || !merchant.wabaId || !merchant.waAccessToken) return;

  const plainAccessToken = decryptToken(merchant.waAccessToken);
  const appSecretProof = generateAppSecretProof(plainAccessToken);

  const tpl = await db.template.findFirst({
    where: { merchantId: merchant.id, eventType: "ORDER_CONFIRM_ADDRESS" },
  });

  if (!tpl) return;

  const components = [];

  // Header (Cleaned of emojis / formatting)
  if (tpl.headerType === "TEXT" && tpl.headerText) {
    const { metaText, exampleValues, count } = convertToMetaTemplateFormat(tpl.headerText, true);
    if (metaText) {
      const headerComponent = {
        type: "HEADER",
        format: "TEXT",
        text: metaText,
      };
      if (count > 0) {
        headerComponent.example = { header_text: exampleValues };
      }
      components.push(headerComponent);
    }
  }

  // Body
  const { metaText: bodyMeta, exampleValues: bodyExamples, count: bodyCount } = convertToMetaTemplateFormat(tpl.bodyText, false);
  const bodyComponent = {
    type: "BODY",
    text: bodyMeta,
  };
  if (bodyCount > 0) {
    bodyComponent.example = { body_text: [bodyExamples] };
  }
  components.push(bodyComponent);

  // Footer (Clean static text only)
  if (tpl.footerText) {
    const cleanFooter = stripEmojisAndFormatting(tpl.footerText.replace(/\{\{[^}]+\}\}/g, merchant.name || merchant.shop.replace(".myshopify.com", ""))).slice(0, 60);
    components.push({
      type: "FOOTER",
      text: cleanFooter,
    });
  }

  // Buttons (Clean plain text without emojis)
  const templateButtons = tpl.buttons || [];
  if (templateButtons && Array.isArray(templateButtons) && templateButtons.length > 0) {
    const metaButtons = [];
    templateButtons.slice(0, 3).forEach((b) => {
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
  }

  const payload = {
    name: "order_confirm_address",
    category: "UTILITY",
    language: "en_US",
    components,
  };

  console.log("Submitting payload to Meta Graph API:\n", JSON.stringify(payload, null, 2));

  const endpoint = `https://graph.facebook.com/v21.0/${merchant.wabaId}/message_templates?appsecret_proof=${appSecretProof}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${plainAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  console.log("\nMeta Creation Response status:", res.status);
  console.log("Response Body:", JSON.stringify(data, null, 2));

  if (data.id) {
    await db.template.update({
      where: { id: tpl.id },
      data: {
        metaTemplateId: data.id,
        metaTemplateName: "order_confirm_address",
        metaTemplateStatus: data.status || "APPROVED",
      },
    });
    console.log("Successfully created and saved template in DB with Meta ID:", data.id);
  }
}

main().catch(console.error).finally(() => db.$disconnect());
