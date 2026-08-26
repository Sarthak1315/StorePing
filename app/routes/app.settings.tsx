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
  TextField,
  Select,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { sendWhatsAppMessage } from "../utils/meta-whatsapp.server";
import { normalizePhoneNumber } from "../utils/phone.utils";
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
  const intent = formData.get("intent");

  const merchant = await db.merchant.findUnique({ where: { shop } });
  if (!merchant) return json({ error: "Merchant not found" }, { status: 404 });

  // 1. Test WhatsApp Dispatch
  if (intent === "sendTestMessage") {
    const rawPhone = formData.get("testPhone") as string;
    const testPhone = normalizePhoneNumber(rawPhone);

    if (!testPhone) {
      return json({ error: "Please enter a valid 10-digit mobile number with country code." }, { status: 400 });
    }

    if (!merchant.isWhatsAppConnected) {
      return json({ error: "WhatsApp Business Account is not connected yet. Please connect on the Connect page first." }, { status: 400 });
    }

    const testBody = `👋 *StorePing Test Alert*\n\nHello! This is a test notification from *${merchant.name || "Your Store"}*.\n\nYour StorePing WhatsApp integration is active and operating at 100% health! 🚀`;

    const result = await sendWhatsAppMessage({
      merchantId: merchant.id,
      recipientPhone: testPhone,
      customerName: "Store Owner",
      eventType: "TEST_DISPATCH",
      bodyText: testBody,
      headerType: "TEXT",
      headerText: "🟢 StorePing Live Test",
      footerText: "StorePing WhatsApp Automation",
      buttonType: "CTA_URL",
      buttonText: "🛍️ Visit Dashboard",
      buttonUrl: process.env.SHOPIFY_APP_URL || "https://storeping.everonlab.in",
    });

    if (result.success) {
      return json({ success: true, message: `Live test WhatsApp message sent successfully to +${testPhone}!` });
    } else {
      return json({ error: result.error || "Failed to dispatch test message" }, { status: 500 });
    }
  }

  // 2. Save General Settings
  const storeName = formData.get("storeName") as string;
  const currency = formData.get("currency") as string;
  const timezone = formData.get("timezone") as string;

  await db.merchant.update({
    where: { shop },
    data: {
      name: storeName,
      currency,
      timezone,
    },
  });

  await logInfo("Merchant settings updated", { shop, source: "settings" });

  return json({ success: true, message: "Settings saved successfully." });
};

export default function SettingsPage() {
  const { merchant } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [testPhone, setTestPhone] = useState(merchant?.phone || "");
  const [storeName, setStoreName] = useState(merchant?.name || "");
  const [currency, setCurrency] = useState(merchant?.currency || "INR");
  const [timezone, setTimezone] = useState(merchant?.timezone || "Asia/Kolkata");

  const isLoading = fetcher.state !== "idle";
  const actionData = fetcher.data as any;

  const handleSendTest = () => {
    const form = new FormData();
    form.append("intent", "sendTestMessage");
    form.append("testPhone", testPhone);
    fetcher.submit(form, { method: "POST" });
  };

  const handleSaveSettings = () => {
    const form = new FormData();
    form.append("intent", "saveSettings");
    form.append("storeName", storeName);
    form.append("currency", currency);
    form.append("timezone", timezone);
    fetcher.submit(form, { method: "POST" });
  };

  return (
    <Page
      title="Settings & Test Console"
      subtitle="Configure store preferences and test live WhatsApp message dispatches to your phone."
    >
      <Layout>
        {actionData?.error && (
          <Layout.Section>
            <Banner title="Action Failed" tone="critical">
              <Text as="p">{actionData.error}</Text>
            </Banner>
          </Layout.Section>
        )}

        {actionData?.success && (
          <Layout.Section>
            <Banner title="Success" tone="success">
              <Text as="p">{actionData.message}</Text>
            </Banner>
          </Layout.Section>
        )}

        {/* Test Console */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">📲 Live WhatsApp Test Sender</Text>
              <Divider />
              <Text as="p" tone="subdued">
                Verify your Meta WhatsApp Cloud API connection by sending a real test message to your personal or work phone number.
              </Text>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <TextField
                  label="Test WhatsApp Mobile Number"
                  value={testPhone}
                  onChange={(v) => setTestPhone(v)}
                  placeholder="e.g. 9876543210 or 919876543210"
                  autoComplete="off"
                  helpText="Standard 10-digit Indian mobile number or international E.164"
                />
              </div>

              <InlineStack gap="200">
                <Button variant="primary" onClick={handleSendTest} loading={isLoading}>
                  Send Test WhatsApp Message
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* General Store Preferences */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Store & Currency Preferences</Text>
              <Divider />

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <TextField
                  label="Brand / Store Display Name"
                  value={storeName}
                  onChange={(v) => setStoreName(v)}
                  autoComplete="off"
                />

                <Select
                  label="Display Currency"
                  options={[
                    { label: "INR (₹) - Indian Rupee", value: "INR" },
                    { label: "USD ($) - US Dollar", value: "USD" },
                    { label: "EUR (€) - Euro", value: "EUR" },
                    { label: "GBP (£) - British Pound", value: "GBP" },
                    { label: "AED (د.إ) - UAE Dirham", value: "AED" },
                  ]}
                  value={currency}
                  onChange={(v) => setCurrency(v)}
                />

                <Select
                  label="Store Timezone"
                  options={[
                    { label: "Asia/Kolkata (IST)", value: "Asia/Kolkata" },
                    { label: "America/New_York (EST)", value: "America/New_York" },
                    { label: "Europe/London (GMT)", value: "Europe/London" },
                    { label: "Asia/Dubai (GST)", value: "Asia/Dubai" },
                  ]}
                  value={timezone}
                  onChange={(v) => setTimezone(v)}
                />
              </div>

              <InlineStack gap="200">
                <Button onClick={handleSaveSettings} loading={isLoading}>
                  Save Preferences
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
