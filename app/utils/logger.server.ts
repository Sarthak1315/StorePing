import db from "../db.server";
import { maskPhoneNumber } from "./phone.utils";

type LogLevel = "info" | "warn" | "error" | "debug";

interface LogOptions {
  shop?: string;
  source?: string;
  details?: any;
}

/**
 * Sanitizes details to ensure PII (like raw phone numbers or raw tokens) is not logged in plain text.
 */
function sanitizeDetails(details: any): string | null {
  if (!details) return null;
  try {
    const jsonStr = JSON.stringify(details, (key, value) => {
      if (typeof value === "string") {
        if (key.toLowerCase().includes("token") || key.toLowerCase().includes("secret")) {
          return "[REDACTED_SECRET]";
        }
        if (key.toLowerCase().includes("phone") && value.length >= 10) {
          return maskPhoneNumber(value);
        }
      }
      return value;
    });
    return jsonStr;
  } catch {
    return String(details);
  }
}

async function persistLog(level: LogLevel, message: string, options?: LogOptions) {
  const shop = options?.shop;
  const source = options?.source || "system";
  const sanitizedDetails = sanitizeDetails(options?.details);

  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [StorePing] [${level.toUpperCase()}] [${source}]${shop ? ` [${shop}]` : ""}: ${message}`);

  try {
    await db.log.create({
      data: {
        shop: shop || null,
        level,
        message,
        details: sanitizedDetails,
        source,
      },
    });
  } catch (err: any) {
    console.error("[StorePing Logger Failed to write to DB]:", err.message);
  }
}

export const logInfo = (message: string, options?: LogOptions) => persistLog("info", message, options);
export const logWarn = (message: string, options?: LogOptions) => persistLog("warn", message, options);
export const logError = (message: string, options?: LogOptions) => persistLog("error", message, options);
export const logDebug = (message: string, options?: LogOptions) => persistLog("debug", message, options);
