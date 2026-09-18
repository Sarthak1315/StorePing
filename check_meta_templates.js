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

async function main() {
  const merchant = await db.merchant.findFirst();
  console.log("Merchant:", merchant?.shop, "wabaId:", merchant?.wabaId);
  if (!merchant || !merchant.wabaId || !merchant.waAccessToken) return;

  const plainAccessToken = decryptToken(merchant.waAccessToken);
  const appSecretProof = generateAppSecretProof(plainAccessToken);

  console.log("Querying Meta Graph API directly...");
  const endpoint = `https://graph.facebook.com/v21.0/${merchant.wabaId}/message_templates?fields=name,status,category,language,components,id&limit=100&appsecret_proof=${appSecretProof}`;
  const res = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${plainAccessToken}` },
  });
  const data = await res.json();
  console.log("Meta API Response status:", res.status);
  console.log("Meta Templates Count:", data.data?.length || 0);
  if (data.data) {
    data.data.forEach(t => {
      console.log("-> Name:", t.name, "| Status:", t.status, "| Lang:", t.language, "| Cat:", t.category, "| ID:", t.id);
      console.log("   Components:", JSON.stringify(t.components));
    });
  } else {
    console.log("Error from Meta:", JSON.stringify(data));
  }
}

main().catch(console.error).finally(() => db.$disconnect());
