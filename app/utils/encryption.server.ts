import crypto from "crypto";

const SECRET_STRING =
  process.env.ENCRYPTION_SECRET ||
  process.env.SHOPIFY_API_SECRET ||
  "storeping_fallback_secret_32bytes!!";
const ENCRYPTION_KEY = crypto.createHash("sha256").update(SECRET_STRING).digest(); // Always 32 bytes for AES-256
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits for GCM

/**
 * Encrypts a plain-text token using AES-256-GCM authenticated encryption.
 * @param text Plain text access token
 * @returns Encrypted token format 'enc:gcm:<iv>:<tag>:<ciphertext>'
 */
export function encryptToken(text: string): string {
  if (!text || typeof text !== "string") return text;
  if (text.startsWith("enc:gcm:")) return text;

  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);

    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");
    const authTag = cipher.getAuthTag().toString("hex");

    return `enc:gcm:${iv.toString("hex")}:${authTag}:${encrypted}`;
  } catch (err: any) {
    console.error("[StorePing Encryption Error] Failed to encrypt token:", err.message);
    throw new Error("Token encryption failed");
  }
}

/**
 * Decrypts an AES-256-GCM encrypted token.
 * Handles legacy unencrypted tokens gracefully for backwards compatibility.
 * @param cipherText Encrypted token string or raw token
 * @returns Plain-text token
 */
export function decryptToken(cipherText: string): string {
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
  } catch (err: any) {
    console.error("[StorePing Decryption Error] Failed to decrypt token:", err.message);
    throw new Error("Token decryption failed or corrupted");
  }
}
