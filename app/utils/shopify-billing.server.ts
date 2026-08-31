import db from "../db.server";

export interface PlanConfig {
  id: "FREE" | "GROWTH" | "PRO";
  name: string;
  price: number; // USD per month
  inrPrice: number; // INR approx per month
  monthlyRecoveryLimit: number; // -1 for unlimited
  teamSeatsLimit: number;
  badgeTone?: "info" | "success" | "attention";
  popular?: boolean;
  features: string[];
}

export const SHOPIFY_PLANS: Record<"FREE" | "GROWTH" | "PRO", PlanConfig> = {
  FREE: {
    id: "FREE",
    name: "Free Starter",
    price: 0,
    inrPrice: 0,
    monthlyRecoveryLimit: 50,
    teamSeatsLimit: 1,
    badgeTone: "info",
    popular: false,
    features: [
      "Up to 50 Cart Recoveries / month",
      "Standard Abandoned Cart Reminder",
      "COD & Order Verification",
      "1 Team Seat",
      "Official Meta WhatsApp API",
      "Community & Email Support",
    ],
  },
  GROWTH: {
    id: "GROWTH",
    name: "Growth Plan",
    price: 19,
    inrPrice: 1599,
    monthlyRecoveryLimit: -1, // Unlimited
    teamSeatsLimit: 3,
    badgeTone: "success",
    popular: true,
    features: [
      "Unlimited Abandoned Cart Recoveries",
      "Dynamic 1-Time Personalized Discount Codes",
      "2-Way Live Customer Support Inbox",
      "Up to 3 Team Member Seats",
      "Custom Visual Template Designer",
      "Exportable CSV Audit Logs",
      "Everon Labs Priority Support",
    ],
  },
  PRO: {
    id: "PRO",
    name: "Pro / Scale",
    price: 49,
    inrPrice: 3999,
    monthlyRecoveryLimit: -1, // Unlimited
    teamSeatsLimit: 999, // Unlimited
    badgeTone: "attention",
    popular: false,
    features: [
      "Everything in Growth Plan",
      "High-Throughput Priority Dispatch Queue",
      "Unlimited Team Member Seats",
      "Full Multi-Agent Routing & Roles",
      "Meta Cloud API Telemetry & Audit Inspector",
      "Dedicated Everon Labs Account Manager",
      "1-on-1 WhatsApp API Setup Assistance",
    ],
  },
};

/**
 * Checks if a merchant is permitted to send an abandoned cart recovery.
 * Enforces the 50 recoveries/month cap on the Free Starter plan.
 */
export async function canRecoverCart(merchantId: string): Promise<{ allowed: boolean; reason?: string }> {
  const merchant = await db.merchant.findUnique({
    where: { id: merchantId },
    select: { planId: true },
  });

  const planId = (merchant?.planId || "FREE") as keyof typeof SHOPIFY_PLANS;
  const plan = SHOPIFY_PLANS[planId] || SHOPIFY_PLANS.FREE;

  if (plan.monthlyRecoveryLimit === -1) {
    return { allowed: true };
  }

  // Count recoveries in the current calendar month
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const recoveriesThisMonth = await db.cartRecovery.count({
    where: {
      merchantId,
      status: "RECOVERED",
      updatedAt: { gte: startOfMonth },
    },
  });

  if (recoveriesThisMonth >= plan.monthlyRecoveryLimit) {
    return {
      allowed: false,
      reason: `Monthly limit of ${plan.monthlyRecoveryLimit} recoveries reached on ${plan.name}. Upgrade to Growth or Pro for unlimited recoveries.`,
    };
  }

  return { allowed: true };
}

/**
 * Checks if a merchant is permitted to invite another team member based on active plan seats.
 */
export async function canAddTeamMember(merchantId: string): Promise<{ allowed: boolean; currentCount: number; maxSeats: number }> {
  const merchant = await db.merchant.findUnique({
    where: { id: merchantId },
    select: { planId: true },
  });

  const planId = (merchant?.planId || "FREE") as keyof typeof SHOPIFY_PLANS;
  const plan = SHOPIFY_PLANS[planId] || SHOPIFY_PLANS.FREE;

  const currentCount = await db.user.count({
    where: { merchantId },
  });

  if (currentCount >= plan.teamSeatsLimit) {
    return { allowed: false, currentCount, maxSeats: plan.teamSeatsLimit };
  }

  return { allowed: true, currentCount, maxSeats: plan.teamSeatsLimit };
}

/**
 * Creates a Shopify App Subscription using GraphQL Billing API.
 */
export async function createShopifyAppSubscription(
  admin: any,
  planId: "GROWTH" | "PRO",
  returnUrl: string
): Promise<{ confirmationUrl: string | null; error?: string }> {
  const plan = SHOPIFY_PLANS[planId];
  if (!plan) return { confirmationUrl: null, error: "Invalid plan selected" };

  try {
    const response = await admin.graphql(
      `#graphql
      mutation AppSubscriptionCreate($name: String!, $returnUrl: URL!, $lineItems: [AppSubscriptionLineItemInput!]!) {
        appSubscriptionCreate(name: $name, returnUrl: $returnUrl, lineItems: $lineItems) {
          appSubscription {
            id
            status
          }
          confirmationUrl
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          name: `StorePing ${plan.name}`,
          returnUrl,
          lineItems: [
            {
              plan: {
                appRecurringPricingDetails: {
                  price: { amount: plan.price, currencyCode: "USD" },
                  interval: "EVERY_30_DAYS",
                },
              },
            },
          ],
        },
      }
    );

    const json = await response.json();
    const data = json.data?.appSubscriptionCreate;

    if (data?.userErrors && data.userErrors.length > 0) {
      return { confirmationUrl: null, error: data.userErrors[0].message };
    }

    return { confirmationUrl: data?.confirmationUrl || null };
  } catch (err: any) {
    console.error("[ShopifyBilling] Subscription create error:", err);
    return { confirmationUrl: null, error: err.message || "Failed to create subscription" };
  }
}
