import db from "../db.server";

export interface LogMetaApiCallParams {
  merchantId?: string | null;
  endpoint: string;
  httpMethod: string;
  statusCode?: number | null;
  durationMs?: number | null;
  status?: "SUCCESS" | "FAILED" | "RATE_LIMITED";
  metaMessageId?: string | null;
  requestPayload?: any;
  responseBody?: any;
  rateLimitUsage?: string | null;
  initiatedBy?: string | null;
  ipAddress?: string | null;
  errorMessage?: string | null;
}

/**
 * Sanitizes and logs every Meta Graph & WhatsApp Cloud API interaction to PostgreSQL
 * for full traceability, rate-limiting telemetry, and Super Admin auditing.
 */
export async function logMetaApiCall(params: LogMetaApiCallParams) {
  try {
    const sanitize = (obj: any): string | null => {
      if (!obj) return null;
      if (typeof obj === "string") {
        return obj.replace(/EAA[A-Za-z0-9_-]+/g, "EAA***[MASKED_TOKEN]");
      }
      try {
        const str = JSON.stringify(obj, null, 2);
        return str.replace(/EAA[A-Za-z0-9_-]+/g, "EAA***[MASKED_TOKEN]");
      } catch {
        return String(obj);
      }
    };

    let status = params.status;
    if (!status) {
      if (params.statusCode === 429) {
        status = "RATE_LIMITED";
      } else if (params.statusCode && params.statusCode >= 200 && params.statusCode < 300) {
        status = "SUCCESS";
      } else {
        status = "FAILED";
      }
    }

    return await db.metaApiLog.create({
      data: {
        merchantId: params.merchantId || null,
        endpoint: params.endpoint,
        httpMethod: params.httpMethod.toUpperCase(),
        statusCode: params.statusCode || null,
        durationMs: params.durationMs || null,
        status,
        metaMessageId: params.metaMessageId || null,
        requestPayload: sanitize(params.requestPayload),
        responseBody: sanitize(params.responseBody),
        rateLimitUsage: params.rateLimitUsage || null,
        initiatedBy: params.initiatedBy || "SYSTEM",
        ipAddress: params.ipAddress || null,
        errorMessage: params.errorMessage || null,
      },
    });
  } catch (err) {
    console.error("Meta API audit log error:", err);
    return null;
  }
}
