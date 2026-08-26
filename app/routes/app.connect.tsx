import { useState, useEffect, useCallback, useRef } from "react";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import {
  Page,
  Layout,
  Card,
  Text,
  Button,
  Banner,
  Badge,
  BlockStack,
  InlineStack,
  Divider,
  Spinner,
  List,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { encryptToken } from "../utils/encryption.server";
import { logInfo, logWarn, logError } from "../utils/logger.server";

declare global {
  interface Window {
    FB: any;
    fbAsyncInit: () => void;
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const merchant = await db.merchant.findUnique({
    where: { shop },
    select: {
      isWhatsAppConnected: true,
      phoneNumberId: true,
      wabaId: true,
      qualityRating: true,
      messagingLimit: true,
    },
  });

  return json({
    shop,
    isWhatsAppConnected: merchant?.isWhatsAppConnected ?? false,
    phoneNumberId: merchant?.phoneNumberId ?? null,
    wabaId: merchant?.wabaId ?? null,
    qualityRating: merchant?.qualityRating ?? "UNKNOWN",
    metaAppId: process.env.META_APP_ID ?? "",
    metaConfigId: process.env.META_CONFIG_ID ?? "",
    appConnectUrl: `${process.env.SHOPIFY_APP_URL ?? ""}/app/connect`,
  });
}

/**
 * Auto-discovers WABA and Phone Number ID using Meta Graph API v21.0.
 */
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
    throw new Error("No Meta Business Portfolio found for this account. Ensure your Facebook account has a Business Manager.");
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

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();

  const intent = formData.get("intent");

  if (intent === "disconnect") {
    await db.merchant.updateMany({
      where: { shop },
      data: {
        isWhatsAppConnected: false,
        waAccessToken: null,
        alertType: "NONE",
        alertMessage: null,
      },
    });
    await logWarn("Merchant disconnected WhatsApp account", { shop, source: "connect" });
    return json({ success: true, disconnected: true });
  }

  const code = formData.get("code") as string;
  let wabaId = (formData.get("wabaId") as string) || "";
  let phoneNumberId = (formData.get("phoneNumberId") as string) || "";

  if (!code) {
    return json({ error: "Authorization code missing from Facebook. Please retry." }, { status: 400 });
  }

  try {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;

    if (!appId || !appSecret) {
      throw new Error("META_APP_ID or META_APP_SECRET environment variables not configured.");
    }

    // 1. Exchange auth code for long-lived access token
    const tokenUrl = `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&code=${code}&redirect_uri=${process.env.SHOPIFY_APP_URL}/app/connect`;
    const tokenRes = await fetch(tokenUrl);
    const tokenData = (await tokenRes.json()) as any;

    if (!tokenRes.ok || tokenData.error || !tokenData.access_token) {
      throw new Error(tokenData.error?.message || "Failed to exchange Meta authorization token.");
    }

    const accessToken = tokenData.access_token;
    let displayPhoneNumber: string | null = null;
    let qualityRating = "UNKNOWN";
    let messagingLimit = "TIER_250";

    // 2. Discover or complete WABA info
    if (!wabaId || !phoneNumberId) {
      const discovered = await discoverWabaCredentials(accessToken);
      wabaId = discovered.wabaId;
      phoneNumberId = discovered.phoneNumberId;
      displayPhoneNumber = discovered.displayPhoneNumber;
      qualityRating = discovered.qualityRating;
      messagingLimit = discovered.messagingLimit;
    }

    // 3. Encrypt access token at rest with AES-256-GCM
    const encryptedToken = encryptToken(accessToken);

    // 4. Save to Database
    await db.merchant.upsert({
      where: { shop },
      create: {
        shop,
        wabaId,
        phoneNumberId,
        displayPhoneNumber,
        waAccessToken: encryptedToken,
        isWhatsAppConnected: true,
        qualityRating,
        messagingLimit,
        alertType: "NONE",
        alertMessage: null,
      },
      update: {
        wabaId,
        phoneNumberId,
        displayPhoneNumber,
        waAccessToken: encryptedToken,
        isWhatsAppConnected: true,
        qualityRating,
        messagingLimit,
        alertType: "NONE",
        alertMessage: null,
      },
    });

    await logInfo("WhatsApp Business Account connected successfully ✓", {
      shop,
      source: "connect",
      details: { wabaId, phoneNumberId },
    });

    return json({ success: true, phoneNumberId });
  } catch (err: any) {
    await logError(`Connection action failed: ${err.message}`, { shop, source: "connect" });
    return json({ error: err.message }, { status: 500 });
  }
}

export default function ConnectWhatsAppPage() {
  const loaderData = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [isConnected, setIsConnected] = useState(loaderData.isWhatsAppConnected);
  const [sdkLoaded, setSdkLoaded] = useState(false);
  const [sdkError, setSdkError] = useState(false);

  const isLoading = fetcher.state !== "idle";
  const actionData = fetcher.data;
  const capturedWabaRef = useRef<{ phoneNumberId: string; wabaId: string } | null>(null);

  // Initialize Facebook SDK
  useEffect(() => {
    if (document.getElementById("facebook-jssdk")) {
      setSdkLoaded(true);
      return;
    }

    window.fbAsyncInit = function () {
      window.FB.init({
        appId: loaderData.metaAppId,
        autoLogAppEvents: true,
        xfbml: true,
        version: "v21.0",
      });
      setSdkLoaded(true);
    };

    const script = document.createElement("script");
    script.id = "facebook-jssdk";
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    script.defer = true;
    script.onerror = () => setSdkError(true);
    document.body.appendChild(script);
  }, [loaderData.metaAppId]);

  // Listen for Embedded Signup postMessage
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!["https://www.facebook.com", "https://web.facebook.com"].includes(event.origin)) return;
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (data.type === "WA_EMBEDDED_SIGNUP") {
          const { phone_number_id, waba_id } = data.data || {};
          if (phone_number_id && waba_id) {
            capturedWabaRef.current = { phoneNumberId: phone_number_id, wabaId: waba_id };
          }
        }
      } catch {}
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  // Launch Embedded Signup
  const handleConnect = useCallback(() => {
    if (!sdkLoaded || !window.FB) {
      alert("Facebook SDK is still initializing. Please wait a second.");
      return;
    }

    capturedWabaRef.current = null;

    window.FB.login(
      (response: any) => {
        if (!response.authResponse?.code) return;

        const form = new FormData();
        form.append("code", response.authResponse.code);

        if (capturedWabaRef.current) {
          form.append("wabaId", capturedWabaRef.current.wabaId);
          form.append("phoneNumberId", capturedWabaRef.current.phoneNumberId);
        }

        fetcher.submit(form, { method: "POST" });
      },
      {
        config_id: loaderData.metaConfigId,
        response_type: "code",
        override_default_response_type: true,
        extras: {
          setup: {},
          featureType: "",
          sessionInfoVersion: "2",
        },
      }
    );
  }, [sdkLoaded, fetcher, loaderData.metaConfigId]);

  useEffect(() => {
    if (actionData && "success" in actionData) {
      if (actionData.disconnected) {
        setIsConnected(false);
      } else {
        setIsConnected(true);
      }
    }
  }, [actionData]);

  return (
    <Page
      title="Connect WhatsApp Business"
      subtitle="Connect your Meta / Facebook Business Portfolio to enable automated WhatsApp customer alerts."
    >
      <Layout>
        {actionData && "error" in actionData && (
          <Layout.Section>
            <Banner title="Connection Failed" tone="critical">
              <Text as="p">{actionData.error}</Text>
            </Banner>
          </Layout.Section>
        )}

        {isConnected && (
          <Layout.Section>
            <Banner title="WhatsApp Business Connected!" tone="success">
              <Text as="p">
                Your WhatsApp Business Account is actively connected. Outbound automated order notifications, shipping alerts, and abandoned cart recoveries are now live!
              </Text>
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Meta WhatsApp Business Account (WABA)
                </Text>
                <InlineStack gap="200" blockAlign="center">
                  {isLoading && <Spinner size="small" />}
                  <Badge tone={isConnected ? "success" : "attention"}>
                    {isConnected ? "Connected" : "Not Connected"}
                  </Badge>
                </InlineStack>
              </InlineStack>

              <Divider />

              <Text as="p" tone="subdued">
                Click below to connect using Facebook Embedded Signup. You will be prompted to log in to your Facebook Portfolio and select your registered WhatsApp Business phone number.
              </Text>

              {isConnected && loaderData.phoneNumberId && (
                <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" fontWeight="semibold">Connected WhatsApp Number ID:</Text>
                    <Text as="p" variant="bodySm" tone="subdued">{loaderData.phoneNumberId}</Text>
                  </BlockStack>
                </Box>
              )}

              <InlineStack gap="300">
                <Button
                  variant="primary"
                  size="large"
                  onClick={handleConnect}
                  loading={isLoading}
                  disabled={sdkError || isConnected || (!sdkLoaded && !isConnected)}
                >
                  {isConnected ? "WhatsApp Connected ✓" : !sdkLoaded ? "Loading Facebook SDK..." : "Connect WhatsApp via Facebook"}
                </Button>

                {isConnected && (
                  <Button
                    variant="plain"
                    tone="critical"
                    onClick={() => {
                      const form = new FormData();
                      form.append("intent", "disconnect");
                      fetcher.submit(form, { method: "POST" });
                    }}
                  >
                    Disconnect Number
                  </Button>
                )}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">Requirements</Text>
              <List type="bullet">
                <List.Item>A Meta / Facebook Business Portfolio</List.Item>
                <List.Item>A WhatsApp Business Account (WABA)</List.Item>
                <List.Item>A phone number not registered on personal WhatsApp</List.Item>
              </List>

              <Divider />

              <Text as="h3" variant="headingSm">Zero Developer Markups</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                You connect directly with your own Meta account. You get 1,000 free conversations every month directly from Meta!
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
