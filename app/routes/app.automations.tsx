import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useState, useEffect } from "react";
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
  DataTable,
  Box,
  Tabs,
  ChoiceList,
  RangeSlider,
  Tooltip,
  Icon,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { logInfo } from "../utils/logger.server";
import { cancelJobById, runJobImmediately, retryJobById } from "../utils/queue.server";
import { fetchShopifyDiscounts, createShopifyBasicDiscount, type ShopifyDiscountOption } from "../utils/shopify-discount.server";

export type AutomationActionData = {
  success?: boolean;
  message?: string;
  error?: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const merchant = await db.merchant.findUnique({
    where: { shop },
    include: {
      jobs: {
        orderBy: { createdAt: "desc" },
        take: 50,
      },
    },
  });

  const jobs = merchant?.jobs || [];
  const pendingCount = jobs.filter((j) => j.status === "PENDING" || j.status === "PROCESSING").length;

  // Live query active discounts directly from Shopify Admin GraphQL API
  const shopifyDiscounts = await fetchShopifyDiscounts(admin);

  return json({ merchant, jobs, pendingCount, shopifyDiscounts });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const merchant = await db.merchant.findUnique({ where: { shop } });
  if (!merchant) {
    return json<AutomationActionData>({ success: false, error: "Merchant record not found" }, { status: 404 });
  }

  // 1. Cancel Single Job
  if (intent === "cancelJob") {
    const jobId = formData.get("jobId") as string;
    await cancelJobById(jobId, merchant.id);
    await logInfo(`Merchant cancelled automation job ${jobId}`, { shop, source: "automations" });
    return json<AutomationActionData>({ success: true, message: "Automation job was successfully stopped/cancelled." });
  }

  // 2. Run Job Immediately
  if (intent === "runJobNow") {
    const jobId = formData.get("jobId") as string;
    await runJobImmediately(jobId, merchant.id);
    await logInfo(`Merchant triggered automation job ${jobId} immediately`, { shop, source: "automations" });
    return json<AutomationActionData>({ success: true, message: "Automation job was triggered immediately!" });
  }

  // 3. Retry Failed Job
  if (intent === "retryJob") {
    const jobId = formData.get("jobId") as string;
    await retryJobById(jobId, merchant.id);
    await logInfo(`Merchant retried automation job ${jobId}`, { shop, source: "automations" });
    return json<AutomationActionData>({ success: true, message: "Retrying automation job..." });
  }

  // 4. Cancel All Pending Jobs
  if (intent === "cancelAllPending") {
    await db.job.updateMany({
      where: { merchantId: merchant.id, status: { in: ["PENDING", "PROCESSING"] } },
      data: { status: "CANCELLED" },
    });
    await logInfo("Merchant cancelled all pending automation jobs", { shop, source: "automations" });
    return json<AutomationActionData>({ success: true, message: "All scheduled automation jobs have been stopped." });
  }

  // 5. Save Automation Flow Toggles & 3-Model Abandoned Cart Configuration
  const cartRecoveryEnabled = formData.get("cartRecoveryEnabled") === "true";
  const cartRecoveryStrategy = (formData.get("cartRecoveryStrategy") as string) || "DYNAMIC_ONETIME";
  const cartStep1Enabled = formData.get("cartStep1Enabled") === "true";
  const cartStep2Enabled = formData.get("cartStep2Enabled") === "true";

  const cartDelay1 = parseInt(formData.get("cartDelay1") as string) || 30;
  const cartDelay2 = parseInt(formData.get("cartDelay2") as string) || 360;

  const cartDiscountPrefix = (formData.get("cartDiscountPrefix") as string)?.trim().toUpperCase() || "CART";
  const cartDiscountPercent = parseInt(formData.get("cartDiscountPercent") as string) || 10;
  const cartDiscountExpiryHours = parseInt(formData.get("cartDiscountExpiryHours") as string) || 24;
  const cartDiscountCode = (formData.get("cartDiscountCode") as string)?.trim() || "";

  // Core Flow Toggles
  const orderConfirmEnabled = formData.get("orderConfirmEnabled") === "true";
  const orderShippedEnabled = formData.get("orderShippedEnabled") === "true";
  const orderDeliveredEnabled = formData.get("orderDeliveredEnabled") === "true";
  const promotionsEnabled = formData.get("promotionsEnabled") === "true";
  const reEngagementEnabled = formData.get("reEngagementEnabled") === "true";
  const supportChatEnabled = formData.get("supportChatEnabled") === "true";
  const codVerificationEnabled = formData.get("codVerificationEnabled") === "true";

  // If user selected FIXED_CODE and typed a custom code, ensure it exists in Shopify Admin
  const autoCreateShopifyDiscount = formData.get("autoCreateShopifyDiscount") === "true";
  if (cartRecoveryStrategy === "FIXED_CODE" && cartDiscountCode && autoCreateShopifyDiscount) {
    try {
      await createShopifyBasicDiscount(admin, {
        code: cartDiscountCode,
        percentage: cartDiscountPercent || 10,
        title: `StorePing Recovery Discount (${cartDiscountCode})`,
      });
    } catch (createErr: any) {
      console.warn("Notice creating basic discount in Shopify Admin:", createErr);
    }
  }

  await db.merchant.update({
    where: { shop },
    data: {
      cartRecoveryEnabled,
      cartRecoveryStrategy,
      cartStep1Enabled,
      cartStep2Enabled,
      cartDelay1,
      cartDelay2,
      cartDiscountPrefix,
      cartDiscountPercent,
      cartDiscountExpiryHours,
      cartDiscountCode,
      orderConfirmEnabled,
      orderShippedEnabled,
      orderDeliveredEnabled,
      promotionsEnabled,
      reEngagementEnabled,
      supportChatEnabled,
      codVerificationEnabled,
    },
  });

  await logInfo(`Automations updated (Strategy: ${cartRecoveryStrategy}, Step 1: ${cartDelay1}m, Step 2: ${cartDelay2}m)`, {
    shop,
    source: "automations",
  });

  return json<AutomationActionData>({ success: true, message: "Automation rules & discount configuration saved successfully." });
};

export default function AutomationsPage() {
  const { merchant, jobs, pendingCount, shopifyDiscounts } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<AutomationActionData>();

  const [selectedTab, setSelectedTab] = useState(0);

  // Master & Strategy State
  const [cartRecovery, setCartRecovery] = useState(merchant?.cartRecoveryEnabled ?? true);
  const [recoveryStrategy, setRecoveryStrategy] = useState<string>(merchant?.cartRecoveryStrategy || "DYNAMIC_ONETIME");

  // Step Toggles
  const [step1Active, setStep1Active] = useState(merchant?.cartStep1Enabled ?? true);
  const [step2Active, setStep2Active] = useState(merchant?.cartStep2Enabled ?? true);

  // Timing Delays
  const [delay1, setDelay1] = useState(String(merchant?.cartDelay1 ?? 30));
  const [delay2, setDelay2] = useState(String(merchant?.cartDelay2 ?? 360));

  // Dynamic 1-Time Coupon Controls
  const [discountPrefix, setDiscountPrefix] = useState(merchant?.cartDiscountPrefix || "CART");
  const [discountPercent, setDiscountPercent] = useState(merchant?.cartDiscountPercent ?? 10);
  const [discountExpiryHours, setDiscountExpiryHours] = useState(String(merchant?.cartDiscountExpiryHours ?? 24));

  // Fixed Shopify Discount Controls
  const [discountCode, setDiscountCode] = useState(merchant?.cartDiscountCode ?? "");
  const [autoCreateInShopify, setAutoCreateInShopify] = useState(true);

  // Other Core Flows State
  const [orderConfirm, setOrderConfirm] = useState(merchant?.orderConfirmEnabled ?? true);
  const [orderShipped, setOrderShipped] = useState(merchant?.orderShippedEnabled ?? true);
  const [orderDelivered, setOrderDelivered] = useState(merchant?.orderDeliveredEnabled ?? true);
  const [promotions, setPromotions] = useState(merchant?.promotionsEnabled ?? true);
  const [reEngagement, setReEngagement] = useState(merchant?.reEngagementEnabled ?? true);
  const [supportChat, setSupportChat] = useState(merchant?.supportChatEnabled ?? true);
  const [codVerification, setCodVerification] = useState(merchant?.codVerificationEnabled ?? true);

  const isSubmitting = fetcher.state !== "idle";

  // Toast Notification Handler
  useEffect(() => {
    if (fetcher.data) {
      if (fetcher.data.message) {
        try {
          if (typeof window !== "undefined" && (window as any).shopify?.toast) {
            (window as any).shopify.toast.show(fetcher.data.message, { duration: 4000 });
          }
        } catch {}
      } else if (fetcher.data.error) {
        try {
          if (typeof window !== "undefined" && (window as any).shopify?.toast) {
            (window as any).shopify.toast.show(fetcher.data.error, { isError: true, duration: 5000 });
          }
        } catch {}
      }
    }
  }, [fetcher.data]);

  const handleSave = () => {
    const form = new FormData();
    form.append("intent", "saveAutomations");
    form.append("cartRecoveryEnabled", String(cartRecovery));
    form.append("cartRecoveryStrategy", recoveryStrategy);
    form.append("cartStep1Enabled", String(step1Active));
    form.append("cartStep2Enabled", String(step2Active));
    form.append("cartDelay1", delay1);
    form.append("cartDelay2", delay2);
    form.append("cartDiscountPrefix", discountPrefix);
    form.append("cartDiscountPercent", String(discountPercent));
    form.append("cartDiscountExpiryHours", discountExpiryHours);
    form.append("cartDiscountCode", discountCode);
    form.append("autoCreateShopifyDiscount", String(autoCreateInShopify));

    form.append("orderConfirmEnabled", String(orderConfirm));
    form.append("orderShippedEnabled", String(orderShipped));
    form.append("orderDeliveredEnabled", String(orderDelivered));
    form.append("promotionsEnabled", String(promotions));
    form.append("reEngagementEnabled", String(reEngagement));
    form.append("supportChatEnabled", String(supportChat));
    form.append("codVerificationEnabled", String(codVerification));

    fetcher.submit(form, { method: "POST" });
  };

  const handleCancelJob = (jobId: string) => {
    const form = new FormData();
    form.append("intent", "cancelJob");
    form.append("jobId", jobId);
    fetcher.submit(form, { method: "POST" });
  };

  const handleRunNow = (jobId: string) => {
    const form = new FormData();
    form.append("intent", "runJobNow");
    form.append("jobId", jobId);
    fetcher.submit(form, { method: "POST" });
  };

  const handleRetryJob = (jobId: string) => {
    const form = new FormData();
    form.append("intent", "retryJob");
    form.append("jobId", jobId);
    fetcher.submit(form, { method: "POST" });
  };

  const handleCancelAll = () => {
    if (confirm("Are you sure you want to cancel all scheduled/pending automation messages?")) {
      const form = new FormData();
      form.append("intent", "cancelAllPending");
      fetcher.submit(form, { method: "POST" });
    }
  };

  const tabs = [
    { id: "flows", content: "⚙️ 7 Core Automation Flows" },
    { id: "queue", content: `⚡ Live Queue & Job Status (${pendingCount} active)` },
  ];

  // Helper to format event type names
  const formatEventName = (eventType: string) => {
    switch (eventType) {
      case "ORDER_CONFIRM_ADDRESS":
        return "🧾 Order & Address Confirmation (3-Button)";
      case "ORDER_CONFIRM":
        return "🧾 Order Placed Confirmation";
      case "COD_CONFIRM":
        return "💳 COD Order Verification";
      case "CART_RECOVERY_1":
        return "🛒 Cart Recovery (Step 1 - Gentle Reminder)";
      case "CART_RECOVERY_2":
        return "🛒 Cart Recovery (Step 2 - Discount Offer)";
      case "ORDER_SHIPPED":
        return "🚚 Shipping & Tracking Alert";
      case "ORDER_DELIVERED":
        return "📦 Order Delivered & Review";
      case "PROMOTION":
        return "🎁 Offer & Flash Sale";
      case "WIN_BACK":
        return "✨ Customer Win-Back";
      case "SUPPORT_AUTO_REPLY":
        return "🤖 Support Auto-Reply";
      default:
        return eventType || "WhatsApp Dispatch";
    }
  };

  const formatTiming = (job: any) => {
    const runAt = new Date(job.runAt);
    const now = Date.now();
    const diffMs = runAt.getTime() - now;
    const diffMins = Math.round(diffMs / 60000);

    if (job.status === "COMPLETED") {
      return `Sent at ${new Date(job.processedAt || job.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    }
    if (job.status === "CANCELLED") {
      return "Stopped by merchant";
    }
    if (job.status === "FAILED") {
      return `Failed: ${job.error || "Meta delivery failure"}`;
    }
    if (diffMins <= 0) {
      return "Ready to send now";
    }
    return `In ${diffMins} min (${runAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})`;
  };

  const cleanPrefix = (discountPrefix || "CART").trim().toUpperCase().replace(/[^A-Z0-9]/g, "") || "CART";
  const dynamicPreviewCode = `${cleanPrefix}${discountPercent}-8X2F`;

  const jobRows = jobs.map((job: any) => {
    const payload = (job.payload || {}) as any;
    const eventType = payload.eventType || job.jobType;
    const recipient = payload.recipientPhone ? `+${payload.recipientPhone}` : "Customer";
    const customerName = payload.customerName || "Customer";

    return [
      <BlockStack gap="050" key={job.id}>
        <Text as="span" variant="bodySm" fontWeight="bold">
          {formatEventName(eventType)}
        </Text>
        <Text as="span" variant="bodyXs" tone="subdued">
          {customerName} • {recipient}
        </Text>
      </BlockStack>,
      <Badge
        key={`badge-${job.id}`}
        tone={
          job.status === "COMPLETED"
            ? "success"
            : job.status === "PENDING"
            ? "attention"
            : job.status === "PROCESSING"
            ? "info"
            : job.status === "CANCELLED"
            ? undefined
            : "critical"
        }
      >
        {job.status}
      </Badge>,
      <Text key={`time-${job.id}`} as="span" variant="bodySm">
        {formatTiming(job)}
      </Text>,
      <Text key={`attempts-${job.id}`} as="span" variant="bodyXs" tone="subdued">
        {job.attempts} / {job.maxAttempts}
      </Text>,
      <InlineStack key={`actions-${job.id}`} gap="150">
        {job.status === "PENDING" && (
          <>
            <Button
              size="slim"
              variant="primary"
              onClick={() => handleRunNow(job.id)}
              loading={isSubmitting}
            >
              ⚡ Run Now
            </Button>
            <Button
              size="slim"
              tone="critical"
              onClick={() => handleCancelJob(job.id)}
              loading={isSubmitting}
            >
              🛑 Stop
            </Button>
          </>
        )}
        {job.status === "FAILED" && (
          <Button
            size="slim"
            onClick={() => handleRetryJob(job.id)}
            loading={isSubmitting}
          >
            🔄 Retry
          </Button>
        )}
        {job.status === "COMPLETED" && (
          <Text as="span" variant="bodyXs" tone="success">
            ✅ Delivered
          </Text>
        )}
        {job.status === "CANCELLED" && (
          <Text as="span" variant="bodyXs" tone="subdued">
            Cancelled
          </Text>
        )}
      </InlineStack>,
    ];
  });

  return (
    <Page
      fullWidth
      title="Automations"
      subtitle="Manage WhatsApp triggers, delivery schedules, dynamic discounts, and queued notifications."
      primaryAction={{
        content: "Save Automations",
        onAction: handleSave,
        loading: isSubmitting,
      }}
      secondaryActions={
        pendingCount > 0
          ? [
              {
                content: `🛑 Stop All Pending Jobs (${pendingCount})`,
                destructive: true,
                onAction: handleCancelAll,
              },
            ]
          : undefined
      }
    >
      <BlockStack gap="500">
        <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
          <Box padding="400">
            {selectedTab === 0 ? (
              <Layout>
                {/* 1. 🛒 Abandoned Cart Recovery Flow */}
                <Layout.Section>
                  <Card>
                    <BlockStack gap="400">
                      <InlineStack align="space-between" blockAlign="center">
                        <BlockStack gap="100">
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="h2" variant="headingMd">
                              🛒 1. Abandoned Cart Recovery Flow
                            </Text>
                            <Badge tone={cartRecovery ? "success" : undefined}>
                              {cartRecovery ? "Active" : "Disabled"}
                            </Badge>
                          </InlineStack>
                          <Text as="p" tone="subdued">
                            Automatically recovers lost sales when shoppers abandon their cart or checkout via smart WhatsApp reminders and single-use self-destroying discounts.
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

                          {/* Strategy Selector (3 Models) */}
                          <BlockStack gap="300">
                            <Text as="h3" variant="headingSm">
                              Choose Recovery Strategy & Model
                            </Text>

                            <ChoiceList
                              title=""
                              choices={[
                                {
                                  label: (
                                    <BlockStack gap="050">
                                      <InlineStack gap="150" blockAlign="center">
                                        <Text as="span" fontWeight="bold">
                                          ⚡ Model 1: Dynamic 1-Time Coupon (Self-Destroying)
                                        </Text>
                                        <Badge tone="success">Recommended</Badge>
                                      </InlineStack>
                                      <Text as="span" variant="bodySm" tone="subdued">
                                        Sends a gentle reminder first (e.g. at 30 min), then generates a unique single-use code (e.g. {dynamicPreviewCode}) via Shopify GraphQL with <Text as="span" fontWeight="bold">usageLimit: 1</Text> and expiry. Auto-destroys after 1 use to prevent coupon leaks!
                                      </Text>
                                    </BlockStack>
                                  ),
                                  value: "DYNAMIC_ONETIME",
                                },
                                {
                                  label: (
                                    <BlockStack gap="050">
                                      <InlineStack gap="150" blockAlign="center">
                                        <Text as="span" fontWeight="bold">
                                          🛡️ Model 2: Gentle Reminder Only (No Discount)
                                        </Text>
                                        <Badge tone="info">No Margin Loss</Badge>
                                      </InlineStack>
                                      <Text as="span" variant="bodySm" tone="subdued">
                                        Ideal for brands that do not want to discount products. Sends only a gentle WhatsApp reminder with cart items and 1-click checkout recovery link after 30 minutes (or custom delay). No follow-up discount is sent.
                                      </Text>
                                    </BlockStack>
                                  ),
                                  value: "REMINDER_ONLY",
                                },
                                {
                                  label: (
                                    <BlockStack gap="050">
                                      <InlineStack gap="150" blockAlign="center">
                                        <Text as="span" fontWeight="bold">
                                          🏷️ Model 3: Fixed Store-Wide Shopify Discount Code
                                        </Text>
                                      </InlineStack>
                                      <Text as="span" variant="bodySm" tone="subdued">
                                        Select from your existing live Shopify Admin discounts (e.g. SAVE10) or type a custom store code that auto-creates and syncs directly to Shopify Admin Discounts.
                                      </Text>
                                    </BlockStack>
                                  ),
                                  value: "FIXED_CODE",
                                },
                              ]}
                              selected={[recoveryStrategy]}
                              onChange={(val) => setRecoveryStrategy(val[0])}
                            />
                          </BlockStack>

                          {/* Dynamic 1-Time Coupon Settings (Model 1) */}
                          {recoveryStrategy === "DYNAMIC_ONETIME" && (
                            <Box
                              padding="400"
                              background="bg-surface-secondary"
                              borderRadius="200"
                              borderWidth="025"
                              borderColor="border"
                            >
                              <BlockStack gap="300">
                                <InlineStack align="space-between" blockAlign="center">
                                  <Text as="h4" variant="headingSm">
                                    ⚡ Dynamic Single-Use Coupon Configuration
                                  </Text>
                                  <Badge tone="success">Auto-Created in Shopify on Dispatch</Badge>
                                </InlineStack>

                                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px" }}>
                                  <TextField
                                    label="Code Prefix / Pattern"
                                    value={discountPrefix}
                                    onChange={(val) => setDiscountPrefix(val.toUpperCase())}
                                    helpText="Example: CART, VIP, FLASH, SAVE"
                                    autoComplete="off"
                                  />

                                  <Select
                                    label="Discount Percentage"
                                    options={[
                                      { label: "5% Off", value: "5" },
                                      { label: "10% Off (Standard)", value: "10" },
                                      { label: "15% Off (High Conversion)", value: "15" },
                                      { label: "20% Off (Aggressive)", value: "20" },
                                      { label: "25% Off", value: "25" },
                                    ]}
                                    value={String(discountPercent)}
                                    onChange={(val) => setDiscountPercent(parseInt(val))}
                                  />

                                  <Select
                                    label="Coupon Expiration Timer"
                                    options={[
                                      { label: "6 Hours (Fast Urgency)", value: "6" },
                                      { label: "12 Hours", value: "12" },
                                      { label: "24 Hours (Recommended)", value: "24" },
                                      { label: "48 Hours", value: "48" },
                                    ]}
                                    value={discountExpiryHours}
                                    onChange={(val) => setDiscountExpiryHours(val)}
                                    helpText="Shopify automatically expires the code after this period"
                                  />
                                </div>

                                <Box padding="200" background="bg-surface-brand-active" borderRadius="150">
                                  <InlineStack align="space-between" blockAlign="center">
                                    <Text as="span" variant="bodySm">
                                      🎫 Live Code Generated for Customer: <Text as="span" fontWeight="bold">{dynamicPreviewCode}</Text>
                                    </Text>
                                    <Text as="span" variant="bodyXs" tone="subdued">
                                      Limits: 1 Total Use • Expires in {discountExpiryHours}h • Auto-Applied at Checkout
                                    </Text>
                                  </InlineStack>
                                </Box>
                              </BlockStack>
                            </Box>
                          )}

                          {/* Fixed Store Discount Settings (Model 3) */}
                          {recoveryStrategy === "FIXED_CODE" && (
                            <Box
                              padding="400"
                              background="bg-surface-secondary"
                              borderRadius="200"
                              borderWidth="025"
                              borderColor="border"
                            >
                              <BlockStack gap="300">
                                <InlineStack align="space-between" blockAlign="center">
                                  <Text as="h4" variant="headingSm">
                                    🏷️ Shopify Admin Discount Selector & Sync
                                  </Text>
                                  <Badge tone="info">{`${shopifyDiscounts.length} Live Shopify Discounts Found`}</Badge>
                                </InlineStack>

                                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                                  {shopifyDiscounts.length > 0 && (
                                    <Select
                                      label="Select from Shopify Admin Discounts"
                                      options={[
                                        { label: "-- Select an existing Shopify discount --", value: "" },
                                        ...shopifyDiscounts.map((d) => ({
                                          label: `${d.code} (${d.summary}) - ${d.title}`,
                                          value: d.code,
                                        })),
                                      ]}
                                      value={discountCode}
                                      onChange={(val) => {
                                        if (val) setDiscountCode(val);
                                      }}
                                    />
                                  )}

                                  <TextField
                                    label="Or Enter Custom Discount Code"
                                    value={discountCode}
                                    onChange={(val) => setDiscountCode(val.toUpperCase())}
                                    helpText="Example: SAVE10 or FLAT50"
                                    autoComplete="off"
                                  />
                                </div>

                                <Checkbox
                                  label="Automatically create & sync this discount in Shopify Admin if it doesn't already exist"
                                  checked={autoCreateInShopify}
                                  onChange={(val) => setAutoCreateInShopify(val)}
                                />
                              </BlockStack>
                            </Box>
                          )}

                          <Divider />

                          {/* Delivery Schedule & Timings */}
                          <BlockStack gap="300">
                            <Text as="h3" variant="headingSm">
                              Delivery Timers & Multi-Step Sequence
                            </Text>

                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                              {/* Step 1: Gentle Reminder */}
                              <Card>
                                <BlockStack gap="300">
                                  <InlineStack align="space-between" blockAlign="center">
                                    <BlockStack gap="050">
                                      <Text as="h4" variant="headingSm">
                                        Step 1: Gentle Reminder
                                      </Text>
                                      <Text as="p" variant="bodyXs" tone="subdued">
                                        Sends cart preview & items without pressure
                                      </Text>
                                    </BlockStack>
                                    <Checkbox
                                      label=""
                                      checked={step1Active}
                                      onChange={(val) => setStep1Active(val)}
                                    />
                                  </InlineStack>

                                  <Select
                                    label="Send Delay"
                                    disabled={!step1Active}
                                    options={[
                                      { label: "15 Minutes (Fast Action)", value: "15" },
                                      { label: "30 Minutes (Recommended by Shopify)", value: "30" },
                                      { label: "45 Minutes", value: "45" },
                                      { label: "1 Hour", value: "60" },
                                      { label: "2 Hours", value: "120" },
                                    ]}
                                    value={delay1}
                                    onChange={(val) => setDelay1(val)}
                                  />
                                </BlockStack>
                              </Card>

                              {/* Step 2: Follow-up & Discount */}
                              <Card>
                                <BlockStack gap="300">
                                  <InlineStack align="space-between" blockAlign="center">
                                    <BlockStack gap="050">
                                      <Text as="h4" variant="headingSm">
                                        Step 2: Discount & Urgency Follow-up
                                      </Text>
                                      <Text as="p" variant="bodyXs" tone="subdued">
                                        {recoveryStrategy === "REMINDER_ONLY"
                                          ? "Disabled (Reminder Only Strategy)"
                                          : "Sends discount coupon code & urgency timer"}
                                      </Text>
                                    </BlockStack>
                                    <Checkbox
                                      label=""
                                      disabled={recoveryStrategy === "REMINDER_ONLY"}
                                      checked={recoveryStrategy !== "REMINDER_ONLY" && step2Active}
                                      onChange={(val) => setStep2Active(val)}
                                    />
                                  </InlineStack>

                                  <Select
                                    label="Send Delay"
                                    disabled={recoveryStrategy === "REMINDER_ONLY" || !step2Active}
                                    options={[
                                      { label: "2 Hours", value: "120" },
                                      { label: "4 Hours", value: "240" },
                                      { label: "6 Hours (Recommended)", value: "360" },
                                      { label: "12 Hours", value: "720" },
                                      { label: "24 Hours", value: "1440" },
                                    ]}
                                    value={delay2}
                                    onChange={(val) => setDelay2(val)}
                                  />
                                </BlockStack>
                              </Card>
                            </div>
                          </BlockStack>
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
                            <Badge tone={orderConfirm ? "success" : undefined}>{orderConfirm ? "Active" : "Disabled"}</Badge>
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
                            <Badge tone={orderShipped ? "success" : undefined}>{orderShipped ? "Active" : "Disabled"}</Badge>
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

                {/* 4. 📦 Order Delivery & Review Flow */}
                <Layout.Section>
                  <Card>
                    <BlockStack gap="300">
                      <InlineStack align="space-between" blockAlign="center">
                        <BlockStack gap="100">
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="h3" variant="headingMd">📦 4. Order Delivery & Review Flow</Text>
                            <Badge tone={orderDelivered ? "success" : undefined}>{orderDelivered ? "Active" : "Disabled"}</Badge>
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
                            <Badge tone={promotions ? "success" : undefined}>{promotions ? "Active" : "Disabled"}</Badge>
                          </InlineStack>
                          <Text as="p" tone="subdued">
                            Send targeted festive discounts, flash sales, and product catalog promotions with rich image banners and call-to-action buttons.
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

                {/* 6. ✨ Customer Re-engagement Flow */}
                <Layout.Section>
                  <Card>
                    <BlockStack gap="300">
                      <InlineStack align="space-between" blockAlign="center">
                        <BlockStack gap="100">
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="h3" variant="headingMd">✨ 6. Win-Back & Re-Engagement Flow</Text>
                            <Badge tone={reEngagement ? "success" : undefined}>{reEngagement ? "Active" : "Disabled"}</Badge>
                          </InlineStack>
                          <Text as="p" tone="subdued">
                            Automatically triggers special loyalty offers to buyers who haven't ordered in 45+ days to increase store repeat purchase rate.
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

                {/* 7. 🤖 Support Auto-Reply Flow */}
                <Layout.Section>
                  <Card>
                    <BlockStack gap="300">
                      <InlineStack align="space-between" blockAlign="center">
                        <BlockStack gap="100">
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="h3" variant="headingMd">🤖 7. Support Chat Auto-Reply Flow</Text>
                            <Badge tone={supportChat ? "success" : undefined}>{supportChat ? "Active" : "Disabled"}</Badge>
                          </InlineStack>
                          <Text as="p" tone="subdued">
                            Greets customer instantly when they send an inbound WhatsApp message, providing quick answers and routing to your Live Inbox.
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
            ) : (
              /* Live Queue & Job Status Tab */
              <Card padding="0">
                {jobRows.length === 0 ? (
                  <Box padding="600">
                    <BlockStack gap="200" align="center">
                      <Text as="p" tone="subdued" alignment="center">
                        No active or scheduled automation jobs in the queue.
                      </Text>
                      <Text as="p" variant="bodyXs" tone="subdued" alignment="center">
                        When an order is created or a checkout is abandoned, StorePing automatically schedules the job and shows its position, timer, and Stop button here.
                      </Text>
                    </BlockStack>
                  </Box>
                ) : (
                  <DataTable
                    columnContentTypes={["text", "text", "text", "text", "text"]}
                    headings={["Automation Event & Customer", "Status", "Schedule / Position", "Attempts", "Job Controls"]}
                    rows={jobRows}
                  />
                )}
              </Card>
            )}
          </Box>
        </Tabs>
      </BlockStack>
    </Page>
  );
}
