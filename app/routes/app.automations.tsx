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
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { logInfo } from "../utils/logger.server";
import { cancelJobById, runJobImmediately, retryJobById } from "../utils/queue.server";

export type AutomationActionData = {
  success?: boolean;
  message?: string;
  error?: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
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

  return json({ merchant, jobs, pendingCount });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
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

  // 5. Save Automation Flow Toggles
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

  return json<AutomationActionData>({ success: true, message: "Automation rules saved successfully." });
};

export default function AutomationsPage() {
  const { merchant, jobs, pendingCount } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<AutomationActionData>();

  const [selectedTab, setSelectedTab] = useState(0);

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

  const isSubmitting = fetcher.state !== "idle";

  // Floating Toast Notification Handler (No top banners)
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
        return "🛒 Cart Recovery (Step 1)";
      case "CART_RECOVERY_2":
        return "🛒 Cart Recovery (Step 2 - 10% Discount)";
      case "CART_RECOVERY_3":
        return "🛒 Cart Recovery (Step 3 - Final Urgency)";
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
      case "ADDRESS_UPDATE_PROMPT":
        return "✏️ Address Update Prompt";
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

  const jobRows = jobs.map((job: any) => {
    const payload = (job.payload || {}) as any;
    const eventType = payload.eventType || job.jobType;
    const recipient = payload.recipientPhone ? `+${payload.recipientPhone}` : "Customer";
    const customerName = payload.customerName || "Customer";

    return [
      <BlockStack gap="050">
        <Text as="span" variant="bodySm" fontWeight="bold">
          {formatEventName(eventType)}
        </Text>
        <Text as="span" variant="bodyXs" tone="subdued">
          {customerName} • {recipient}
        </Text>
      </BlockStack>,
      <Badge
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
      <Text as="span" variant="bodySm">
        {formatTiming(job)}
      </Text>,
      <Text as="span" variant="bodyXs" tone="subdued">
        {job.attempts} / {job.maxAttempts}
      </Text>,
      <InlineStack gap="150">
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
              🛑 Stop / Cancel
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
      subtitle="Manage WhatsApp triggers, delivery schedules, and queued notifications."
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
                {/* 1. 🛒 Abandoned Cart Recovery */}
                <Layout.Section>
                  <Card>
                    <BlockStack gap="400">
                      <InlineStack align="space-between" blockAlign="center">
                        <BlockStack gap="100">
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="h3" variant="headingMd">🛒 1. Abandoned Cart Recovery Flow</Text>
                            <Badge tone={cartRecovery ? "success" : undefined}>{cartRecovery ? "Active" : "Disabled"}</Badge>
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
