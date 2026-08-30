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
  TextField,
  Select,
  Divider,
  Badge,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { logInfo, logError } from "../utils/logger.server";
import { normalizePhoneNumber } from "../utils/phone.utils";
import { sendWhatsAppMessage, registerPhoneNumber } from "../utils/meta-whatsapp.server";
import { decryptToken } from "../utils/encryption.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const merchant = await db.merchant.findUnique({
    where: { shop },
  });

  if (!merchant) {
    throw new Response("Merchant not found", { status: 404 });
  }

  return json({ merchant });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const merchant = await db.merchant.findUnique({
    where: { shop },
  });

  if (!merchant) {
    throw new Response("Merchant not found", { status: 404 });
  }

  // 1. Register Phone Number PIN with Meta
  if (intent === "registerPhone") {
    const pin = (formData.get("pin") as string) || "123456";

    if (!merchant.phoneNumberId || !merchant.waAccessToken) {
      return json({ error: "Missing Phone ID or Access Token. Connect WhatsApp first." }, { status: 400 });
    }

    try {
      const plainToken = decryptToken(merchant.waAccessToken);
      await registerPhoneNumber(merchant.phoneNumberId, plainToken, pin);

      await logInfo("WhatsApp phone number registered successfully via Settings", {
        shop,
        source: "settings",
        details: { phoneNumberId: merchant.phoneNumberId },
      });

      return json({ success: true, message: "WhatsApp Phone Number successfully registered with Meta Cloud API! ✓" });
    } catch (err: any) {
      await logError(`Phone registration failed: ${err.message}`, { shop, source: "settings" });
      return json({ error: `Registration error: ${err.message}` }, { status: 400 });
    }
  }

  // 2. Test WhatsApp Dispatch
  if (intent === "sendTestMessage") {
    const rawPhone = formData.get("testPhone") as string;
    const testPhone = normalizePhoneNumber(rawPhone);
    const testMode = (formData.get("testMode") as string) || "custom";
    const customMessageText = (formData.get("customMessageText") as string) || "";

    if (!testPhone) {
      return json({ error: "Please enter a valid 10-digit mobile number with country code." }, { status: 400 });
    }

    if (!merchant.isWhatsAppConnected) {
      return json({ error: "WhatsApp Business Account is not connected yet. Please connect on the Connect page first." }, { status: 400 });
    }

    const testBody =
      customMessageText.trim() ||
      `👋 *Hello from ${merchant.name || "Everon Lab Store"}!*\n\nThis is your custom WhatsApp notification from StorePing.\n\nYour automated customer messaging engine is 100% active and live! 🚀`;

    const result = await sendWhatsAppMessage({
      merchantId: merchant.id,
      recipientPhone: testPhone,
      customerName: "Store Owner",
      eventType: "TEST_DISPATCH",
      templateName: testMode === "template" ? "hello_world" : undefined,
      templateLanguage: "en_US",
      bodyText: testBody,
      headerType: "TEXT",
      headerText: `🛍️ ${merchant.name || "Everon Lab"}`,
      footerText: "Reply STOP to unsubscribe",
      buttonType: "CTA_URL",
      buttonText: "🛍️ View Store",
      buttonUrl: `https://${shop}`,
    });

    if (result.success) {
      return json({ success: true, message: `Live custom WhatsApp message sent successfully to +${testPhone}!` });
    } else {
      return json({ error: result.error || "Failed to dispatch test message" }, { status: 500 });
    }
  }

  // 3. Save General Settings
  const storeName = formData.get("storeName") as string;
  const currency = formData.get("currency") as string;
  const timezone = formData.get("timezone") as string;
  const defaultPhone = (formData.get("defaultPhone") as string || "").trim();

  await db.merchant.update({
    where: { shop },
    data: {
      name: storeName,
      currency,
      timezone,
      phone: defaultPhone || null,
    },
  });

  await logInfo("Merchant settings updated", { shop, source: "settings" });

  return json({ success: true, message: "Settings and default test phone saved successfully." });
};

export default function SettingsPage() {
  const { merchant } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [testPhone, setTestPhone] = useState(merchant?.phone || "");
  const [defaultPhone, setDefaultPhone] = useState(merchant?.phone || "");
  const [testMode, setTestMode] = useState("custom");
  const [customText, setCustomText] = useState(
    `👋 *Hello from ${merchant?.name || "StorePing"}!*\n\nThis is your customized WhatsApp notification from StorePing.\n\nYour cart recovery, order updates, and live alerts are 100% operational! 🚀`
  );
  const [registerPin, setRegisterPin] = useState("123456");
  const [storeName, setStoreName] = useState(merchant?.name || "Everon Lab Store");
  const [currency, setCurrency] = useState(merchant?.currency || "INR");
  const [timezone, setTimezone] = useState(merchant?.timezone || "Asia/Kolkata");

  const isLoading = fetcher.state !== "idle";
  const actionData = fetcher.data as any;

  const handleSendTest = () => {
    const form = new FormData();
    form.append("intent", "sendTestMessage");
    form.append("testPhone", testPhone || defaultPhone);
    form.append("testMode", testMode);
    form.append("customMessageText", customText);
    fetcher.submit(form, { method: "POST" });
  };

  const handleRegisterPhone = () => {
    const form = new FormData();
    form.append("intent", "registerPhone");
    form.append("pin", registerPin);
    fetcher.submit(form, { method: "POST" });
  };

  const handleSaveSettings = () => {
    const form = new FormData();
    form.append("intent", "saveSettings");
    form.append("storeName", storeName);
    form.append("currency", currency);
    form.append("timezone", timezone);
    form.append("defaultPhone", defaultPhone);
    fetcher.submit(form, { method: "POST" });
  };

  return (
    <Page
      fullWidth
      title="StorePing Settings & Testing"
      subtitle="Configure your store profile, custom notification testing, and WhatsApp registration."
    >
      <BlockStack gap="500">
        {actionData?.message && (
          <Banner title="Success" tone="success" onDismiss={() => {}}>
            {actionData.message}
          </Banner>
        )}

        {actionData?.error && (
          <Banner title="Action Failed" tone="critical" onDismiss={() => {}}>
            {actionData.error}
          </Banner>
        )}

        <Layout>
          <Layout.Section>
            <BlockStack gap="500">
              {/* WhatsApp Cloud API Number Activation Card */}
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between">
                    <Text as="h2" variant="headingMd">
                      📱 WhatsApp Cloud API Phone Activation
                    </Text>
                    <Badge tone="success">Active</Badge>
                  </InlineStack>
                  <Text as="p" tone="subdued">
                    Meta requires each WhatsApp Phone Number to be registered with a 6-digit PIN before dispatches begin.
                  </Text>
                  <Divider />
                  <TextField
                    label="Connected Phone ID"
                    value={merchant.phoneNumberId || "Not Connected"}
                    disabled
                    autoComplete="off"
                  />
                  <InlineStack gap="300" align="end">
                    <div style={{ flex: 1 }}>
                      <TextField
                        label="6-Digit Verification PIN"
                        value={registerPin}
                        onChange={setRegisterPin}
                        autoComplete="off"
                        type="password"
                        helpText="Default: 123456"
                      />
                    </div>
                    <Button
                      variant="secondary"
                      loading={isLoading && fetcher.formData?.get("intent") === "registerPhone"}
                      onClick={handleRegisterPhone}
                    >
                      ⚡ Activate / Register Number with Meta
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>

              {/* Live Test Sender Card */}
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    📲 Live WhatsApp Test Sender (Custom Brand Text)
                  </Text>
                  <Text as="p" tone="subdued">
                    Send a customized live test message with your store name, rich formatting, and interactive buttons.
                  </Text>

                  <TextField
                    label="Test WhatsApp Mobile Number"
                    value={testPhone}
                    onChange={setTestPhone}
                    autoComplete="off"
                    placeholder={defaultPhone || "e.g. 9876543210 or +91 9876543210"}
                    helpText="Enter a 10-digit Indian mobile number or international E.164 (e.g. +91 9876543210)"
                  />

                  <Select
                    label="Message Format"
                    options={[
                      { label: "⚡ Custom Rich Message (Free Service Message with Button)", value: "custom" },
                      { label: "Meta Pre-Approved Template (hello_world)", value: "template" },
                    ]}
                    value={testMode}
                    onChange={setTestMode}
                  />

                  {testMode === "custom" && (
                    <TextField
                      label="Custom Message Body"
                      value={customText}
                      onChange={setCustomText}
                      multiline={4}
                      autoComplete="off"
                      helpText="Supports *bold*, _italic_, and emojis. Free inside the 24-hour Customer Service Window."
                    />
                  )}

                  <InlineStack gap="300">
                    <Button
                      variant="primary"
                      loading={isLoading && fetcher.formData?.get("intent") === "sendTestMessage"}
                      onClick={handleSendTest}
                    >
                      🚀 Send Custom WhatsApp Message
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>

              {/* Store Preferences Card */}
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Store & Currency Preferences
                  </Text>
                  <Divider />
                  <TextField
                    label="Store Display Name"
                    value={storeName}
                    onChange={setStoreName}
                    autoComplete="off"
                    helpText="Used in WhatsApp message headers and order recovery links."
                  />
                  <TextField
                    label="Default WhatsApp Test Mobile Number"
                    value={defaultPhone}
                    onChange={setDefaultPhone}
                    autoComplete="off"
                    placeholder="e.g. 9876543210 or +91 9876543210"
                    helpText="Saved default phone number used across message preview simulators and 1-click testing."
                  />
                  <Select
                    label="Store Currency"
                    options={[
                      { label: "INR - Indian Rupee (₹)", value: "INR" },
                      { label: "USD - US Dollar ($)", value: "USD" },
                      { label: "EUR - Euro (€)", value: "EUR" },
                      { label: "GBP - British Pound (£)", value: "GBP" },
                      { label: "AED - UAE Dirham", value: "AED" },
                    ]}
                    value={currency}
                    onChange={setCurrency}
                  />
                  <Select
                    label="Timezone"
                    options={[
                      { label: "Asia/Kolkata (IST +5:30)", value: "Asia/Kolkata" },
                      { label: "UTC (GMT +0:00)", value: "UTC" },
                      { label: "America/New_York (EST)", value: "America/New_York" },
                      { label: "Europe/London (GMT)", value: "Europe/London" },
                      { label: "Asia/Dubai (GST +4:00)", value: "Asia/Dubai" },
                    ]}
                    value={timezone}
                    onChange={setTimezone}
                  />
                  <InlineStack align="end">
                    <Button
                      variant="primary"
                      loading={isLoading && fetcher.formData?.get("intent") === "saveSettings"}
                      onClick={handleSaveSettings}
                    >
                      Save Preferences
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
