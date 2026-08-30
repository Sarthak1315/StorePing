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
import { subscribeWabaToWebhooks } from "../utils/meta-whatsapp.server";
import { logInfo, logWarn, logError } from "../utils/logger.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const merchant = await db.merchant.findUnique({
    where: { shop },
    select: {
      id: true,
      isWhatsAppConnected: true,
      phoneNumberId: true,
      displayPhoneNumber: true,
      wabaId: true,
      qualityRating: true,
      messagingLimit: true,
      phone: true,
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
    phone: merchant?.phone ?? "",
    metaAppId: process.env.META_APP_ID ?? "",
    metaConfigId: process.env.META_CONFIG_ID ?? "",
    webhookUrl: "https://storeping.everonlab.in/api/meta/webhook",
    verifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN ?? "storeping_meta_verify_token_secure_2026",
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

    await logInfo("WhatsApp disconnected by merchant", { shop, source: "connect" });
    return json({ success: true, disconnected: true });
  }

  if (intent === "subscribeWebhook") {
    const merchant = await db.merchant.findUnique({ where: { shop } });
    if (!merchant) throw new Response("Merchant not found", { status: 404 });
    const success = await subscribeWabaToWebhooks(merchant.id);
    return json({ webhookSubscribed: success, success: true });
  }

  if (intent === "simulateIncoming") {
    const merchant = await db.merchant.findUnique({ where: { shop } });
    if (!merchant) throw new Response("Merchant not found", { status: 404 });

    const customerPhone = (formData.get("customerPhone") as string || merchant.phone || "919876543210").replace(/[^0-9]/g, "");
    const messageText = (formData.get("messageText") as string || "Hello! StorePing live chat is working perfectly.").trim();

    const conv = await db.conversation.upsert({
      where: {
        merchantId_customerPhone: {
          merchantId: merchant.id,
          customerPhone,
        },
      },
      create: {
        merchantId: merchant.id,
        customerPhone,
        customerName: "Customer",
        lastMessageText: messageText,
        lastMessageAt: new Date(),
        unreadCount: 1,
        status: "ACTIVE",
        cswExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
      update: {
        lastMessageText: messageText,
        lastMessageAt: new Date(),
        unreadCount: { increment: 1 },
        status: "ACTIVE",
        cswExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    await db.chatMessage.create({
      data: {
        conversationId: conv.id,
        sender: "CUSTOMER",
        messageType: "TEXT",
        bodyText: messageText,
        status: "DELIVERED",
      },
    });

    return json({ success: true, simulated: true });
  }

  if (intent === "connectManual") {
    const phoneNumberId = (formData.get("phoneNumberId") as string || "").trim();
    const wabaId = (formData.get("wabaId") as string || "").trim();
    const displayPhoneNumber = (formData.get("displayPhoneNumber") as string || "").trim();
    const waAccessToken = (formData.get("waAccessToken") as string || "").trim();

    if (!phoneNumberId || !waAccessToken) {
      return json({ error: "Phone Number ID and Access Token are required." }, { status: 400 });
    }

    try {
      // Validate credentials by pinging Meta Graph API
      const metaRes = await fetch(
        `https://graph.facebook.com/v21.0/${phoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating,messaging_limit_tier&access_token=${waAccessToken}`
      );
      const metaData = (await metaRes.json()) as any;

      if (!metaRes.ok || metaData.error) {
        throw new Error(metaData.error?.message || "Invalid Meta WhatsApp credentials or token expired.");
      }

      const qualityRating = metaData.quality_rating || "GREEN";
      const messagingLimit = metaData.messaging_limit_tier || "TIER_250";
      const realDisplayNumber = metaData.display_phone_number || displayPhoneNumber;

      const encryptedToken = encryptToken(waAccessToken);

      const updatedMerchant = await db.merchant.upsert({
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

      // Auto-subscribe WABA to Webhooks
      await subscribeWabaToWebhooks(updatedMerchant.id);

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
      fullWidth
      title="Connect WhatsApp Business"
      subtitle="Connect your Meta / Facebook Business Portfolio to enable automated WhatsApp customer alerts & live inbox."
    >
      <BlockStack gap="400">
        {actionData?.error && (
          <Banner title="Connection Error" tone="critical">
            <p>{actionData.error}</p>
          </Banner>
        )}

        {actionData?.webhookSubscribed && (
          <Banner title="Meta Webhook Subscribed Successfully!" tone="success">
            <p>Your WhatsApp Business Account (WABA) is successfully subscribed to the Meta App webhooks!</p>
          </Banner>
        )}

        {actionData?.simulated && (
          <Banner title="Test Customer Message Ingested!" tone="success">
            <p>A test incoming message has been added. Check your <b>Live Inbox & Search</b> to see it live!</p>
          </Banner>
        )}

        {!isConnected && errorParam && (
          <Banner title="Connection Notice" tone="warning">
            <p>{decodeURIComponent(errorParam)}</p>
          </Banner>
        )}

        {(isConnected || connectedParam) && (
          <Banner title="WhatsApp Business Connected!" tone="success">
            <p>
              Your WhatsApp Business Account is actively connected. Outbound automated order notifications, shipping tracking, and 2-way support conversations are live!
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
                          <Text as="span" variant="bodySm" fontWeight="semibold">Quality Rating:</Text>
                          <Badge tone={loaderData.qualityRating === "GREEN" ? "success" : "warning"}>
                            {loaderData.qualityRating}
                          </Badge>
                        </InlineStack>
                        <InlineStack align="space-between">
                          <Text as="span" variant="bodySm" fontWeight="semibold">Messaging Tier:</Text>
                          <Text as="span" variant="bodySm">{loaderData.messagingLimit}</Text>
                        </InlineStack>
                      </BlockStack>
                    </Box>

                    <InlineStack gap="300">
                      <Button
                        onClick={() => {
                          const form = new FormData();
                          form.append("intent", "subscribeWebhook");
                          fetcher.submit(form, { method: "POST" });
                        }}
                        loading={isSubmitting}
                      >
                        🔌 Register Webhook with Meta (Sync WABA)
                      </Button>

                      <Button
                        tone="critical"
                        variant="plain"
                        onClick={() => {
                          const form = new FormData();
                          form.append("intent", "disconnect");
                          fetcher.submit(form, { method: "POST" });
                        }}
                        loading={isSubmitting}
                      >
                        Disconnect WhatsApp
                      </Button>
                    </InlineStack>
                  </BlockStack>
                ) : (
                  <BlockStack gap="400">
                    <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
                      <Box padding="300">
                        {selectedTab === 0 ? (
                          <BlockStack gap="300">
                            <Text as="p" variant="bodySm" tone="subdued">
                              Enter your WhatsApp Cloud API credentials from Meta Developer Portal.
                            </Text>

                            <TextField
                              label="Phone Number ID"
                              value={phoneNumberId}
                              onChange={setPhoneNumberId}
                              autoComplete="off"
                              placeholder="e.g. 1166112789916926"
                              helpText="Found in Meta Developers ➡️ WhatsApp ➡️ API Setup"
                            />

                            <TextField
                              label="WhatsApp Business Account (WABA) ID"
                              value={wabaId}
                              onChange={setWabaId}
                              autoComplete="off"
                              placeholder="e.g. 2066881594231087"
                            />

                            <TextField
                              label="Display Phone Number"
                              value={displayPhoneNumber}
                              onChange={setDisplayPhoneNumber}
                              autoComplete="off"
                              placeholder="e.g. +91 76239 61821"
                            />

                            <TextField
                              label="System User / Permanent Access Token"
                              type="password"
                              value={waAccessToken}
                              onChange={setWaAccessToken}
                              autoComplete="off"
                              placeholder="EAABw..."
                              helpText="Access token with whatsapp_business_messaging & whatsapp_business_management permissions."
                            />

                            <Button
                              variant="primary"
                              loading={isSubmitting}
                              onClick={() => {
                                const form = new FormData();
                                form.append("intent", "connectManual");
                                form.append("phoneNumberId", phoneNumberId);
                                form.append("wabaId", wabaId);
                                form.append("displayPhoneNumber", displayPhoneNumber);
                                form.append("waAccessToken", waAccessToken);
                                fetcher.submit(form, { method: "POST" });
                              }}
                            >
                              Save & Connect WhatsApp Account
                            </Button>
                          </BlockStack>
                        ) : (
                          <BlockStack gap="300">
                            <Text as="p" variant="bodySm" tone="subdued">
                              Connect your Meta Business Account with 1-Click Embedded Signup.
                            </Text>

                            <Button variant="primary" onClick={handleConnectOAuth}>
                              Continue with Facebook / Meta
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

          {/* Webhook Configuration & Verification Details */}
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">
                  📡 Meta Webhook Settings
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Ensure these exact values are set in Meta Developer Dashboard ➡️ WhatsApp ➡️ Configuration:
                </Text>

                <Box padding="200" background="bg-surface-secondary" borderRadius="150">
                  <BlockStack gap="100">
                    <Text as="span" variant="bodyXs" fontWeight="semibold">Callback URL:</Text>
                    <Text as="span" variant="bodyXs" breakWord>{loaderData.webhookUrl}</Text>
                  </BlockStack>
                </Box>

                <Box padding="200" background="bg-surface-secondary" borderRadius="150">
                  <BlockStack gap="100">
                    <Text as="span" variant="bodyXs" fontWeight="semibold">Verify Token:</Text>
                    <Text as="span" variant="bodyXs" breakWord>{loaderData.verifyToken}</Text>
                  </BlockStack>
                </Box>

                <Text as="p" variant="bodySm" fontWeight="semibold">
                  Required Webhook Fields:
                </Text>
                <List type="bullet">
                  <List.Item>✅ <code>messages</code> (Receives customer chat replies)</List.Item>
                  <List.Item>✅ <code>message_template_status_update</code> (Template status)</List.Item>
                </List>

                <Divider />

                <Text as="p" variant="bodyXs" tone="subdued">
                  Click below to test how an incoming customer WhatsApp message looks in your Live Inbox.
                </Text>

                <Button
                  size="slim"
                  onClick={() => {
                    const form = new FormData();
                    form.append("intent", "simulateIncoming");
                    form.append("customerPhone", loaderData.phone ? loaderData.phone.replace(/[^0-9]/g, "") : "919876543210");
                    form.append("messageText", "Hello! I am inquiring about my order #1001. 😊");
                    fetcher.submit(form, { method: "POST" });
                  }}
                  loading={isSubmitting}
                >
                  🧪 Test Inbound Message Simulation
                </Button>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
