import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  Badge,
  Button,
  Banner,
  BlockStack,
  InlineStack,
  Divider,
  ProgressBar,
  DataTable,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { seedDefaultTemplates } from "../utils/template.server";
import { refreshWabaHealth } from "../utils/meta-whatsapp.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // Find or create merchant
  let merchant = await db.merchant.findUnique({
    where: { shop },
    include: {
      messages: { take: 10, orderBy: { createdAt: "desc" } },
      cartRecoveries: { where: { status: "RECOVERED" } },
    },
  });

  if (!merchant) {
    merchant = await db.merchant.create({
      data: {
        shop,
        name: shop.replace(".myshopify.com", ""),
      },
      include: {
        messages: true,
        cartRecoveries: true,
      },
    });
  }

  // Non-blocking WABA health check in background
  if (merchant.isWhatsAppConnected) {
    refreshWabaHealth(merchant.id).catch(() => {});
  }

  // Compute all metrics concurrently in 1 roundtrip
  const [totalSent, totalDelivered, totalRead, totalRecoveredCarts] = await Promise.all([
    db.messageLog.count({ where: { merchantId: merchant.id } }),
    db.messageLog.count({ where: { merchantId: merchant.id, status: "DELIVERED" } }),
    db.messageLog.count({ where: { merchantId: merchant.id, status: "READ" } }),
    db.cartRecovery.count({ where: { merchantId: merchant.id, status: "RECOVERED" } }),
  ]);

  const recoveredRevenue = (merchant.cartRecoveries || []).reduce((acc, curr) => acc + curr.cartTotal, 0);

  const deliveryRate = totalSent > 0 ? Math.round((totalDelivered / totalSent) * 100) : 100;
  const readRate = totalDelivered > 0 ? Math.round((totalRead / totalDelivered) * 100) : 100;

  // Calculate tier limit numeric value
  let tierLimit = 250;
  if (merchant.messagingLimit === "TIER_1K") tierLimit = 1000;
  if (merchant.messagingLimit === "TIER_10K") tierLimit = 10000;
  if (merchant.messagingLimit === "TIER_100K") tierLimit = 100000;
  if (merchant.messagingLimit === "UNLIMITED") tierLimit = 1000000;

  const usagePercent = Math.min(100, Math.round((merchant.dailySentCount / tierLimit) * 100));

  return json({
    merchant,
    metrics: {
      totalSent,
      deliveryRate,
      readRate,
      totalRecoveredCarts,
      recoveredRevenue: recoveredRevenue.toFixed(2),
      currency: merchant.currency,
      dailySentCount: merchant.dailySentCount,
      tierLimit,
      usagePercent,
    },
    recentMessages: merchant.messages || [],
  });
};

export default function DashboardOverview() {
  const { merchant, metrics, recentMessages } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const isConnected = merchant.isWhatsAppConnected;
  const quality = merchant.qualityRating || "UNKNOWN";
  const alertType = merchant.alertType;

  return (
    <Page
      fullWidth
      title="StorePing Dashboard"
      subtitle="Automated WhatsApp Marketing, Order Alerts & Abandoned Cart Recovery"
      primaryAction={{
        content: isConnected ? "Test WhatsApp Send" : "Connect WhatsApp",
        onAction: () => navigate(isConnected ? "/app/settings" : "/app/connect"),
      }}
      secondaryActions={[
        {
          content: "📦 Orders",
          onAction: () => navigate("/app/orders"),
        },
        {
          content: "💬 Live Inbox",
          onAction: () => navigate("/app/inbox"),
        },
      ]}
    >
      <Layout>
        {/* 🚨 Critical Meta Alert Banner (Payment Required / Limit Exceeded) */}
        {alertType === "PAYMENT_REQUIRED" && (
          <Layout.Section>
            <Banner
              title="🚨 WhatsApp Messaging Halted: Meta Payment Method Required"
              tone="critical"
              action={{
                content: "Add Payment Method in Meta",
                url: "https://business.facebook.com/billing_hub",
                target: "_blank",
              }}
            >
              <Text as="p">
                {merchant.alertMessage ||
                  "Your Meta WhatsApp Business account requires an active payment method on your Meta Business Portfolio. Please update your billing details to resume message delivery."}
              </Text>
            </Banner>
          </Layout.Section>
        )}

        {alertType === "LIMIT_EXCEEDED" && (
          <Layout.Section>
            <Banner
              title="⚠️ Daily WhatsApp Message Limit Reached"
              tone="warning"
              action={{
                content: "Learn About Messaging Tiers",
                url: "https://developers.facebook.com/docs/whatsapp/messaging-limits",
                target: "_blank",
              }}
            >
              <Text as="p">
                {merchant.alertMessage ||
                  `You have reached your 24-hour limit (${metrics.dailySentCount} / ${metrics.tierLimit} messages). Outbound messages will automatically resume once your rolling 24-hour window resets.`}
              </Text>
            </Banner>
          </Layout.Section>
        )}

        {!isConnected && (
          <Layout.Section>
            <Banner
              title="WhatsApp Not Connected"
              tone="info"
              action={{
                content: "Connect WhatsApp Business",
                onAction: () => navigate("/app/connect"),
              }}
            >
              <Text as="p">
                Connect your WhatsApp Business Account via your Facebook / Meta Business Portfolio in 1 click to activate automated order alerts and abandoned cart recovery.
              </Text>
            </Banner>
          </Layout.Section>
        )}

        {/* 📊 KPI Metric Cards */}
        <Layout.Section>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card>
              <BlockStack gap="200">
                <Text as="p" variant="headingSm" tone="subdued">Recovered Revenue</Text>
                <Text as="h2" variant="heading2xl" fontWeight="bold">
                  {metrics.currency} {metrics.recoveredRevenue}
                </Text>
                <Text as="p" variant="bodySm" tone="success">
                  🛍️ {metrics.totalRecoveredCarts} Carts Recovered
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="p" variant="headingSm" tone="subdued">Total Messages Sent</Text>
                <Text as="h2" variant="heading2xl" fontWeight="bold">
                  {metrics.totalSent}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  All automated triggers
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="p" variant="headingSm" tone="subdued">Delivery Rate</Text>
                <Text as="h2" variant="heading2xl" fontWeight="bold">
                  {metrics.deliveryRate}%
                </Text>
                <Text as="p" variant="bodySm" tone="success">
                  ✓ High Delivery Score
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="p" variant="headingSm" tone="subdued">Read / Open Rate</Text>
                <Text as="h2" variant="heading2xl" fontWeight="bold">
                  {metrics.readRate}%
                </Text>
                <Text as="p" variant="bodySm" tone="success">
                  🔥 4.5x higher than email
                </Text>
              </BlockStack>
            </Card>
          </div>
        </Layout.Section>

        {/* 🟢 WhatsApp Health & Limit Card */}
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingMd">WhatsApp Health</Text>
                <Badge tone={isConnected ? "success" : "attention"}>
                  {isConnected ? "Connected" : "Disconnected"}
                </Badge>
              </InlineStack>

              <Divider />

              <BlockStack gap="200">
                <InlineStack align="space-between">
                  <Text as="p" variant="bodySm" tone="subdued">Quality Rating</Text>
                  <Badge
                    tone={
                      quality === "GREEN"
                        ? "success"
                        : quality === "YELLOW"
                        ? "attention"
                        : quality === "RED"
                        ? "critical"
                        : "info"
                    }
                  >
                    {quality}
                  </Badge>
                </InlineStack>

                <InlineStack align="space-between">
                  <Text as="p" variant="bodySm" tone="subdued">Phone Number ID</Text>
                  <Text as="p" variant="bodySm" fontWeight="semibold">
                    {merchant.phoneNumberId ? `${merchant.phoneNumberId.slice(0, 6)}...` : "None"}
                  </Text>
                </InlineStack>

                <InlineStack align="space-between">
                  <Text as="p" variant="bodySm" tone="subdued">Daily Tier Limit</Text>
                  <Badge tone="info">{merchant.messagingLimit || "TIER_250"}</Badge>
                </InlineStack>

                <Box paddingBlockStart="200">
                  <BlockStack gap="100">
                    <InlineStack align="space-between">
                      <Text as="p" variant="bodySm">24h Quota Usage</Text>
                      <Text as="p" variant="bodySm" fontWeight="bold">
                        {metrics.dailySentCount} / {metrics.tierLimit}
                      </Text>
                    </InlineStack>
                    <ProgressBar progress={metrics.usagePercent} size="small" />
                  </BlockStack>
                </Box>
              </BlockStack>

              <Divider />

              <Button fullWidth onClick={() => navigate("/app/automations")}>
                Manage Automations
              </Button>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* 📋 Recent Activity Feed */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingMd">Live Message Activity</Text>
                <Button variant="plain" onClick={() => navigate("/app/analytics")}>
                  View Full Analytics
                </Button>
              </InlineStack>

              <Divider />

              {recentMessages.length === 0 ? (
                <Box padding="400">
                  <Text as="p" tone="subdued" alignment="center">
                    No message dispatches yet. Connect your WhatsApp number to start receiving live automated events!
                  </Text>
                </Box>
              ) : (
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "text"]}
                  headings={["Recipient", "Customer", "Event Type", "Status", "Time"]}
                  rows={recentMessages.map((msg) => [
                    msg.recipientPhone,
                    msg.customerName || "Customer",
                    msg.eventType,
                    <Badge
                      key={msg.id}
                      tone={
                        msg.status === "READ"
                          ? "success"
                          : msg.status === "DELIVERED"
                          ? "info"
                          : msg.status === "FAILED"
                          ? "critical"
                          : "attention"
                      }
                    >
                      {msg.status}
                    </Badge>,
                    new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                  ])}
                />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
