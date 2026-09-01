import db from "../db.server";

export interface LogShopifyApiCallParams {
  merchantId?: string | null;
  shop: string;
  topic: string;
  apiType?: "WEBHOOK" | "GRAPHQL" | "REST" | "OAUTH";
  httpMethod?: string;
  statusCode?: number | null;
  durationMs?: number | null;
  status?: "SUCCESS" | "FAILED" | "RATE_LIMITED" | "IGNORED";
  webhookId?: string | null;
  apiVersion?: string | null;
  requestPayload?: any;
  responseBody?: any;
  rateLimitUsage?: string | null;
  initiatedBy?: string | null;
  ipAddress?: string | null;
  errorMessage?: string | null;
}

/**
 * Sanitizes and logs every Shopify Webhook, GraphQL mutation/query, and REST call to PostgreSQL
 * for full end-to-end traceability, webhook tracking, and Super Admin auditing.
 */
export async function logShopifyApiCall(params: LogShopifyApiCallParams) {
  try {
    const sanitize = (obj: any): string | null => {
      if (!obj) return null;
      if (typeof obj === "string") {
        return obj
          .replace(/shpat_[A-Za-z0-9]+/g, "shpat_***[MASKED_TOKEN]")
          .replace(/shpca_[A-Za-z0-9]+/g, "shpca_***[MASKED_TOKEN]");
      }
      try {
        const str = JSON.stringify(obj, null, 2);
        return str
          .replace(/shpat_[A-Za-z0-9]+/g, "shpat_***[MASKED_TOKEN]")
          .replace(/shpca_[A-Za-z0-9]+/g, "shpca_***[MASKED_TOKEN]");
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
      } else if (params.statusCode) {
        status = "FAILED";
      } else {
        status = "SUCCESS";
      }
    }

    // Resolve merchantId from shop if not provided
    let merchantId = params.merchantId;
    if (!merchantId && params.shop) {
      const m = await db.merchant.findUnique({
        where: { shop: params.shop },
        select: { id: true },
      });
      if (m) merchantId = m.id;
    }

    return await db.shopifyApiLog.create({
      data: {
        merchantId: merchantId || null,
        shop: params.shop,
        topic: params.topic,
        apiType: params.apiType || "WEBHOOK",
        httpMethod: (params.httpMethod || "POST").toUpperCase(),
        statusCode: params.statusCode || 200,
        durationMs: params.durationMs || null,
        status,
        webhookId: params.webhookId || null,
        apiVersion: params.apiVersion || "2025-01",
        requestPayload: sanitize(params.requestPayload),
        responseBody: sanitize(params.responseBody),
        rateLimitUsage: params.rateLimitUsage || null,
        initiatedBy: params.initiatedBy || "SHOPIFY_WEBHOOK",
        ipAddress: params.ipAddress || null,
        errorMessage: params.errorMessage || null,
      },
    });
  } catch (err) {
    console.error("Shopify API audit log error:", err);
    return null;
  }
}
