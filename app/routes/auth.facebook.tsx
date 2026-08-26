import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") ?? "";

  const appId = process.env.META_APP_ID || "1083822394035933";
  const appUrl = process.env.SHOPIFY_APP_URL || "https://storeping.everonlab.in";

  const redirectUri = `${appUrl}/auth/facebook/callback`;

  // Pure WhatsApp Business OAuth - No Facebook Page or Catalog required!
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    scope: "whatsapp_business_management,whatsapp_business_messaging,public_profile",
    response_type: "code",
    state: shop,
  });

  return redirect(`https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`);
};
