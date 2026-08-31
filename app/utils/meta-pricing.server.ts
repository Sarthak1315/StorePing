import db from "../db.server";

export interface MessageCostResult {
  isBillable: boolean;
  estimatedCost: number;
  currency: string;
  currencySymbol: string;
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION" | "SERVICE";
}

/**
 * Calculates the estimated cost of a WhatsApp message based on recipient country code,
 * message template category, and active Customer Service Window (CSW).
 */
export function calculateMessageCost(
  recipientPhone: string,
  categoryInput: string = "UTILITY",
  isInsideCSW: boolean = false,
  preferredCurrency: string = "INR"
): MessageCostResult {
  const cleanPhone = (recipientPhone || "").replace(/[^0-9]/g, "");
  const normalizedCategory = (categoryInput || "UTILITY").toUpperCase() as
    | "MARKETING"
    | "UTILITY"
    | "AUTHENTICATION"
    | "SERVICE";

  const isIndia = cleanPhone.startsWith("91");
  const isNorthAmerica = cleanPhone.startsWith("1");

  // Default to INR for India numbers, USD for international
  const currency = isIndia || preferredCurrency === "INR" ? "INR" : "USD";
  const currencySymbol = currency === "INR" ? "₹" : "$";

  // 1. Service Messages (Support Replies in CSW) are 100% FREE
  if (normalizedCategory === "SERVICE" || isInsideCSW) {
    if (normalizedCategory === "UTILITY") {
      // Utility templates inside open CSW are free
      return {
        isBillable: false,
        estimatedCost: 0,
        currency,
        currencySymbol,
        category: "UTILITY",
      };
    }
    return {
      isBillable: false,
      estimatedCost: 0,
      currency,
      currencySymbol,
      category: "SERVICE",
    };
  }

  // 2. India (+91) Official Per-Message Rate Card
  if (isIndia || currency === "INR") {
    if (normalizedCategory === "MARKETING") {
      return {
        isBillable: true,
        estimatedCost: 0.85,
        currency: "INR",
        currencySymbol: "₹",
        category: "MARKETING",
      };
    }
    if (normalizedCategory === "AUTHENTICATION") {
      return {
        isBillable: true,
        estimatedCost: 0.15,
        currency: "INR",
        currencySymbol: "₹",
        category: "AUTHENTICATION",
      };
    }
    // Default Utility
    return {
      isBillable: true,
      estimatedCost: 0.15,
      currency: "INR",
      currencySymbol: "₹",
      category: "UTILITY",
    };
  }

  // 3. USA / Canada (+1) Official Per-Message Rate Card
  if (isNorthAmerica || currency === "USD") {
    if (normalizedCategory === "MARKETING") {
      return {
        isBillable: true,
        estimatedCost: 0.025,
        currency: "USD",
        currencySymbol: "$",
        category: "MARKETING",
      };
    }
    if (normalizedCategory === "AUTHENTICATION") {
      return {
        isBillable: true,
        estimatedCost: 0.0135,
        currency: "USD",
        currencySymbol: "$",
        category: "AUTHENTICATION",
      };
    }
    // Default Utility
    return {
      isBillable: true,
      estimatedCost: 0.005,
      currency: "USD",
      currencySymbol: "$",
      category: "UTILITY",
    };
  }

  // 4. Rest of World Standard Fallback
  return {
    isBillable: true,
    estimatedCost: normalizedCategory === "MARKETING" ? 0.035 : 0.01,
    currency: "USD",
    currencySymbol: "$",
    category: normalizedCategory,
  };
}

/**
 * Returns a comprehensive monthly billing summary for a specific merchant store.
 */
export async function getMerchantBillingSummary(merchantId: string) {
  const merchant = await db.merchant.findUnique({
    where: { id: merchantId },
  });

  if (!merchant) {
    throw new Error(`Merchant not found: ${merchantId}`);
  }

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  // Fetch all message logs delivered in the current month
  const messagesThisMonth = await db.messageLog.findMany({
    where: {
      merchantId,
      createdAt: { gte: startOfMonth },
    },
    select: {
      id: true,
      status: true,
      pricingCategory: true,
      isBillable: true,
      estimatedCost: true,
      createdAt: true,
      recipientPhone: true,
      eventType: true,
    },
    orderBy: { createdAt: "desc" },
  });

  let marketingCount = 0;
  let marketingSpend = 0;
  let utilityCount = 0;
  let utilitySpend = 0;
  let freeServiceCount = 0;
  let totalSpend = 0;

  for (const msg of messagesThisMonth) {
    const cost = msg.estimatedCost || 0;
    const cat = (msg.pricingCategory || "UTILITY").toUpperCase();

    if (cat === "MARKETING") {
      marketingCount++;
      marketingSpend += cost;
      totalSpend += cost;
    } else if (cat === "SERVICE" || !msg.isBillable) {
      freeServiceCount++;
    } else {
      utilityCount++;
      utilitySpend += cost;
      totalSpend += cost;
    }
  }

  // Format currency
  const currency = merchant.billingCurrency || "INR";
  const currencySymbol = currency === "INR" ? "₹" : "$";
  const budgetLimit = merchant.monthlyBudgetLimit || 1000.0;
  const budgetUsedPercent = Math.min(100, Math.round((totalSpend / budgetLimit) * 100));
  const budgetRemaining = Math.max(0, budgetLimit - totalSpend);

  return {
    merchantId,
    shop: merchant.shop,
    name: merchant.name,
    planId: merchant.planId || "FREE",
    subscriptionStatus: merchant.subscriptionStatus || "ACTIVE",
    currency,
    currencySymbol,
    monthlyBudgetLimit: budgetLimit,
    totalMessagesThisMonth: messagesThisMonth.length,
    marketingCount,
    marketingSpend: Number(marketingSpend.toFixed(2)),
    utilityCount,
    utilitySpend: Number(utilitySpend.toFixed(2)),
    freeServiceCount,
    totalEstimatedSpend: Number(totalSpend.toFixed(2)),
    budgetUsedPercent,
    budgetRemaining: Number(budgetRemaining.toFixed(2)),
    alertType: merchant.alertType,
    alertMessage: merchant.alertMessage,
    recentBillableLogs: messagesThisMonth.slice(0, 15),
  };
}

/**
 * Evaluates merchant spend thresholds and triggers proactive notifications.
 */
export async function checkAndTriggerSpendAlerts(merchantId: string, currentTotalSpend: number) {
  const merchant = await db.merchant.findUnique({
    where: { id: merchantId },
    select: {
      id: true,
      shop: true,
      billingCurrency: true,
      monthlyBudgetLimit: true,
      budgetAlert50Sent: true,
      budgetAlert80Sent: true,
      budgetAlert100Sent: true,
    },
  });

  if (!merchant) return;

  const budget = merchant.monthlyBudgetLimit || 1000.0;
  const currencySymbol = merchant.billingCurrency === "USD" ? "$" : "₹";
  const percentUsed = (currentTotalSpend / budget) * 100;

  // 100% Budget Exceeded Alert
  if (percentUsed >= 100 && !merchant.budgetAlert100Sent) {
    await db.merchant.update({
      where: { id: merchantId },
      data: {
        alertType: "LIMIT_EXCEEDED",
        alertMessage: `⚠️ Monthly WhatsApp Budget 100% Reached: You have spent ${currencySymbol}${currentTotalSpend.toFixed(
          2
        )} of your ${currencySymbol}${budget.toFixed(2)} budget.`,
        budgetAlert100Sent: true,
        budgetAlert80Sent: true,
        budgetAlert50Sent: true,
      },
    });
    return;
  }

  // 80% Budget Milestone Alert
  if (percentUsed >= 80 && !merchant.budgetAlert80Sent) {
    await db.merchant.update({
      where: { id: merchantId },
      data: {
        alertType: "BUDGET_WARNING",
        alertMessage: `⚠️ WhatsApp Budget Alert: You have used 80% (${currencySymbol}${currentTotalSpend.toFixed(
          2
        )}) of your ${currencySymbol}${budget.toFixed(2)} monthly budget.`,
        budgetAlert80Sent: true,
        budgetAlert50Sent: true,
      },
    });
    return;
  }

  // 50% Budget Milestone Alert
  if (percentUsed >= 50 && !merchant.budgetAlert50Sent) {
    await db.merchant.update({
      where: { id: merchantId },
      data: {
        alertType: "BUDGET_NOTICE",
        alertMessage: `ℹ️ WhatsApp Budget Update: You have reached 50% (${currencySymbol}${currentTotalSpend.toFixed(
          2
        )}) of your monthly budget.`,
        budgetAlert50Sent: true,
      },
    });
  }
}

/**
 * Returns global platform-wide WhatsApp billing telemetry across all merchant stores for Super Admin.
 */
export async function getGlobalPlatformBillingSummary() {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [allMerchants, messagesThisMonth, totalLogsCount] = await Promise.all([
    db.merchant.findMany({
      select: {
        id: true,
        shop: true,
        name: true,
        planId: true,
        subscriptionStatus: true,
        isWhatsAppConnected: true,
        displayPhoneNumber: true,
        alertType: true,
        monthlyBudgetLimit: true,
        currentMonthSpend: true,
      },
    }),
    db.messageLog.findMany({
      where: { createdAt: { gte: startOfMonth } },
      select: {
        merchantId: true,
        pricingCategory: true,
        isBillable: true,
        estimatedCost: true,
      },
    }),
    db.messageLog.count(),
  ]);

  // Aggregate spend per merchant
  const spendPerMerchant = new Map<string, { spend: number; count: number }>();
  let platformTotalMonthSpend = 0;
  let totalBillableCount = 0;
  let totalFreeCount = 0;

  for (const msg of messagesThisMonth) {
    const cost = msg.estimatedCost || 0;
    platformTotalMonthSpend += cost;

    if (msg.isBillable) {
      totalBillableCount++;
    } else {
      totalFreeCount++;
    }

    const prev = spendPerMerchant.get(msg.merchantId) || { spend: 0, count: 0 };
    spendPerMerchant.set(msg.merchantId, {
      spend: prev.spend + cost,
      count: prev.count + 1,
    });
  }

  // Map stores with live billing data
  const storeBillingLedger = allMerchants.map((store) => {
    const usage = spendPerMerchant.get(store.id) || { spend: 0, count: 0 };
    return {
      id: store.id,
      shop: store.shop,
      name: store.name,
      planId: store.planId || "FREE",
      subscriptionStatus: store.subscriptionStatus || "ACTIVE",
      isWhatsAppConnected: store.isWhatsAppConnected,
      displayPhoneNumber: store.displayPhoneNumber,
      monthToDateSpend: Number(usage.spend.toFixed(2)),
      monthlyMessageCount: usage.count,
      budgetLimit: store.monthlyBudgetLimit || 1000.0,
      alertType: store.alertType || "NONE",
    };
  });

  return {
    totalStores: allMerchants.length,
    activePaidPlans: allMerchants.filter((m) => m.planId === "GROWTH" || m.planId === "PRO").length,
    platformTotalMonthSpend: Number(platformTotalMonthSpend.toFixed(2)),
    totalBillableCount,
    totalFreeCount,
    totalLogsCount,
    storeBillingLedger,
  };
}
