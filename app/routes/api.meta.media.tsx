import type { LoaderFunctionArgs } from "@remix-run/node";
import db from "../db.server";
import { decryptToken } from "../utils/encryption.server";
import { logWarn } from "../utils/logger.server";

/**
 * Streaming Proxy for Meta WhatsApp Media (Images, Videos, Audio, Documents).
 * Securely fetches encrypted media from Meta Cloud API and streams it directly to the browser.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const mediaId = url.searchParams.get("mediaId") || url.searchParams.get("id");
  const shop = url.searchParams.get("shop");

  if (!mediaId) {
    return new Response("Missing mediaId parameter", { status: 400 });
  }

  try {
    // 1. Find merchant credentials
    const merchant = shop
      ? await db.merchant.findUnique({ where: { shop } })
      : await db.merchant.findFirst({ where: { isWhatsAppConnected: true } });

    if (!merchant || !merchant.waAccessToken) {
      return new Response("WhatsApp merchant credentials not configured", { status: 401 });
    }

    const plainAccessToken = decryptToken(merchant.waAccessToken);

    // 2. Fetch Media metadata from Meta Graph API
    const metaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
      headers: {
        Authorization: `Bearer ${plainAccessToken}`,
      },
    });

    const metaData = (await metaRes.json()) as any;

    if (!metaRes.ok || metaData.error || !metaData.url) {
      await logWarn(`Failed to resolve Meta media ${mediaId}: ${metaData.error?.message || "Not found"}`, {
        shop: merchant.shop,
        source: "meta-media",
      });
      return new Response("Media not found or expired on Meta", { status: 404 });
    }

    // 3. Download the actual binary stream from Meta's secure Lookaside URL
    const mediaStreamRes = await fetch(metaData.url, {
      headers: {
        Authorization: `Bearer ${plainAccessToken}`,
      },
    });

    if (!mediaStreamRes.ok) {
      return new Response("Failed to fetch media binary from Meta CDN", { status: mediaStreamRes.status });
    }

    const contentType = metaData.mime_type || mediaStreamRes.headers.get("content-type") || "application/octet-stream";
    const contentLength = metaData.file_size?.toString() || mediaStreamRes.headers.get("content-length");

    const headers = new Headers();
    headers.set("Content-Type", contentType);
    if (contentLength) headers.set("Content-Length", contentLength);
    headers.set("Cache-Control", "public, max-age=604800, immutable"); // Cache for 7 days

    if (url.searchParams.get("download") === "true") {
      const extension = contentType.split("/")[1]?.split(";")[0] || "bin";
      headers.set("Content-Disposition", `attachment; filename="whatsapp_media_${mediaId}.${extension}"`);
    }

    return new Response(mediaStreamRes.body, {
      status: 200,
      headers,
    });
  } catch (err: any) {
    await logWarn(`Meta media proxy error: ${err.message}`, { source: "meta-media" });
    return new Response("Internal Server Error", { status: 500 });
  }
};
