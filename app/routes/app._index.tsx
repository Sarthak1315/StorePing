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
  List,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { seedDefaultTemplates } from "../utils/template.server";
import { refreshWabaHealth } from "../utils/meta-whatsapp.server";
import { getMerchantBillingSummary } from "../utils/meta-pricing.server";

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
  const [totalSent, totalDelivered, totalRead, totalRecoveredCarts, confirmations, recentConversations] = await Promise.all([
    db.messageLog.count({ where: { merchantId: merchant.id } }),
    db.messageLog.count({ where: { merchantId: merchant.id, status: "DELIVERED" } }),
    db.messageLog.count({ where: { merchantId: merchant.id, status: "READ" } }),
    db.cartRecovery.count({ where: { merchantId: merchant.id, status: "RECOVERED" } }),
    db.orderConfirmation.findMany({
      where: { merchantId: merchant.id },
      orderBy: { updatedAt: "desc" },
      take: 6,
    }),
    db.conversation.findMany({
      where: { merchantId: merchant.id },
      orderBy: { lastMessageAt: "desc" },
      take: 6,
    }),
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

  // Build unified customer notification feed
  const customerNotifications: Array<{
    id: string;
    type: "CONFIRMED" | "UPDATE_REQUESTED" | "INBOUND_CHAT" | "RECOVERY";
    title: string;
    description: string;
    time: string;
    actionUrl: string;
    actionLabel: string;
    badgeTone: "success" | "attention" | "info" | "warning";
  }> = [];

  for (const conf of confirmations) {
    if (conf.status === "UPDATE_REQUESTED") {
      customerNotifications.push({
        id: `conf-${conf.id}`,
        type: "UPDATE_REQUESTED",
        title: `Order #${conf.orderNumber}: Address Change Requested`,
        description: `${conf.customerName || "Customer"} requested: "${conf.customerNotes || "Address change"}"`,
        time: new Date(conf.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        actionUrl: "/app/orders",
        actionLabel: "View Order",
        badgeTone: "attention",
      });
    } else if (conf.status === "CONFIRMED") {
      customerNotifications.push({
        id: `conf-${conf.id}`,
        type: "CONFIRMED",
        title: `Order #${conf.orderNumber}: Delivery Address Confirmed`,
        description: `${conf.customerName || "Customer"} confirmed delivery via WhatsApp button.`,
        time: new Date(conf.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        actionUrl: "/app/orders",
        actionLabel: "View Order",
        badgeTone: "success",
      });
    }
  }

  for (const conv of recentConversations) {
    if (conv.lastMessageText) {
      customerNotifications.push({
        id: `conv-${conv.id}`,
        type: "INBOUND_CHAT",
        title: `Message from ${conv.customerName || `+${conv.customerPhone}`}`,
        description: conv.lastMessageText,
        time: new Date(conv.lastMessageAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        actionUrl: "/app/inbox",
        actionLabel: "Open Inbox",
        badgeTone: "info",
      });
    }
  }

  const billingSummary = await getMerchantBillingSummary(merchant.id);

  return json({
    merchant,
    billingSummary,
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
    customerNotifications: customerNotifications.slice(0, 6),
    recentMessages: merchant.messages || [],
  });
};

export default function DashboardOverview() {
  const { merchant, billingSummary, metrics, customerNotifications, recentMessages } = useLoaderData<typeof loader>();
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
          content: "💳 Plans & Billing",
          onAction: () => navigate("/app/billing"),
        },
        {
          content: "📦 Orders",
          onAction: () => navigate("/app/orders"),
        },
        {
          content: "💬 Inbox",
          onAction: () => navigate("/app/inbox"),
        },
      ]}
    >
      <Layout>
        {/* 🚨 Critical Meta Alert Banner (Payment Required / Limit Exceeded) */}
        {alertType === "PAYMENT_REQUIRED" && (
          <Layout.Section>
            <Banner
              title="Meta Cloud API Payment Method Required"
              tone="critical"
              action={{
                content: "Add Payment in Meta Business Suite",
                url: "https://business.facebook.com/billing_hub/payment_methods",
                external: true,
              }}
            >
              <Text as="p">
                Your Meta WhatsApp Business account has exceeded its free tier limit. Meta has paused outgoing marketing dispatches until a valid payment method is added.
              </Text>
            </Banner>
          </Layout.Section>
        )}

        {/* Top 4 KPI Metric Cards */}
        <Layout.Section>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px" }}>
            <Card>
              <BlockStack gap="200">
                <Text as="p" tone="subdued" variant="bodySm">
                  Total Dispatches
                </Text>
                <Text as="h3" variant="headingXl">
                  {metrics.totalSent}
                </Text>
                <Badge tone="info">Live Automated Dispatches</Badge>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="p" tone="subdued" variant="bodySm">
                  Delivery Rate
                </Text>
                <Text as="h3" variant="headingXl">
                  {metrics.deliveryRate}%
                </Text>
                <Badge tone={metrics.deliveryRate >= 90 ? "success" : "attention"}>
                  {metrics.deliveryRate >= 90 ? "High Deliverability" : "Attention"}
                </Badge>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="p" tone="subdued" variant="bodySm">
                  Read Rate
                </Text>
                <Text as="h3" variant="headingXl">
                  {metrics.readRate}%
                </Text>
                <Badge tone="success">WhatsApp Blue Ticks</Badge>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="p" tone="subdued" variant="bodySm">
                  Recovered Revenue
                </Text>
                <Text as="h3" variant="headingXl">
                  {metrics.currency} {metrics.recoveredRevenue}
                </Text>
                <Badge tone="success">
                  {`${metrics.totalRecoveredCarts} Carts Recovered`}
                </Badge>
              </BlockStack>
            </Card>
          </div>
        </Layout.Section>

        {/* 🔔 Customer Notification & Live Activity Center */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    🔔 Customer Activity & WhatsApp Notifications
                  </Text>
                  {customerNotifications.length > 0 && (
                    <Badge tone="success">{`${customerNotifications.length} Recent Events`}</Badge>
                  )}
                </InlineStack>
                <InlineStack gap="200">
                  <Button variant="plain" onClick={() => navigate("/app/inbox")}>
                    Go to Inbox
                  </Button>
                  <Button variant="plain" onClick={() => navigate("/app/orders")}>
                    Go to Orders
                  </Button>
                </InlineStack>
              </InlineStack>

              <Divider />

              {customerNotifications.length === 0 ? (
                <Box padding="400">
                  <Text as="p" tone="subdued" alignment="center">
                    No customer activity yet. When customers confirm addresses, request changes, or message your store on WhatsApp, live notifications will display here!
                  </Text>
                </Box>
              ) : (
                <BlockStack gap="300">
                  {customerNotifications.map((notif) => (
                    <Box
                      key={notif.id}
                      padding="300"
                      background="bg-surface-secondary"
                      borderRadius="200"
                      borderWidth="025"
                      borderColor="border"
                    >
                      <InlineStack align="space-between" blockAlign="center" wrap={false}>
                        <InlineStack gap="300" blockAlign="center">
                          <Badge tone={notif.badgeTone}>
                            {notif.type === "UPDATE_REQUESTED"
                              ? "⚠️ Address Change"
                              : notif.type === "CONFIRMED"
                              ? "✅ Address Confirmed"
                              : notif.type === "INBOUND_CHAT"
                              ? "💬 Customer Chat"
                              : "🛒 Recovered"}
                          </Badge>
                          <BlockStack gap="050">
                            <Text as="p" variant="bodySm" fontWeight="bold">
                              {notif.title}
                            </Text>
                            <Text as="p" variant="bodyXs" tone="subdued">
                              {notif.description}
                            </Text>
                          </BlockStack>
                        </InlineStack>

                        <InlineStack gap="200" blockAlign="center">
                          <Text as="span" variant="bodyXs" tone="subdued">
                            {notif.time}
                          </Text>
                          <Button size="slim" onClick={() => navigate(notif.actionUrl)}>
                            {notif.actionLabel}
                          </Button>
                        </InlineStack>
                      </InlineStack>
                    </Box>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* 2 Columns: Connection / Health Card & Live Activity Feed */}
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="400">
              <Text as="h3" variant="headingMd">Account & Quality Health</Text>
              <Divider />

              <BlockStack gap="200">
                <InlineStack align="space-between">
                  <Text as="p" variant="bodySm" tone="subdued">Connection</Text>
                  <Badge tone={isConnected ? "success" : "critical"}>
                    {isConnected ? "Connected" : "Disconnected"}
                  </Badge>
                </InlineStack>

                <InlineStack align="space-between">
                  <Text as="p" variant="bodySm" tone="subdued">Meta Phone Quality</Text>
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

        {/* 📋 Recent Message Activity Feed */}
        <Layout.Section variant="oneThird">
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
