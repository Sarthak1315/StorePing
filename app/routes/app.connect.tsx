import { useState, useEffect } from "react";
import { useFetcher, useLoaderData, useSearchParams, useNavigate } from "@remix-run/react";
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
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { logWarn } from "../utils/logger.server";

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
    phoneNumberId: merchant?.phoneNumberId ?? null,
    displayPhoneNumber: merchant?.displayPhoneNumber ?? null,
    wabaId: merchant?.wabaId ?? null,
    qualityRating: merchant?.qualityRating ?? "UNKNOWN",
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

  return json({ success: true });
}

export default function ConnectWhatsAppPage() {
  const loaderData = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [isConnected, setIsConnected] = useState(loaderData.isWhatsAppConnected);
  const isDisconnecting = fetcher.state !== "idle";

  const connectedParam = searchParams.get("connected") === "true";
  const errorParam = searchParams.get("error");

  const oauthUrl = `/auth/facebook?shop=${encodeURIComponent(loaderData.shop)}`;

  const handleConnectInMainTab = () => {
    const width = 600;
    const height = 750;
    const left = window.screen.width / 2 - width / 2;
    const top = window.screen.height / 2 - height / 2;

    const popup = window.open(
      oauthUrl,
      "MetaWhatsAppConnect",
      `width=${width},height=${height},top=${top},left=${left},scrollbars=yes,status=no`
    );

    // If popup was blocked or closed, allow standard navigation
    if (!popup || popup.closed || typeof popup.closed === "undefined") {
      window.top?.location?.assign(oauthUrl);
    }
  };

  useEffect(() => {
    if (connectedParam) {
      setIsConnected(true);
    }
  }, [connectedParam]);

  useEffect(() => {
    if (fetcher.data && (fetcher.data as any).disconnected) {
      setIsConnected(false);
    }
  }, [fetcher.data]);

  return (
    <Page
      title="Connect WhatsApp Business"
      subtitle="Connect your Meta / Facebook Business Portfolio to enable automated WhatsApp customer alerts."
    >
      <BlockStack gap="400">
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

                <Text as="p" tone="subdued">
                  Click below to connect using Meta Embedded Signup. You will log in to your Facebook Portfolio and select your registered WhatsApp Business phone number.
                </Text>

                {isConnected && (
                  <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                    <BlockStack gap="100">
                      <InlineStack align="space-between">
                        <Text as="span" variant="bodySm" fontWeight="semibold">WhatsApp Phone ID:</Text>
                        <Text as="span" variant="bodySm">{loaderData.phoneNumberId || "Active"}</Text>
                      </InlineStack>
                      {loaderData.displayPhoneNumber && (
                        <InlineStack align="space-between">
                          <Text as="span" variant="bodySm" fontWeight="semibold">Display Number:</Text>
                          <Text as="span" variant="bodySm" tone="success">{loaderData.displayPhoneNumber}</Text>
                        </InlineStack>
                      )}
                      <InlineStack align="space-between">
                        <Text as="span" variant="bodySm" fontWeight="semibold">Messaging Tier:</Text>
                        <Badge tone="info">{loaderData.messagingLimit || "TIER_250"}</Badge>
                      </InlineStack>
                    </BlockStack>
                  </Box>
                )}

                <InlineStack gap="300">
                  {!isConnected ? (
                    <Button
                      variant="primary"
                      size="large"
                      onClick={handleConnectInMainTab}
                    >
                      Connect WhatsApp via Facebook
                    </Button>
                  ) : (
                    <Button
                      variant="plain"
                      tone="critical"
                      loading={isDisconnecting}
                      onClick={() => {
                        const form = new FormData();
                        form.append("intent", "disconnect");
                        fetcher.submit(form, { method: "POST" });
                      }}
                    >
                      Disconnect WhatsApp Account
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
      </BlockStack>
    </Page>
  );
}
