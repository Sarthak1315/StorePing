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
  Select,
  TextField,
  Tag,
  Box,
  Badge,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { seedDefaultTemplates } from "../utils/template.server";
import { interpolateVariables } from "../utils/template.shared";
import { logInfo, logError } from "../utils/logger.server";
import { syncTemplateToMeta, sendWhatsAppMessage } from "../utils/meta-whatsapp.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let merchant = await db.merchant.findUnique({
    where: { shop },
    include: { templates: true },
  });

  if (!merchant) {
    merchant = await db.merchant.create({
      data: { shop, name: shop.replace(".myshopify.com", "") },
      include: { templates: true },
    });
  }

  await seedDefaultTemplates(merchant.id);

  const updatedTemplates = await db.template.findMany({
    where: { merchantId: merchant.id },
    orderBy: { createdAt: "asc" },
  });

  return json({ merchant, templates: updatedTemplates });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();

  const actionType = (formData.get("actionType") as string) || "SAVE";
  const templateId = formData.get("templateId") as string;
  const bodyText = (formData.get("bodyText") as string) || "";
  const headerType = (formData.get("headerType") as string) || "NONE";
  const headerText = (formData.get("headerText") as string) || "";
  const headerMediaUrl = (formData.get("headerMediaUrl") as string) || "";
  const footerText = (formData.get("footerText") as string) || "";
  const buttonType = (formData.get("buttonType") as string) || "NONE";
  const buttonText = (formData.get("buttonText") as string) || "";
  const buttonUrl = (formData.get("buttonUrl") as string) || "";

  const merchant = await db.merchant.findUnique({ where: { shop } });
  if (!merchant) throw new Response("Merchant not found", { status: 404 });

  // 1. Handle Test Message Sending from Templates Page
  if (actionType === "SEND_TEST") {
    let testPhone = (formData.get("testPhone") as string) || "9374626600";
    testPhone = testPhone.replace(/[^0-9]/g, "");
    if (testPhone.length === 10) testPhone = `91${testPhone}`;

    const sampleVariables = {
      customer_name: "Rahul Sharma",
      order_id: "1024",
      order_name: "#1024",
      order_number: "1024",
      total_price: "₹2,499.00",
      total_amount: "2,499.00",
      currency: "INR",
      shipping_address: "Flat 402, Royal Residency, MG Road, Mumbai, Maharashtra 400001",
      customer_phone: testPhone,
      cart_items: "Silk Embroidered Sherwani (x1), Royal Dupatta (x1)",
      items: "Silk Embroidered Sherwani (x1), Royal Dupatta (x1)",
      store_name: merchant.name || shop.replace(".myshopify.com", ""),
      carrier: "BlueDart Express",
      tracking_number: "IN9823471029",
      tracking_url: `https://${shop}/account/orders`,
      checkout_url: `https://${shop}/checkouts/sample-cart`,
      discount_code: "SAVE10",
    };

    const interpolatedBody = interpolateVariables(bodyText, sampleVariables);
    const interpolatedHeader = interpolateVariables(headerText, sampleVariables);
    const interpolatedBtnUrl = interpolateVariables(buttonUrl, sampleVariables);

    // Default 3 buttons if multi-button
    const sampleButtons =
      buttonType === "MULTI_BUTTON"
        ? [
            { id: "confirm_order_1024", text: "✅ Confirm Address", type: "QUICK_REPLY" },
            { id: "update_address_1024", text: "✏️ Update Address / Mobile", type: "QUICK_REPLY" },
            { id: "support_query_1024", text: "💬 Ask Query", type: "QUICK_REPLY" },
          ]
        : undefined;

    try {
      const sendResult = await sendWhatsAppMessage({
        merchantId: merchant.id,
        recipientPhone: testPhone,
        customerName: "Test Recipient",
        eventType: "TEST_DISPATCH",
        bodyText: interpolatedBody,
        headerType: headerType !== "NONE" ? headerType : null,
        headerText: headerType === "TEXT" ? interpolatedHeader : null,
        headerMediaUrl: headerType === "IMAGE" ? headerMediaUrl : null,
        footerText: footerText || `${merchant.name || shop} • 1-Click Verification`,
        buttonType: buttonType !== "NONE" ? buttonType : null,
        buttonText: buttonText || null,
        buttonUrl: interpolatedBtnUrl || null,
        buttons: sampleButtons,
      });

      if (!sendResult.success) {
        return json({
          success: false,
          testSent: false,
          testError: sendResult.error || "Failed to send test message",
          testPhone,
          metaSyncResult: null,
          metaSyncError: null,
        });
      }

      return json({
        success: true,
        testSent: true,
        testError: null,
        testPhone,
        metaSyncResult: null,
        metaSyncError: null,
      });
    } catch (err: any) {
      return json({
        success: false,
        testSent: false,
        testError: err.message,
        testPhone,
        metaSyncResult: null,
        metaSyncError: null,
      });
    }
  }

  // 2. Handle Save & Meta Sync
  const syncToMeta = formData.get("syncToMeta") === "true";

  // Build buttons json
  let buttonsJson: any[] = [];
  if (buttonType === "MULTI_BUTTON") {
    buttonsJson = [
      { id: "confirm_order", text: "✅ Confirm Address", type: "QUICK_REPLY" },
      { id: "update_address", text: "✏️ Update Address / Mobile", type: "QUICK_REPLY" },
      { id: "support_query", text: "💬 Ask Query", type: "QUICK_REPLY" },
    ];
  } else if (buttonType === "CTA_URL") {
    buttonsJson = [{ id: "cta_btn", text: buttonText, type: "CTA_URL", url: buttonUrl }];
  } else if (buttonType === "QUICK_REPLY") {
    buttonsJson = [{ id: "quick_btn", text: buttonText, type: "QUICK_REPLY" }];
  }

  const updated = await db.template.update({
    where: { id: templateId },
    data: {
      bodyText,
      headerType,
      headerText,
      headerMediaUrl,
      footerText,
      buttonType,
      buttonText,
      buttonUrl,
      buttons: buttonsJson as any,
    },
  });

  let metaSyncResult = null;
  let metaSyncError = null;

  if (syncToMeta) {
    try {
      metaSyncResult = await syncTemplateToMeta(merchant.id, {
        name: `storeping_${updated.eventType.toLowerCase()}`,
        category: updated.eventType.includes("CART") || updated.eventType.includes("WIN_BACK") ? "MARKETING" : "UTILITY",
        bodyText,
        headerType,
        headerText,
        footerText,
        buttonType,
        buttonText,
        buttonUrl,
      });
      await logInfo(`Template ${templateId} synced to Meta WABA`, { shop, source: "templates" });
    } catch (err: any) {
      metaSyncError = err.message;
      await logError(`Meta template sync failed: ${err.message}`, { shop, source: "templates" });
    }
  }

  return json({
    success: true,
    testSent: false,
    testError: null,
    testPhone: null,
    metaSyncResult,
    metaSyncError,
  });
};

export default function TemplatesAndSimulatorPage() {
  const { merchant, templates } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const actionData = fetcher.data as any;

  const [selectedEvent, setSelectedEvent] = useState<string>(templates[0]?.eventType || "ORDER_CONFIRM_ADDRESS");

  const currentTemplate = templates.find((t) => t.eventType === selectedEvent) || templates[0];

  const [headerType, setHeaderType] = useState<string>(currentTemplate?.headerType || "NONE");
  const [headerText, setHeaderText] = useState<string>(currentTemplate?.headerText || "");
  const [headerMediaUrl, setHeaderMediaUrl] = useState<string>(currentTemplate?.headerMediaUrl || "");
  const [bodyText, setBodyText] = useState<string>(currentTemplate?.bodyText || "");
  const [footerText, setFooterText] = useState<string>(currentTemplate?.footerText || "");
  const [buttonType, setButtonType] = useState<string>(currentTemplate?.buttonType || "MULTI_BUTTON");
  const [buttonText, setButtonText] = useState<string>(currentTemplate?.buttonText || "");
  const [buttonUrl, setButtonUrl] = useState<string>(currentTemplate?.buttonUrl || "");
  const [testPhoneNumber, setTestPhoneNumber] = useState<string>("+91 9374626600");

  // Update editor state when selecting different template event
  const handleSelectTemplate = (eventKey: string) => {
    setSelectedEvent(eventKey);
    const tpl = templates.find((t) => t.eventType === eventKey);
    if (tpl) {
      setHeaderType(tpl.headerType || "NONE");
      setHeaderText(tpl.headerText || "");
      setHeaderMediaUrl(tpl.headerMediaUrl || "");
      setBodyText(tpl.bodyText || "");
      setFooterText(tpl.footerText || "");
      setButtonType(tpl.buttonType || "MULTI_BUTTON");
      setButtonText(tpl.buttonText || "");
      setButtonUrl(tpl.buttonUrl || "");
    }
  };

  const insertVariable = (variableName: string) => {
    setBodyText((prev: string) => `${prev} {{${variableName}}}`);
  };

  const isSubmitting = fetcher.state !== "idle";

  const handleSave = (syncToMeta: boolean = false) => {
    if (!currentTemplate) return;
    const form = new FormData();
    form.append("actionType", "SAVE");
    form.append("templateId", currentTemplate.id);
    form.append("headerType", headerType);
    form.append("headerText", headerText);
    form.append("headerMediaUrl", headerMediaUrl);
    form.append("bodyText", bodyText);
    form.append("footerText", footerText);
    form.append("buttonType", buttonType);
    form.append("buttonText", buttonText);
    form.append("buttonUrl", buttonUrl);
    form.append("syncToMeta", syncToMeta ? "true" : "false");
    fetcher.submit(form, { method: "POST" });
  };

  const handleSendTestMessage = () => {
    if (!currentTemplate) return;
    const form = new FormData();
    form.append("actionType", "SEND_TEST");
    form.append("testPhone", testPhoneNumber);
    form.append("templateId", currentTemplate.id);
    form.append("headerType", headerType);
    form.append("headerText", headerText);
    form.append("headerMediaUrl", headerMediaUrl);
    form.append("bodyText", bodyText);
    form.append("footerText", footerText);
    form.append("buttonType", buttonType);
    form.append("buttonText", buttonText);
    form.append("buttonUrl", buttonUrl);
    fetcher.submit(form, { method: "POST" });
  };

  // Mock variables for live simulator preview
  const sampleVariables = {
    customer_name: "Rahul Sharma",
    order_id: "1024",
    order_name: "#1024",
    order_number: "1024",
    total_price: "₹2,499.00",
    total_amount: "2,499.00",
    currency: "INR",
    shipping_address: "Flat 402, Royal Residency, MG Road, Mumbai, Maharashtra 400001",
    customer_phone: "919374626600",
    cart_items: "Silk Embroidered Sherwani (x1), Royal Dupatta (x1)",
    items: "Silk Embroidered Sherwani (x1), Royal Dupatta (x1)",
    store_name: merchant.name || merchant.shop.replace(".myshopify.com", ""),
    carrier: "BlueDart Express",
    tracking_number: "IN9823471029",
    tracking_url: `https://${merchant.shop}/account/orders`,
    checkout_url: `https://${merchant.shop}/checkouts/sample-cart`,
    discount_code: "SAVE10",
  };

  const simulatedBody = interpolateVariables(bodyText, sampleVariables);
  const simulatedHeader = interpolateVariables(headerText, sampleVariables);

  const availableVariables = [
    { label: "Customer Name", key: "customer_name" },
    { label: "Order Number", key: "order_number" },
    { label: "Total Amount", key: "total_amount" },
    { label: "Currency", key: "currency" },
    { label: "Shipping Address", key: "shipping_address" },
    { label: "Customer Phone", key: "customer_phone" },
    { label: "Order Items", key: "cart_items" },
    { label: "Store Name", key: "store_name" },
    { label: "Tracking URL", key: "tracking_url" },
    { label: "Courier Carrier", key: "carrier" },
    { label: "Checkout URL", key: "checkout_url" },
    { label: "Discount Code", key: "discount_code" },
  ];

  const templateOptions = [
    { label: "🧾 Order & Delivery Address Confirmation (3 Interactive Buttons)", value: "ORDER_CONFIRM_ADDRESS" },
    { label: "📦 Standard Order Confirmation", value: "ORDER_CONFIRM" },
    { label: "💳 Cash on Delivery (COD) Verification", value: "COD_CONFIRM" },
    { label: "🚚 Shipping & Tracking Update", value: "ORDER_SHIPPED" },
    { label: "📦 Order Delivered & Review Request", value: "ORDER_DELIVERED" },
    { label: "🛒 Cart Recovery - Step 1 (30 min)", value: "CART_RECOVERY_1" },
    { label: "🛒 Cart Recovery - Step 2 (6 hr 10% Off)", value: "CART_RECOVERY_2" },
    { label: "✨ Inactive Customer Win-Back", value: "WIN_BACK" },
    { label: "🤖 24/7 Support Auto-Reply", value: "SUPPORT_AUTO_REPLY" },
  ];

  return (
    <Page
      fullWidth
      title="WhatsApp Message Templates & Live Simulator"
      subtitle="Create, customize, and test WhatsApp message templates with interactive buttons directly on your phone."
    >
      <BlockStack gap="500">
        {actionData?.testSent && (
          <Banner title="Test Message Delivered! 🚀" tone="success" onDismiss={() => {}}>
            Live test message was successfully dispatched via Meta Cloud API to <strong>{actionData.testPhone}</strong>. Check your WhatsApp!
          </Banner>
        )}

        {actionData?.testError && (
          <Banner title="Test Message Failed" tone="critical" onDismiss={() => {}}>
            {actionData.testError}
          </Banner>
        )}

        {actionData?.success && !actionData?.testSent && !actionData?.metaSyncError && (
          <Banner title="Template Saved Successfully" tone="success" onDismiss={() => {}}>
            {actionData?.metaSyncResult
              ? "Template updated in StorePing and successfully synced to Meta WhatsApp Business Account."
              : "Template updated in StorePing."}
          </Banner>
        )}

        {actionData?.metaSyncError && (
          <Banner title="Meta Sync Notice" tone="warning" onDismiss={() => {}}>
            Template saved locally, but Meta sync returned: {actionData.metaSyncError}. (Make sure your WABA has template creation permissions).
          </Banner>
        )}

        <Layout>
          {/* Left Column: Template Editor */}
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Template Configuration
                </Text>
                <Divider />

                <Select
                  label="Select Notification Event"
                  options={templateOptions}
                  value={selectedEvent}
                  onChange={handleSelectTemplate}
                />

                {/* Header Configuration */}
                <Select
                  label="Header Type (Optional)"
                  options={[
                    { label: "None", value: "NONE" },
                    { label: "Text Header", value: "TEXT" },
                    { label: "Image Header", value: "IMAGE" },
                  ]}
                  value={headerType}
                  onChange={setHeaderType}
                />

                {headerType === "TEXT" && (
                  <TextField
                    label="Header Text"
                    value={headerText}
                    onChange={setHeaderText}
                    autoComplete="off"
                    helpText="Appears bold at the top of your message. Supports variables like {{order_number}}."
                  />
                )}

                {headerType === "IMAGE" && (
                  <TextField
                    label="Header Image URL"
                    value={headerMediaUrl}
                    onChange={setHeaderMediaUrl}
                    autoComplete="off"
                    helpText="Must be a publicly accessible image URL (e.g. from Shopify Files)."
                  />
                )}

                {/* Variable Pills */}
                <BlockStack gap="200">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Click to insert dynamic Shopify variable:
                  </Text>
                  <InlineStack gap="200" wrap>
                    {availableVariables.map((v) => (
                      <div
                        key={v.key}
                        onClick={() => insertVariable(v.key)}
                        style={{ cursor: "pointer" }}
                      >
                        <Tag>{v.label}</Tag>
                      </div>
                    ))}
                  </InlineStack>
                </BlockStack>

                {/* Body Text */}
                <TextField
                  label="Message Body"
                  value={bodyText}
                  onChange={setBodyText}
                  multiline={6}
                  autoComplete="off"
                  helpText="Use {{variable_name}} for dynamic store data."
                />

                {/* Footer Text */}
                <TextField
                  label="Footer Text (Optional)"
                  value={footerText}
                  onChange={setFooterText}
                  autoComplete="off"
                  helpText="Small muted text at the bottom. E.g., 'Reply STOP to unsubscribe'."
                />

                {/* Button Action Configuration */}
                <Select
                  label="Interactive Button Format"
                  options={[
                    { label: "None", value: "NONE" },
                    { label: "3 Interactive Quick-Reply Buttons (Address Confirm / Edit / Query)", value: "MULTI_BUTTON" },
                    { label: "Single Quick-Reply Button", value: "QUICK_REPLY" },
                    { label: "Call to Action URL Button (Checkout / Tracking)", value: "CTA_URL" },
                  ]}
                  value={buttonType}
                  onChange={setButtonType}
                />

                {buttonType === "QUICK_REPLY" && (
                  <TextField
                    label="Button Label"
                    value={buttonText}
                    onChange={setButtonText}
                    autoComplete="off"
                  />
                )}

                {buttonType === "CTA_URL" && (
                  <>
                    <TextField
                      label="Button Label"
                      value={buttonText}
                      onChange={setButtonText}
                      autoComplete="off"
                    />
                    <TextField
                      label="Button Destination URL"
                      value={buttonUrl}
                      onChange={setButtonUrl}
                      autoComplete="off"
                      helpText="Supports {{checkout_url}} or {{tracking_url}}."
                    />
                  </>
                )}

                {buttonType === "MULTI_BUTTON" && (
                  <Box background="bg-surface-secondary" padding="300" borderRadius="200">
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm" fontWeight="bold">
                        Interactive Action Buttons (Dispatched directly via WhatsApp API):
                      </Text>
                      <Text as="p" variant="bodyXs" tone="subdued">
                        1. <b>[✅ Confirm Address]</b> — Instant verification status updated in merchant orders table.
                      </Text>
                      <Text as="p" variant="bodyXs" tone="subdued">
                        2. <b>[✏️ Update Address / Mobile]</b> — Auto-prompts customer for new delivery address and flags order.
                      </Text>
                      <Text as="p" variant="bodyXs" tone="subdued">
                        3. <b>[💬 Ask Query]</b> — Opens live conversation in Live Inbox.
                      </Text>
                    </BlockStack>
                  </Box>
                )}

                <InlineStack gap="300" align="end">
                  <Button onClick={() => handleSave(false)} loading={isSubmitting}>
                    Save in StorePing
                  </Button>
                  <Button variant="primary" onClick={() => handleSave(true)} loading={isSubmitting}>
                    ⚡ Save & Sync to Meta WhatsApp
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* Right Column: Realistic WhatsApp Phone Mockup Simulator & Test Dispatch */}
          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between">
                    <Text as="h2" variant="headingMd">
                      Live Phone Simulator
                    </Text>
                    <Badge tone="success">Meta Preview</Badge>
                  </InlineStack>
                  <Divider />

                  {/* WhatsApp Phone Mockup Container */}
                  <Box
                    background="bg-surface-secondary"
                    padding="400"
                    borderRadius="300"
                    borderWidth="025"
                    borderColor="border"
                  >
                    {/* Phone Header Bar */}
                    <div
                      style={{
                        backgroundColor: "#075e54",
                        color: "#ffffff",
                        padding: "10px 14px",
                        borderRadius: "8px 8px 0 0",
                        display: "flex",
                        alignItems: "center",
                        gap: "10px",
                      }}
                    >
                      <div
                        style={{
                          width: "32px",
                          height: "32px",
                          borderRadius: "50%",
                          backgroundColor: "#128c7e",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontWeight: "bold",
                          fontSize: "14px",
                        }}
                      >
                        {merchant.shop.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: "14px" }}>
                          {merchant.displayPhoneNumber || merchant.shop}
                        </div>
                        <div style={{ fontSize: "10px", opacity: 0.8 }}>
                          Official Business Account ✓
                        </div>
                      </div>
                    </div>

                    {/* Chat Background & Bubble */}
                    <div
                      style={{
                        backgroundColor: "#efeae2",
                        padding: "16px 12px",
                        minHeight: "320px",
                        borderRadius: "0 0 8px 8px",
                        display: "flex",
                        flexDirection: "column",
                        justifyContent: "flex-start",
                      }}
                    >
                      <div
                        style={{
                          backgroundColor: "#ffffff",
                          borderRadius: "8px",
                          padding: "10px 12px",
                          maxWidth: "96%",
                          boxShadow: "0 1px 1px rgba(0,0,0,0.13)",
                          alignSelf: "flex-start",
                        }}
                      >
                        {/* Message Header (Text or Image) */}
                        {headerType === "TEXT" && simulatedHeader && (
                          <div
                            style={{
                              fontWeight: "bold",
                              fontSize: "13px",
                              marginBottom: "6px",
                              color: "#075e54",
                            }}
                          >
                            {simulatedHeader}
                          </div>
                        )}

                        {headerType === "IMAGE" && (
                          <div
                            style={{
                              backgroundColor: "#e2e8f0",
                              borderRadius: "6px",
                              height: "120px",
                              marginBottom: "8px",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              color: "#64748b",
                              fontSize: "12px",
                              overflow: "hidden",
                            }}
                          >
                            {headerMediaUrl ? (
                              <img
                                src={headerMediaUrl}
                                alt="Header Preview"
                                style={{ width: "100%", height: "100%", objectFit: "cover" }}
                              />
                            ) : (
                              "🖼️ Image Preview"
                            )}
                          </div>
                        )}

                        {/* Message Body */}
                        <div
                          style={{
                            fontSize: "13px",
                            lineHeight: "1.45",
                            color: "#334155",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                          }}
                        >
                          {simulatedBody || "Your message body will appear here..."}
                        </div>

                        {/* Message Footer */}
                        {footerText && (
                          <div
                            style={{
                              fontSize: "11px",
                              color: "#94a3b8",
                              marginTop: "6px",
                            }}
                          >
                            {footerText}
                          </div>
                        )}

                        {/* Timestamp & Delivered Double Checkmark */}
                        <div
                          style={{
                            textAlign: "right",
                            fontSize: "10px",
                            color: "#94a3b8",
                            marginTop: "4px",
                          }}
                        >
                          12:30 PM <span style={{ color: "#34b7f1" }}>✓✓</span>
                        </div>
                      </div>

                      {/* Interactive Buttons Preview */}
                      {buttonType === "MULTI_BUTTON" && (
                        <div style={{ marginTop: "6px", display: "flex", flexDirection: "column", gap: "4px", maxWidth: "96%" }}>
                          <div
                            style={{
                              backgroundColor: "#ffffff",
                              borderRadius: "6px",
                              padding: "8px",
                              textAlign: "center",
                              color: "#00a884",
                              fontWeight: 600,
                              fontSize: "12px",
                              boxShadow: "0 1px 1px rgba(0,0,0,0.13)",
                            }}
                          >
                            ✅ Confirm Address
                          </div>
                          <div
                            style={{
                              backgroundColor: "#ffffff",
                              borderRadius: "6px",
                              padding: "8px",
                              textAlign: "center",
                              color: "#00a884",
                              fontWeight: 600,
                              fontSize: "12px",
                              boxShadow: "0 1px 1px rgba(0,0,0,0.13)",
                            }}
                          >
                            ✏️ Update Address / Mobile
                          </div>
                          <div
                            style={{
                              backgroundColor: "#ffffff",
                              borderRadius: "6px",
                              padding: "8px",
                              textAlign: "center",
                              color: "#00a884",
                              fontWeight: 600,
                              fontSize: "12px",
                              boxShadow: "0 1px 1px rgba(0,0,0,0.13)",
                            }}
                          >
                            💬 Ask Query
                          </div>
                        </div>
                      )}

                      {buttonType === "QUICK_REPLY" && buttonText && (
                        <div
                          style={{
                            backgroundColor: "#ffffff",
                            borderRadius: "6px",
                            marginTop: "6px",
                            padding: "8px",
                            textAlign: "center",
                            color: "#00a884",
                            fontWeight: 600,
                            fontSize: "12px",
                            boxShadow: "0 1px 1px rgba(0,0,0,0.13)",
                            maxWidth: "96%",
                          }}
                        >
                          💬 {buttonText}
                        </div>
                      )}

                      {buttonType === "CTA_URL" && buttonText && (
                        <div
                          style={{
                            backgroundColor: "#ffffff",
                            borderRadius: "6px",
                            marginTop: "6px",
                            padding: "8px",
                            textAlign: "center",
                            color: "#00a884",
                            fontWeight: 600,
                            fontSize: "12px",
                            boxShadow: "0 1px 1px rgba(0,0,0,0.13)",
                            maxWidth: "96%",
                          }}
                        >
                          🔗 {buttonText}
                        </div>
                      )}
                    </div>
                  </Box>
                </BlockStack>
              </Card>

              {/* Instant Test Dispatch Card */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">
                    📱 Test This Template on Your Phone
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Dispatches this live template configuration directly to your WhatsApp with interactive buttons.
                  </Text>
                  <TextField
                    label="Recipient WhatsApp Number"
                    value={testPhoneNumber}
                    onChange={setTestPhoneNumber}
                    autoComplete="off"
                    helpText="Include country code (e.g. +91 9374626600)"
                  />
                  <Button
                    variant="primary"
                    tone="success"
                    onClick={handleSendTestMessage}
                    loading={isSubmitting}
                    fullWidth
                  >
                    🚀 Send Test to WhatsApp
                  </Button>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
