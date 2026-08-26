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
  Badge,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { sendWhatsAppMessage, registerPhoneNumber } from "../utils/meta-whatsapp.server";
import { decryptToken } from "../utils/encryption.server";
import { normalizePhoneNumber } from "../utils/phone.utils";
import { logInfo, logError } from "../utils/logger.server";

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

  // 1. Register Phone Number with Meta (#133010 Fix)
  if (intent === "registerPhone") {
    if (!merchant.phoneNumberId || !merchant.waAccessToken) {
      return json({ error: "No WhatsApp credentials found. Please connect your account first." }, { status: 400 });
    }

    try {
      const plainAccessToken = decryptToken(merchant.waAccessToken);
      const pin = (formData.get("pin") as string)?.trim() || "123456";

      await registerPhoneNumber(merchant.phoneNumberId, plainAccessToken, pin);
      await logInfo("WhatsApp Phone Number registered successfully with Meta Cloud API ✓", {
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
    const testMode = formData.get("testMode") as string || "template";

    if (!testPhone) {
      return json({ error: "Please enter a valid 10-digit mobile number with country code." }, { status: 400 });
    }

    if (!merchant.isWhatsAppConnected) {
      return json({ error: "WhatsApp Business Account is not connected yet. Please connect on the Connect page first." }, { status: 400 });
    }

    const testBody = `👋 *StorePing Test Alert*\n\nHello! This is a live test notification from *${merchant.name || "Your Store"}*.\n\nYour StorePing WhatsApp integration is active and operating at 100% health! 🚀`;

    const result = await sendWhatsAppMessage({
      merchantId: merchant.id,
      recipientPhone: testPhone,
      customerName: "Store Owner",
      eventType: "TEST_DISPATCH",
      templateName: testMode === "template" ? "hello_world" : undefined,
      templateLanguage: "en_US",
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

  // 3. Save General Settings
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

  const [testPhone, setTestPhone] = useState(merchant?.phone || "9374626600");
  const [testMode, setTestMode] = useState("template");
  const [registerPin, setRegisterPin] = useState("123456");
  const [storeName, setStoreName] = useState(merchant?.name || "");
  const [currency, setCurrency] = useState(merchant?.currency || "INR");
  const [timezone, setTimezone] = useState(merchant?.timezone || "Asia/Kolkata");

  const isLoading = fetcher.state !== "idle";
  const actionData = fetcher.data as any;

  const handleSendTest = () => {
    const form = new FormData();
    form.append("intent", "sendTestMessage");
    form.append("testPhone", testPhone);
    form.append("testMode", testMode);
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
    fetcher.submit(form, { method: "POST" });
  };

  return (
    <Page
      title="Settings & Test Console"
      subtitle="Configure store preferences and test live WhatsApp message dispatches to your phone."
    >
      <BlockStack gap="400">
        {actionData?.error && (
          <Banner title="Action Failed" tone="critical">
            <p>{actionData.error}</p>
          </Banner>
        )}

        {actionData?.success && (
          <Banner title="Success" tone="success">
            <p>{actionData.message}</p>
          </Banner>
        )}

        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              {/* WhatsApp Account Activation & Registration Card */}
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      📱 WhatsApp Cloud API Phone Activation
                    </Text>
                    <Badge tone={merchant?.isWhatsAppConnected ? "success" : "attention"}>
                      {merchant?.isWhatsAppConnected ? "Active" : "Not Connected"}
                    </Badge>
                  </InlineStack>

                  <Text as="p" tone="subdued">
                    Meta requires each WhatsApp Phone Number to be registered with a 6-digit PIN before dispatches begin.
                  </Text>

                  <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodySm" fontWeight="semibold">Connected Phone ID:</Text>
                      <Text as="span" variant="bodySm">{merchant?.phoneNumberId || "1166112789916926"}</Text>
                    </InlineStack>
                  </Box>

                  <InlineStack gap="300" blockAlign="end">
                    <div style={{ flexGrow: 1, maxWidth: "200px" }}>
                      <TextField
                        label="6-Digit Verification PIN"
                        value={registerPin}
                        onChange={setRegisterPin}
                        type="password"
                        autoComplete="off"
                        maxLength={6}
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
                    📲 Live WhatsApp Test Sender
                  </Text>
                  <Text as="p" tone="subdued">
                    Verify your Meta WhatsApp Cloud API connection by sending a real test message to your personal or work phone number.
                  </Text>

                  <TextField
                    label="Test WhatsApp Mobile Number"
                    value={testPhone}
                    onChange={setTestPhone}
                    autoComplete="off"
                    placeholder="9374626600"
                    helpText="Standard 10-digit Indian mobile number or international E.164 (e.g. +91 9374626600)"
                  />

                  <Select
                    label="Message Type"
                    options={[
                      { label: "Meta Pre-Approved Template (hello_world) - Recommended for initial test", value: "template" },
                      { label: "Custom Rich Message with CTA Button", value: "custom" },
                    ]}
                    value={testMode}
                    onChange={setTestMode}
                  />

                  <InlineStack gap="300">
                    <Button
                      variant="primary"
                      loading={isLoading && fetcher.formData?.get("intent") === "sendTestMessage"}
                      onClick={handleSendTest}
                    >
                      Send Test WhatsApp Message
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

                  <TextField
                    label="Brand / Store Display Name"
                    value={storeName}
                    onChange={setStoreName}
                    autoComplete="off"
                    helpText="Used in WhatsApp template headers and message bodies"
                  />

                  <Select
                    label="Display Currency"
                    options={[
                      { label: "INR (₹) - Indian Rupee", value: "INR" },
                      { label: "USD ($) - US Dollar", value: "USD" },
                      { label: "EUR (€) - Euro", value: "EUR" },
                      { label: "GBP (£) - British Pound", value: "GBP" },
                      { label: "AED (د.إ) - UAE Dirham", value: "AED" },
                      { label: "CAD ($) - Canadian Dollar", value: "CAD" },
                      { label: "AUD ($) - Australian Dollar", value: "AUD" },
                    ]}
                    value={currency}
                    onChange={setCurrency}
                  />

                  <Select
                    label="Store Timezone"
                    options={[
                      { label: "Asia/Kolkata (IST)", value: "Asia/Kolkata" },
                      { label: "America/New_York (EST)", value: "America/New_York" },
                      { label: "America/Los_Angeles (PST)", value: "America/Los_Angeles" },
                      { label: "Europe/London (GMT/BST)", value: "Europe/London" },
                      { label: "Asia/Dubai (GST)", value: "Asia/Dubai" },
                      { label: "Asia/Singapore (SGT)", value: "Asia/Singapore" },
                    ]}
                    value={timezone}
                    onChange={setTimezone}
                  />

                  <InlineStack gap="300">
                    <Button
                      variant="secondary"
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
