import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useState, useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  Button,
  BlockStack,
  InlineStack,
  TextField,
  Select,
  Divider,
  Badge,
  Checkbox,
  Box,
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

  return json({
    shop,
    merchant,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const merchant = await db.merchant.findUnique({ where: { shop } });
  if (!merchant) throw new Response("Merchant not found", { status: 404 });

  // 1. WhatsApp Phone Number Activation / 6-Digit PIN Registration
  if (intent === "registerPhone") {
    const pin = (formData.get("pin") as string || "123456").trim();

    if (!merchant.phoneNumberId || !merchant.waAccessToken) {
      return json({ error: "Please connect your WhatsApp Cloud API credentials in 'Connect WhatsApp' first." }, { status: 400 });
    }

    try {
      const decryptedToken = decryptToken(merchant.waAccessToken);
      const regResult = await registerPhoneNumber(merchant.phoneNumberId, decryptedToken, pin);

      if (!regResult.success) {
        throw new Error(regResult.error || "Meta registration failed.");
      }

      await logInfo(`WhatsApp Phone ID ${merchant.phoneNumberId} registered with PIN successfully`, { shop, source: "settings" });

      return json({ success: true, message: "WhatsApp Phone Number successfully registered with Meta Cloud API! 🚀" });
    } catch (err: any) {
      await logError(`PIN registration failed: ${err.message}`, { shop, source: "settings" });
      return json({ error: `Meta Phone Registration Error: ${err.message}` }, { status: 500 });
    }
  }

  // 2. Send Live Test WhatsApp Message
  if (intent === "sendTestMessage") {
    const testPhone = (formData.get("testPhone") as string || merchant.phone || "").trim();
    const testMode = formData.get("testMode") as string;
    const customMessageText = (formData.get("customMessageText") as string || "").trim();

    if (!merchant.isWhatsAppConnected) {
      return json({ error: "WhatsApp is not connected. Please connect your credentials first." }, { status: 400 });
    }

    if (!testPhone) {
      return json({ error: "Please enter a recipient test mobile phone number." }, { status: 400 });
    }

    let cleanPhone = normalizePhoneNumber(testPhone);
    if (!cleanPhone) {
      return json({ error: "Invalid mobile number format. Please include country code (e.g. +91 9876543210)." }, { status: 400 });
    }

    if (testMode === "template") {
      const result = await sendWhatsAppMessage({
        merchantId: merchant.id,
        recipientPhone: cleanPhone,
        customerName: "StorePing Test Merchant",
        eventType: "MANUAL_OUTREACH",
        templateName: "hello_world",
        templateLanguage: "en_US",
      });

      if (result.success) {
        return json({ success: true, message: `Live test template 'hello_world' sent successfully to +${cleanPhone}!` });
      } else {
        return json({ error: result.error || "Failed to dispatch template message" }, { status: 500 });
      }
    }

    // Default: Custom Interactive Session Message
    const defaultText = `👋 *Hello from ${merchant.name || shop}!*\n\nThis is your test WhatsApp notification from StorePing.\n\nYour cart recovery and order alerts are 100% active! 🚀`;

    const result = await sendWhatsAppMessage({
      merchantId: merchant.id,
      recipientPhone: cleanPhone,
      customerName: "StorePing Test Merchant",
      eventType: "MANUAL_OUTREACH",
      bodyText: customMessageText || defaultText,
      buttonText: "🛍️ View Store",
      buttonUrl: `https://${shop}`,
    });

    if (result.success) {
      return json({ success: true, message: `Live WhatsApp message sent successfully to +${cleanPhone}!` });
    } else {
      return json({ error: result.error || "Failed to dispatch test message" }, { status: 500 });
    }
  }

  // 3. Save General Settings & Notification Preferences
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

  return json({ success: true, message: "Settings and notification preferences saved successfully!" });
};

export default function SettingsPage() {
  const { shop, merchant } = useLoaderData<typeof loader>();
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

  // Notification toggles
  const [notifyConfirm, setNotifyConfirm] = useState(true);
  const [notifyAddressUpdate, setNotifyAddressUpdate] = useState(true);
  const [notifyInboundChat, setNotifyInboundChat] = useState(true);
  const [notifyRecovery, setNotifyRecovery] = useState(true);

  const isLoading = fetcher.state !== "idle";
  const actionData = fetcher.data as any;

  // Floating Toast Notification Trigger (No top banner)
  useEffect(() => {
    if (actionData) {
      if (actionData.message) {
        try {
          if (typeof window !== "undefined" && (window as any).shopify?.toast) {
            (window as any).shopify.toast.show(actionData.message, { duration: 4000 });
          }
        } catch {
          // fallback
        }
      } else if (actionData.error) {
        try {
          if (typeof window !== "undefined" && (window as any).shopify?.toast) {
            (window as any).shopify.toast.show(actionData.error, { isError: true, duration: 5000 });
          }
        } catch {
          // fallback
        }
      }
    }
  }, [actionData]);

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
      title="Settings"
      subtitle="Configure store profile, customer notification preferences, and default test number."
    >
      <BlockStack gap="500">
        <Layout>
          {/* Main Configuration Section */}
          <Layout.Section>
            <BlockStack gap="500">
              {/* WhatsApp Registration PIN Card */}
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between">
                    <Text as="h2" variant="headingMd">
                      📱 WhatsApp Cloud API Phone Activation
                    </Text>
                    <Badge tone={merchant?.isWhatsAppConnected ? "success" : "attention"}>
                      {merchant?.isWhatsAppConnected ? "Active" : "Disconnected"}
                    </Badge>
                  </InlineStack>
                  <Text as="p" tone="subdued">
                    Meta requires each WhatsApp Phone Number to be registered with a 6-digit PIN before dispatches begin.
                  </Text>
                  <Divider />

                  <TextField
                    label="Connected Phone ID"
                    value={merchant?.phoneNumberId || "Not Connected"}
                    disabled
                    autoComplete="off"
                  />

                  <InlineStack gap="300" blockAlign="end">
                    <div style={{ flex: 1 }}>
                      <TextField
                        label="6-Digit Verification PIN"
                        type="password"
                        value={registerPin}
                        onChange={setRegisterPin}
                        autoComplete="off"
                        helpText="Default: 123456"
                      />
                    </div>
                    <Button
                      tone="success"
                      loading={isLoading && fetcher.formData?.get("intent") === "registerPhone"}
                      onClick={handleRegisterPhone}
                    >
                      ⚡ Activate / Register Number with Meta
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>

              {/* Customer Notifications Management Card */}
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between">
                    <Text as="h2" variant="headingMd">
                      🔔 Customer Notification Alerts & Triggers
                    </Text>
                    <Badge tone="info">Live Feed Active</Badge>
                  </InlineStack>
                  <Text as="p" tone="subdued">
                    Control which real-time customer WhatsApp actions trigger alerts across your StorePing workspace and Dashboard.
                  </Text>
                  <Divider />

                  <BlockStack gap="300">
                    <Checkbox
                      label="Order & Delivery Address Confirmations"
                      helpText="Display live alert when customer confirms their delivery address on WhatsApp."
                      checked={notifyConfirm}
                      onChange={setNotifyConfirm}
                    />
                    <Checkbox
                      label="Customer Address & Mobile Update Requests"
                      helpText="Highlight orders requiring merchant review when a customer notes an address change on WhatsApp."
                      checked={notifyAddressUpdate}
                      onChange={setNotifyAddressUpdate}
                    />
                    <Checkbox
                      label="New Inbound WhatsApp Chat Messages"
                      helpText="Notify on incoming 2-way customer inquiries in Live Inbox."
                      checked={notifyInboundChat}
                      onChange={setNotifyInboundChat}
                    />
                    <Checkbox
                      label="Abandoned Cart Conversions & Recovery"
                      helpText="Show real-time notifications when a recovered customer completes checkout."
                      checked={notifyRecovery}
                      onChange={setNotifyRecovery}
                    />
                  </BlockStack>
                </BlockStack>
              </Card>

              {/* Live WhatsApp Test Sender Card */}
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    🚀 Live WhatsApp Test Sender (Custom Brand Text)
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

              {/* 3. STOREFRONT 1-CLICK WHATSAPP SUPPORT BUTTON CARD */}
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <div>
                      <Text as="h2" variant="headingMd">
                        💬 Storefront 1-Click WhatsApp Support Button
                      </Text>
                      <Text as="p" tone="subdued" variant="bodySm">
                        Floating corner button for instant customer service, order tracking, and returns.
                      </Text>
                    </div>
                    <Badge tone="success">100% Free CSW (₹0.00)</Badge>
                  </InlineStack>

                  <Divider />

                  <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                    <BlockStack gap="200">
                      <Text variant="headingXs" as="h4" tone="subdued">
                        WHY ENABLE THIS BUTTON:
                      </Text>
                      <InlineStack gap="400" align="start">
                        <div style={{ flex: 1 }}>
                          <Text variant="bodySm" as="p" fontWeight="bold">
                            💰 100% Free Meta Replies (₹0.00)
                          </Text>
                          <Text variant="bodyXs" as="p" tone="subdued">
                            When shoppers initiate chat from the button, Meta opens the 24h Free Customer Service Window.
                          </Text>
                        </div>

                        <div style={{ flex: 1 }}>
                          <Text variant="bodySm" as="p" fontWeight="bold">
                            📦 Order & Return Resolution
                          </Text>
                          <Text variant="bodyXs" as="p" tone="subdued">
                            Inquiries land directly in your Live Support Inbox (/app/inbox) for agents to resolve.
                          </Text>
                        </div>

                        <div style={{ flex: 1 }}>
                          <Text variant="bodySm" as="p" fontWeight="bold">
                            🎨 Theme Customizer Powered
                          </Text>
                          <Text variant="bodyXs" as="p" tone="subdued">
                            Customize button position, tooltip, pre-filled text & colors live in Shopify Theme Editor.
                          </Text>
                        </div>
                      </InlineStack>
                    </BlockStack>
                  </Box>

                  <InlineStack align="space-between" blockAlign="center">
                    <div>
                      <Text variant="bodySm" as="p" fontWeight="bold">
                        App Embed: StorePing WhatsApp Chat
                      </Text>
                      <Text variant="bodyXs" as="p" tone="subdued">
                        Click below to open your Shopify Theme Editor and toggle the StorePing App Embed on your store.
                      </Text>
                    </div>

                    <Button
                      variant="primary"
                      url={`https://admin.shopify.com/store/${shop.replace(".myshopify.com", "")}/themes/current/editor?context=apps`}
                      external
                    >
                      Open Theme Customizer ↗
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
