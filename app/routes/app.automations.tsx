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
  Box,
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
  const reEngagementEnabled = formData.get("reEngagementEnabled") === "true";
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
      reEngagementEnabled,
      codVerificationEnabled,
      cartDelay1,
      cartDelay2,
      cartDiscountCode,
    },
  });

  await logInfo("Automations settings updated", { shop, source: "automations" });

  return json({ success: true });
};

export default function AutomationsPage() {
  const { merchant } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [cartRecovery, setCartRecovery] = useState(merchant?.cartRecoveryEnabled ?? true);
  const [orderConfirm, setOrderConfirm] = useState(merchant?.orderConfirmEnabled ?? true);
  const [orderShipped, setOrderShipped] = useState(merchant?.orderShippedEnabled ?? true);
  const [orderDelivered, setOrderDelivered] = useState(merchant?.orderDeliveredEnabled ?? true);
  const [reEngagement, setReEngagement] = useState(merchant?.reEngagementEnabled ?? false);
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
    form.append("reEngagementEnabled", String(reEngagement));
    form.append("codVerificationEnabled", String(codVerification));
    form.append("cartDelay1", delay1);
    form.append("cartDelay2", delay2);
    form.append("cartDiscountCode", discountCode);
    fetcher.submit(form, { method: "POST" });
  };

  return (
    <Page
      title="Automations & Triggers"
      subtitle="Manage and customize which events automatically send WhatsApp messages to your customers."
      primaryAction={{
        content: "Save Settings",
        onAction: handleSave,
        loading: isSaving,
      }}
    >
      <Layout>
        {fetcher.data?.success && (
          <Layout.Section>
            <Banner title="Settings Saved Successfully" tone="success" />
          </Layout.Section>
        )}

        {/* 🛒 Abandoned Cart Recovery */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h3" variant="headingMd">🛒 Abandoned Cart Recovery Funnel</Text>
                  <Text as="p" tone="subdued">
                    Sends automated reminders with 1-click checkout links and dynamic coupons when customers leave without buying.
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
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <Select
                      label="Sequence 1 Delay (Gentle Reminder)"
                      options={[
                        { label: "15 Minutes", value: "15" },
                        { label: "30 Minutes (Recommended)", value: "30" },
                        { label: "1 Hour", value: "60" },
                      ]}
                      value={delay1}
                      onChange={(val) => setDelay1(val)}
                    />

                    <Select
                      label="Sequence 2 Delay (Discount Urgency)"
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
                      label="Recovery Discount Coupon"
                      value={discountCode}
                      onChange={(val) => setDiscountCode(val)}
                      helpText="Injected dynamically in Step 2"
                      autoComplete="off"
                    />
                  </div>
                </>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* 🧾 Order Lifecycle Alerts */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h3" variant="headingMd">📦 Order Lifecycle Notifications</Text>
              <Divider />

              {/* Order Placed */}
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="050">
                  <Text as="p" fontWeight="semibold">🧾 Order Placed & Confirmation</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Instantly notifies customers with order summary & prepares confirmation.
                  </Text>
                </BlockStack>
                <Checkbox label="" checked={orderConfirm} onChange={(v) => setOrderConfirm(v)} />
              </InlineStack>

              <Divider />

              {/* Order Shipped */}
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="050">
                  <Text as="p" fontWeight="semibold">🚚 Order Shipped & Live Tracking</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Sends real-time courier tracking links upon fulfillment.
                  </Text>
                </BlockStack>
                <Checkbox label="" checked={orderShipped} onChange={(v) => setOrderShipped(v)} />
              </InlineStack>

              <Divider />

              {/* Order Delivered */}
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="050">
                  <Text as="p" fontWeight="semibold">📦 Order Delivered + Review Request</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Follows up after delivery to ask for reviews and offer repeat purchase perks.
                  </Text>
                </BlockStack>
                <Checkbox label="" checked={orderDelivered} onChange={(v) => setOrderDelivered(v)} />
              </InlineStack>

              <Divider />

              {/* Re-engagement */}
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="050">
                  <Text as="p" fontWeight="semibold">🔁 Inactive Customer Win-Back (&gt;45 Days)</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Re-engages customers who haven't ordered in 45 days with exclusive new arrivals.
                  </Text>
                </BlockStack>
                <Checkbox label="" checked={reEngagement} onChange={(v) => setReEngagement(v)} />
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
