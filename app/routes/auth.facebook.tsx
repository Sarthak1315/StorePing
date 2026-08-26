import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") ?? "";

  const appId = process.env.META_APP_ID;
  const configId = process.env.META_CONFIG_ID;
  const appUrl = process.env.SHOPIFY_APP_URL || "https://storeping.everonlab.in";

  const redirectUri = `${appUrl}/auth/facebook/callback`;

  const params = new URLSearchParams({
    client_id: appId || "",
    config_id: configId || "",
    redirect_uri: redirectUri,
    response_type: "code",
    state: shop,
  });

  return redirect(`https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`);
};
