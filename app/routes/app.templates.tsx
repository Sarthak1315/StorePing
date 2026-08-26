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
import { logInfo } from "../utils/logger.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const merchant = await db.merchant.findUnique({
    where: { shop },
    include: { templates: true },
  });

  if (!merchant) {
    throw new Response("Merchant not found", { status: 404 });
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

  const templateId = formData.get("templateId") as string;
  const bodyText = formData.get("bodyText") as string;
  const headerType = formData.get("headerType") as string;
  const headerText = formData.get("headerText") as string;
  const headerMediaUrl = formData.get("headerMediaUrl") as string;
  const footerText = formData.get("footerText") as string;
  const buttonType = formData.get("buttonType") as string;
  const buttonText = formData.get("buttonText") as string;
  const buttonUrl = formData.get("buttonUrl") as string;

  await db.template.update({
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
    },
  });

  await logInfo(`Template ${templateId} updated`, { shop, source: "templates" });

  return json({ success: true });
};

export default function TemplatesAndSimulatorPage() {
  const { merchant, templates } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [selectedEvent, setSelectedEvent] = useState<string>(templates[0]?.eventType || "CART_RECOVERY_1");

  const currentTemplate = templates.find((t) => t.eventType === selectedEvent) || templates[0];

  const [headerType, setHeaderType] = useState<string>(currentTemplate?.headerType || "NONE");
  const [headerText, setHeaderText] = useState<string>(currentTemplate?.headerText || "");
  const [headerMediaUrl, setHeaderMediaUrl] = useState<string>(currentTemplate?.headerMediaUrl || "");
  const [bodyText, setBodyText] = useState<string>(currentTemplate?.bodyText || "");
  const [footerText, setFooterText] = useState<string>(currentTemplate?.footerText || "");
  const [buttonType, setButtonType] = useState<string>(currentTemplate?.buttonType || "QUICK_REPLY");
  const [buttonText, setButtonText] = useState<string>(currentTemplate?.buttonText || "");
  const [buttonUrl, setButtonUrl] = useState<string>(currentTemplate?.buttonUrl || "");

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
      setButtonType(tpl.buttonType || "QUICK_REPLY");
      setButtonText(tpl.buttonText || "");
      setButtonUrl(tpl.buttonUrl || "");
    }
  };

  const insertVariable = (variableName: string) => {
    setBodyText((prev: string) => `${prev} {{${variableName}}}`);
  };

  const isSaving = fetcher.state !== "idle";

  const handleSave = () => {
    if (!currentTemplate) return;
    const form = new FormData();
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
    order_number: "SP-1024",
    total_amount: "1,499.00",
    currency: merchant.currency || "₹",
    cart_items: "Premium Wireless Earbuds (x1), Matte Case (x1)",
    tracking_url: "https://storeping.everonlab.in/track/sample",
    checkout_url: "https://storeping.everonlab.in/checkout/sample",
    discount_code: "SAVE10",
    store_name: merchant.name || "Your Store",
    carrier: "BlueDart Express",
  };

  const previewBody = interpolateVariables(bodyText, sampleVariables);
  const previewHeader = interpolateVariables(headerText, sampleVariables);
  const previewButtonUrl = interpolateVariables(buttonUrl, sampleVariables);

  return (
    <Page
      title="Visual Template Designer & Live Simulator"
      subtitle="Customize WhatsApp messaging templates with dynamic variables and preview on the live phone simulator."
      primaryAction={{
        content: "Save Template Changes",
        onAction: handleSave,
        loading: isSaving,
      }}
    >
      <Layout>
        {fetcher.data?.success && (
          <Layout.Section>
            <Banner title="Template Saved Successfully" tone="success" />
          </Layout.Section>
        )}

        {/* Template Selector Tabs */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">Select Event Trigger to Customize:</Text>
              <InlineStack gap="200" wrap>
                {templates.map((tpl) => (
                  <Button
                    key={tpl.id}
                    variant={selectedEvent === tpl.eventType ? "primary" : "secondary"}
                    onClick={() => handleSelectTemplate(tpl.eventType)}
                  >
                    {tpl.eventType === "CART_RECOVERY_1"
                      ? "🛒 Cart Reminder (Step 1)"
                      : tpl.eventType === "CART_RECOVERY_2"
                      ? "🎁 Cart Discount (Step 2)"
                      : tpl.eventType === "ORDER_CONFIRM"
                      ? "🧾 Order Confirmation"
                      : tpl.eventType === "ORDER_SHIPPED"
                      ? "🚚 Order Shipped"
                      : tpl.eventType === "ORDER_DELIVERED"
                      ? "📦 Order Delivered"
                      : "🔁 Win-Back Offer"}
                  </Button>
                ))}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Left: Visual Editor */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h3" variant="headingMd">Template Editor</Text>
                <Badge tone="info">{selectedEvent}</Badge>
              </InlineStack>

              <Divider />

              {/* Header Settings */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Select
                  label="Header Type"
                  options={[
                    { label: "None", value: "NONE" },
                    { label: "Text Header", value: "TEXT" },
                    { label: "Image Header", value: "IMAGE" },
                  ]}
                  value={headerType}
                  onChange={(val) => setHeaderType(val)}
                />

                {headerType === "TEXT" && (
                  <TextField
                    label="Header Text"
                    value={headerText}
                    onChange={(val) => setHeaderText(val)}
                    autoComplete="off"
                  />
                )}

                {headerType === "IMAGE" && (
                  <TextField
                    label="Header Image URL"
                    value={headerMediaUrl}
                    onChange={(val) => setHeaderMediaUrl(val)}
                    placeholder="https://cdn.shopify.com/..."
                    autoComplete="off"
                  />
                )}
              </div>

              {/* Dynamic Variable Pills */}
              <BlockStack gap="200">
                <Text as="p" variant="bodySm" fontWeight="semibold">Click to Insert Dynamic Variable:</Text>
                <InlineStack gap="150" wrap>
                  {[
                    "customer_name",
                    "order_number",
                    "total_amount",
                    "currency",
                    "cart_items",
                    "discount_code",
                    "tracking_url",
                    "checkout_url",
                    "store_name",
                  ].map((v) => (
                    <Button key={v} size="micro" onClick={() => insertVariable(v)}>
                      + {`{{${v}}}`}
                    </Button>
                  ))}
                </InlineStack>
              </BlockStack>

              {/* Body Text */}
              <TextField
                label="WhatsApp Message Body"
                value={bodyText}
                onChange={(val) => setBodyText(val)}
                multiline={6}
                autoComplete="off"
                helpText="Use standard WhatsApp formatting: *bold*, _italic_, ~strikethrough~"
              />

              {/* Footer Text */}
              <TextField
                label="Footer Note"
                value={footerText}
                onChange={(val) => setFooterText(val)}
                autoComplete="off"
              />

              {/* Action Button */}
              <Divider />
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Select
                  label="Button Type"
                  options={[
                    { label: "None", value: "NONE" },
                    { label: "Call to Action URL Button", value: "CTA_URL" },
                    { label: "Quick Reply Button", value: "QUICK_REPLY" },
                  ]}
                  value={buttonType}
                  onChange={(val) => setButtonType(val)}
                />

                {buttonType !== "NONE" && (
                  <TextField
                    label="Button Text"
                    value={buttonText}
                    onChange={(val) => setButtonText(val)}
                    autoComplete="off"
                  />
                )}

                {buttonType === "CTA_URL" && (
                  <TextField
                    label="Button URL / Variable"
                    value={buttonUrl}
                    onChange={(val) => setButtonUrl(val)}
                    placeholder="{{checkout_url}}"
                    autoComplete="off"
                  />
                )}
              </div>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Right: Live WhatsApp Phone Simulator */}
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">📱 Live Phone Simulator</Text>
              <Text as="p" variant="bodySm" tone="subdued">Realistic preview of how this message looks on WhatsApp.</Text>

              <Divider />

              {/* Phone Frame Simulator */}
              <div style={{
                background: "#ECE5DD",
                borderRadius: "24px",
                padding: "16px 12px",
                border: "8px solid #1f2937",
                boxShadow: "0 10px 25px rgba(0,0,0,0.15)",
                minHeight: "420px",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                fontFamily: "Helvetica, Arial, sans-serif",
              }}>
                {/* Header Bar */}
                <div style={{
                  background: "#075E54",
                  color: "#fff",
                  padding: "8px 12px",
                  borderRadius: "12px",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  fontSize: "13px",
                  fontWeight: "bold",
                }}>
                  <span>🟢</span>
                  <span>{merchant.name || "StorePing Store"}</span>
                  <span style={{ fontSize: "10px", marginLeft: "auto", color: "#25D366" }}>✓ Business</span>
                </div>

                {/* WhatsApp Chat Bubble */}
                <div style={{
                  background: "#ffffff",
                  borderRadius: "8px 8px 8px 0px",
                  padding: "10px 12px",
                  marginBlock: "14px",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.15)",
                  fontSize: "13px",
                  color: "#111827",
                  lineHeight: "1.5",
                  wordBreak: "break-word",
                }}>
                  {/* Header Image or Text */}
                  {headerType === "IMAGE" && (headerMediaUrl || currentTemplate?.headerMediaUrl) && (
                    <img
                      src={headerMediaUrl || currentTemplate?.headerMediaUrl || ""}
                      alt="Header"
                      style={{ width: "100%", height: "110px", objectFit: "cover", borderRadius: "6px", marginBottom: "8px" }}
                    />
                  )}

                  {headerType === "TEXT" && previewHeader && (
                    <div style={{ fontWeight: "bold", fontSize: "14px", marginBottom: "6px", color: "#075E54" }}>
                      {previewHeader}
                    </div>
                  )}

                  {/* Body Text */}
                  <div style={{ whiteSpace: "pre-wrap" }}>
                    {previewBody || "Start typing your template body..."}
                  </div>

                  {/* Footer */}
                  {footerText && (
                    <div style={{ fontSize: "10px", color: "#6B7280", marginTop: "6px" }}>
                      {footerText}
                    </div>
                  )}

                  {/* Timestamp & Double Checkmarks */}
                  <div style={{ textAlign: "right", fontSize: "10px", color: "#9CA3AF", marginTop: "4px" }}>
                    10:45 AM <span style={{ color: "#34B7F1", fontWeight: "bold" }}>✓✓</span>
                  </div>
                </div>

                {/* WhatsApp Interactive Button */}
                {buttonType !== "NONE" && buttonText && (
                  <div style={{
                    background: "#ffffff",
                    border: "1px solid #E5E7EB",
                    borderRadius: "8px",
                    padding: "10px",
                    textAlign: "center",
                    color: "#00A884",
                    fontWeight: "bold",
                    fontSize: "13px",
                    cursor: "pointer",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
                  }}>
                    {buttonType === "CTA_URL" ? "🔗 " : "💬 "}
                    {buttonText}
                  </div>
                )}
              </div>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
