import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation, Form } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  Badge,
  Button,
  Banner,
  BlockStack,
  InlineStack,
  Divider,
  ProgressBar,
  Box,
  List,
  Icon,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { SHOPIFY_PLANS, createShopifyAppSubscription } from "../utils/shopify-billing.server";
import { getMerchantBillingSummary } from "../utils/meta-pricing.server";
import { getPlatformSettings } from "../utils/platform-settings.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // Find or create merchant
  let merchant = await db.merchant.findUnique({
    where: { shop },
  });

  if (!merchant) {
    merchant = await db.merchant.create({
      data: {
        shop,
        name: shop.replace(".myshopify.com", ""),
      },
    });
  }

  // Concurrently fetch billing summary, plans, and dynamic platform support settings
  const [billingSummary, platformSettings] = await Promise.all([
    getMerchantBillingSummary(merchant.id),
    getPlatformSettings(),
  ]);

  return json({
    merchant,
    plans: SHOPIFY_PLANS,
    billingSummary,
    platformSettings,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const targetPlanId = formData.get("planId") as "GROWTH" | "PRO";

  if (intent === "upgrade_plan" && (targetPlanId === "GROWTH" || targetPlanId === "PRO")) {
    const url = new URL(request.url);
    const returnUrl = `${url.origin}/app/billing?plan_updated=${targetPlanId}`;

    const { confirmationUrl, error } = await createShopifyAppSubscription(admin, targetPlanId, returnUrl);

    if (error || !confirmationUrl) {
      return json({ success: null as string | null, error: error || "Failed to initiate Shopify plan upgrade" }, { status: 400 });
    }

    return redirect(confirmationUrl);
  }

  if (intent === "select_free_plan") {
    await db.merchant.update({
      where: { shop: session.shop },
      data: {
        planId: "FREE",
        subscriptionStatus: "ACTIVE",
      },
    });
    return json({ success: "Switched to Free Starter Plan.", error: null as string | null });
  }

  return json({ success: null as string | null, error: "Unknown action" }, { status: 400 });
};

export default function BillingPage() {
  const { merchant, plans, billingSummary, platformSettings } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const activePlanId = merchant.planId || "FREE";
  const currencySymbol = billingSummary.currencySymbol || "₹";

  return (
    <Page
      title="Plans & WhatsApp Billing"
      subtitle="Manage your StorePing SaaS plan subscription and monitor live Meta WhatsApp message consumption."
      backAction={{ content: "Dashboard", url: "/app" }}
    >
      <BlockStack gap="500">
        {/* Action Alerts */}
        {actionData?.error && (
          <Banner tone="critical" title="Billing Error">
            <p>{actionData.error}</p>
          </Banner>
        )}
        {actionData?.success && (
          <Banner tone="success" title="Success">
            <p>{actionData.success}</p>
          </Banner>
        )}

        {/* Payment Required Warning Banner */}
        {merchant.alertType === "PAYMENT_REQUIRED" && (
          <Banner
            tone="critical"
            title="⚠️ WhatsApp Card Declined on Meta Business Suite"
            action={{
              content: "Update Payment Method on Meta ↗",
              url: "https://business.facebook.com/billing_hub",
              external: true,
            }}
          >
            <p>
              Meta was unable to process your message charges on your linked card. Please update your card in Meta Business Suite to avoid message delivery pauses.
            </p>
          </Banner>
        )}

        {/* 1. THREE-TIER SHOPIFY SAAS SUBSCRIPTION CARDS */}
        <Layout>
          {Object.values(plans).map((plan) => {
            const isCurrent = activePlanId === plan.id;
            return (
              <Layout.Section variant="oneThird" key={plan.id}>
                <Card>
                  <BlockStack gap="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text variant="headingMd" as="h3">
                        {plan.name}
                      </Text>
                      {isCurrent ? (
                        <Badge tone="success">Current Plan</Badge>
                      ) : plan.popular ? (
                        <Badge tone="attention">Most Popular</Badge>
                      ) : null}
                    </InlineStack>

                    <div>
                      <InlineStack align="start" blockAlign="baseline" gap="100">
                        <Text variant="headingXl" as="span" fontWeight="bold">
                          ${plan.price}
                        </Text>
                        <Text variant="bodySm" as="span" tone="subdued">
                          / month (approx. ₹{plan.inrPrice})
                        </Text>
                      </InlineStack>
                      <Text variant="bodyXs" as="p" tone="subdued">
                        Billed automatically via Shopify 30-day invoice.
                      </Text>
                    </div>

                    <Divider />

                    <BlockStack gap="200">
                      <Text variant="headingXs" as="h4" tone="subdued">
                        WHAT'S INCLUDED:
                      </Text>
                      <List type="bullet">
                        {plan.features.map((feat, idx) => (
                          <List.Item key={idx}>{feat}</List.Item>
                        ))}
                      </List>
                    </BlockStack>

                    <Divider />

                    <div style={{ paddingTop: "8px" }}>
                      {isCurrent ? (
                        <Button fullWidth disabled>
                          Active Subscription
                        </Button>
                      ) : plan.id === "FREE" ? (
                        <Form method="post">
                          <input type="hidden" name="intent" value="select_free_plan" />
                          <Button fullWidth submit loading={isSubmitting}>
                            Switch to Free
                          </Button>
                        </Form>
                      ) : (
                        <Form method="post">
                          <input type="hidden" name="intent" value="upgrade_plan" />
                          <input type="hidden" name="planId" value={plan.id} />
                          <Button
                            fullWidth
                            variant="primary"
                            submit
                            loading={isSubmitting}
                          >
                            Upgrade to {plan.name}
                          </Button>
                        </Form>
                      )}
                    </div>
                  </BlockStack>
                </Card>
              </Layout.Section>
            );
          })}
        </Layout>

        {/* 2. META WHATSAPP USAGE CONSUMPTION & DIRECT CARD BILLING */}
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <div>
                    <Text variant="headingMd" as="h3">
                      💬 Meta WhatsApp Cloud API Consumption
                    </Text>
                    <Text variant="bodySm" as="p" tone="subdued">
                      Live delivery cost estimates for this calendar month.
                    </Text>
                  </div>
                  <Badge tone="info">Model 1: Direct Meta Card</Badge>
                </InlineStack>

                <Divider />

                <InlineStack align="space-between" blockAlign="center">
                  <div>
                    <Text variant="bodySm" as="p" tone="subdued">
                      Estimated WhatsApp Spend (This Month):
                    </Text>
                    <Text variant="headingXl" as="p" fontWeight="bold">
                      {currencySymbol}
                      {billingSummary.totalEstimatedSpend.toFixed(2)}
                    </Text>
                  </div>

                  <div style={{ textAlign: "right" }}>
                    <Text variant="bodySm" as="p" tone="subdued">
                      Monthly Budget Limit:
                    </Text>
                    <Text variant="headingMd" as="p">
                      {currencySymbol}
                      {billingSummary.monthlyBudgetLimit.toFixed(2)}
                    </Text>
                  </div>
                </InlineStack>

                {/* Budget Progress */}
                <div>
                  <div style={{ marginBottom: "6px" }}>
                    <InlineStack align="space-between">
                      <Text variant="bodyXs" as="span" tone="subdued">
                        {billingSummary.budgetUsedPercent}% of monthly budget used
                      </Text>
                      <Text variant="bodyXs" as="span" tone="success">
                        {currencySymbol}
                        {billingSummary.budgetRemaining.toFixed(2)} Remaining
                      </Text>
                    </InlineStack>
                  </div>
                  <ProgressBar
                    progress={billingSummary.budgetUsedPercent}
                    tone={
                      billingSummary.budgetUsedPercent > 80
                        ? "critical"
                        : billingSummary.budgetUsedPercent > 50
                        ? "highlight"
                        : "success"
                    }
                  />
                </div>

                {/* Breakdown by Category */}
                <Box
                  padding="400"
                  background="bg-surface-secondary"
                  borderRadius="200"
                >
                  <InlineStack align="space-between" gap="400">
                    <div>
                      <Text variant="bodyXs" as="p" tone="subdued">
                        📢 MARKETING ({billingSummary.marketingCount} msgs)
                      </Text>
                      <Text variant="bodyMd" as="p" fontWeight="bold">
                        {currencySymbol}
                        {billingSummary.marketingSpend.toFixed(2)}
                      </Text>
                    </div>

                    <div>
                      <Text variant="bodyXs" as="p" tone="subdued">
                        📦 UTILITY ({billingSummary.utilityCount} msgs)
                      </Text>
                      <Text variant="bodyMd" as="p" fontWeight="bold">
                        {currencySymbol}
                        {billingSummary.utilitySpend.toFixed(2)}
                      </Text>
                    </div>

                    <div>
                      <Text variant="bodyXs" as="p" tone="subdued">
                        💬 SUPPORT CHAT ({billingSummary.freeServiceCount} msgs)
                      </Text>
                      <Text variant="bodyMd" as="p" fontWeight="bold" tone="success">
                        100% FREE (₹0.00)
                      </Text>
                    </div>
                  </InlineStack>
                </Box>

                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="bodyXs" as="p" tone="subdued">
                    * Message delivery charges are billed directly by Meta to your attached payment method in Meta Business Suite.
                  </Text>
                  <Button
                    url="https://business.facebook.com/billing_hub"
                    external
                    variant="plain"
                  >
                    Meta Invoices & Card Settings ↗
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* 3. DYNAMIC EVERON LABS DEDICATED SUPPORT CARD */}
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <InlineStack align="start" gap="200" blockAlign="center">
                  <span style={{ fontSize: "20px" }}>🏢</span>
                  <div>
                    <Text variant="headingSm" as="h3">
                      Everon Labs Support
                    </Text>
                    <Text variant="bodyXs" as="p" tone="subdued">
                      Billing & WhatsApp Technical Assistance
                    </Text>
                  </div>
                </InlineStack>

                <Divider />

                <BlockStack gap="200">
                  <div>
                    <Text variant="bodyXs" as="p" tone="subdued">
                      Support Email:
                    </Text>
                    <Text variant="bodySm" as="p" fontWeight="bold">
                      <a href={`mailto:${platformSettings.supportEmail}`} style={{ color: "inherit" }}>
                        {platformSettings.supportEmail}
                      </a>
                    </Text>
                  </div>

                  <div>
                    <Text variant="bodyXs" as="p" tone="subdued">
                      Direct Phone:
                    </Text>
                    <Text variant="bodySm" as="p" fontWeight="bold">
                      {platformSettings.supportPhone}
                    </Text>
                  </div>

                  <div>
                    <Text variant="bodyXs" as="p" tone="subdued">
                      Operating Hours:
                    </Text>
                    <Text variant="bodyXs" as="p">
                      {platformSettings.supportHours}
                    </Text>
                  </div>
                </BlockStack>

                <Divider />

                <BlockStack gap="200">
                  <Button
                    url={`https://wa.me/${platformSettings.supportWhatsApp}?text=Hello%20Everon%20Labs%20Team%2C%20I%20need%20help%20with%20StorePing%20Billing%20for%20${merchant.shop}`}
                    external
                    variant="primary"
                    fullWidth
                  >
                    💬 Chat on WhatsApp
                  </Button>
                  <Button
                    url={`mailto:${platformSettings.supportEmail}?subject=StorePing%20Support%20Request%20-%20${merchant.shop}`}
                    external
                    fullWidth
                  >
                    ✉️ Email Support
                  </Button>
                </BlockStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
