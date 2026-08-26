import type { LoaderFunctionArgs } from "@remix-run/node";
import db from "../db.server";
import { encryptToken } from "../utils/encryption.server";
import { logInfo, logError, logWarn } from "../utils/logger.server";

/**
 * Universal WABA and Phone discovery using Meta Graph API v21.0.
 * Covers Embedded Signup, User Tokens, System User Tokens, and Business Portfolios.
 */
async function discoverWabaCredentials(accessToken: string, appId: string, appSecret: string) {
  const BASE = "https://graph.facebook.com/v21.0";
  const auth = `access_token=${accessToken}`;
  const appAuth = `access_token=${appId}|${appSecret}`;

  let wabaIds: string[] = [];

  // Strategy 1: Direct /me/whatsapp_business_accounts
  try {
    const meWabaRes = await fetch(`${BASE}/me/whatsapp_business_accounts?fields=id,name,phone_numbers{id,display_phone_number,verified_name,status,quality_rating,messaging_limit_tier}&${auth}`);
    const meWabaData = (await meWabaRes.json()) as any;
    if (meWabaData?.data && Array.isArray(meWabaData.data)) {
      for (const w of meWabaData.data) {
        if (w.id) wabaIds.push(w.id);
        if (w.phone_numbers?.data?.length > 0) {
          const p = w.phone_numbers.data[0];
          return {
            wabaId: w.id,
            phoneNumberId: p.id,
            displayPhoneNumber: p.display_phone_number || null,
            qualityRating: p.quality_rating || "UNKNOWN",
            messagingLimit: p.messaging_limit_tier || "TIER_250",
          };
        }
      }
    }
  } catch (e) {
    console.warn("Direct /me/whatsapp_business_accounts check error:", e);
  }

  // Strategy 2: /debug_token granular scopes (WhatsApp Embedded Signup standard)
  try {
    const debugRes = await fetch(`${BASE}/debug_token?input_token=${accessToken}&${appAuth}`);
    const debugData = (await debugRes.json()) as any;

    if (debugData?.data?.granular_scopes) {
      for (const scopeItem of debugData.data.granular_scopes) {
        if (
          scopeItem.scope === "whatsapp_business_management" ||
          scopeItem.scope === "whatsapp_business_messaging"
        ) {
          if (Array.isArray(scopeItem.target_ids)) {
            wabaIds.push(...scopeItem.target_ids);
          }
        }
      }
    }
  } catch (e) {
    console.warn("debug_token check failed, continuing to fallback", e);
  }

  // Strategy 3: /me/assigned_whatsapp_business_accounts
  try {
    const assignedRes = await fetch(`${BASE}/me/assigned_whatsapp_business_accounts?fields=id,name&${auth}`);
    const assignedData = (await assignedRes.json()) as any;
    if (assignedData?.data && Array.isArray(assignedData.data)) {
      for (const w of assignedData.data) {
        if (w.id) wabaIds.push(w.id);
      }
    }
  } catch {}

  // Strategy 4: Query /me/businesses & /me/client_whatsapp_business_accounts
  try {
    const bizRes = await fetch(`${BASE}/me/businesses?fields=id,name,owned_whatsapp_business_accounts{id,name}&${auth}`);
    const bizData = (await bizRes.json()) as any;
    if (bizData?.data && Array.isArray(bizData.data)) {
      for (const biz of bizData.data) {
        if (biz.owned_whatsapp_business_accounts?.data) {
          for (const w of biz.owned_whatsapp_business_accounts.data) {
            if (w.id) wabaIds.push(w.id);
          }
        }
      }
    }
  } catch {}

  // Deduplicate discovered WABA IDs
  wabaIds = Array.from(new Set(wabaIds));

  // Retrieve phone numbers for each discovered WABA
  for (const wabaId of wabaIds) {
    try {
      const phoneRes = await fetch(
        `${BASE}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,status,quality_rating,messaging_limit_tier&${auth}`
      );
      const phoneData = (await phoneRes.json()) as any;
      const phones: any[] = phoneData.data || [];

      if (phones.length > 0) {
        const phone = phones.find((p: any) => p.status === "CONNECTED" || p.status === "VERIFIED") || phones[0];
        return {
          wabaId,
          phoneNumberId: phone.id,
          displayPhoneNumber: phone.display_phone_number || null,
          qualityRating: phone.quality_rating || "UNKNOWN",
          messagingLimit: phone.messaging_limit_tier || "TIER_250",
        };
      }
    } catch {}
  }

  if (wabaIds.length > 0) {
    return {
      wabaId: wabaIds[0],
      phoneNumberId: "",
      displayPhoneNumber: null,
      qualityRating: "UNKNOWN",
      messagingLimit: "TIER_250",
    };
  }

  throw new Error("No WhatsApp Business Account found under this Facebook login. Ensure your Facebook account has admin access to your WhatsApp Business Account.");
}

function renderClosePopupOrRedirectHtml(targetUrl: string) {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Connecting WhatsApp...</title>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
    .card { text-align: center; padding: 2rem; background: #1e293b; border-radius: 1rem; border: 1px solid #334155; }
    .spinner { border: 3px solid rgba(255,255,255,0.1); border-top: 3px solid #10b981; border-radius: 50%; width: 36px; height: 36px; animation: spin 0.8s linear infinite; margin: 0 auto 1rem; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h3>Connecting to Shopify...</h3>
    <p style="color: #94a3b8; font-size: 0.875rem;">Redirecting you back to StorePing...</p>
  </div>
  <script>
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.location.href = "${targetUrl}";
        window.close();
      } else if (window.top) {
        window.top.location.href = "${targetUrl}";
      } else {
        window.location.href = "${targetUrl}";
      }
    } catch (e) {
      window.location.href = "${targetUrl}";
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
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
    const failUrl = `https://${shop}/admin/apps/${apiKey}/app/connect?error=${encodeURIComponent(errorDescription || error || "cancelled")}`;
    return renderClosePopupOrRedirectHtml(failUrl);
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

    let accessToken = tokenData.access_token;

    // Exchange short token for long-lived / permanent system user token if possible
    try {
      const longTokenUrl = `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${accessToken}`;
      const longRes = await fetch(longTokenUrl);
      const longData = (await longRes.json()) as any;
      if (longData.access_token) {
        accessToken = longData.access_token;
      }
    } catch {}

    // 2. Discover WABA ID and Phone Number ID
    const discovered = await discoverWabaCredentials(accessToken, appId, appSecret);
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

    const successUrl = `https://${shop}/admin/apps/${apiKey}/app/connect?connected=true`;
    return renderClosePopupOrRedirectHtml(successUrl);
  } catch (err: any) {
    await logError(`Meta WhatsApp callback error: ${err.message}`, {
      shop,
      source: "auth.facebook.callback",
    });
    const errUrl = `https://${shop}/admin/apps/${apiKey}/app/connect?error=${encodeURIComponent(err.message)}`;
    return renderClosePopupOrRedirectHtml(errUrl);
  }
};
