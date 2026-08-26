import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import db from "../db.server";
import { encryptToken } from "../utils/encryption.server";
import { logInfo, logError, logWarn } from "../utils/logger.server";

async function discoverWabaCredentials(accessToken: string) {
  const BASE = "https://graph.facebook.com/v21.0";
  const auth = `access_token=${accessToken}`;

  const bizRes = await fetch(`${BASE}/me/businesses?fields=id,name&${auth}`);
  const bizData = (await bizRes.json()) as any;

  if (!bizRes.ok || bizData.error) {
    throw new Error(`Meta /me/businesses error: ${bizData.error?.message || JSON.stringify(bizData)}`);
  }

  const businesses: any[] = bizData.data || [];
  if (businesses.length === 0) {
    throw new Error("No Meta Business Portfolio found for this account.");
  }

  for (const biz of businesses) {
    const wabaRes = await fetch(`${BASE}/${biz.id}/owned_whatsapp_business_accounts?fields=id,name&${auth}`);
    const wabaData = (await wabaRes.json()) as any;
    const wabas: any[] = wabaData.data || [];

    for (const waba of wabas) {
      const phoneRes = await fetch(
        `${BASE}/${waba.id}/phone_numbers?fields=id,display_phone_number,verified_name,status,quality_rating,messaging_limit_tier&${auth}`
      );
      const phoneData = (await phoneRes.json()) as any;
      const phones: any[] = phoneData.data || [];

      if (phones.length > 0) {
        const phone = phones.find((p: any) => p.status === "CONNECTED" || p.status === "VERIFIED") || phones[0];
        return {
          wabaId: waba.id,
          phoneNumberId: phone.id,
          displayPhoneNumber: phone.display_phone_number || null,
          qualityRating: phone.quality_rating || "UNKNOWN",
          messagingLimit: phone.messaging_limit_tier || "TIER_250",
        };
      }
    }
  }

  throw new Error("No WhatsApp phone number found in your Meta Business Portfolio.");
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const shop = url.searchParams.get("state") || "";
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  const apiKey = process.env.SHOPIFY_API_KEY || "41d2866a571078941a8565955ca0297d";
  const appUrl = process.env.SHOPIFY_APP_URL || "https://storeping.everonlab.in";

  if (error || !code || !shop) {
    await logWarn("Meta WhatsApp OAuth denied or cancelled", {
      shop,
      source: "auth.facebook.callback",
      details: { error, errorDescription },
    });
    return redirect(`https://${shop}/admin/apps/${apiKey}/app/connect?error=${encodeURIComponent(errorDescription || error || "cancelled")}`);
  }

  try {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;

    if (!appId || !appSecret) {
      throw new Error("META_APP_ID or META_APP_SECRET environment variables not configured.");
    }

    const redirectUri = `${appUrl}/auth/facebook/callback`;

    // 1. Exchange auth code for access token
    const tokenUrl = `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&code=${code}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    const tokenRes = await fetch(tokenUrl);
    const tokenData = (await tokenRes.json()) as any;

    if (!tokenRes.ok || tokenData.error || !tokenData.access_token) {
      throw new Error(tokenData.error?.message || "Failed to exchange Meta authorization token.");
    }

    const accessToken = tokenData.access_token;

    // 2. Discover WABA ID and Phone Number ID
    const discovered = await discoverWabaCredentials(accessToken);
    const encryptedToken = encryptToken(accessToken);

    // 3. Save / Update Merchant record
    await db.merchant.upsert({
      where: { shop },
      create: {
        shop,
        wabaId: discovered.wabaId,
        phoneNumberId: discovered.phoneNumberId,
        displayPhoneNumber: discovered.displayPhoneNumber,
        waAccessToken: encryptedToken,
        isWhatsAppConnected: true,
        qualityRating: discovered.qualityRating,
        messagingLimit: discovered.messagingLimit,
        alertType: "NONE",
        alertMessage: null,
      },
      update: {
        wabaId: discovered.wabaId,
        phoneNumberId: discovered.phoneNumberId,
        displayPhoneNumber: discovered.displayPhoneNumber,
        waAccessToken: encryptedToken,
        isWhatsAppConnected: true,
        qualityRating: discovered.qualityRating,
        messagingLimit: discovered.messagingLimit,
        alertType: "NONE",
        alertMessage: null,
      },
    });

    await logInfo("WhatsApp Business Account connected successfully ✓", {
      shop,
      source: "auth.facebook.callback",
      details: { wabaId: discovered.wabaId, phoneNumberId: discovered.phoneNumberId },
    });

    return redirect(`https://${shop}/admin/apps/${apiKey}/app/connect?connected=true`);
  } catch (err: any) {
    await logError(`Meta WhatsApp callback error: ${err.message}`, {
      shop,
      source: "auth.facebook.callback",
    });
    return redirect(`https://${shop}/admin/apps/${apiKey}/app/connect?error=${encodeURIComponent(err.message)}`);
  }
};
