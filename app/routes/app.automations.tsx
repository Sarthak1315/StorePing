import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useState } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  Button,
  Banner,
  BlockStack,
  InlineStack,
  Divider,
  Checkbox,
  TextField,
  Select,
  Badge,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { logInfo } from "../utils/logger.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const merchant = await db.merchant.findUnique({
    where: { shop },
  });

  return json({ merchant });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();

  const cartRecoveryEnabled = formData.get("cartRecoveryEnabled") === "true";
  const orderConfirmEnabled = formData.get("orderConfirmEnabled") === "true";
  const orderShippedEnabled = formData.get("orderShippedEnabled") === "true";
  const orderDeliveredEnabled = formData.get("orderDeliveredEnabled") === "true";
  const promotionsEnabled = formData.get("promotionsEnabled") === "true";
  const reEngagementEnabled = formData.get("reEngagementEnabled") === "true";
  const supportChatEnabled = formData.get("supportChatEnabled") === "true";
  const codVerificationEnabled = formData.get("codVerificationEnabled") === "true";

  const cartDelay1 = parseInt(formData.get("cartDelay1") as string) || 30;
  const cartDelay2 = parseInt(formData.get("cartDelay2") as string) || 360;
  const cartDiscountCode = (formData.get("cartDiscountCode") as string) || "SAVE10";

  await db.merchant.update({
    where: { shop },
    data: {
      cartRecoveryEnabled,
      orderConfirmEnabled,
      orderShippedEnabled,
      orderDeliveredEnabled,
      promotionsEnabled,
      reEngagementEnabled,
      supportChatEnabled,
      codVerificationEnabled,
      cartDelay1,
      cartDelay2,
      cartDiscountCode,
    },
  });

  await logInfo("Automations (7 flows) updated", { shop, source: "automations" });

  return json({ success: true });
};

export default function AutomationsPage() {
  const { merchant } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [cartRecovery, setCartRecovery] = useState(merchant?.cartRecoveryEnabled ?? true);
  const [orderConfirm, setOrderConfirm] = useState(merchant?.orderConfirmEnabled ?? true);
  const [orderShipped, setOrderShipped] = useState(merchant?.orderShippedEnabled ?? true);
  const [orderDelivered, setOrderDelivered] = useState(merchant?.orderDeliveredEnabled ?? true);
  const [promotions, setPromotions] = useState(merchant?.promotionsEnabled ?? true);
  const [reEngagement, setReEngagement] = useState(merchant?.reEngagementEnabled ?? true);
  const [supportChat, setSupportChat] = useState(merchant?.supportChatEnabled ?? true);
  const [codVerification, setCodVerification] = useState(merchant?.codVerificationEnabled ?? true);

  const [delay1, setDelay1] = useState(String(merchant?.cartDelay1 ?? 30));
  const [delay2, setDelay2] = useState(String(merchant?.cartDelay2 ?? 360));
  const [discountCode, setDiscountCode] = useState(merchant?.cartDiscountCode ?? "SAVE10");

  const isSaving = fetcher.state !== "idle";

  const handleSave = () => {
    const form = new FormData();
    form.append("cartRecoveryEnabled", String(cartRecovery));
    form.append("orderConfirmEnabled", String(orderConfirm));
    form.append("orderShippedEnabled", String(orderShipped));
    form.append("orderDeliveredEnabled", String(orderDelivered));
    form.append("promotionsEnabled", String(promotions));
    form.append("reEngagementEnabled", String(reEngagement));
    form.append("supportChatEnabled", String(supportChat));
    form.append("codVerificationEnabled", String(codVerification));
    form.append("cartDelay1", delay1);
    form.append("cartDelay2", delay2);
    form.append("cartDiscountCode", discountCode);
    fetcher.submit(form, { method: "POST" });
  };

  return (
    <Page
      title="Store Automation Engine (7 Core Flows)"
      subtitle="Configure and activate automated WhatsApp customer touchpoints across the entire buyer journey."
      primaryAction={{
        content: "Save Automations",
        onAction: handleSave,
        loading: isSaving,
      }}
    >
      <BlockStack gap="500">
        {fetcher.data?.success && (
          <Banner title="Automation Rules Saved Successfully" tone="success" onDismiss={() => {}}>
            All 7 WhatsApp messaging triggers are active and synchronized with your store events.
          </Banner>
        )}

        <Layout>
          {/* 1. 🛒 Abandoned Cart Recovery */}
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="h3" variant="headingMd">🛒 1. Abandoned Cart Recovery Flow</Text>
                      <Badge tone={cartRecovery ? "success" : "subdued"}>{cartRecovery ? "Active" : "Disabled"}</Badge>
                    </InlineStack>
                    <Text as="p" tone="subdued">
                      Sends automated multi-step reminders with direct 1-click checkout recovery links and dynamic coupons when shoppers leave items.
                    </Text>
                  </BlockStack>
                  <Checkbox
                    label=""
                    checked={cartRecovery}
                    onChange={(val) => setCartRecovery(val)}
                  />
                </InlineStack>

                {cartRecovery && (
                  <>
                    <Divider />
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px" }}>
                      <Select
                        label="Step 1 Delay (Gentle Reminder)"
                        options={[
                          { label: "15 Minutes", value: "15" },
                          { label: "30 Minutes (Recommended)", value: "30" },
                          { label: "1 Hour", value: "60" },
                        ]}
                        value={delay1}
                        onChange={(val) => setDelay1(val)}
                      />

                      <Select
                        label="Step 2 Delay (Discount Urgency)"
                        options={[
                          { label: "3 Hours", value: "180" },
                          { label: "6 Hours (Recommended)", value: "360" },
                          { label: "12 Hours", value: "720" },
                          { label: "24 Hours", value: "1440" },
                        ]}
                        value={delay2}
                        onChange={(val) => setDelay2(val)}
                      />

                      <TextField
                        label="Discount Coupon Code"
                        value={discountCode}
                        onChange={(val) => setDiscountCode(val)}
                        helpText="Automatically injected into checkout links"
                        autoComplete="off"
                      />
                    </div>
                  </>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* 2. 🧾 Order Confirmation Flow */}
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="h3" variant="headingMd">🧾 2. Order Confirmation Flow</Text>
                      <Badge tone={orderConfirm ? "success" : "subdued"}>{orderConfirm ? "Active" : "Disabled"}</Badge>
                    </InlineStack>
                    <Text as="p" tone="subdued">
                      Instantly sends a WhatsApp receipt with order number, item summary, and status link when an order is placed on storefront or created in Admin.
                    </Text>
                  </BlockStack>
                  <Checkbox
                    label=""
                    checked={orderConfirm}
                    onChange={(val) => setOrderConfirm(val)}
                  />
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* 3. 🚚 Shipping & Live Tracking Flow */}
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="h3" variant="headingMd">🚚 3. Shipping & Live Tracking Flow</Text>
                      <Badge tone={orderShipped ? "success" : "subdued"}>{orderShipped ? "Active" : "Disabled"}</Badge>
                    </InlineStack>
                    <Text as="p" tone="subdued">
                      Dispatches tracking number, courier carrier details (Shiprocket, Delhivery, BlueDart), and 1-click live tracking button on fulfillment.
                    </Text>
                  </BlockStack>
                  <Checkbox
                    label=""
                    checked={orderShipped}
                    onChange={(val) => setOrderShipped(val)}
                  />
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* 4. 📦 Delivery & Review Request Flow */}
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="h3" variant="headingMd">📦 4. Order Delivery & Review Flow</Text>
                      <Badge tone={orderDelivered ? "success" : "subdued"}>{orderDelivered ? "Active" : "Disabled"}</Badge>
                    </InlineStack>
                    <Text as="p" tone="subdued">
                      Delivers a post-purchase celebration message when carrier marks package as delivered, requesting product reviews and giving VIP discounts.
                    </Text>
                  </BlockStack>
                  <Checkbox
                    label=""
                    checked={orderDelivered}
                    onChange={(val) => setOrderDelivered(val)}
                  />
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* 5. 🎁 Offer & Promotion Flow */}
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="h3" variant="headingMd">🎁 5. Offer & Promotion Flow</Text>
                      <Badge tone={promotions ? "success" : "subdued"}>{promotions ? "Active" : "Disabled"}</Badge>
                    </InlineStack>
                    <Text as="p" tone="subdued">
                      Broadcast seasonal deals, festival discounts (Diwali/Eid/New Year), and flash sale notifications with customized coupon buttons.
                    </Text>
                  </BlockStack>
                  <Checkbox
                    label=""
                    checked={promotions}
                    onChange={(val) => setPromotions(val)}
                  />
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* 6. 🔄 Customer Re-Engagement & Win-Back Flow */}
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="h3" variant="headingMd">🔄 6. Customer Re-Engagement & Win-Back Flow</Text>
                      <Badge tone={reEngagement ? "success" : "subdued"}>{reEngagement ? "Active" : "Disabled"}</Badge>
                    </InlineStack>
                    <Text as="p" tone="subdued">
                      Re-activates dormant customers who haven't placed an order in over 45 days with personalized recommendations and exclusive return gifts.
                    </Text>
                  </BlockStack>
                  <Checkbox
                    label=""
                    checked={reEngagement}
                    onChange={(val) => setReEngagement(val)}
                  />
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* 7. 💬 WhatsApp Communication & 2-Way Live Support */}
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="h3" variant="headingMd">💬 7. WhatsApp 2-Way Communication & Support Inbox</Text>
                      <Badge tone={supportChat ? "success" : "subdued"}>{supportChat ? "Active" : "Disabled"}</Badge>
                    </InlineStack>
                    <Text as="p" tone="subdued">
                      Enables customer questions, complaints, and live order tracking inquiries to flow into your Live Inbox (`/app/inbox`) for real-time 1-click replies.
                    </Text>
                  </BlockStack>
                  <Checkbox
                    label=""
                    checked={supportChat}
                    onChange={(val) => setSupportChat(val)}
                  />
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
