import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  Badge,
  BlockStack,
  InlineStack,
  Divider,
  DataTable,
  ProgressBar,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const merchant = await db.merchant.findUnique({
    where: { shop },
    include: {
      messages: { take: 50, orderBy: { createdAt: "desc" } },
      cartRecoveries: { take: 50, orderBy: { createdAt: "desc" } },
    },
  });

  if (!merchant) throw new Response("Merchant not found", { status: 404 });

  const totalSent = await db.messageLog.count({ where: { merchantId: merchant.id } });
  const totalDelivered = await db.messageLog.count({ where: { merchantId: merchant.id, status: "DELIVERED" } });
  const totalRead = await db.messageLog.count({ where: { merchantId: merchant.id, status: "READ" } });
  const totalFailed = await db.messageLog.count({ where: { merchantId: merchant.id, status: "FAILED" } });

  const totalCarts = await db.cartRecovery.count({ where: { merchantId: merchant.id } });
  const recoveredCarts = await db.cartRecovery.count({ where: { merchantId: merchant.id, status: "RECOVERED" } });
  const recoveredAmount = merchant.cartRecoveries
    .filter((c) => c.status === "RECOVERED")
    .reduce((acc, curr) => acc + curr.cartTotal, 0);

  const cartRecoveryRate = totalCarts > 0 ? Math.round((recoveredCarts / totalCarts) * 100) : 0;

  return json({
    merchant,
    stats: {
      totalSent,
      totalDelivered,
      totalRead,
      totalFailed,
      totalCarts,
      recoveredCarts,
      recoveredAmount: recoveredAmount.toFixed(2),
      cartRecoveryRate,
      currency: merchant.currency,
    },
    messages: merchant.messages || [],
    cartRecoveries: merchant.cartRecoveries || [],
  });
};

export default function AnalyticsPage() {
  const { stats, messages, cartRecoveries } = useLoaderData<typeof loader>();

  return (
    <Page
      title="StorePing Analytics"
      subtitle="Comprehensive performance metrics for WhatsApp messaging and cart recovery revenue."
    >
      <Layout>
        {/* Performance Metric Cards */}
        <Layout.Section>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Card>
              <BlockStack gap="200">
                <Text as="p" variant="headingSm" tone="subdued">Recovered Revenue</Text>
                <Text as="h2" variant="heading2xl" fontWeight="bold">
                  {stats.currency} {stats.recoveredAmount}
                </Text>
                <Text as="p" variant="bodySm" tone="success">
                  {stats.recoveredCarts} carts saved
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="p" variant="headingSm" tone="subdued">Cart Recovery Rate</Text>
                <Text as="h2" variant="heading2xl" fontWeight="bold">
                  {stats.cartRecoveryRate}%
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {stats.totalCarts} total abandoned checkouts
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="p" variant="headingSm" tone="subdued">Delivered & Read Messages</Text>
                <Text as="h2" variant="heading2xl" fontWeight="bold">
                  {stats.totalDelivered + stats.totalRead}
                </Text>
                <Text as="p" variant="bodySm" tone="success">
                  ✓ {stats.totalRead} Verified Reads
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="p" variant="headingSm" tone="subdued">Failed Dispatches</Text>
                <Text as="h2" variant="heading2xl" fontWeight="bold">
                  {stats.totalFailed}
                </Text>
                <Text as="p" variant="bodySm" tone={stats.totalFailed > 0 ? "critical" : "subdued"}>
                  {stats.totalFailed > 0 ? "Check Meta tier limits" : "0 delivery errors"}
                </Text>
              </BlockStack>
            </Card>
          </div>
        </Layout.Section>

        {/* Abandoned Cart Recovery Log */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">🛒 Abandoned Cart Recovery Activity</Text>
              <Divider />

              {cartRecoveries.length === 0 ? (
                <Box padding="400">
                  <Text as="p" tone="subdued" alignment="center">
                    No abandoned carts recorded yet. StorePing will automatically track abandoned checkouts.
                  </Text>
                </Box>
              ) : (
                <DataTable
                  columnContentTypes={["text", "text", "numeric", "text", "text"]}
                  headings={["Customer", "Phone", "Cart Total", "Status", "Date"]}
                  rows={cartRecoveries.map((c) => [
                    c.customerName || "Customer",
                    c.customerPhone,
                    `${c.currency} ${c.cartTotal.toFixed(2)}`,
                    <Badge
                      key={c.id}
                      tone={
                        c.status === "RECOVERED"
                          ? "success"
                          : c.status === "SENT"
                          ? "info"
                          : c.status === "CANCELLED"
                          ? "subdued"
                          : "attention"
                      }
                    >
                      {c.status}
                    </Badge>,
                    new Date(c.createdAt).toLocaleDateString(),
                  ])}
                />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Full Message Log */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">📋 WhatsApp Message Dispatch Audit</Text>
              <Divider />

              {messages.length === 0 ? (
                <Box padding="400">
                  <Text as="p" tone="subdued" alignment="center">
                    No message history yet.
                  </Text>
                </Box>
              ) : (
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "text"]}
                  headings={["Recipient Phone", "Customer", "Event", "Delivery Status", "Time"]}
                  rows={messages.map((m) => [
                    m.recipientPhone,
                    m.customerName || "Customer",
                    m.eventType,
                    <Badge
                      key={m.id}
                      tone={
                        m.status === "READ"
                          ? "success"
                          : m.status === "DELIVERED"
                          ? "info"
                          : m.status === "FAILED"
                          ? "critical"
                          : "attention"
                      }
                    >
                      {m.status}
                    </Badge>,
                    new Date(m.createdAt).toLocaleString(),
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
