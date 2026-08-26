import { useState, useEffect } from "react";
import { useFetcher, useLoaderData, useSearchParams } from "@remix-run/react";
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
  List,
  Box,
  TextField,
  Tabs,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { encryptToken } from "../utils/encryption.server";
import { logInfo, logWarn, logError } from "../utils/logger.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const merchant = await db.merchant.findUnique({
    where: { shop },
    select: {
      isWhatsAppConnected: true,
      phoneNumberId: true,
      displayPhoneNumber: true,
      wabaId: true,
      qualityRating: true,
      messagingLimit: true,
    },
  });

  return json({
    shop,
    isWhatsAppConnected: merchant?.isWhatsAppConnected ?? false,
    phoneNumberId: merchant?.phoneNumberId ?? "1166112789916926",
    displayPhoneNumber: merchant?.displayPhoneNumber ?? "+91 76239 61821",
    wabaId: merchant?.wabaId ?? "2066881594231087",
    qualityRating: merchant?.qualityRating ?? "GREEN",
    messagingLimit: merchant?.messagingLimit ?? "TIER_250",
    metaAppId: process.env.META_APP_ID ?? "",
    metaConfigId: process.env.META_CONFIG_ID ?? "",
  });
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

  if (intent === "manual_connect") {
    const phoneNumberId = (formData.get("phoneNumberId") as string)?.trim();
    const wabaId = (formData.get("wabaId") as string)?.trim();
    const displayPhoneNumber = (formData.get("displayPhoneNumber") as string)?.trim() || "+91 76239 61821";
    const waAccessToken = (formData.get("waAccessToken") as string)?.trim();

    if (!phoneNumberId || !waAccessToken) {
      return json({ error: "Phone Number ID and Access Token are required." }, { status: 400 });
    }

    try {
      // Validate credentials by pinging Meta Graph API
      const metaRes = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating,messaging_limit_tier&access_token=${waAccessToken}`);
      const metaData = (await metaRes.json()) as any;

      if (!metaRes.ok || metaData.error) {
        throw new Error(metaData.error?.message || "Invalid Meta WhatsApp credentials or token expired.");
      }

      const qualityRating = metaData.quality_rating || "GREEN";
      const messagingLimit = metaData.messaging_limit_tier || "TIER_250";
      const realDisplayNumber = metaData.display_phone_number || displayPhoneNumber;

      const encryptedToken = encryptToken(waAccessToken);

      await db.merchant.upsert({
        where: { shop },
        create: {
          shop,
          wabaId: wabaId || "2066881594231087",
          phoneNumberId,
          displayPhoneNumber: realDisplayNumber,
          waAccessToken: encryptedToken,
          isWhatsAppConnected: true,
          qualityRating,
          messagingLimit,
          alertType: "NONE",
          alertMessage: null,
        },
        update: {
          wabaId: wabaId || "2066881594231087",
          phoneNumberId,
          displayPhoneNumber: realDisplayNumber,
          waAccessToken: encryptedToken,
          isWhatsAppConnected: true,
          qualityRating,
          messagingLimit,
          alertType: "NONE",
          alertMessage: null,
        },
      });

      await logInfo("WhatsApp Business Account connected via Direct API Credentials ✓", {
        shop,
        source: "connect",
        details: { phoneNumberId, wabaId },
      });

      return json({ success: true, connected: true });
    } catch (err: any) {
      await logError(`Manual connection failed: ${err.message}`, { shop, source: "connect" });
      return json({ error: err.message }, { status: 400 });
    }
  }

  return json({ success: true });
}

export default function ConnectWhatsAppPage() {
  const loaderData = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [searchParams] = useSearchParams();

  const [selectedTab, setSelectedTab] = useState(0);
  const [isConnected, setIsConnected] = useState(loaderData.isWhatsAppConnected);

  // Form state for Direct API Connection
  const [phoneNumberId, setPhoneNumberId] = useState(loaderData.phoneNumberId || "1166112789916926");
  const [wabaId, setWabaId] = useState(loaderData.wabaId || "2066881594231087");
  const [displayPhoneNumber, setDisplayPhoneNumber] = useState(loaderData.displayPhoneNumber || "+91 76239 61821");
  const [waAccessToken, setWaAccessToken] = useState("");

  const isSubmitting = fetcher.state !== "idle";
  const actionData = fetcher.data as any;

  const connectedParam = searchParams.get("connected") === "true";
  const errorParam = searchParams.get("error");

  const oauthUrl = `/auth/facebook?shop=${encodeURIComponent(loaderData.shop)}`;

  const handleConnectOAuth = () => {
    if (window.top) {
      window.top.location.href = oauthUrl;
    } else {
      window.location.href = oauthUrl;
    }
  };

  useEffect(() => {
    if (connectedParam) {
      setIsConnected(true);
    }
  }, [connectedParam]);

  useEffect(() => {
    if (actionData) {
      if (actionData.disconnected) {
        setIsConnected(false);
      } else if (actionData.connected || actionData.success) {
        setIsConnected(true);
      }
    }
  }, [actionData]);

  const tabs = [
    { id: "direct-api", content: "⚡ Direct WhatsApp Cloud API (Recommended)" },
    { id: "facebook-login", content: "🔗 Meta 1-Click Embedded Signup" },
  ];

  return (
    <Page
      title="Connect WhatsApp Business"
      subtitle="Connect your Meta / Facebook Business Portfolio to enable automated WhatsApp customer alerts."
    >
      <BlockStack gap="400">
        {actionData?.error && (
          <Banner title="Connection Error" tone="critical">
            <p>{actionData.error}</p>
          </Banner>
        )}

        {errorParam && (
          <Banner title="Connection Notice" tone="warning">
            <p>{decodeURIComponent(errorParam)}</p>
          </Banner>
        )}

        {(isConnected || connectedParam) && (
          <Banner title="WhatsApp Business Connected!" tone="success">
            <p>
              Your WhatsApp Business Account is actively connected. Outbound automated order notifications, shipping tracking, and abandoned cart recoveries are live!
            </p>
          </Banner>
        )}

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Meta WhatsApp Business Account (WABA)
                  </Text>
                  <Badge tone={isConnected ? "success" : "attention"}>
                    {isConnected ? "Connected" : "Not Connected"}
                  </Badge>
                </InlineStack>

                <Divider />

                {isConnected ? (
                  <BlockStack gap="300">
                    <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                      <BlockStack gap="150">
                        <InlineStack align="space-between">
                          <Text as="span" variant="bodySm" fontWeight="semibold">WhatsApp Phone ID:</Text>
                          <Text as="span" variant="bodySm">{phoneNumberId}</Text>
                        </InlineStack>
                        <InlineStack align="space-between">
                          <Text as="span" variant="bodySm" fontWeight="semibold">WABA Account ID:</Text>
                          <Text as="span" variant="bodySm">{wabaId}</Text>
                        </InlineStack>
                        <InlineStack align="space-between">
                          <Text as="span" variant="bodySm" fontWeight="semibold">Display Number:</Text>
                          <Text as="span" variant="bodySm" tone="success">{displayPhoneNumber}</Text>
                        </InlineStack>
                        <InlineStack align="space-between">
                          <Text as="span" variant="bodySm" fontWeight="semibold">Messaging Tier:</Text>
                          <Badge tone="info">{loaderData.messagingLimit || "TIER_250"}</Badge>
                        </InlineStack>
                      </BlockStack>
                    </Box>

                    <InlineStack gap="300">
                      <Button
                        variant="plain"
                        tone="critical"
                        loading={isSubmitting}
                        onClick={() => {
                          const form = new FormData();
                          form.append("intent", "disconnect");
                          fetcher.submit(form, { method: "POST" });
                        }}
                      >
                        Disconnect WhatsApp Account
                      </Button>
                    </InlineStack>
                  </BlockStack>
                ) : (
                  <BlockStack gap="400">
                    <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
                      <Box paddingBlockStart="300">
                        {selectedTab === 0 ? (
                          <BlockStack gap="300">
                            <Text as="p" tone="subdued">
                              Connect directly with your Everon Lab Phone Number ID and Access Token to start sending WhatsApp messages immediately.
                            </Text>

                            <TextField
                              label="Phone Number ID"
                              value={phoneNumberId}
                              onChange={setPhoneNumberId}
                              autoComplete="off"
                              helpText="Your Meta WhatsApp Phone Number ID (e.g. 1166112789916926)"
                            />

                            <TextField
                              label="WhatsApp Business Account (WABA) ID"
                              value={wabaId}
                              onChange={setWabaId}
                              autoComplete="off"
                              helpText="Your Meta WABA ID (e.g. 2066881594231087)"
                            />

                            <TextField
                              label="Display Phone Number"
                              value={displayPhoneNumber}
                              onChange={setDisplayPhoneNumber}
                              autoComplete="off"
                              helpText="e.g. +91 76239 61821"
                            />

                            <TextField
                              label="Meta System User / Permanent Access Token"
                              value={waAccessToken}
                              onChange={setWaAccessToken}
                              type="password"
                              autoComplete="off"
                              placeholder="EAA..."
                              helpText="From Meta Developer Dashboard (WhatsApp > API Setup) or Business Settings > System Users"
                            />

                            <Button
                              variant="primary"
                              size="large"
                              loading={isSubmitting}
                              onClick={() => {
                                const form = new FormData();
                                form.append("intent", "manual_connect");
                                form.append("phoneNumberId", phoneNumberId);
                                form.append("wabaId", wabaId);
                                form.append("displayPhoneNumber", displayPhoneNumber);
                                form.append("waAccessToken", waAccessToken);
                                fetcher.submit(form, { method: "POST" });
                              }}
                            >
                              Save & Connect WhatsApp
                            </Button>
                          </BlockStack>
                        ) : (
                          <BlockStack gap="300">
                            <Text as="p" tone="subdued">
                              Log in with your Facebook account and select your business portfolio.
                            </Text>
                            <Button
                              variant="primary"
                              size="large"
                              onClick={handleConnectOAuth}
                            >
                              Connect WhatsApp via Facebook
                            </Button>
                          </BlockStack>
                        )}
                      </Box>
                    </Tabs>
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">Your WhatsApp Info</Text>
                <List type="bullet">
                  <List.Item><strong>Phone ID:</strong> 1166112789916926</List.Item>
                  <List.Item><strong>WABA ID:</strong> 2066881594231087</List.Item>
                  <List.Item><strong>Number:</strong> +91 76239 61821</List.Item>
                  <List.Item><strong>Portfolio:</strong> Everon Lab (Verified)</List.Item>
                </List>

                <Divider />

                <Text as="h3" variant="headingSm">Where to get the Token?</Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Go to <strong>developers.facebook.com</strong> → Your App → <strong>WhatsApp</strong> → <strong>API Setup</strong> and copy the Access Token.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
