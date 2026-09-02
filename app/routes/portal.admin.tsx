import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { useState } from "react";
import db from "../db.server";
import { requireRole } from "../utils/portal-auth.server";
import { getPlatformSettings, updatePlatformSettings } from "../utils/platform-settings.server";
import { getGlobalPlatformBillingSummary } from "../utils/meta-pricing.server";

export async function loader({ request }: LoaderFunctionArgs) {
  // Only SUPER_ADMIN allowed
  const user = await requireRole(request, ["SUPER_ADMIN"]);

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Run all global platform telemetry, billing summaries, and audit queries in parallel
  const [
    pendingUsers,
    allStores,
    allUsers,
    totalDispatches,
    totalConversations,
    totalCartRecoveries,
    totalOrderConfirmations,
    callsInLastHour,
    recentJobs,
    apiLogs,
    totalApiCalls,
    apiCalls24h,
    rateLimitedCalls,
    failedApiCalls,
    latestRateLimitLog,
    callsPerMerchant1h,
    platformSettings,
    platformBilling,
    shopifyLogs,
    totalShopifyLogs,
    shopifyLogs24h,
    failedShopifyLogs,
    rateLimitedShopifyLogs,
  ] = await Promise.all([
    db.user.findMany({
      where: { approvalStatus: "PENDING" },
      include: {
        merchant: {
          select: { id: true, shop: true, name: true },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    db.merchant.findMany({
      include: {
        _count: {
          select: {
            users: true,
            messages: true,
            conversations: true,
            orderConfirmations: true,
            cartRecoveries: true,
            apiLogs: true,
            shopifyApiLogs: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    db.user.findMany({
      include: {
        merchant: {
          select: { id: true, shop: true, name: true },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    db.messageLog.count(),
    db.conversation.count(),
    db.cartRecovery.count(),
    db.orderConfirmation.count(),
    db.metaApiLog.count({
      where: {
        createdAt: { gte: oneHourAgo },
      },
    }),
    db.job.findMany({
      take: 15,
      orderBy: { runAt: "desc" },
      include: {
        merchant: {
          select: { shop: true },
        },
      },
    }),
    db.metaApiLog.findMany({
      take: 2500,
      orderBy: { createdAt: "desc" },
      include: {
        merchant: {
          select: { shop: true, name: true },
        },
      },
    }),
    db.metaApiLog.count(),
    db.metaApiLog.count({
      where: { createdAt: { gte: twentyFourHoursAgo } },
    }),
    db.metaApiLog.count({
      where: { status: "RATE_LIMITED" },
    }),
    db.metaApiLog.count({
      where: { status: "FAILED" },
    }),
    db.metaApiLog.findFirst({
      where: { rateLimitUsage: { not: null } },
      orderBy: { createdAt: "desc" },
    }),
    db.metaApiLog.groupBy({
      by: ["merchantId"],
      where: {
        createdAt: { gte: oneHourAgo },
        merchantId: { not: null },
      },
      _count: true,
    }),
    getPlatformSettings(),
    getGlobalPlatformBillingSummary(),
    db.shopifyApiLog.findMany({
      take: 2500,
      orderBy: { createdAt: "desc" },
      include: {
        merchant: {
          select: { shop: true, name: true },
        },
      },
    }),
    db.shopifyApiLog.count(),
    db.shopifyApiLog.count({
      where: { createdAt: { gte: twentyFourHoursAgo } },
    }),
    db.shopifyApiLog.count({
      where: { status: "FAILED" },
    }),
    db.shopifyApiLog.count({
      where: { status: "RATE_LIMITED" },
    }),
  ]);

  const activeWabas = allStores.filter((s) => s.isWhatsAppConnected).length;
  const connectedNumbersCount = allStores.filter((s) => s.displayPhoneNumber).length || 1;

  // Map 1-hour calls per merchant
  const merchantHourlyCallMap = new Map<string, number>();
  for (const group of callsPerMerchant1h) {
    if (group.merchantId) {
      merchantHourlyCallMap.set(group.merchantId, group._count);
    }
  }

  // Official Meta WhatsApp Business Management & Cloud API Rate Limit Formula:
  // Quota = 5,000 requests per hour, per active WABA / Phone Number
  const perWabaHourlyLimit = 5000;
  const totalPlatformWabaLimit = Math.max(1, activeWabas) * perWabaHourlyLimit;

  // Parse Meta Live Header Telemetry if present in DB
  let liveHeaderTelemetry = null;
  if (latestRateLimitLog?.rateLimitUsage) {
    try {
      const parsed = JSON.parse(latestRateLimitLog.rateLimitUsage);
      if (typeof parsed === "object") {
        const firstKey = Object.keys(parsed)[0];
        const item = Array.isArray(parsed[firstKey]) ? parsed[firstKey][0] : parsed;
        liveHeaderTelemetry = {
          callCountPct: item?.call_count ?? null,
          totalCpuTimePct: item?.total_cputime ?? null,
          totalTimePct: item?.total_time ?? null,
          estimatedTimeToRegainAccess: item?.estimated_time_to_regain_access ?? 0,
          rawHeader: latestRateLimitLog.rateLimitUsage,
        };
      }
    } catch {
      // ignore parse error
    }
  }

  const rateLimitUsedPercent =
    liveHeaderTelemetry?.callCountPct !== null && liveHeaderTelemetry?.callCountPct !== undefined
      ? Math.min(100, Math.round(Number(liveHeaderTelemetry.callCountPct)))
      : Math.min(100, Math.round((callsInLastHour / totalPlatformWabaLimit) * 100));

  const rateLimitRemainingPercent = Math.max(0, 100 - rateLimitUsedPercent);

  // Success rate calculation
  const successCount = totalApiCalls - failedApiCalls;
  const apiSuccessRate = totalApiCalls > 0 ? Math.round((successCount / totalApiCalls) * 100) : 100;

  const shopifySuccessCount = totalShopifyLogs - failedShopifyLogs;
  const shopifySuccessRate = totalShopifyLogs > 0 ? Math.round((shopifySuccessCount / totalShopifyLogs) * 100) : 100;

  // Store-level WABA rate limit & 24h tier breakdown
  const storeWabaBreakdown = allStores.map((store) => {
    const calls60m = merchantHourlyCallMap.get(store.id) || 0;
    const storeLimit = store.isWhatsAppConnected ? perWabaHourlyLimit : 200;
    const storeUsagePercent = Math.min(100, Math.round((calls60m / storeLimit) * 100));

    return {
      id: store.id,
      shop: store.shop,
      name: store.name,
      displayPhoneNumber: store.displayPhoneNumber,
      wabaId: store.wabaId,
      isWhatsAppConnected: store.isWhatsAppConnected,
      qualityRating: store.qualityRating || "GREEN",
      messagingLimitTier: store.messagingLimit || "TIER_250",
      dailySentCount: store.dailySentCount,
      calls60m,
      hourlyLimit: storeLimit,
      usagePercent: storeUsagePercent,
    };
  });

  return json({
    user,
    pendingUsers,
    allStores,
    allUsers,
    recentJobs,
    apiLogs,
    shopifyLogs,
    platformSettings,
    platformBilling,
    apiStats: {
      totalApiCalls,
      apiCalls24h,
      rateLimitedCalls,
      failedApiCalls,
      apiSuccessRate,
    },
    shopifyStats: {
      totalShopifyLogs,
      shopifyLogs24h,
      failedShopifyLogs,
      rateLimitedShopifyLogs,
      shopifySuccessRate,
    },
    rateLimitStats: {
      appId: "1083822394035933",
      appName: "StorePing",
      activeWabas,
      connectedNumbersCount,
      perWabaHourlyLimit,
      totalPlatformWabaLimit,
      callsInLastHour,
      rateLimitUsedPercent,
      rateLimitRemainingPercent,
      liveHeaderTelemetry,
    },
    storeWabaBreakdown,
    stats: {
      totalStores: allStores.length,
      activeWabas,
      totalDispatches,
      totalConversations,
      totalCartRecoveries,
      totalOrderConfirmations,
      totalUsers: allUsers.length,
      pendingCount: pendingUsers.length,
    },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireRole(request, ["SUPER_ADMIN"]);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const targetUserId = formData.get("userId") as string;
  const jobId = formData.get("jobId") as string;

  // 1. Update Global Platform Support Settings
  if (intent === "update_platform_settings") {
    const supportEmail = (formData.get("supportEmail") as string) || "";
    const supportPhone = (formData.get("supportPhone") as string) || "";
    const supportWhatsApp = (formData.get("supportWhatsApp") as string) || "";
    const supportHours = (formData.get("supportHours") as string) || "";

    await updatePlatformSettings({
      supportEmail,
      supportPhone,
      supportWhatsApp,
      supportHours,
    });

    return json({
      success: "Everon Labs platform support settings updated successfully.",
      error: null as string | null,
    });
  }

  // 2. Approve User Registration Request
  if (intent === "approve_user") {
    const updated = await db.user.update({
      where: { id: targetUserId },
      data: {
        approvalStatus: "APPROVED",
        isActive: true,
      },
    });
    return json({
      success: `Approved account for ${updated.name} (${updated.email}). User can now log in!`,
      error: null as string | null,
    });
  }

  // 3. Reject User Registration Request
  if (intent === "reject_user") {
    const updated = await db.user.update({
      where: { id: targetUserId },
      data: {
        approvalStatus: "REJECTED",
        isActive: false,
      },
    });
    return json({
      success: `Rejected registration request for ${updated.email}.`,
      error: null as string | null,
    });
  }

  // 4. Toggle User Active/Inactive
  if (intent === "toggle_user_status") {
    const currentStatus = formData.get("currentStatus") === "true";
    if (targetUserId === user.id) {
      return json({ success: null as string | null, error: "Cannot deactivate Super Admin account." }, { status: 400 });
    }
    await db.user.update({
      where: { id: targetUserId },
      data: { isActive: !currentStatus },
    });
    return json({ success: "User status updated.", error: null as string | null });
  }

  // 5. Delete User Account
  if (intent === "delete_user") {
    if (targetUserId === user.id) {
      return json({ success: null as string | null, error: "Cannot delete Super Admin account." }, { status: 400 });
    }
    await db.user.delete({ where: { id: targetUserId } });
    return json({ success: "User account deleted.", error: null as string | null });
  }

  // 6. Retry Background Job
  if (intent === "retry_job" && jobId) {
    await db.job.update({
      where: { id: jobId },
      data: {
        status: "PENDING",
        attempts: 0,
        runAt: new Date(),
        error: null,
      },
    });
    return json({ success: "Job reset to PENDING for immediate retry.", error: null as string | null });
  }

  // 7. Delete Background Job
  if (intent === "delete_job" && jobId) {
    await db.job.delete({ where: { id: jobId } });
    return json({ success: "Job removed from queue.", error: null as string | null });
  }

  // 8. Purge Completed Jobs
  if (intent === "purge_completed_jobs") {
    const res = await db.job.deleteMany({
      where: { status: "COMPLETED" },
    });
    return json({ success: `Purged ${res.count} completed jobs from history.`, error: null as string | null });
  }

  return json({ success: null as string | null, error: "Unknown action" }, { status: 400 });
}

export default function SuperAdminDashboard() {
  const {
    user,
    pendingUsers,
    allStores,
    allUsers,
    recentJobs,
    apiLogs,
    shopifyLogs,
    apiStats,
    shopifyStats,
    rateLimitStats,
    storeWabaBreakdown,
    platformSettings,
    platformBilling,
    stats,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  // Sidebar Collapse / Expand State
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  // Active Main Navigation Section
  const [activeSection, setActiveSection] = useState<
    "OVERVIEW" | "BILLING" | "SETTINGS" | "META_LOGS" | "SHOPIFY_LOGS" | "API_LOGS" | "APPROVALS" | "STORES" | "USERS" | "JOBS"
  >("OVERVIEW");

  // Filter & Search States
  const [userSearch, setUserSearch] = useState("");
  const [userRoleFilter, setUserRoleFilter] = useState("ALL");
  const [userStatusFilter, setUserStatusFilter] = useState("ALL");

  const [storeSearch, setStoreSearch] = useState("");
  const [billingSearch, setBillingSearch] = useState("");
  const [billingPlanFilter, setBillingPlanFilter] = useState("ALL");
  const [showRateLimitDetails, setShowRateLimitDetails] = useState(false);

  // API Logs Filter States
  const [logPlatform, setLogPlatform] = useState<"META" | "SHOPIFY">("META");
  const [apiSearch, setApiSearch] = useState("");
  const [apiStatusFilter, setApiStatusFilter] = useState("ALL");
  const [apiMethodFilter, setApiMethodFilter] = useState("ALL");
  const [shopifyApiTypeFilter, setShopifyApiTypeFilter] = useState("ALL");
  const [selectedApiLog, setSelectedApiLog] = useState<(typeof apiLogs)[number] | null>(null);
  const [selectedShopifyLog, setSelectedShopifyLog] = useState<(typeof shopifyLogs)[number] | null>(null);
  const [metaInspectTab, setMetaInspectTab] = useState<"OVERVIEW" | "PAYLOAD" | "RESPONSE" | "ERROR" | "RAW_DB">("OVERVIEW");
  const [shopifyInspectTab, setShopifyInspectTab] = useState<"OVERVIEW" | "PAYLOAD" | "RESPONSE" | "ERROR" | "RAW_DB">("OVERVIEW");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copyToClipboard = (text: string, key: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    }
  };

  const formatJson = (val: string | null | undefined) => {
    if (!val) return "";
    try {
      const parsed = JSON.parse(val);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return val;
    }
  };

  // Group By & Pagination States for Meta
  const [metaGroupBy, setMetaGroupBy] = useState<"NONE" | "STORE" | "WEBHOOK" | "ENDPOINT">("NONE");
  const [metaPage, setMetaPage] = useState(1);
  const [metaPageSize, setMetaPageSize] = useState(15);

  // Group By & Pagination States for Shopify
  const [shopifyGroupBy, setShopifyGroupBy] = useState<"NONE" | "STORE" | "WEBHOOK" | "API_TYPE">("NONE");
  const [shopifyPage, setShopifyPage] = useState(1);
  const [shopifyPageSize, setShopifyPageSize] = useState(15);

  // Export Modal State
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportLogType, setExportLogType] = useState<"meta" | "shopify">("meta");
  const [exportRangePreset, setExportRangePreset] = useState("1m");
  const [exportStartDate, setExportStartDate] = useState("");
  const [exportEndDate, setExportEndDate] = useState("");
  const [exportStatus, setExportStatus] = useState("ALL");

  // Filtered Users
  const filteredUsers = allUsers.filter((u) => {
    const matchesSearch =
      u.name.toLowerCase().includes(userSearch.toLowerCase()) ||
      u.email.toLowerCase().includes(userSearch.toLowerCase()) ||
      (u.merchant?.shop && u.merchant.shop.toLowerCase().includes(userSearch.toLowerCase()));

    const matchesRole = userRoleFilter === "ALL" || u.role === userRoleFilter;
    const matchesStatus =
      userStatusFilter === "ALL" ||
      (userStatusFilter === "PENDING" && u.approvalStatus === "PENDING") ||
      (userStatusFilter === "APPROVED" && u.approvalStatus === "APPROVED") ||
      (userStatusFilter === "REJECTED" && u.approvalStatus === "REJECTED") ||
      (userStatusFilter === "ACTIVE" && u.isActive) ||
      (userStatusFilter === "INACTIVE" && !u.isActive);

    return matchesSearch && matchesRole && matchesStatus;
  });

  // Filtered Stores
  const filteredStores = allStores.filter((s) => {
    const query = storeSearch.toLowerCase();
    return (
      s.shop.toLowerCase().includes(query) ||
      (s.name && s.name.toLowerCase().includes(query)) ||
      (s.displayPhoneNumber && s.displayPhoneNumber.includes(query)) ||
      (s.wabaId && s.wabaId.includes(query))
    );
  });

  // Filtered Billing Ledger
  const filteredBillingLedger = platformBilling.storeBillingLedger.filter((s) => {
    const query = billingSearch.toLowerCase();
    const matchesSearch = s.shop.toLowerCase().includes(query) || (s.name && s.name.toLowerCase().includes(query));
    const matchesPlan = billingPlanFilter === "ALL" || s.planId === billingPlanFilter;
    return matchesSearch && matchesPlan;
  });

  // Filtered Meta API Logs:
  // Default: Only display last 24 hours of records
  // Search: Searches full database history across all dates
  const isMetaSearchActive = apiSearch.trim().length > 0;
  const filteredApiLogs = apiLogs.filter((log) => {
    const query = apiSearch.toLowerCase().trim();

    // When not searching, restrict strictly to the last 24 hours
    if (!isMetaSearchActive) {
      const logTime = new Date(log.createdAt).getTime();
      const isWithin24h = logTime >= Date.now() - 24 * 60 * 60 * 1000;
      if (!isWithin24h) return false;
    }

    const matchesSearch =
      !isMetaSearchActive ||
      log.endpoint.toLowerCase().includes(query) ||
      (log.initiatedBy && log.initiatedBy.toLowerCase().includes(query)) ||
      (log.merchant?.shop && log.merchant.shop.toLowerCase().includes(query)) ||
      (log.merchant?.name && log.merchant.name.toLowerCase().includes(query)) ||
      (log.metaMessageId && log.metaMessageId.toLowerCase().includes(query)) ||
      (log.errorMessage && log.errorMessage.toLowerCase().includes(query)) ||
      (log.statusCode && log.statusCode.toString().includes(query));

    const matchesStatus = apiStatusFilter === "ALL" || log.status === apiStatusFilter;
    const matchesMethod = apiMethodFilter === "ALL" || log.httpMethod === apiMethodFilter;

    return matchesSearch && matchesStatus && matchesMethod;
  });

  // Meta Group By Aggregations
  // 1. Group By Store
  const metaStoreGroups = Object.values(
    filteredApiLogs.reduce<
      Record<
        string,
        {
          store: string;
          name: string;
          totalCalls: number;
          successCount: number;
          rateLimitedCount: number;
          failedCount: number;
          totalDurationMs: number;
          avgLatency: number;
          lastActivity: Date;
        }
      >
    >((acc, log) => {
      const storeKey = log.merchant?.shop || "Global / System";
      if (!acc[storeKey]) {
        acc[storeKey] = {
          store: storeKey,
          name: log.merchant?.name || storeKey,
          totalCalls: 0,
          successCount: 0,
          rateLimitedCount: 0,
          failedCount: 0,
          totalDurationMs: 0,
          avgLatency: 0,
          lastActivity: new Date(log.createdAt),
        };
      }
      acc[storeKey].totalCalls++;
      if (log.status === "SUCCESS") acc[storeKey].successCount++;
      else if (log.status === "RATE_LIMITED") acc[storeKey].rateLimitedCount++;
      else acc[storeKey].failedCount++;

      if (log.durationMs) acc[storeKey].totalDurationMs += log.durationMs;
      const logDate = new Date(log.createdAt);
      if (logDate > acc[storeKey].lastActivity) acc[storeKey].lastActivity = logDate;
      return acc;
    }, {})
  )
    .map((g) => ({
      ...g,
      avgLatency: g.totalCalls > 0 ? Math.round(g.totalDurationMs / g.totalCalls) : 0,
    }))
    .sort((a, b) => b.totalCalls - a.totalCalls);

  // 2. Group By Webhook
  const metaWebhookGroups = Object.values(
    filteredApiLogs
      .filter((log) => {
        const trigger = (log.initiatedBy || "").toLowerCase();
        const ep = (log.endpoint || "").toLowerCase();
        return (
          trigger.includes("webhook") ||
          ep.includes("webhook") ||
          ep.includes("subscribed_apps") ||
          trigger.includes("inbound") ||
          trigger.includes("status") ||
          trigger.includes("interactive")
        );
      })
      .reduce<
        Record<
          string,
          {
            webhookType: string;
            endpoint: string;
            totalCount: number;
            successCount: number;
            failedCount: number;
            rateLimitedCount: number;
            totalDurationMs: number;
            avgLatency: number;
            lastReceived: Date;
          }
        >
      >((acc, log) => {
        const key = log.initiatedBy || log.endpoint || "Meta Inbound Webhook";
        if (!acc[key]) {
          acc[key] = {
            webhookType: key,
            endpoint: log.endpoint,
            totalCount: 0,
            successCount: 0,
            failedCount: 0,
            rateLimitedCount: 0,
            totalDurationMs: 0,
            avgLatency: 0,
            lastReceived: new Date(log.createdAt),
          };
        }
        acc[key].totalCount++;
        if (log.status === "SUCCESS") acc[key].successCount++;
        else if (log.status === "RATE_LIMITED") acc[key].rateLimitedCount++;
        else acc[key].failedCount++;

        if (log.durationMs) acc[key].totalDurationMs += log.durationMs;
        const logDate = new Date(log.createdAt);
        if (logDate > acc[key].lastReceived) acc[key].lastReceived = logDate;
        return acc;
      }, {})
  )
    .map((g) => ({
      ...g,
      avgLatency: g.totalCount > 0 ? Math.round(g.totalDurationMs / g.totalCount) : 0,
    }))
    .sort((a, b) => b.totalCount - a.totalCount);

  // 3. Group By API Endpoint
  const metaEndpointGroups = Object.values(
    filteredApiLogs.reduce<
      Record<
        string,
        {
          endpointKey: string;
          httpMethod: string;
          endpoint: string;
          totalCalls: number;
          successCount: number;
          rateLimitedCount: number;
          failedCount: number;
          totalDurationMs: number;
          avgLatency: number;
          lastCall: Date;
        }
      >
    >((acc, log) => {
      const cleanEndpoint = log.endpoint.replace(/\/v\d+\.\d+\/\d+/, "").replace(/\?.*/, "") || log.endpoint;
      const key = `${log.httpMethod} ${cleanEndpoint}`;
      if (!acc[key]) {
        acc[key] = {
          endpointKey: key,
          httpMethod: log.httpMethod,
          endpoint: log.endpoint,
          totalCalls: 0,
          successCount: 0,
          rateLimitedCount: 0,
          failedCount: 0,
          totalDurationMs: 0,
          avgLatency: 0,
          lastCall: new Date(log.createdAt),
        };
      }
      acc[key].totalCalls++;
      if (log.status === "SUCCESS") acc[key].successCount++;
      else if (log.status === "RATE_LIMITED") acc[key].rateLimitedCount++;
      else acc[key].failedCount++;

      if (log.durationMs) acc[key].totalDurationMs += log.durationMs;
      const logDate = new Date(log.createdAt);
      if (logDate > acc[key].lastCall) acc[key].lastCall = logDate;
      return acc;
    }, {})
  )
    .map((g) => ({
      ...g,
      avgLatency: g.totalCalls > 0 ? Math.round(g.totalDurationMs / g.totalCalls) : 0,
    }))
    .sort((a, b) => b.totalCalls - a.totalCalls);

  // Filtered Shopify API & Webhook Logs:
  // Default: Only display last 24 hours of records
  // Search: Searches full database history across all dates
  const isShopifySearchActive = apiSearch.trim().length > 0;
  const filteredShopifyLogs = shopifyLogs.filter((log) => {
    const query = apiSearch.toLowerCase().trim();

    // When not searching, restrict strictly to the last 24 hours
    if (!isShopifySearchActive) {
      const logTime = new Date(log.createdAt).getTime();
      const isWithin24h = logTime >= Date.now() - 24 * 60 * 60 * 1000;
      if (!isWithin24h) return false;
    }

    const matchesSearch =
      !isShopifySearchActive ||
      log.topic.toLowerCase().includes(query) ||
      (log.initiatedBy && log.initiatedBy.toLowerCase().includes(query)) ||
      (log.shop && log.shop.toLowerCase().includes(query)) ||
      (log.merchant?.name && log.merchant.name.toLowerCase().includes(query)) ||
      (log.webhookId && log.webhookId.toLowerCase().includes(query)) ||
      (log.errorMessage && log.errorMessage.toLowerCase().includes(query)) ||
      (log.statusCode && log.statusCode.toString().includes(query));

    const matchesStatus = apiStatusFilter === "ALL" || log.status === apiStatusFilter;
    const matchesMethod = apiMethodFilter === "ALL" || log.httpMethod === apiMethodFilter;
    const matchesApiType = shopifyApiTypeFilter === "ALL" || log.apiType === shopifyApiTypeFilter;

    return matchesSearch && matchesStatus && matchesMethod && matchesApiType;
  });

  // Shopify Group By Aggregations
  // 1. Group By Store
  const shopifyStoreGroups = Object.values(
    filteredShopifyLogs.reduce<
      Record<
        string,
        {
          store: string;
          name: string;
          totalOps: number;
          webhookCount: number;
          graphqlCount: number;
          restCount: number;
          successCount: number;
          rateLimitedCount: number;
          failedCount: number;
          totalDurationMs: number;
          avgLatency: number;
          lastActivity: Date;
        }
      >
    >((acc, log) => {
      const storeKey = log.shop || log.merchant?.shop || "Global / App";
      if (!acc[storeKey]) {
        acc[storeKey] = {
          store: storeKey,
          name: log.merchant?.name || storeKey,
          totalOps: 0,
          webhookCount: 0,
          graphqlCount: 0,
          restCount: 0,
          successCount: 0,
          rateLimitedCount: 0,
          failedCount: 0,
          totalDurationMs: 0,
          avgLatency: 0,
          lastActivity: new Date(log.createdAt),
        };
      }
      acc[storeKey].totalOps++;
      if (log.apiType === "WEBHOOK") acc[storeKey].webhookCount++;
      else if (log.apiType === "GRAPHQL") acc[storeKey].graphqlCount++;
      else if (log.apiType === "REST") acc[storeKey].restCount++;

      if (log.status === "SUCCESS") acc[storeKey].successCount++;
      else if (log.status === "RATE_LIMITED") acc[storeKey].rateLimitedCount++;
      else acc[storeKey].failedCount++;

      if (log.durationMs) acc[storeKey].totalDurationMs += log.durationMs;
      const logDate = new Date(log.createdAt);
      if (logDate > acc[storeKey].lastActivity) acc[storeKey].lastActivity = logDate;
      return acc;
    }, {})
  )
    .map((g) => ({
      ...g,
      avgLatency: g.totalOps > 0 ? Math.round(g.totalDurationMs / g.totalOps) : 0,
    }))
    .sort((a, b) => b.totalOps - a.totalOps);

  // 2. Group By Webhook Topic
  const shopifyWebhookGroups = Object.values(
    filteredShopifyLogs
      .filter((log) => log.apiType === "WEBHOOK" || log.topic.includes("ORDERS") || log.topic.includes("CHECKOUTS") || log.topic.includes("APP_") || log.topic.includes("FULFILLMENTS"))
      .reduce<
        Record<
          string,
          {
            topic: string;
            totalCount: number;
            successCount: number;
            failedCount: number;
            ignoredCount: number;
            rateLimitedCount: number;
            totalDurationMs: number;
            avgLatency: number;
            lastReceived: Date;
          }
        >
      >((acc, log) => {
        const key = log.topic || "UNKNOWN_WEBHOOK";
        if (!acc[key]) {
          acc[key] = {
            topic: key,
            totalCount: 0,
            successCount: 0,
            failedCount: 0,
            ignoredCount: 0,
            rateLimitedCount: 0,
            totalDurationMs: 0,
            avgLatency: 0,
            lastReceived: new Date(log.createdAt),
          };
        }
        acc[key].totalCount++;
        if (log.status === "SUCCESS") acc[key].successCount++;
        else if (log.status === "IGNORED") acc[key].ignoredCount++;
        else if (log.status === "RATE_LIMITED") acc[key].rateLimitedCount++;
        else acc[key].failedCount++;

        if (log.durationMs) acc[key].totalDurationMs += log.durationMs;
        const logDate = new Date(log.createdAt);
        if (logDate > acc[key].lastReceived) acc[key].lastReceived = logDate;
        return acc;
      }, {})
  )
    .map((g) => ({
      ...g,
      avgLatency: g.totalCount > 0 ? Math.round(g.totalDurationMs / g.totalCount) : 0,
    }))
    .sort((a, b) => b.totalCount - a.totalCount);

  // 3. Group By API Operation
  const shopifyApiGroups = Object.values(
    filteredShopifyLogs.reduce<
      Record<
        string,
        {
          operationKey: string;
          apiType: string;
          topic: string;
          httpMethod: string;
          totalCalls: number;
          successCount: number;
          failedCount: number;
          rateLimitedCount: number;
          totalDurationMs: number;
          avgLatency: number;
          lastCall: Date;
        }
      >
    >((acc, log) => {
      const key = `${log.apiType} : ${log.topic || log.httpMethod}`;
      if (!acc[key]) {
        acc[key] = {
          operationKey: key,
          apiType: log.apiType,
          topic: log.topic,
          httpMethod: log.httpMethod,
          totalCalls: 0,
          successCount: 0,
          failedCount: 0,
          rateLimitedCount: 0,
          totalDurationMs: 0,
          avgLatency: 0,
          lastCall: new Date(log.createdAt),
        };
      }
      acc[key].totalCalls++;
      if (log.status === "SUCCESS") acc[key].successCount++;
      else if (log.status === "RATE_LIMITED") acc[key].rateLimitedCount++;
      else acc[key].failedCount++;

      if (log.durationMs) acc[key].totalDurationMs += log.durationMs;
      const logDate = new Date(log.createdAt);
      if (logDate > acc[key].lastCall) acc[key].lastCall = logDate;
      return acc;
    }, {})
  )
    .map((g) => ({
      ...g,
      avgLatency: g.totalCalls > 0 ? Math.round(g.totalDurationMs / g.totalCalls) : 0,
    }))
    .sort((a, b) => b.totalCalls - a.totalCalls);

  const exportDownloadUrl = `/api/admin/export-logs?type=${exportLogType}&range=${exportRangePreset}${
    exportRangePreset === "custom" && exportStartDate ? `&startDate=${exportStartDate}` : ""
  }${exportRangePreset === "custom" && exportEndDate ? `&endDate=${exportEndDate}` : ""}&status=${exportStatus}`;

  // Menu items list with distinct Meta and Shopify telemetry sections
  const menuItems = [
    {
      id: "OVERVIEW" as const,
      label: "Overview & Limits",
      icon: "📊",
      badge: null,
    },
    {
      id: "BILLING" as const,
      label: "Merchant Billing & Plans",
      icon: "💳",
      badge: `${platformBilling.activePaidPlans} Paid`,
      badgeColor: "bg-emerald-500/20 text-emerald-300 font-bold",
    },
    {
      id: "SETTINGS" as const,
      label: "Platform Support Settings",
      icon: "🏢",
      badge: "Dynamic",
      badgeColor: "bg-slate-800 text-slate-400",
    },
    {
      id: "META_LOGS" as const,
      label: "Meta Logs & Webhooks",
      icon: "🟢",
      badge: `${apiStats.apiCalls24h}`,
      badgeColor: "bg-slate-800 text-emerald-400",
    },
    {
      id: "SHOPIFY_LOGS" as const,
      label: "Shopify Logs & Webhooks",
      icon: "🛍️",
      badge: `${shopifyStats.shopifyLogs24h}`,
      badgeColor: "bg-slate-800 text-purple-400",
    },
    {
      id: "APPROVALS" as const,
      label: "Pending Approvals",
      icon: "⏳",
      badge: pendingUsers.length > 0 ? `${pendingUsers.length}` : null,
      badgeColor: "bg-amber-500/20 text-amber-300 font-bold",
    },
    {
      id: "STORES" as const,
      label: "Stores Directory",
      icon: "🏬",
      badge: `${allStores.length}`,
      badgeColor: "bg-slate-800 text-slate-400",
    },
    {
      id: "USERS" as const,
      label: "User Directory",
      icon: "👥",
      badge: `${allUsers.length}`,
      badgeColor: "bg-slate-800 text-slate-400",
    },
    {
      id: "JOBS" as const,
      label: "Background Queue",
      icon: "⚙️",
      badge: `${recentJobs.length}`,
      badgeColor: "bg-slate-800 text-slate-400",
    },
  ];

  return (
    <div className="h-screen w-screen overflow-hidden bg-slate-950 text-slate-100 flex flex-col md:flex-row font-sans">
      {/* 1. DEDICATED SUPER ADMIN SIDEBAR (COLLAPSIBLE) */}
      <aside
        className={`bg-slate-900 border-r border-slate-800 flex flex-col justify-between shrink-0 h-full transition-all duration-300 ${
          isSidebarOpen ? "w-72" : "w-20"
        }`}
      >
        <div className="flex-1 flex flex-col min-h-0">
          {/* Sidebar Top: Logo & Toggle Button */}
          <div className="p-4 border-b border-slate-800 flex items-center justify-between shrink-0">
            {isSidebarOpen ? (
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center text-base shrink-0">
                  👑
                </div>
                <div>
                  <div className="font-bold text-sm tracking-tight text-white">StorePing Admin</div>
                  <div className="text-[10px] text-slate-400 font-medium">Super Admin Portal</div>
                </div>
              </div>
            ) : (
              <div className="mx-auto w-8 h-8 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center text-base">
                👑
              </div>
            )}

            <button
              type="button"
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 text-xs transition shrink-0"
              title={isSidebarOpen ? "Collapse Sidebar" : "Expand Sidebar"}
            >
              {isSidebarOpen ? "◀" : "▶"}
            </button>
          </div>

          {/* Super Admin Badge Banner */}
          {isSidebarOpen && (
            <div className="px-4 py-2.5 border-b border-slate-800/80 bg-slate-950/40 text-[11px] text-slate-400 flex items-center justify-between">
              <span>Platform Governance</span>
              <span className="text-[9px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 py-0.5 rounded font-mono font-semibold">
                ● Live
              </span>
            </div>
          )}

          {/* Sidebar Navigation Items */}
          <nav className="p-3 space-y-1 overflow-y-auto flex-1">
            {isSidebarOpen && (
              <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                Governance & Auditing
              </div>
            )}

            {menuItems.map((item) => {
              const isActive =
                activeSection === item.id ||
                (item.id === "META_LOGS" && activeSection === "API_LOGS" && logPlatform === "META") ||
                (item.id === "SHOPIFY_LOGS" && activeSection === "API_LOGS" && logPlatform === "SHOPIFY");
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setActiveSection(item.id);
                    if (item.id === "META_LOGS") {
                      setLogPlatform("META");
                      setMetaPage(1);
                    } else if (item.id === "SHOPIFY_LOGS") {
                      setLogPlatform("SHOPIFY");
                      setShopifyPage(1);
                    }
                  }}
                  title={!isSidebarOpen ? item.label : undefined}
                  className={`w-full flex items-center ${
                    isSidebarOpen ? "justify-between px-3" : "justify-center px-2"
                  } py-2.5 rounded-xl text-xs font-medium transition-colors ${
                    isActive
                      ? "bg-slate-800 text-white font-semibold border-l-2 border-emerald-400"
                      : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
                  }`}
                >
                  <div className="flex items-center gap-2.5 truncate">
                    <span className="text-sm shrink-0">{item.icon}</span>
                    {isSidebarOpen && <span className="truncate">{item.label}</span>}
                  </div>

                  {isSidebarOpen && item.badge && (
                    <span
                      className={`text-[10px] px-1.5 py-0.2 rounded-md font-mono shrink-0 ${
                        item.badgeColor || "bg-slate-800 text-slate-400"
                      }`}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}

            {/* Quick Workspace Switcher link to Live Support Inbox */}
            <div className="pt-3 border-t border-slate-800/80 mt-3">
              {isSidebarOpen && (
                <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  Customer Ops
                </div>
              )}
              <Link
                to="/portal/inbox"
                prefetch="intent"
                title={!isSidebarOpen ? "Live Support Inbox" : undefined}
                className={`w-full flex items-center ${
                  isSidebarOpen ? "justify-between px-3" : "justify-center px-2"
                } py-2.5 rounded-xl text-xs font-medium text-slate-400 hover:text-white hover:bg-slate-800/50 transition`}
              >
                <div className="flex items-center gap-2.5">
                  <span className="text-sm">💬</span>
                  {isSidebarOpen && <span>Live Support Inbox</span>}
                </div>
                {isSidebarOpen && (
                  <span className="text-[10px] px-1.5 py-0.2 bg-slate-800 text-slate-400 rounded-md font-mono">
                    2-Way
                  </span>
                )}
              </Link>
            </div>
          </nav>
        </div>

        {/* Sidebar Footer: User Profile & Sign Out */}
        <div className="p-3 border-t border-slate-800 bg-slate-950/50 shrink-0">
          {isSidebarOpen ? (
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-7 h-7 rounded-lg bg-slate-800 text-emerald-400 font-bold flex items-center justify-center text-xs shrink-0 border border-slate-700">
                  {user.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="truncate">
                  <div className="text-xs font-semibold text-white truncate">{user.name}</div>
                  <div className="text-[10px] text-slate-400 font-mono">SUPER_ADMIN</div>
                </div>
              </div>

              <Form action="/portal/login" method="post">
                <input type="hidden" name="intent" value="logout" />
                <button
                  type="submit"
                  className="px-2 py-1 text-[10px] font-medium text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded transition"
                  title="Sign Out"
                >
                  🚪 Exit
                </button>
              </Form>
            </div>
          ) : (
            <div className="flex justify-center">
              <Form action="/portal/login" method="post">
                <input type="hidden" name="intent" value="logout" />
                <button
                  type="submit"
                  className="p-1.5 text-xs text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded transition"
                  title="Sign Out"
                >
                  🚪
                </button>
              </Form>
            </div>
          )}
        </div>
      </aside>

      {/* 2. MAIN CONTENT VIEWPORT */}
      <main className="flex-1 flex flex-col min-w-0 h-full overflow-hidden bg-slate-950">
        {/* Top Viewport Header */}
        <header className="h-16 border-b border-slate-800 bg-slate-900/60 backdrop-blur-md px-6 lg:px-8 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              className="md:hidden p-2 rounded-lg bg-slate-800 text-slate-300 text-xs"
            >
              ☰
            </button>
            <div>
              <h1 className="text-base font-bold text-white tracking-tight">
                {activeSection === "META_LOGS" || (activeSection === "API_LOGS" && logPlatform === "META")
                  ? "Meta API Logs & Telemetry"
                  : activeSection === "SHOPIFY_LOGS" || (activeSection === "API_LOGS" && logPlatform === "SHOPIFY")
                  ? "Shopify API & Webhook Logs"
                  : menuItems.find((m) => m.id === activeSection)?.label || "Super Admin"}
              </h1>
              <p className="text-[11px] text-slate-400 hidden sm:block">
                {activeSection === "META_LOGS" || (activeSection === "API_LOGS" && logPlatform === "META")
                  ? "Meta WhatsApp Cloud API requests, inbound webhooks, and live pricing & token usage telemetry."
                  : activeSection === "SHOPIFY_LOGS" || (activeSection === "API_LOGS" && logPlatform === "SHOPIFY")
                  ? "Shopify Webhooks ingestion, GraphQL Admin queries/mutations, and store integration audit trail."
                  : "StorePing multi-tenant platform telemetry, WhatsApp Cloud API billing, and merchant governance."}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {(activeSection === "API_LOGS" || activeSection === "META_LOGS" || activeSection === "SHOPIFY_LOGS") && (
              <button
                type="button"
                onClick={() => {
                  setExportLogType(activeSection === "SHOPIFY_LOGS" || logPlatform === "SHOPIFY" ? "shopify" : "meta");
                  setShowExportModal(true);
                }}
                className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-semibold transition flex items-center gap-1.5"
              >
                <span>📊</span>
                <span>Export to Excel / CSV</span>
              </button>
            )}

            <Link
              to="/portal/inbox"
              prefetch="intent"
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium border border-slate-700 transition flex items-center gap-1.5"
            >
              <span>💬</span>
              <span>Support Inbox</span>
            </Link>
          </div>
        </header>

        {/* Scrollable Main Body */}
        <div className="flex-1 overflow-y-auto p-6 lg:p-8 space-y-6">
          {/* Action Alerts */}
          {actionData?.success && (
            <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-medium flex items-center gap-2">
              <span>✅</span>
              <span>{actionData.success}</span>
            </div>
          )}
          {actionData?.error && (
            <div className="p-3.5 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-medium flex items-center gap-2">
              <span>⚠️</span>
              <span>{actionData.error}</span>
            </div>
          )}

          {/* SECTION 1: OVERVIEW & RATE LIMITS */}
          {activeSection === "OVERVIEW" && (
            <div className="space-y-6">
              {/* Meta WhatsApp Business Management & Cloud API Rate Limit Card */}
              <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 shadow-sm space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center text-lg shrink-0">
                      💬
                    </div>
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        WhatsApp Business Cloud API (BUC) Rate Limit
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <h3 className="text-sm font-bold text-white">{rateLimitStats.appName}</h3>
                        <span className="text-xs font-mono text-slate-400">
                          App ID: {rateLimitStats.appId}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Official Meta WhatsApp Cloud API rolling 1-hour quota: 5,000 requests/hr per active WABA / Phone Number.
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setShowRateLimitDetails(!showRateLimitDetails)}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg text-xs font-medium transition self-start sm:self-auto"
                  >
                    {showRateLimitDetails ? "Hide Details" : "View Details"}
                  </button>
                </div>

                {/* Progress Bar Display */}
                <div className="pt-2 border-t border-slate-800/80">
                  <div className="flex items-center justify-between text-xs mb-2">
                    <span className="text-slate-300 font-medium">
                      {rateLimitStats.rateLimitUsedPercent}% of WABA hourly quota used
                    </span>
                    <span className="text-emerald-400 font-mono font-semibold">
                      {rateLimitStats.rateLimitRemainingPercent}% Remaining
                    </span>
                  </div>

                  <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        rateLimitStats.rateLimitUsedPercent > 80
                          ? "bg-red-500"
                          : rateLimitStats.rateLimitUsedPercent > 50
                          ? "bg-amber-400"
                          : "bg-emerald-500"
                      }`}
                      style={{
                        width: `${Math.max(2, rateLimitStats.rateLimitUsedPercent)}%`,
                      }}
                    />
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between text-[11px] text-slate-400 mt-2 font-mono gap-1">
                    <span>Platform 60m Calls: {rateLimitStats.callsInLastHour} calls</span>
                    <span>
                      Total Capacity: {rateLimitStats.totalPlatformWabaLimit} calls/hr (5,000 × {rateLimitStats.activeWabas} active WABAs)
                    </span>
                  </div>
                </div>

                {/* Live Header Telemetry Badge if returned by Meta */}
                {rateLimitStats.liveHeaderTelemetry && (
                  <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800 flex flex-wrap items-center gap-4 text-xs font-mono">
                    <span className="text-slate-400 font-bold uppercase text-[10px]">
                      Live Meta Header Telemetry:
                    </span>
                    {rateLimitStats.liveHeaderTelemetry.callCountPct !== null && (
                      <span className="text-emerald-400">
                        Call Count: {rateLimitStats.liveHeaderTelemetry.callCountPct}%
                      </span>
                    )}
                    {rateLimitStats.liveHeaderTelemetry.totalCpuTimePct !== null && (
                      <span className="text-slate-300">
                        CPU Time: {rateLimitStats.liveHeaderTelemetry.totalCpuTimePct}%
                      </span>
                    )}
                    {rateLimitStats.liveHeaderTelemetry.totalTimePct !== null && (
                      <span className="text-slate-300">
                        Total Time: {rateLimitStats.liveHeaderTelemetry.totalTimePct}%
                      </span>
                    )}
                    <span className="text-slate-400">
                      Throttle Regain: {rateLimitStats.liveHeaderTelemetry.estimatedTimeToRegainAccess}m
                    </span>
                  </div>
                )}
              </div>

              {/* Platform Telemetry Cards */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
                <div className="p-4 rounded-xl bg-slate-900 border border-slate-800">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Total Stores
                  </div>
                  <div className="text-xl font-bold text-white mt-1 font-mono">{stats.totalStores}</div>
                  <div className="text-[10px] text-emerald-400 mt-0.5 font-medium">
                    {stats.activeWabas} Active WhatsApp WABAs
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-slate-900 border border-slate-800">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Platform WhatsApp Spend (30d)
                  </div>
                  <div className="text-xl font-bold text-emerald-400 mt-1 font-mono">
                    ₹{platformBilling.platformTotalMonthSpend.toFixed(2)}
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5">
                    {platformBilling.totalBillableCount} Billable Deliveries
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-slate-900 border border-slate-800">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Active Paid SaaS Stores
                  </div>
                  <div className="text-xl font-bold text-white mt-1 font-mono">
                    {platformBilling.activePaidPlans} Stores
                  </div>
                  <div className="text-[10px] text-emerald-400 mt-0.5 font-medium">
                    Growth & Pro Subscriptions
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-slate-900 border border-slate-800">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Pending Approvals
                  </div>
                  <div className="text-xl font-bold text-amber-300 mt-1 font-mono">{stats.pendingCount}</div>
                  <div className="text-[10px] text-amber-400/80 mt-0.5">Requires Review</div>
                </div>
              </div>
            </div>
          )}

          {/* SECTION 2: MERCHANT BILLING & PLANS CENTER */}
          {activeSection === "BILLING" && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h2 className="text-sm font-bold text-white flex items-center gap-2">
                    <span>💳</span>
                    <span>Merchant Subscriptions & WhatsApp Billing Ledger</span>
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Monitor each connected store's active Shopify SaaS Plan, current month WhatsApp spend, and payment health.
                  </p>
                </div>

                <div className="flex items-center gap-2.5">
                  <select
                    value={billingPlanFilter}
                    onChange={(e) => setBillingPlanFilter(e.target.value)}
                    className="px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-300 focus:outline-none focus:border-slate-600"
                  >
                    <option value="ALL">All SaaS Plans</option>
                    <option value="FREE">Free Starter ($0)</option>
                    <option value="GROWTH">Growth ($19)</option>
                    <option value="PRO">Pro / Scale ($49)</option>
                  </select>

                  <div className="relative w-56">
                    <input
                      type="text"
                      value={billingSearch}
                      onChange={(e) => setBillingSearch(e.target.value)}
                      placeholder="Search store domain..."
                      className="w-full pl-7 pr-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-slate-600"
                    />
                    <span className="absolute left-2.5 top-2 text-[10px] text-slate-500">🔍</span>
                  </div>
                </div>
              </div>

              {/* Summary KPIs */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono">
                <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                  <div className="text-[10px] font-bold text-slate-400 uppercase font-sans">Total Platform Spend</div>
                  <div className="text-base font-bold text-emerald-400 mt-0.5">₹{platformBilling.platformTotalMonthSpend.toFixed(2)}</div>
                </div>
                <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                  <div className="text-[10px] font-bold text-slate-400 uppercase font-sans">Billable Messages</div>
                  <div className="text-base font-bold text-white mt-0.5">{platformBilling.totalBillableCount}</div>
                </div>
                <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                  <div className="text-[10px] font-bold text-slate-400 uppercase font-sans">Free CSW Support Msgs</div>
                  <div className="text-base font-bold text-emerald-400 mt-0.5">{platformBilling.totalFreeCount} (₹0.00)</div>
                </div>
                <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                  <div className="text-[10px] font-bold text-slate-400 uppercase font-sans">Paid SaaS Subscriptions</div>
                  <div className="text-base font-bold text-teal-400 mt-0.5">{platformBilling.activePaidPlans} Stores</div>
                </div>
              </div>

              {/* Stores Billing Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400 font-medium">
                      <th className="pb-2.5">Shopify Store</th>
                      <th className="pb-2.5">Shopify SaaS Plan</th>
                      <th className="pb-2.5">Subscription Status</th>
                      <th className="pb-2.5">WhatsApp Number</th>
                      <th className="pb-2.5">Month-to-Date Spend</th>
                      <th className="pb-2.5">Monthly Deliveries</th>
                      <th className="pb-2.5">Payment Health</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
                    {filteredBillingLedger.map((s) => (
                      <tr key={s.id} className="hover:bg-slate-800/30 transition">
                        <td className="py-3 font-sans font-semibold text-white">
                          {s.shop}
                          {s.name && <span className="text-slate-400 font-normal ml-1">({s.name})</span>}
                        </td>
                        <td className="py-3">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              s.planId === "PRO"
                                ? "bg-purple-500/20 text-purple-300 border border-purple-500/30"
                                : s.planId === "GROWTH"
                                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                                : "bg-slate-800 text-slate-400 border border-slate-700"
                            }`}
                          >
                            {s.planId === "PRO" ? "PRO ($49)" : s.planId === "GROWTH" ? "GROWTH ($19)" : "FREE ($0)"}
                          </span>
                        </td>
                        <td className="py-3 font-sans">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                              s.subscriptionStatus === "ACTIVE"
                                ? "bg-emerald-500/10 text-emerald-400"
                                : "bg-amber-500/10 text-amber-300"
                            }`}
                          >
                            {s.subscriptionStatus}
                          </span>
                        </td>
                        <td className="py-3 text-slate-300">
                          {s.displayPhoneNumber || <span className="text-slate-500">Not Connected</span>}
                        </td>
                        <td className="py-3 text-white font-bold">
                          ₹{s.monthToDateSpend.toFixed(2)}
                        </td>
                        <td className="py-3 text-slate-300">
                          {s.monthlyMessageCount} messages
                        </td>
                        <td className="py-3 font-sans">
                          {s.alertType === "PAYMENT_REQUIRED" ? (
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-red-500/20 text-red-300 border border-red-500/40">
                              ⚠️ Card Declined
                            </span>
                          ) : s.alertType === "LIMIT_EXCEEDED" ? (
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40">
                              100% Budget Reached
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-400">
                              ● Healthy
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* SECTION 3: PLATFORM SUPPORT CONFIGURATION (DYNAMIC SETTINGS) */}
          {activeSection === "SETTINGS" && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Left 2 Cols: Form to Edit Dynamic Support Settings */}
              <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-sm space-y-4">
                <div>
                  <h2 className="text-sm font-bold text-white flex items-center gap-2">
                    <span>🏢</span>
                    <span>Everon Labs Global Support Configuration</span>
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    Manage the dynamic billing support email, direct phone number, WhatsApp contact, and operating hours rendered across all merchant portals and Shopify apps.
                  </p>
                </div>

                <Form method="post" className="space-y-4 pt-2">
                  <input type="hidden" name="intent" value="update_platform_settings" />

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-slate-300 mb-1">
                        Billing Support Email
                      </label>
                      <input
                        type="email"
                        name="supportEmail"
                        defaultValue={platformSettings.supportEmail}
                        required
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white focus:outline-none focus:border-slate-600"
                      />
                      <span className="text-[10px] text-slate-500 mt-0.5 block">
                        Displayed on invoice footers and help cards.
                      </span>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-slate-300 mb-1">
                        Direct Support Phone Number
                      </label>
                      <input
                        type="text"
                        name="supportPhone"
                        defaultValue={platformSettings.supportPhone}
                        required
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white font-mono focus:outline-none focus:border-slate-600"
                      />
                      <span className="text-[10px] text-slate-500 mt-0.5 block">
                        Official hotline for merchant calls.
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-slate-300 mb-1">
                        Support WhatsApp Number (Digits only with country code)
                      </label>
                      <input
                        type="text"
                        name="supportWhatsApp"
                        defaultValue={platformSettings.supportWhatsApp}
                        required
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white font-mono focus:outline-none focus:border-slate-600"
                      />
                      <span className="text-[10px] text-slate-500 mt-0.5 block">
                        Used to generate 1-click WhatsApp support links (`wa.me/919374626600`).
                      </span>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-slate-300 mb-1">
                        Support Operating Hours
                      </label>
                      <input
                        type="text"
                        name="supportHours"
                        defaultValue={platformSettings.supportHours}
                        required
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white focus:outline-none focus:border-slate-600"
                      />
                      <span className="text-[10px] text-slate-500 mt-0.5 block">
                        e.g., Monday - Saturday: 9:00 AM - 8:00 PM IST
                      </span>
                    </div>
                  </div>

                  <div className="pt-3 border-t border-slate-800 flex justify-end">
                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className="px-5 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-xl text-xs transition shadow-sm"
                    >
                      {isSubmitting ? "Saving Changes..." : "Save Platform Support Settings"}
                    </button>
                  </div>
                </Form>
              </div>

              {/* Right Col: Live Preview of Dynamic Support Card */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm space-y-3 h-fit">
                <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                  Live Merchant Preview
                </div>
                <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-center text-sm">
                      🏢
                    </div>
                    <div>
                      <div className="text-xs font-bold text-white">Everon Labs Support</div>
                      <div className="text-[10px] text-slate-400">Billing & WhatsApp Assistance</div>
                    </div>
                  </div>

                  <div className="space-y-1 text-xs text-slate-300 font-mono text-[11px] pt-1">
                    <div>✉️ {platformSettings.supportEmail}</div>
                    <div>📞 {platformSettings.supportPhone}</div>
                    <div className="text-slate-400 text-[10px] font-sans">{platformSettings.supportHours}</div>
                  </div>

                  <div className="pt-2">
                    <span className="block w-full py-1.5 text-center bg-emerald-500 text-slate-950 font-bold rounded-lg text-[11px]">
                      💬 Chat on WhatsApp
                    </span>
                  </div>
                </div>
                <p className="text-[11px] text-slate-500">
                  This card updates automatically on `/app/billing` and `/portal/billing` whenever you save changes.
                </p>
              </div>
            </div>
          )}

          {/* SECTION 4: API LOGS & WEBHOOK TELEMETRY (META & SHOPIFY WITH GROUPBY & PAGING) */}
          {(activeSection === "API_LOGS" || activeSection === "META_LOGS" || activeSection === "SHOPIFY_LOGS") && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm space-y-4">
              {/* Platform Switcher Tabs & Export Button */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setLogPlatform("META");
                      setMetaPage(1);
                      setSelectedApiLog(null);
                      setSelectedShopifyLog(null);
                    }}
                    className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition flex items-center gap-1.5 ${
                      logPlatform === "META"
                        ? "bg-emerald-500 text-slate-950 shadow-sm"
                        : "bg-slate-950 text-slate-400 border border-slate-800 hover:text-white hover:bg-slate-800/60"
                    }`}
                  >
                    <span>🟢</span>
                    <span>
                      Meta WhatsApp Cloud API ({apiSearch.trim() ? `${filteredApiLogs.length} found` : `${apiStats.apiCalls24h} (24h)`})
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setLogPlatform("SHOPIFY");
                      setShopifyPage(1);
                      setSelectedApiLog(null);
                      setSelectedShopifyLog(null);
                    }}
                    className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition flex items-center gap-1.5 ${
                      logPlatform === "SHOPIFY"
                        ? "bg-purple-500 text-white shadow-sm"
                        : "bg-slate-950 text-slate-400 border border-slate-800 hover:text-white hover:bg-slate-800/60"
                    }`}
                  >
                    <span>🛍️</span>
                    <span>
                      Shopify Webhooks & GraphQL ({apiSearch.trim() ? `${filteredShopifyLogs.length} found` : `${shopifyStats.shopifyLogs24h} (24h)`})
                    </span>
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setExportLogType(logPlatform === "META" ? "meta" : "shopify");
                    setShowExportModal(true);
                  }}
                  className="px-3.5 py-1.5 bg-slate-950 hover:bg-slate-800 text-slate-200 border border-slate-700 rounded-xl text-xs font-semibold transition flex items-center gap-1.5 shadow-sm"
                >
                  <span>📊</span>
                  <span>Export CSV Logs</span>
                </button>
              </div>

              {/* Telemetry Metric Cards */}
              {logPlatform === "META" ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                    <div className="text-[10px] font-bold text-slate-400 uppercase">24-Hour Meta Calls</div>
                    <div className="text-base font-bold text-white font-mono mt-0.5">{apiStats.apiCalls24h}</div>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                    <div className="text-[10px] font-bold text-slate-400 uppercase">Success Rate</div>
                    <div className="text-base font-bold text-emerald-400 font-mono mt-0.5">{apiStats.apiSuccessRate}%</div>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                    <div className="text-[10px] font-bold text-slate-400 uppercase">Rate Limited (429)</div>
                    <div className="text-base font-bold text-amber-300 font-mono mt-0.5">{apiStats.rateLimitedCalls}</div>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                    <div className="text-[10px] font-bold text-slate-400 uppercase">Failed Calls</div>
                    <div className="text-base font-bold text-red-400 font-mono mt-0.5">{apiStats.failedApiCalls}</div>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                    <div className="text-[10px] font-bold text-slate-400 uppercase">24-Hour Shopify Ops</div>
                    <div className="text-base font-bold text-white font-mono mt-0.5">{shopifyStats.shopifyLogs24h}</div>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                    <div className="text-[10px] font-bold text-slate-400 uppercase">Success Rate</div>
                    <div className="text-base font-bold text-emerald-400 font-mono mt-0.5">{shopifyStats.shopifySuccessRate}%</div>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                    <div className="text-[10px] font-bold text-slate-400 uppercase">Rate Limited</div>
                    <div className="text-base font-bold text-amber-300 font-mono mt-0.5">{shopifyStats.rateLimitedShopifyLogs}</div>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                    <div className="text-[10px] font-bold text-slate-400 uppercase">Failed Webhooks</div>
                    <div className="text-base font-bold text-red-400 font-mono mt-0.5">{shopifyStats.failedShopifyLogs}</div>
                  </div>
                </div>
              )}

              {/* Group By Selector Bar */}
              <div className="flex flex-wrap items-center justify-between gap-2 p-2 rounded-xl bg-slate-950/80 border border-slate-800">
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-slate-400 font-medium px-1 text-[11px]">Group By:</span>
                  {logPlatform === "META" ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setMetaGroupBy("NONE");
                          setMetaPage(1);
                        }}
                        className={`px-2.5 py-1 rounded-lg font-medium transition text-xs ${
                          metaGroupBy === "NONE"
                            ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                            : "text-slate-400 hover:text-white hover:bg-slate-800"
                        }`}
                      >
                        📋 All Logs ({filteredApiLogs.length})
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setMetaGroupBy("STORE");
                          setMetaPage(1);
                        }}
                        className={`px-2.5 py-1 rounded-lg font-medium transition text-xs ${
                          metaGroupBy === "STORE"
                            ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                            : "text-slate-400 hover:text-white hover:bg-slate-800"
                        }`}
                      >
                        🏬 Group by Store ({metaStoreGroups.length})
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setMetaGroupBy("WEBHOOK");
                          setMetaPage(1);
                        }}
                        className={`px-2.5 py-1 rounded-lg font-medium transition text-xs ${
                          metaGroupBy === "WEBHOOK"
                            ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                            : "text-slate-400 hover:text-white hover:bg-slate-800"
                        }`}
                      >
                        🪝 Group by Webhook ({metaWebhookGroups.length})
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setMetaGroupBy("ENDPOINT");
                          setMetaPage(1);
                        }}
                        className={`px-2.5 py-1 rounded-lg font-medium transition text-xs ${
                          metaGroupBy === "ENDPOINT"
                            ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                            : "text-slate-400 hover:text-white hover:bg-slate-800"
                        }`}
                      >
                        ⚡ Group by API Call ({metaEndpointGroups.length})
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setShopifyGroupBy("NONE");
                          setShopifyPage(1);
                        }}
                        className={`px-2.5 py-1 rounded-lg font-medium transition text-xs ${
                          shopifyGroupBy === "NONE"
                            ? "bg-purple-500/20 text-purple-300 border border-purple-500/30"
                            : "text-slate-400 hover:text-white hover:bg-slate-800"
                        }`}
                      >
                        📋 All Logs ({filteredShopifyLogs.length})
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setShopifyGroupBy("STORE");
                          setShopifyPage(1);
                        }}
                        className={`px-2.5 py-1 rounded-lg font-medium transition text-xs ${
                          shopifyGroupBy === "STORE"
                            ? "bg-purple-500/20 text-purple-300 border border-purple-500/30"
                            : "text-slate-400 hover:text-white hover:bg-slate-800"
                        }`}
                      >
                        🏬 Group by Store ({shopifyStoreGroups.length})
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setShopifyGroupBy("WEBHOOK");
                          setShopifyPage(1);
                        }}
                        className={`px-2.5 py-1 rounded-lg font-medium transition text-xs ${
                          shopifyGroupBy === "WEBHOOK"
                            ? "bg-purple-500/20 text-purple-300 border border-purple-500/30"
                            : "text-slate-400 hover:text-white hover:bg-slate-800"
                        }`}
                      >
                        🪝 Group by Webhook ({shopifyWebhookGroups.length})
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setShopifyGroupBy("API_TYPE");
                          setShopifyPage(1);
                        }}
                        className={`px-2.5 py-1 rounded-lg font-medium transition text-xs ${
                          shopifyGroupBy === "API_TYPE"
                            ? "bg-purple-500/20 text-purple-300 border border-purple-500/30"
                            : "text-slate-400 hover:text-white hover:bg-slate-800"
                        }`}
                      >
                        ⚡ Group by API Call ({shopifyApiGroups.length})
                      </button>
                    </>
                  )}
                </div>

                {/* Per Page Selector */}
                <div className="flex items-center gap-1.5 text-xs text-slate-400">
                  <span className="text-[10px]">Show:</span>
                  <select
                    value={logPlatform === "META" ? metaPageSize : shopifyPageSize}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      if (logPlatform === "META") {
                        setMetaPageSize(val);
                        setMetaPage(1);
                      } else {
                        setShopifyPageSize(val);
                        setShopifyPage(1);
                      }
                    }}
                    className="px-2 py-0.5 bg-slate-900 border border-slate-700 rounded text-xs text-slate-200 focus:outline-none focus:border-slate-500"
                  >
                    <option value={10}>10 / page</option>
                    <option value={15}>15 / page</option>
                    <option value={25}>25 / page</option>
                    <option value={50}>50 / page</option>
                    <option value={100}>100 / page</option>
                  </select>
                </div>
              </div>

              {/* Search & Filter Bar */}
              <div className="flex flex-wrap items-center gap-2.5 pt-1">
                <select
                  value={apiStatusFilter}
                  onChange={(e) => {
                    setApiStatusFilter(e.target.value);
                    setMetaPage(1);
                    setShopifyPage(1);
                  }}
                  className="px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-300 focus:outline-none focus:border-slate-600"
                >
                  <option value="ALL">All Statuses</option>
                  <option value="SUCCESS">✅ SUCCESS</option>
                  <option value="RATE_LIMITED">⚠️ RATE_LIMITED (429)</option>
                  <option value="FAILED">❌ FAILED</option>
                  {logPlatform === "SHOPIFY" && <option value="IGNORED">⚪ IGNORED</option>}
                </select>

                {logPlatform === "SHOPIFY" && (
                  <select
                    value={shopifyApiTypeFilter}
                    onChange={(e) => {
                      setShopifyApiTypeFilter(e.target.value);
                      setShopifyPage(1);
                    }}
                    className="px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-300 focus:outline-none focus:border-slate-600"
                  >
                    <option value="ALL">All API Types</option>
                    <option value="WEBHOOK">🪝 WEBHOOK</option>
                    <option value="GRAPHQL">⚡ GRAPHQL</option>
                    <option value="REST">🌐 REST</option>
                    <option value="OAUTH">🔐 OAUTH</option>
                  </select>
                )}

                <select
                  value={apiMethodFilter}
                  onChange={(e) => {
                    setApiMethodFilter(e.target.value);
                    setMetaPage(1);
                    setShopifyPage(1);
                  }}
                  className="px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-300 focus:outline-none focus:border-slate-600"
                >
                  <option value="ALL">All HTTP Methods</option>
                  <option value="POST">POST</option>
                  <option value="GET">GET</option>
                  <option value="GRAPHQL">GRAPHQL</option>
                  <option value="DELETE">DELETE</option>
                </select>

                <div className="relative flex-1 min-w-[220px]">
                  <input
                    type="text"
                    value={apiSearch}
                    onChange={(e) => {
                      setApiSearch(e.target.value);
                      setMetaPage(1);
                      setShopifyPage(1);
                    }}
                    placeholder={
                      logPlatform === "META"
                        ? "Search endpoint, store name/shop, trigger, message ID, status code..."
                        : "Search topic, store domain, webhook ID, error, status code..."
                    }
                    className="w-full pl-7 pr-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-slate-600"
                  />
                  <span className="absolute left-2.5 top-2 text-[10px] text-slate-500">🔍</span>
                </div>

                {apiSearch && (
                  <button
                    type="button"
                    onClick={() => {
                      setApiSearch("");
                      setMetaPage(1);
                      setShopifyPage(1);
                    }}
                    className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white rounded text-xs"
                  >
                    Clear ✕
                  </button>
                )}
              </div>

              {/* 24-Hour vs Full Table Search Context Bar */}
              <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-[11px]">
                <div className="flex items-center gap-1.5">
                  {apiSearch.trim() ? (
                    <span className="text-emerald-400 font-semibold flex items-center gap-1">
                      <span>🌐</span>
                      <span>
                        Full Table Search Active: {logPlatform === "META" ? filteredApiLogs.length : filteredShopifyLogs.length} matching records found across all time
                      </span>
                    </span>
                  ) : (
                    <span className="text-slate-400 flex items-center gap-1">
                      <span>🕒</span>
                      <span>
                        Displaying last 24 hours of records only. Type in the search box to search the entire database table.
                      </span>
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-slate-500 font-mono">
                  Database Total: {logPlatform === "META" ? apiStats.totalApiCalls : shopifyStats.totalShopifyLogs} records
                </div>
              </div>

              {/* ========================================================================= */}
              {/* PLATFORM 1: META WHATSAPP VIEWS (ALL LOGS & GROUPED VIEWS) */}
              {/* ========================================================================= */}
              {logPlatform === "META" && (
                <>
                  {/* VIEW 1: ALL META LOGS */}
                  {metaGroupBy === "NONE" && (
                    filteredApiLogs.length === 0 ? (
                      <div className="p-10 text-center bg-slate-950 rounded-xl border border-slate-800 text-xs text-slate-500">
                        No Meta API audit records matching filter criteria.
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-xs">
                            <thead>
                              <tr className="border-b border-slate-800 text-slate-400 font-medium">
                                <th className="pb-2.5">Timestamp</th>
                                <th className="pb-2.5">Initiated By / Trigger</th>
                                <th className="pb-2.5">Store</th>
                                <th className="pb-2.5">Method & Endpoint</th>
                                <th className="pb-2.5">Status</th>
                                <th className="pb-2.5">Latency</th>
                                <th className="pb-2.5 text-right">Details</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
                              {filteredApiLogs
                                .slice((metaPage - 1) * metaPageSize, metaPage * metaPageSize)
                                .map((log) => (
                                  <tr key={log.id} className="hover:bg-slate-800/30 transition">
                                    <td className="py-3 text-slate-400 whitespace-nowrap">
                                      <div>{new Date(log.createdAt).toLocaleDateString()}</div>
                                      <div className="text-[10px] text-slate-500">
                                        {new Date(log.createdAt).toLocaleTimeString([], {
                                          hour: "2-digit",
                                          minute: "2-digit",
                                          second: "2-digit",
                                        })}
                                      </div>
                                    </td>
                                    <td className="py-3 text-white font-sans font-medium">
                                      {log.initiatedBy || "System"}
                                    </td>
                                    <td className="py-3 text-slate-300 font-sans">
                                      <div>{log.merchant?.name || log.merchant?.shop || "Global"}</div>
                                      {log.merchant?.shop && log.merchant.name && (
                                        <div className="text-[10px] text-slate-500 font-mono">{log.merchant.shop}</div>
                                      )}
                                    </td>
                                    <td className="py-3">
                                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold mr-1.5 bg-slate-800 text-slate-300 border border-slate-700">
                                        {log.httpMethod}
                                      </span>
                                      <span className="text-slate-300 font-mono">{log.endpoint}</span>
                                    </td>
                                    <td className="py-3">
                                      <span
                                        className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                                          log.status === "SUCCESS"
                                            ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                                            : log.status === "RATE_LIMITED"
                                            ? "bg-amber-500/10 text-amber-300 border border-amber-500/20"
                                            : "bg-red-500/10 text-red-400 border border-red-500/20"
                                        }`}
                                      >
                                        {log.statusCode || (log.status === "SUCCESS" ? 200 : 500)} {log.status}
                                      </span>
                                    </td>
                                    <td className="py-3 text-slate-400">
                                      {log.durationMs ? `${log.durationMs}ms` : "—"}
                                    </td>
                                    <td className="py-3 text-right">
                                      <button
                                        type="button"
                                        onClick={() => setSelectedApiLog(log)}
                                        className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-[10px] font-sans font-medium transition"
                                      >
                                        Inspect 🔍
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                            </tbody>
                          </table>
                        </div>

                        {/* Pagination Bar */}
                        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-800 text-xs text-slate-400">
                          <div>
                            Showing {(metaPage - 1) * metaPageSize + 1} to{" "}
                            {Math.min(metaPage * metaPageSize, filteredApiLogs.length)} of {filteredApiLogs.length} Meta logs
                          </div>

                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={metaPage <= 1}
                              onClick={() => setMetaPage((p) => Math.max(1, p - 1))}
                              className="px-3 py-1 bg-slate-950 border border-slate-800 hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-slate-950 rounded text-xs text-white"
                            >
                              ◀ Previous
                            </button>

                            <span className="px-2 font-mono text-[11px] text-slate-300">
                              Page {metaPage} of {Math.ceil(filteredApiLogs.length / metaPageSize) || 1}
                            </span>

                            <button
                              type="button"
                              disabled={metaPage >= Math.ceil(filteredApiLogs.length / metaPageSize)}
                              onClick={() => setMetaPage((p) => p + 1)}
                              className="px-3 py-1 bg-slate-950 border border-slate-800 hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-slate-950 rounded text-xs text-white"
                            >
                              Next ▶
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  )}

                  {/* VIEW 2: META GROUP BY STORE */}
                  {metaGroupBy === "STORE" && (
                    metaStoreGroups.length === 0 ? (
                      <div className="p-10 text-center bg-slate-950 rounded-xl border border-slate-800 text-xs text-slate-500">
                        No stores found matching current filters.
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-xs">
                            <thead>
                              <tr className="border-b border-slate-800 text-slate-400 font-medium">
                                <th className="pb-2.5">Store / Merchant</th>
                                <th className="pb-2.5">Total Meta Calls</th>
                                <th className="pb-2.5">Success Rate</th>
                                <th className="pb-2.5">Rate Limited (429)</th>
                                <th className="pb-2.5">Failed Calls</th>
                                <th className="pb-2.5">Avg Latency</th>
                                <th className="pb-2.5">Last Activity</th>
                                <th className="pb-2.5 text-right">Drilldown</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
                              {metaStoreGroups
                                .slice((metaPage - 1) * metaPageSize, metaPage * metaPageSize)
                                .map((group) => {
                                  const successRate = group.totalCalls > 0 ? Math.round((group.successCount / group.totalCalls) * 100) : 100;
                                  return (
                                    <tr key={group.store} className="hover:bg-slate-800/30 transition">
                                      <td className="py-3 font-sans">
                                        <div className="font-semibold text-white">{group.name}</div>
                                        <div className="text-[10px] text-slate-400 font-mono">{group.store}</div>
                                      </td>
                                      <td className="py-3 text-white font-bold">{group.totalCalls}</td>
                                      <td className="py-3">
                                        <span className="text-emerald-400 font-semibold">{successRate}%</span>
                                        <span className="text-slate-500 text-[10px] ml-1">({group.successCount})</span>
                                      </td>
                                      <td className="py-3">
                                        {group.rateLimitedCount > 0 ? (
                                          <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-300 font-bold border border-amber-500/30">
                                            {group.rateLimitedCount}
                                          </span>
                                        ) : (
                                          <span className="text-slate-500">0</span>
                                        )}
                                      </td>
                                      <td className="py-3">
                                        {group.failedCount > 0 ? (
                                          <span className="px-1.5 py-0.5 rounded text-[10px] bg-red-500/20 text-red-300 font-bold border border-red-500/30">
                                            {group.failedCount}
                                          </span>
                                        ) : (
                                          <span className="text-slate-500">0</span>
                                        )}
                                      </td>
                                      <td className="py-3 text-slate-300">{group.avgLatency}ms</td>
                                      <td className="py-3 text-slate-400 text-[10px] whitespace-nowrap">
                                        {group.lastActivity.toLocaleString()}
                                      </td>
                                      <td className="py-3 text-right font-sans">
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setApiSearch(group.store);
                                            setMetaGroupBy("NONE");
                                            setMetaPage(1);
                                          }}
                                          className="px-2.5 py-1 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 rounded text-[10px] font-semibold transition"
                                        >
                                          View Store Logs 🔍
                                        </button>
                                      </td>
                                    </tr>
                                  );
                                })}
                            </tbody>
                          </table>
                        </div>

                        {/* Pagination Bar */}
                        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-800 text-xs text-slate-400">
                          <div>
                            Showing {(metaPage - 1) * metaPageSize + 1} to{" "}
                            {Math.min(metaPage * metaPageSize, metaStoreGroups.length)} of {metaStoreGroups.length} Stores
                          </div>

                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={metaPage <= 1}
                              onClick={() => setMetaPage((p) => Math.max(1, p - 1))}
                              className="px-3 py-1 bg-slate-950 border border-slate-800 hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-slate-950 rounded text-xs text-white"
                            >
                              ◀ Previous
                            </button>

                            <span className="px-2 font-mono text-[11px] text-slate-300">
                              Page {metaPage} of {Math.ceil(metaStoreGroups.length / metaPageSize) || 1}
                            </span>

                            <button
                              type="button"
                              disabled={metaPage >= Math.ceil(metaStoreGroups.length / metaPageSize)}
                              onClick={() => setMetaPage((p) => p + 1)}
                              className="px-3 py-1 bg-slate-950 border border-slate-800 hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-slate-950 rounded text-xs text-white"
                            >
                              Next ▶
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  )}

                  {/* VIEW 3: META GROUP BY WEBHOOK */}
                  {metaGroupBy === "WEBHOOK" && (
                    metaWebhookGroups.length === 0 ? (
                      <div className="p-10 text-center bg-slate-950 rounded-xl border border-slate-800 text-xs text-slate-500">
                        No webhook transactions found matching current filters.
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-xs">
                            <thead>
                              <tr className="border-b border-slate-800 text-slate-400 font-medium">
                                <th className="pb-2.5">Webhook Trigger / Event</th>
                                <th className="pb-2.5">Total Invocations</th>
                                <th className="pb-2.5">Success (200 OK)</th>
                                <th className="pb-2.5">Failures</th>
                                <th className="pb-2.5">Rate Limited</th>
                                <th className="pb-2.5">Avg Latency</th>
                                <th className="pb-2.5">Last Received</th>
                                <th className="pb-2.5 text-right">Drilldown</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
                              {metaWebhookGroups
                                .slice((metaPage - 1) * metaPageSize, metaPage * metaPageSize)
                                .map((group) => {
                                  return (
                                    <tr key={group.webhookType} className="hover:bg-slate-800/30 transition">
                                      <td className="py-3 font-sans font-semibold text-white">
                                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 mr-2 font-mono">
                                          WEBHOOK
                                        </span>
                                        {group.webhookType}
                                      </td>
                                      <td className="py-3 text-white font-bold">{group.totalCount}</td>
                                      <td className="py-3 text-emerald-400 font-semibold">{group.successCount}</td>
                                      <td className="py-3">
                                        {group.failedCount > 0 ? (
                                          <span className="px-1.5 py-0.5 rounded text-[10px] bg-red-500/20 text-red-300 font-bold">
                                            {group.failedCount}
                                          </span>
                                        ) : (
                                          <span className="text-slate-500">0</span>
                                        )}
                                      </td>
                                      <td className="py-3 text-amber-300">{group.rateLimitedCount}</td>
                                      <td className="py-3 text-slate-300">{group.avgLatency}ms</td>
                                      <td className="py-3 text-slate-400 text-[10px] whitespace-nowrap">
                                        {group.lastReceived.toLocaleString()}
                                      </td>
                                      <td className="py-3 text-right font-sans">
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setApiSearch(group.webhookType);
                                            setMetaGroupBy("NONE");
                                            setMetaPage(1);
                                          }}
                                          className="px-2.5 py-1 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 rounded text-[10px] font-semibold transition"
                                        >
                                          Inspect Webhooks 🔍
                                        </button>
                                      </td>
                                    </tr>
                                  );
                                })}
                            </tbody>
                          </table>
                        </div>

                        {/* Pagination Bar */}
                        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-800 text-xs text-slate-400">
                          <div>
                            Showing {(metaPage - 1) * metaPageSize + 1} to{" "}
                            {Math.min(metaPage * metaPageSize, metaWebhookGroups.length)} of {metaWebhookGroups.length} Webhook groups
                          </div>

                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={metaPage <= 1}
                              onClick={() => setMetaPage((p) => Math.max(1, p - 1))}
                              className="px-3 py-1 bg-slate-950 border border-slate-800 hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-slate-950 rounded text-xs text-white"
                            >
                              ◀ Previous
                            </button>

                            <span className="px-2 font-mono text-[11px] text-slate-300">
                              Page {metaPage} of {Math.ceil(metaWebhookGroups.length / metaPageSize) || 1}
                            </span>

                            <button
                              type="button"
                              disabled={metaPage >= Math.ceil(metaWebhookGroups.length / metaPageSize)}
                              onClick={() => setMetaPage((p) => p + 1)}
                              className="px-3 py-1 bg-slate-950 border border-slate-800 hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-slate-950 rounded text-xs text-white"
                            >
                              Next ▶
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  )}

                  {/* VIEW 4: META GROUP BY ENDPOINT / API CALL */}
                  {metaGroupBy === "ENDPOINT" && (
                    metaEndpointGroups.length === 0 ? (
                      <div className="p-10 text-center bg-slate-950 rounded-xl border border-slate-800 text-xs text-slate-500">
                        No API calls found matching current filters.
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-xs">
                            <thead>
                              <tr className="border-b border-slate-800 text-slate-400 font-medium">
                                <th className="pb-2.5">HTTP Method & Endpoint</th>
                                <th className="pb-2.5">Total Calls</th>
                                <th className="pb-2.5">Success Rate</th>
                                <th className="pb-2.5">Rate Limited</th>
                                <th className="pb-2.5">Errors</th>
                                <th className="pb-2.5">Avg Latency</th>
                                <th className="pb-2.5">Last Invocation</th>
                                <th className="pb-2.5 text-right">Drilldown</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
                              {metaEndpointGroups
                                .slice((metaPage - 1) * metaPageSize, metaPage * metaPageSize)
                                .map((group) => {
                                  const successRate = group.totalCalls > 0 ? Math.round((group.successCount / group.totalCalls) * 100) : 100;
                                  return (
                                    <tr key={group.endpointKey} className="hover:bg-slate-800/30 transition">
                                      <td className="py-3">
                                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold mr-2 bg-slate-800 text-slate-300 border border-slate-700">
                                          {group.httpMethod}
                                        </span>
                                        <span className="text-white font-mono">{group.endpointKey.replace(group.httpMethod + " ", "")}</span>
                                      </td>
                                      <td className="py-3 text-white font-bold">{group.totalCalls}</td>
                                      <td className="py-3">
                                        <span className="text-emerald-400 font-semibold">{successRate}%</span>
                                        <span className="text-slate-500 text-[10px] ml-1">({group.successCount})</span>
                                      </td>
                                      <td className="py-3 text-amber-300">{group.rateLimitedCount}</td>
                                      <td className="py-3">
                                        {group.failedCount > 0 ? (
                                          <span className="px-1.5 py-0.5 rounded text-[10px] bg-red-500/20 text-red-300 font-bold">
                                            {group.failedCount}
                                          </span>
                                        ) : (
                                          <span className="text-slate-500">0</span>
                                        )}
                                      </td>
                                      <td className="py-3 text-slate-300">{group.avgLatency}ms</td>
                                      <td className="py-3 text-slate-400 text-[10px] whitespace-nowrap">
                                        {group.lastCall.toLocaleString()}
                                      </td>
                                      <td className="py-3 text-right font-sans">
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setApiSearch(group.endpointKey.replace(group.httpMethod + " ", ""));
                                            setMetaGroupBy("NONE");
                                            setMetaPage(1);
                                          }}
                                          className="px-2.5 py-1 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 rounded text-[10px] font-semibold transition"
                                        >
                                          Filter Endpoint 🔍
                                        </button>
                                      </td>
                                    </tr>
                                  );
                                })}
                            </tbody>
                          </table>
                        </div>

                        {/* Pagination Bar */}
                        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-800 text-xs text-slate-400">
                          <div>
                            Showing {(metaPage - 1) * metaPageSize + 1} to{" "}
                            {Math.min(metaPage * metaPageSize, metaEndpointGroups.length)} of {metaEndpointGroups.length} Endpoints
                          </div>

                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={metaPage <= 1}
                              onClick={() => setMetaPage((p) => Math.max(1, p - 1))}
                              className="px-3 py-1 bg-slate-950 border border-slate-800 hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-slate-950 rounded text-xs text-white"
                            >
                              ◀ Previous
                            </button>

                            <span className="px-2 font-mono text-[11px] text-slate-300">
                              Page {metaPage} of {Math.ceil(metaEndpointGroups.length / metaPageSize) || 1}
                            </span>

                            <button
                              type="button"
                              disabled={metaPage >= Math.ceil(metaEndpointGroups.length / metaPageSize)}
                              onClick={() => setMetaPage((p) => p + 1)}
                              className="px-3 py-1 bg-slate-950 border border-slate-800 hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-slate-950 rounded text-xs text-white"
                            >
                              Next ▶
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  )}
                </>
              )}

              {/* ========================================================================= */}
              {/* PLATFORM 2: SHOPIFY WEBHOOKS & GRAPHQL VIEWS (ALL LOGS & GROUPED VIEWS) */}
              {/* ========================================================================= */}
              {logPlatform === "SHOPIFY" && (
                <>
                  {/* VIEW 1: ALL SHOPIFY LOGS */}
                  {shopifyGroupBy === "NONE" && (
                    filteredShopifyLogs.length === 0 ? (
                      <div className="p-10 text-center bg-slate-950 rounded-xl border border-slate-800 text-xs text-slate-500">
                        No Shopify API / Webhook audit records matching filter criteria.
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-xs">
                            <thead>
                              <tr className="border-b border-slate-800 text-slate-400 font-medium">
                                <th className="pb-2.5">Timestamp</th>
                                <th className="pb-2.5">Initiated By / Trigger</th>
                                <th className="pb-2.5">Store Domain</th>
                                <th className="pb-2.5">Type & Topic / Query</th>
                                <th className="pb-2.5">Status</th>
                                <th className="pb-2.5">Latency</th>
                                <th className="pb-2.5 text-right">Details</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
                              {filteredShopifyLogs
                                .slice((shopifyPage - 1) * shopifyPageSize, shopifyPage * shopifyPageSize)
                                .map((log) => (
                                  <tr key={log.id} className="hover:bg-slate-800/30 transition">
                                    <td className="py-3 text-slate-400 whitespace-nowrap">
                                      <div>{new Date(log.createdAt).toLocaleDateString()}</div>
                                      <div className="text-[10px] text-slate-500">
                                        {new Date(log.createdAt).toLocaleTimeString([], {
                                          hour: "2-digit",
                                          minute: "2-digit",
                                          second: "2-digit",
                                        })}
                                      </div>
                                    </td>
                                    <td className="py-3 text-white font-sans font-medium">
                                      {log.initiatedBy || "SHOPIFY_WEBHOOK"}
                                    </td>
                                    <td className="py-3 text-slate-300 font-sans">
                                      <div>{log.merchant?.name || log.shop || log.merchant?.shop || "Global"}</div>
                                      {(log.shop || log.merchant?.shop) && (
                                        <div className="text-[10px] text-slate-500 font-mono">
                                          {log.shop || log.merchant?.shop}
                                        </div>
                                      )}
                                    </td>
                                    <td className="py-3">
                                      <span
                                        className={`px-1.5 py-0.5 rounded text-[10px] font-bold mr-1.5 ${
                                          log.apiType === "WEBHOOK"
                                            ? "bg-purple-500/10 text-purple-300 border border-purple-500/20"
                                            : "bg-blue-500/10 text-blue-300 border border-blue-500/20"
                                        }`}
                                      >
                                        {log.apiType}
                                      </span>
                                      <span className="text-slate-300 font-mono">{log.topic}</span>
                                    </td>
                                    <td className="py-3">
                                      <span
                                        className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                                          log.status === "SUCCESS"
                                            ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                                            : log.status === "RATE_LIMITED"
                                            ? "bg-amber-500/10 text-amber-300 border border-amber-500/20"
                                            : log.status === "IGNORED"
                                            ? "bg-slate-800 text-slate-400 border border-slate-700"
                                            : "bg-red-500/10 text-red-400 border border-red-500/20"
                                        }`}
                                      >
                                        {log.statusCode || 200} {log.status}
                                      </span>
                                    </td>
                                    <td className="py-3 text-slate-400">
                                      {log.durationMs ? `${log.durationMs}ms` : "—"}
                                    </td>
                                    <td className="py-3 text-right">
                                      <button
                                        type="button"
                                        onClick={() => setSelectedShopifyLog(log)}
                                        className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-[10px] font-sans font-medium transition"
                                      >
                                        Inspect 🔍
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                            </tbody>
                          </table>
                        </div>

                        {/* Pagination Bar */}
                        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-800 text-xs text-slate-400">
                          <div>
                            Showing {(shopifyPage - 1) * shopifyPageSize + 1} to{" "}
                            {Math.min(shopifyPage * shopifyPageSize, filteredShopifyLogs.length)} of{" "}
                            {filteredShopifyLogs.length} Shopify records
                          </div>

                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={shopifyPage <= 1}
                              onClick={() => setShopifyPage((p) => Math.max(1, p - 1))}
                              className="px-3 py-1 bg-slate-950 border border-slate-800 hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-slate-950 rounded text-xs text-white"
                            >
                              ◀ Previous
                            </button>

                            <span className="px-2 font-mono text-[11px] text-slate-300">
                              Page {shopifyPage} of {Math.ceil(filteredShopifyLogs.length / shopifyPageSize) || 1}
                            </span>

                            <button
                              type="button"
                              disabled={shopifyPage >= Math.ceil(filteredShopifyLogs.length / shopifyPageSize)}
                              onClick={() => setShopifyPage((p) => p + 1)}
                              className="px-3 py-1 bg-slate-950 border border-slate-800 hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-slate-950 rounded text-xs text-white"
                            >
                              Next ▶
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  )}

                  {/* VIEW 2: SHOPIFY GROUP BY STORE */}
                  {shopifyGroupBy === "STORE" && (
                    shopifyStoreGroups.length === 0 ? (
                      <div className="p-10 text-center bg-slate-950 rounded-xl border border-slate-800 text-xs text-slate-500">
                        No stores found matching current filters.
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-xs">
                            <thead>
                              <tr className="border-b border-slate-800 text-slate-400 font-medium">
                                <th className="pb-2.5">Store Domain / Merchant</th>
                                <th className="pb-2.5">Total Shopify Ops</th>
                                <th className="pb-2.5">Webhooks</th>
                                <th className="pb-2.5">GraphQL / REST</th>
                                <th className="pb-2.5">Success Rate</th>
                                <th className="pb-2.5">Failures</th>
                                <th className="pb-2.5">Avg Latency</th>
                                <th className="pb-2.5">Last Activity</th>
                                <th className="pb-2.5 text-right">Drilldown</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
                              {shopifyStoreGroups
                                .slice((shopifyPage - 1) * shopifyPageSize, shopifyPage * shopifyPageSize)
                                .map((group) => {
                                  const successRate = group.totalOps > 0 ? Math.round((group.successCount / group.totalOps) * 100) : 100;
                                  return (
                                    <tr key={group.store} className="hover:bg-slate-800/30 transition">
                                      <td className="py-3 font-sans">
                                        <div className="font-semibold text-white">{group.name}</div>
                                        <div className="text-[10px] text-slate-400 font-mono">{group.store}</div>
                                      </td>
                                      <td className="py-3 text-white font-bold">{group.totalOps}</td>
                                      <td className="py-3 text-purple-300">{group.webhookCount}</td>
                                      <td className="py-3 text-blue-300">{group.graphqlCount + group.restCount}</td>
                                      <td className="py-3">
                                        <span className="text-emerald-400 font-semibold">{successRate}%</span>
                                        <span className="text-slate-500 text-[10px] ml-1">({group.successCount})</span>
                                      </td>
                                      <td className="py-3">
                                        {group.failedCount > 0 ? (
                                          <span className="px-1.5 py-0.5 rounded text-[10px] bg-red-500/20 text-red-300 font-bold border border-red-500/30">
                                            {group.failedCount}
                                          </span>
                                        ) : (
                                          <span className="text-slate-500">0</span>
                                        )}
                                      </td>
                                      <td className="py-3 text-slate-300">{group.avgLatency}ms</td>
                                      <td className="py-3 text-slate-400 text-[10px] whitespace-nowrap">
                                        {group.lastActivity.toLocaleString()}
                                      </td>
                                      <td className="py-3 text-right font-sans">
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setApiSearch(group.store);
                                            setShopifyGroupBy("NONE");
                                            setShopifyPage(1);
                                          }}
                                          className="px-2.5 py-1 bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 border border-purple-500/20 rounded text-[10px] font-semibold transition"
                                        >
                                          View Store Logs 🔍
                                        </button>
                                      </td>
                                    </tr>
                                  );
                                })}
                            </tbody>
                          </table>
                        </div>

                        {/* Pagination Bar */}
                        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-800 text-xs text-slate-400">
                          <div>
                            Showing {(shopifyPage - 1) * shopifyPageSize + 1} to{" "}
                            {Math.min(shopifyPage * shopifyPageSize, shopifyStoreGroups.length)} of{" "}
                            {shopifyStoreGroups.length} Stores
                          </div>

                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={shopifyPage <= 1}
                              onClick={() => setShopifyPage((p) => Math.max(1, p - 1))}
                              className="px-3 py-1 bg-slate-950 border border-slate-800 hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-slate-950 rounded text-xs text-white"
                            >
                              ◀ Previous
                            </button>

                            <span className="px-2 font-mono text-[11px] text-slate-300">
                              Page {shopifyPage} of {Math.ceil(shopifyStoreGroups.length / shopifyPageSize) || 1}
                            </span>

                            <button
                              type="button"
                              disabled={shopifyPage >= Math.ceil(shopifyStoreGroups.length / shopifyPageSize)}
                              onClick={() => setShopifyPage((p) => p + 1)}
                              className="px-3 py-1 bg-slate-950 border border-slate-800 hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-slate-950 rounded text-xs text-white"
                            >
                              Next ▶
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  )}

                  {/* VIEW 3: SHOPIFY GROUP BY WEBHOOK TOPIC */}
                  {shopifyGroupBy === "WEBHOOK" && (
                    shopifyWebhookGroups.length === 0 ? (
                      <div className="p-10 text-center bg-slate-950 rounded-xl border border-slate-800 text-xs text-slate-500">
                        No Shopify webhooks found matching current filters.
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-xs">
                            <thead>
                              <tr className="border-b border-slate-800 text-slate-400 font-medium">
                                <th className="pb-2.5">Webhook Topic</th>
                                <th className="pb-2.5">Total Received</th>
                                <th className="pb-2.5">Processed (200 OK)</th>
                                <th className="pb-2.5">Failures</th>
                                <th className="pb-2.5">Ignored</th>
                                <th className="pb-2.5">Avg Latency</th>
                                <th className="pb-2.5">Last Ingested</th>
                                <th className="pb-2.5 text-right">Drilldown</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
                              {shopifyWebhookGroups
                                .slice((shopifyPage - 1) * shopifyPageSize, shopifyPage * shopifyPageSize)
                                .map((group) => {
                                  return (
                                    <tr key={group.topic} className="hover:bg-slate-800/30 transition">
                                      <td className="py-3 font-sans font-semibold text-white">
                                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-purple-500/10 text-purple-300 border border-purple-500/20 mr-2 font-mono">
                                          SHOPIFY
                                        </span>
                                        {group.topic}
                                      </td>
                                      <td className="py-3 text-white font-bold">{group.totalCount}</td>
                                      <td className="py-3 text-emerald-400 font-semibold">{group.successCount}</td>
                                      <td className="py-3">
                                        {group.failedCount > 0 ? (
                                          <span className="px-1.5 py-0.5 rounded text-[10px] bg-red-500/20 text-red-300 font-bold">
                                            {group.failedCount}
                                          </span>
                                        ) : (
                                          <span className="text-slate-500">0</span>
                                        )}
                                      </td>
                                      <td className="py-3 text-slate-400">{group.ignoredCount}</td>
                                      <td className="py-3 text-slate-300">{group.avgLatency}ms</td>
                                      <td className="py-3 text-slate-400 text-[10px] whitespace-nowrap">
                                        {group.lastReceived.toLocaleString()}
                                      </td>
                                      <td className="py-3 text-right font-sans">
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setApiSearch(group.topic);
                                            setShopifyGroupBy("NONE");
                                            setShopifyPage(1);
                                          }}
                                          className="px-2.5 py-1 bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 border border-purple-500/20 rounded text-[10px] font-semibold transition"
                                        >
                                          Filter Topic 🔍
                                        </button>
                                      </td>
                                    </tr>
                                  );
                                })}
                            </tbody>
                          </table>
                        </div>

                        {/* Pagination Bar */}
                        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-800 text-xs text-slate-400">
                          <div>
                            Showing {(shopifyPage - 1) * shopifyPageSize + 1} to{" "}
                            {Math.min(shopifyPage * shopifyPageSize, shopifyWebhookGroups.length)} of{" "}
                            {shopifyWebhookGroups.length} Webhook Topics
                          </div>

                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={shopifyPage <= 1}
                              onClick={() => setShopifyPage((p) => Math.max(1, p - 1))}
                              className="px-3 py-1 bg-slate-950 border border-slate-800 hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-slate-950 rounded text-xs text-white"
                            >
                              ◀ Previous
                            </button>

                            <span className="px-2 font-mono text-[11px] text-slate-300">
                              Page {shopifyPage} of {Math.ceil(shopifyWebhookGroups.length / shopifyPageSize) || 1}
                            </span>

                            <button
                              type="button"
                              disabled={shopifyPage >= Math.ceil(shopifyWebhookGroups.length / shopifyPageSize)}
                              onClick={() => setShopifyPage((p) => p + 1)}
                              className="px-3 py-1 bg-slate-950 border border-slate-800 hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-slate-950 rounded text-xs text-white"
                            >
                              Next ▶
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  )}

                  {/* VIEW 4: SHOPIFY GROUP BY API OPERATION */}
                  {shopifyGroupBy === "API_TYPE" && (
                    shopifyApiGroups.length === 0 ? (
                      <div className="p-10 text-center bg-slate-950 rounded-xl border border-slate-800 text-xs text-slate-500">
                        No Shopify operations found matching current filters.
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-xs">
                            <thead>
                              <tr className="border-b border-slate-800 text-slate-400 font-medium">
                                <th className="pb-2.5">API Type & Operation</th>
                                <th className="pb-2.5">Total Invocations</th>
                                <th className="pb-2.5">Success Rate</th>
                                <th className="pb-2.5">Failures</th>
                                <th className="pb-2.5">Rate Limited</th>
                                <th className="pb-2.5">Avg Latency</th>
                                <th className="pb-2.5">Last Invocation</th>
                                <th className="pb-2.5 text-right">Drilldown</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
                              {shopifyApiGroups
                                .slice((shopifyPage - 1) * shopifyPageSize, shopifyPage * shopifyPageSize)
                                .map((group) => {
                                  const successRate = group.totalCalls > 0 ? Math.round((group.successCount / group.totalCalls) * 100) : 100;
                                  return (
                                    <tr key={group.operationKey} className="hover:bg-slate-800/30 transition">
                                      <td className="py-3">
                                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold mr-2 ${
                                          group.apiType === "WEBHOOK"
                                            ? "bg-purple-500/10 text-purple-300 border border-purple-500/20"
                                            : "bg-blue-500/10 text-blue-300 border border-blue-500/20"
                                        }`}>
                                          {group.apiType}
                                        </span>
                                        <span className="text-white font-mono">{group.topic}</span>
                                      </td>
                                      <td className="py-3 text-white font-bold">{group.totalCalls}</td>
                                      <td className="py-3">
                                        <span className="text-emerald-400 font-semibold">{successRate}%</span>
                                        <span className="text-slate-500 text-[10px] ml-1">({group.successCount})</span>
                                      </td>
                                      <td className="py-3">
                                        {group.failedCount > 0 ? (
                                          <span className="px-1.5 py-0.5 rounded text-[10px] bg-red-500/20 text-red-300 font-bold">
                                            {group.failedCount}
                                          </span>
                                        ) : (
                                          <span className="text-slate-500">0</span>
                                        )}
                                      </td>
                                      <td className="py-3 text-amber-300">{group.rateLimitedCount}</td>
                                      <td className="py-3 text-slate-300">{group.avgLatency}ms</td>
                                      <td className="py-3 text-slate-400 text-[10px] whitespace-nowrap">
                                        {group.lastCall.toLocaleString()}
                                      </td>
                                      <td className="py-3 text-right font-sans">
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setApiSearch(group.topic);
                                            setShopifyGroupBy("NONE");
                                            setShopifyPage(1);
                                          }}
                                          className="px-2.5 py-1 bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 border border-purple-500/20 rounded text-[10px] font-semibold transition"
                                        >
                                          Filter Operation 🔍
                                        </button>
                                      </td>
                                    </tr>
                                  );
                                })}
                            </tbody>
                          </table>
                        </div>

                        {/* Pagination Bar */}
                        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-800 text-xs text-slate-400">
                          <div>
                            Showing {(shopifyPage - 1) * shopifyPageSize + 1} to{" "}
                            {Math.min(shopifyPage * shopifyPageSize, shopifyApiGroups.length)} of{" "}
                            {shopifyApiGroups.length} Operations
                          </div>

                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={shopifyPage <= 1}
                              onClick={() => setShopifyPage((p) => Math.max(1, p - 1))}
                              className="px-3 py-1 bg-slate-950 border border-slate-800 hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-slate-950 rounded text-xs text-white"
                            >
                              ◀ Previous
                            </button>

                            <span className="px-2 font-mono text-[11px] text-slate-300">
                              Page {shopifyPage} of {Math.ceil(shopifyApiGroups.length / shopifyPageSize) || 1}
                            </span>

                            <button
                              type="button"
                              disabled={shopifyPage >= Math.ceil(shopifyApiGroups.length / shopifyPageSize)}
                              onClick={() => setShopifyPage((p) => p + 1)}
                              className="px-3 py-1 bg-slate-950 border border-slate-800 hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-slate-950 rounded text-xs text-white"
                            >
                              Next ▶
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  )}
                </>
              )}

              {/* ========================================================================= */}
              {/* META TRANSACTION FULL DATABASE INSPECTOR MODAL */}
              {/* ========================================================================= */}
              {selectedApiLog && (
                <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-3 sm:p-6">
                  <div className="bg-slate-900 border border-slate-700/80 rounded-2xl max-w-4xl w-full p-5 sm:p-6 shadow-2xl space-y-4 max-h-[92vh] flex flex-col">
                    {/* Header */}
                    <div className="flex items-start justify-between border-b border-slate-800 pb-3 gap-3">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-lg">🟢</span>
                          <h3 className="font-bold text-white text-base">
                            Meta WhatsApp Cloud API Audit Record
                          </h3>
                          <span
                            className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${
                              selectedApiLog.status === "SUCCESS"
                                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                                : selectedApiLog.status === "RATE_LIMITED"
                                ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                                : "bg-red-500/20 text-red-300 border border-red-500/30"
                            }`}
                          >
                            {selectedApiLog.statusCode || (selectedApiLog.status === "SUCCESS" ? 200 : 500)} {selectedApiLog.status}
                          </span>
                          {selectedApiLog.durationMs !== null && (
                            <span className="px-2 py-0.5 rounded-full text-[11px] font-mono bg-slate-800 text-slate-300 border border-slate-700">
                              ⚡ {selectedApiLog.durationMs}ms
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-slate-400 font-mono">
                          <span>ID: {selectedApiLog.id}</span>
                          <button
                            type="button"
                            onClick={() => copyToClipboard(selectedApiLog.id, "meta_id")}
                            className="text-[10px] text-slate-400 hover:text-emerald-400 underline transition"
                          >
                            {copiedKey === "meta_id" ? "Copied! ✓" : "Copy ID"}
                          </button>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          setSelectedApiLog(null);
                          setMetaInspectTab("OVERVIEW");
                        }}
                        className="text-slate-400 hover:text-white text-lg p-1 hover:bg-slate-800 rounded-lg transition"
                      >
                        ✕
                      </button>
                    </div>

                    {/* Modal Navigation Tabs */}
                    <div className="flex items-center gap-1.5 border-b border-slate-800 pb-2 text-xs font-medium overflow-x-auto">
                      <button
                        type="button"
                        onClick={() => setMetaInspectTab("OVERVIEW")}
                        className={`px-3 py-1.5 rounded-lg transition flex items-center gap-1.5 ${
                          metaInspectTab === "OVERVIEW"
                            ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-semibold"
                            : "text-slate-400 hover:text-white hover:bg-slate-800/60"
                        }`}
                      >
                        <span>📋</span>
                        <span>DB Fields & Metadata</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setMetaInspectTab("PAYLOAD")}
                        className={`px-3 py-1.5 rounded-lg transition flex items-center gap-1.5 ${
                          metaInspectTab === "PAYLOAD"
                            ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-semibold"
                            : "text-slate-400 hover:text-white hover:bg-slate-800/60"
                        }`}
                      >
                        <span>📤</span>
                        <span>Request Payload {selectedApiLog.requestPayload ? `(${selectedApiLog.requestPayload.length} B)` : "(Empty)"}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setMetaInspectTab("RESPONSE")}
                        className={`px-3 py-1.5 rounded-lg transition flex items-center gap-1.5 ${
                          metaInspectTab === "RESPONSE"
                            ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-semibold"
                            : "text-slate-400 hover:text-white hover:bg-slate-800/60"
                        }`}
                      >
                        <span>📥</span>
                        <span>Response Body {selectedApiLog.responseBody ? `(${selectedApiLog.responseBody.length} B)` : "(Empty)"}</span>
                      </button>

                      {selectedApiLog.errorMessage && (
                        <button
                          type="button"
                          onClick={() => setMetaInspectTab("ERROR")}
                          className={`px-3 py-1.5 rounded-lg transition flex items-center gap-1.5 ${
                            metaInspectTab === "ERROR"
                              ? "bg-red-500/20 text-red-300 border border-red-500/30 font-semibold"
                              : "text-red-400 hover:text-red-300 hover:bg-red-950/40"
                          }`}
                        >
                          <span>❌</span>
                          <span>Error Details</span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => setMetaInspectTab("RAW_DB")}
                        className={`px-3 py-1.5 rounded-lg transition flex items-center gap-1.5 ${
                          metaInspectTab === "RAW_DB"
                            ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-semibold"
                            : "text-slate-400 hover:text-white hover:bg-slate-800/60"
                        }`}
                      >
                        <span>🗄️</span>
                        <span>Full DB Row (JSON)</span>
                      </button>
                    </div>

                    {/* Modal Tab Body */}
                    <div className="flex-1 overflow-y-auto space-y-4 pr-1">
                      {/* TAB 1: OVERVIEW & ALL DB FIELDS */}
                      {metaInspectTab === "OVERVIEW" && (
                        <div className="space-y-4">
                          {/* Key Properties Grid */}
                          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                                Store / Merchant
                              </span>
                              <div className="font-semibold text-white text-xs">
                                {selectedApiLog.merchant?.name || selectedApiLog.merchant?.shop || "Global"}
                              </div>
                              {selectedApiLog.merchant?.shop && (
                                <div className="text-[11px] text-emerald-400 font-mono">
                                  {selectedApiLog.merchant.shop}
                                </div>
                              )}
                            </div>

                            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                                Initiated By / Trigger
                              </span>
                              <div className="font-semibold text-white text-xs">
                                {selectedApiLog.initiatedBy || "System"}
                              </div>
                              <div className="text-[10px] text-slate-400">Trigger Origin</div>
                            </div>

                            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                                HTTP Method & Status
                              </span>
                              <div className="font-mono text-xs font-semibold text-white flex items-center gap-1.5">
                                <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700 text-[10px]">
                                  {selectedApiLog.httpMethod}
                                </span>
                                <span>{selectedApiLog.statusCode || 200} ({selectedApiLog.status})</span>
                              </div>
                              <div className="text-[10px] text-slate-400 font-mono">{selectedApiLog.durationMs}ms duration</div>
                            </div>

                            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1 sm:col-span-2">
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                                  Meta Graph API Endpoint
                                </span>
                                <button
                                  type="button"
                                  onClick={() => copyToClipboard(selectedApiLog.endpoint, "meta_endpoint")}
                                  className="text-[10px] text-slate-400 hover:text-emerald-400"
                                >
                                  {copiedKey === "meta_endpoint" ? "Copied! ✓" : "Copy"}
                                </button>
                              </div>
                              <div className="font-mono text-xs text-slate-200 break-all p-1.5 rounded bg-slate-900 border border-slate-800">
                                {selectedApiLog.httpMethod} {selectedApiLog.endpoint}
                              </div>
                            </div>

                            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                                Merchant UUID (DB FK)
                              </span>
                              <div className="font-mono text-[11px] text-slate-300 break-all">
                                {selectedApiLog.merchantId || "None (Global)"}
                              </div>
                            </div>

                            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                                  Meta Message ID (WAMID)
                                </span>
                                {selectedApiLog.metaMessageId && (
                                  <button
                                    type="button"
                                    onClick={() => copyToClipboard(selectedApiLog.metaMessageId || "", "meta_wamid")}
                                    className="text-[10px] text-slate-400 hover:text-emerald-400"
                                  >
                                    {copiedKey === "meta_wamid" ? "Copied! ✓" : "Copy"}
                                  </button>
                                )}
                              </div>
                              <div className="font-mono text-xs text-slate-300 break-all">
                                {selectedApiLog.metaMessageId || "—"}
                              </div>
                            </div>

                            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                                Rate Limit Usage Header
                              </span>
                              <div className="font-mono text-xs text-amber-300 break-all">
                                {selectedApiLog.rateLimitUsage || "—"}
                              </div>
                            </div>

                            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                                Client / Server IP
                              </span>
                              <div className="font-mono text-xs text-slate-300">
                                {selectedApiLog.ipAddress || "—"}
                              </div>
                            </div>

                            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1 sm:col-span-2">
                              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                                Timestamp Created (Local & UTC)
                              </span>
                              <div className="font-mono text-xs text-slate-200">
                                <div>Local: {new Date(selectedApiLog.createdAt).toLocaleString()}</div>
                                <div className="text-[10px] text-slate-500">ISO: {new Date(selectedApiLog.createdAt).toISOString()}</div>
                              </div>
                            </div>
                          </div>

                          {/* Quick Payload Preview Blocks */}
                          {selectedApiLog.requestPayload && (
                            <div className="space-y-1">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-semibold text-slate-300">Request Payload Preview</span>
                                <button
                                  type="button"
                                  onClick={() => setMetaInspectTab("PAYLOAD")}
                                  className="text-xs text-emerald-400 hover:underline"
                                >
                                  View Full Formatted Payload ↗
                                </button>
                              </div>
                              <pre className="p-3 rounded-xl bg-slate-950 border border-slate-800 font-mono text-[11px] text-slate-300 overflow-x-auto max-h-32">
                                {formatJson(selectedApiLog.requestPayload)}
                              </pre>
                            </div>
                          )}

                          {selectedApiLog.responseBody && (
                            <div className="space-y-1">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-semibold text-slate-300">Response Body Preview</span>
                                <button
                                  type="button"
                                  onClick={() => setMetaInspectTab("RESPONSE")}
                                  className="text-xs text-emerald-400 hover:underline"
                                >
                                  View Full Formatted Response ↗
                                </button>
                              </div>
                              <pre className="p-3 rounded-xl bg-slate-950 border border-slate-800 font-mono text-[11px] text-slate-300 overflow-x-auto max-h-32">
                                {formatJson(selectedApiLog.responseBody)}
                              </pre>
                            </div>
                          )}
                        </div>
                      )}

                      {/* TAB 2: REQUEST PAYLOAD */}
                      {metaInspectTab === "PAYLOAD" && (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-slate-300">
                              Sanitized Request Body / HTTP Parameters
                            </span>
                            {selectedApiLog.requestPayload && (
                              <button
                                type="button"
                                onClick={() => copyToClipboard(selectedApiLog.requestPayload || "", "meta_req")}
                                className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs font-medium transition"
                              >
                                {copiedKey === "meta_req" ? "Copied to Clipboard! ✓" : "📋 Copy Payload"}
                              </button>
                            )}
                          </div>

                          {selectedApiLog.requestPayload ? (
                            <pre className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-emerald-300 font-mono text-xs overflow-x-auto max-h-[420px] select-all leading-relaxed whitespace-pre-wrap">
                              {formatJson(selectedApiLog.requestPayload)}
                            </pre>
                          ) : (
                            <div className="p-8 text-center text-slate-500 bg-slate-950 rounded-xl border border-slate-800 text-xs">
                              No request body payload was recorded for this transaction.
                            </div>
                          )}
                        </div>
                      )}

                      {/* TAB 3: RESPONSE BODY */}
                      {metaInspectTab === "RESPONSE" && (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-slate-300">
                              Meta API HTTP Response Body
                            </span>
                            {selectedApiLog.responseBody && (
                              <button
                                type="button"
                                onClick={() => copyToClipboard(selectedApiLog.responseBody || "", "meta_res")}
                                className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs font-medium transition"
                              >
                                {copiedKey === "meta_res" ? "Copied to Clipboard! ✓" : "📋 Copy Response"}
                              </button>
                            )}
                          </div>

                          {selectedApiLog.responseBody ? (
                            <pre className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-cyan-300 font-mono text-xs overflow-x-auto max-h-[420px] select-all leading-relaxed whitespace-pre-wrap">
                              {formatJson(selectedApiLog.responseBody)}
                            </pre>
                          ) : (
                            <div className="p-8 text-center text-slate-500 bg-slate-950 rounded-xl border border-slate-800 text-xs">
                              No response body recorded.
                            </div>
                          )}
                        </div>
                      )}

                      {/* TAB 4: ERROR DETAILS */}
                      {metaInspectTab === "ERROR" && selectedApiLog.errorMessage && (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-red-400">
                              Transaction Exception / Error Stack
                            </span>
                            <button
                              type="button"
                              onClick={() => copyToClipboard(selectedApiLog.errorMessage || "", "meta_err")}
                              className="px-2.5 py-1 bg-red-950/40 hover:bg-red-900/50 text-red-300 border border-red-800/40 rounded text-xs font-medium transition"
                            >
                              {copiedKey === "meta_err" ? "Copied! ✓" : "📋 Copy Error"}
                            </button>
                          </div>

                          <div className="p-4 rounded-xl bg-red-950/20 border border-red-800/40 text-red-300 font-mono text-xs overflow-x-auto max-h-[420px] select-all whitespace-pre-wrap leading-relaxed">
                            {selectedApiLog.errorMessage}
                          </div>
                        </div>
                      )}

                      {/* TAB 5: RAW DB ROW */}
                      {metaInspectTab === "RAW_DB" && (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-slate-300">
                              Complete Prisma DB Entity (JSON)
                            </span>
                            <button
                              type="button"
                              onClick={() => copyToClipboard(JSON.stringify(selectedApiLog, null, 2), "meta_raw")}
                              className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs font-medium transition"
                            >
                              {copiedKey === "meta_raw" ? "Copied DB Record! ✓" : "📋 Copy Entire Record"}
                            </button>
                          </div>

                          <pre className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-slate-300 font-mono text-xs overflow-x-auto max-h-[420px] select-all leading-relaxed whitespace-pre-wrap">
                            {JSON.stringify(selectedApiLog, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>

                    {/* Footer */}
                    <div className="pt-3 border-t border-slate-800 flex items-center justify-between">
                      <div className="text-[11px] text-slate-500 font-mono">
                        Table: storeping_MetaApiLog
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedApiLog(null);
                          setMetaInspectTab("OVERVIEW");
                        }}
                        className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-xs font-semibold transition"
                      >
                        Close
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* ========================================================================= */}
              {/* SHOPIFY TRANSACTION FULL DATABASE INSPECTOR MODAL */}
              {/* ========================================================================= */}
              {selectedShopifyLog && (
                <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-3 sm:p-6">
                  <div className="bg-slate-900 border border-slate-700/80 rounded-2xl max-w-4xl w-full p-5 sm:p-6 shadow-2xl space-y-4 max-h-[92vh] flex flex-col">
                    {/* Header */}
                    <div className="flex items-start justify-between border-b border-slate-800 pb-3 gap-3">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-lg">🛍️</span>
                          <h3 className="font-bold text-white text-base">
                            Shopify Webhook & API Transaction Record
                          </h3>
                          <span
                            className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${
                              selectedShopifyLog.status === "SUCCESS"
                                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                                : selectedShopifyLog.status === "RATE_LIMITED"
                                ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                                : selectedShopifyLog.status === "IGNORED"
                                ? "bg-slate-800 text-slate-300 border border-slate-700"
                                : "bg-red-500/20 text-red-300 border border-red-500/30"
                            }`}
                          >
                            {selectedShopifyLog.statusCode || 200} {selectedShopifyLog.status}
                          </span>
                          <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-purple-500/20 text-purple-300 border border-purple-500/30">
                            {selectedShopifyLog.apiType}
                          </span>
                          {selectedShopifyLog.durationMs !== null && (
                            <span className="px-2 py-0.5 rounded-full text-[11px] font-mono bg-slate-800 text-slate-300 border border-slate-700">
                              ⚡ {selectedShopifyLog.durationMs}ms
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-slate-400 font-mono">
                          <span>ID: {selectedShopifyLog.id}</span>
                          <button
                            type="button"
                            onClick={() => copyToClipboard(selectedShopifyLog.id, "shopify_id")}
                            className="text-[10px] text-slate-400 hover:text-purple-400 underline transition"
                          >
                            {copiedKey === "shopify_id" ? "Copied! ✓" : "Copy ID"}
                          </button>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          setSelectedShopifyLog(null);
                          setShopifyInspectTab("OVERVIEW");
                        }}
                        className="text-slate-400 hover:text-white text-lg p-1 hover:bg-slate-800 rounded-lg transition"
                      >
                        ✕
                      </button>
                    </div>

                    {/* Modal Navigation Tabs */}
                    <div className="flex items-center gap-1.5 border-b border-slate-800 pb-2 text-xs font-medium overflow-x-auto">
                      <button
                        type="button"
                        onClick={() => setShopifyInspectTab("OVERVIEW")}
                        className={`px-3 py-1.5 rounded-lg transition flex items-center gap-1.5 ${
                          shopifyInspectTab === "OVERVIEW"
                            ? "bg-purple-500/20 text-purple-300 border border-purple-500/30 font-semibold"
                            : "text-slate-400 hover:text-white hover:bg-slate-800/60"
                        }`}
                      >
                        <span>📋</span>
                        <span>DB Fields & Telemetry</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setShopifyInspectTab("PAYLOAD")}
                        className={`px-3 py-1.5 rounded-lg transition flex items-center gap-1.5 ${
                          shopifyInspectTab === "PAYLOAD"
                            ? "bg-purple-500/20 text-purple-300 border border-purple-500/30 font-semibold"
                            : "text-slate-400 hover:text-white hover:bg-slate-800/60"
                        }`}
                      >
                        <span>📤</span>
                        <span>Request / Webhook Body {selectedShopifyLog.requestPayload ? `(${selectedShopifyLog.requestPayload.length} B)` : "(Empty)"}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setShopifyInspectTab("RESPONSE")}
                        className={`px-3 py-1.5 rounded-lg transition flex items-center gap-1.5 ${
                          shopifyInspectTab === "RESPONSE"
                            ? "bg-purple-500/20 text-purple-300 border border-purple-500/30 font-semibold"
                            : "text-slate-400 hover:text-white hover:bg-slate-800/60"
                        }`}
                      >
                        <span>📥</span>
                        <span>Response Body {selectedShopifyLog.responseBody ? `(${selectedShopifyLog.responseBody.length} B)` : "(Empty)"}</span>
                      </button>

                      {selectedShopifyLog.errorMessage && (
                        <button
                          type="button"
                          onClick={() => setShopifyInspectTab("ERROR")}
                          className={`px-3 py-1.5 rounded-lg transition flex items-center gap-1.5 ${
                            shopifyInspectTab === "ERROR"
                              ? "bg-red-500/20 text-red-300 border border-red-500/30 font-semibold"
                              : "text-red-400 hover:text-red-300 hover:bg-red-950/40"
                          }`}
                        >
                          <span>❌</span>
                          <span>Error Details</span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => setShopifyInspectTab("RAW_DB")}
                        className={`px-3 py-1.5 rounded-lg transition flex items-center gap-1.5 ${
                          shopifyInspectTab === "RAW_DB"
                            ? "bg-purple-500/20 text-purple-300 border border-purple-500/30 font-semibold"
                            : "text-slate-400 hover:text-white hover:bg-slate-800/60"
                        }`}
                      >
                        <span>🗄️</span>
                        <span>Full DB Row (JSON)</span>
                      </button>
                    </div>

                    {/* Modal Tab Body */}
                    <div className="flex-1 overflow-y-auto space-y-4 pr-1">
                      {/* TAB 1: OVERVIEW & ALL DB FIELDS */}
                      {shopifyInspectTab === "OVERVIEW" && (
                        <div className="space-y-4">
                          {/* Properties Grid */}
                          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                                Shopify Store Domain
                              </span>
                              <div className="font-semibold text-white text-xs">
                                {selectedShopifyLog.merchant?.name || selectedShopifyLog.shop || "Global"}
                              </div>
                              <div className="text-[11px] text-purple-400 font-mono">
                                {selectedShopifyLog.shop || selectedShopifyLog.merchant?.shop || "—"}
                              </div>
                            </div>

                            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                                API Type & HTTP Method
                              </span>
                              <div className="font-semibold text-white text-xs flex items-center gap-1.5">
                                <span className="px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-300 border border-purple-500/20 font-mono text-[10px]">
                                  {selectedShopifyLog.apiType}
                                </span>
                                <span className="font-mono text-slate-300">{selectedShopifyLog.httpMethod}</span>
                              </div>
                              <div className="text-[10px] text-slate-400 font-mono">{selectedShopifyLog.durationMs}ms duration</div>
                            </div>

                            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                                Initiated By / Trigger
                              </span>
                              <div className="font-semibold text-white text-xs">
                                {selectedShopifyLog.initiatedBy || "SHOPIFY_WEBHOOK"}
                              </div>
                              <div className="text-[10px] text-slate-400">Trigger Origin</div>
                            </div>

                            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1 sm:col-span-2">
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                                  Topic / Operation / Endpoint
                                </span>
                                <button
                                  type="button"
                                  onClick={() => copyToClipboard(selectedShopifyLog.topic, "shopify_topic")}
                                  className="text-[10px] text-slate-400 hover:text-purple-400"
                                >
                                  {copiedKey === "shopify_topic" ? "Copied! ✓" : "Copy"}
                                </button>
                              </div>
                              <div className="font-mono text-xs text-purple-300 break-all p-1.5 rounded bg-slate-900 border border-slate-800">
                                {selectedShopifyLog.topic}
                              </div>
                            </div>

                            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                                Merchant ID (DB Foreign Key)
                              </span>
                              <div className="font-mono text-[11px] text-slate-300 break-all">
                                {selectedShopifyLog.merchantId || "None (Global)"}
                              </div>
                            </div>

                            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                                  X-Shopify-Webhook-Id
                                </span>
                                {selectedShopifyLog.webhookId && (
                                  <button
                                    type="button"
                                    onClick={() => copyToClipboard(selectedShopifyLog.webhookId || "", "shopify_wbid")}
                                    className="text-[10px] text-slate-400 hover:text-purple-400"
                                  >
                                    {copiedKey === "shopify_wbid" ? "Copied! ✓" : "Copy"}
                                  </button>
                                )}
                              </div>
                              <div className="font-mono text-xs text-purple-300 break-all">
                                {selectedShopifyLog.webhookId || "—"}
                              </div>
                            </div>

                            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                                Shopify API Version
                              </span>
                              <div className="font-mono text-xs text-slate-300">
                                {selectedShopifyLog.apiVersion || "—"}
                              </div>
                            </div>

                            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                                Rate Limit Usage Header
                              </span>
                              <div className="font-mono text-xs text-amber-300">
                                {selectedShopifyLog.rateLimitUsage || "—"}
                              </div>
                            </div>

                            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                                Inbound IP Address
                              </span>
                              <div className="font-mono text-xs text-slate-300">
                                {selectedShopifyLog.ipAddress || "—"}
                              </div>
                            </div>

                            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1 sm:col-span-2">
                              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                                Timestamp Created (Local & UTC)
                              </span>
                              <div className="font-mono text-xs text-slate-200">
                                <div>Local: {new Date(selectedShopifyLog.createdAt).toLocaleString()}</div>
                                <div className="text-[10px] text-slate-500">ISO: {new Date(selectedShopifyLog.createdAt).toISOString()}</div>
                              </div>
                            </div>
                          </div>

                          {/* Quick Payload Preview Blocks */}
                          {selectedShopifyLog.requestPayload && (
                            <div className="space-y-1">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-semibold text-slate-300">Payload Preview</span>
                                <button
                                  type="button"
                                  onClick={() => setShopifyInspectTab("PAYLOAD")}
                                  className="text-xs text-purple-400 hover:underline"
                                >
                                  View Full Formatted Payload ↗
                                </button>
                              </div>
                              <pre className="p-3 rounded-xl bg-slate-950 border border-slate-800 font-mono text-[11px] text-slate-300 overflow-x-auto max-h-32">
                                {formatJson(selectedShopifyLog.requestPayload)}
                              </pre>
                            </div>
                          )}

                          {selectedShopifyLog.responseBody && (
                            <div className="space-y-1">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-semibold text-slate-300">Response / Result Preview</span>
                                <button
                                  type="button"
                                  onClick={() => setShopifyInspectTab("RESPONSE")}
                                  className="text-xs text-purple-400 hover:underline"
                                >
                                  View Full Formatted Response ↗
                                </button>
                              </div>
                              <pre className="p-3 rounded-xl bg-slate-950 border border-slate-800 font-mono text-[11px] text-slate-300 overflow-x-auto max-h-32">
                                {formatJson(selectedShopifyLog.responseBody)}
                              </pre>
                            </div>
                          )}
                        </div>
                      )}

                      {/* TAB 2: REQUEST / WEBHOOK BODY */}
                      {shopifyInspectTab === "PAYLOAD" && (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-slate-300">
                              Sanitized Webhook JSON Body / GraphQL Query
                            </span>
                            {selectedShopifyLog.requestPayload && (
                              <button
                                type="button"
                                onClick={() => copyToClipboard(selectedShopifyLog.requestPayload || "", "shopify_req")}
                                className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs font-medium transition"
                              >
                                {copiedKey === "shopify_req" ? "Copied to Clipboard! ✓" : "📋 Copy Payload"}
                              </button>
                            )}
                          </div>

                          {selectedShopifyLog.requestPayload ? (
                            <pre className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-purple-300 font-mono text-xs overflow-x-auto max-h-[420px] select-all leading-relaxed whitespace-pre-wrap">
                              {formatJson(selectedShopifyLog.requestPayload)}
                            </pre>
                          ) : (
                            <div className="p-8 text-center text-slate-500 bg-slate-950 rounded-xl border border-slate-800 text-xs">
                              No request body payload recorded.
                            </div>
                          )}
                        </div>
                      )}

                      {/* TAB 3: RESPONSE BODY */}
                      {shopifyInspectTab === "RESPONSE" && (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-slate-300">
                              Response Body / Execution Handler Results
                            </span>
                            {selectedShopifyLog.responseBody && (
                              <button
                                type="button"
                                onClick={() => copyToClipboard(selectedShopifyLog.responseBody || "", "shopify_res")}
                                className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs font-medium transition"
                              >
                                {copiedKey === "shopify_res" ? "Copied to Clipboard! ✓" : "📋 Copy Response"}
                              </button>
                            )}
                          </div>

                          {selectedShopifyLog.responseBody ? (
                            <pre className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-cyan-300 font-mono text-xs overflow-x-auto max-h-[420px] select-all leading-relaxed whitespace-pre-wrap">
                              {formatJson(selectedShopifyLog.responseBody)}
                            </pre>
                          ) : (
                            <div className="p-8 text-center text-slate-500 bg-slate-950 rounded-xl border border-slate-800 text-xs">
                              No response body recorded.
                            </div>
                          )}
                        </div>
                      )}

                      {/* TAB 4: ERROR DETAILS */}
                      {shopifyInspectTab === "ERROR" && selectedShopifyLog.errorMessage && (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-red-400">
                              Transaction Exception / Error Stack
                            </span>
                            <button
                              type="button"
                              onClick={() => copyToClipboard(selectedShopifyLog.errorMessage || "", "shopify_err")}
                              className="px-2.5 py-1 bg-red-950/40 hover:bg-red-900/50 text-red-300 border border-red-800/40 rounded text-xs font-medium transition"
                            >
                              {copiedKey === "shopify_err" ? "Copied! ✓" : "📋 Copy Error"}
                            </button>
                          </div>

                          <div className="p-4 rounded-xl bg-red-950/20 border border-red-800/40 text-red-300 font-mono text-xs overflow-x-auto max-h-[420px] select-all whitespace-pre-wrap leading-relaxed">
                            {selectedShopifyLog.errorMessage}
                          </div>
                        </div>
                      )}

                      {/* TAB 5: RAW DB ROW */}
                      {shopifyInspectTab === "RAW_DB" && (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-slate-300">
                              Complete Prisma DB Entity (JSON)
                            </span>
                            <button
                              type="button"
                              onClick={() => copyToClipboard(JSON.stringify(selectedShopifyLog, null, 2), "shopify_raw")}
                              className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs font-medium transition"
                            >
                              {copiedKey === "shopify_raw" ? "Copied DB Record! ✓" : "📋 Copy Entire Record"}
                            </button>
                          </div>

                          <pre className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-slate-300 font-mono text-xs overflow-x-auto max-h-[420px] select-all leading-relaxed whitespace-pre-wrap">
                            {JSON.stringify(selectedShopifyLog, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>

                    {/* Footer */}
                    <div className="pt-3 border-t border-slate-800 flex items-center justify-between">
                      <div className="text-[11px] text-slate-500 font-mono">
                        Table: storeping_ShopifyApiLog
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedShopifyLog(null);
                          setShopifyInspectTab("OVERVIEW");
                        }}
                        className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-xs font-semibold transition"
                      >
                        Close
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Export to Excel / CSV Modal */}
              {showExportModal && (
                <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
                  <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4">
                    <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                      <div className="flex items-center gap-2">
                        <span className="text-base">📊</span>
                        <div>
                          <h3 className="font-bold text-white text-sm">
                            Export API & Webhook Audit Logs
                          </h3>
                          <p className="text-xs text-slate-400">
                            Download Excel (.CSV) spreadsheet with complete audit parameters.
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowExportModal(false)}
                        className="text-slate-400 hover:text-white text-base"
                      >
                        ✕
                      </button>
                    </div>

                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-300">
                        Select Log Source
                      </label>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <button
                          type="button"
                          onClick={() => setExportLogType("meta")}
                          className={`p-2.5 rounded-lg border font-medium transition text-left flex items-center gap-2 ${
                            exportLogType === "meta"
                              ? "bg-slate-800 text-white border-emerald-500/60 shadow-sm"
                              : "bg-slate-950 border-slate-800 text-slate-400 hover:bg-slate-800/60"
                          }`}
                        >
                          <span>🟢</span>
                          <div>
                            <div className="font-bold text-white">Meta WhatsApp Logs</div>
                            <div className="text-[10px] text-slate-400">Cloud API & Webhooks</div>
                          </div>
                        </button>

                        <button
                          type="button"
                          onClick={() => setExportLogType("shopify")}
                          className={`p-2.5 rounded-lg border font-medium transition text-left flex items-center gap-2 ${
                            exportLogType === "shopify"
                              ? "bg-slate-800 text-white border-emerald-500/60 shadow-sm"
                              : "bg-slate-950 border-slate-800 text-slate-400 hover:bg-slate-800/60"
                          }`}
                        >
                          <span>🛍️</span>
                          <div>
                            <div className="font-bold text-white">Shopify Audit Logs</div>
                            <div className="text-[10px] text-slate-400">Webhooks & GraphQL</div>
                          </div>
                        </button>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-300">
                        Date Range Presets
                      </label>
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        {[
                          { id: "today", label: "⚡ Today (24h)" },
                          { id: "7d", label: "⚡ 7 Days" },
                          { id: "1m", label: "⚡ 1 Month" },
                          { id: "3m", label: "⚡ 3 Months" },
                          { id: "1y", label: "⚡ 1 Year" },
                          { id: "all", label: "⚡ All Time" },
                        ].map((preset) => (
                          <button
                            key={preset.id}
                            type="button"
                            onClick={() => setExportRangePreset(preset.id)}
                            className={`p-2 rounded-lg border text-center font-medium transition ${
                              exportRangePreset === preset.id
                                ? "bg-slate-800 text-white border-slate-600 shadow-sm"
                                : "bg-slate-950 border-slate-800 text-slate-400 hover:bg-slate-800/60"
                            }`}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-300">Custom Range</span>
                        <button
                          type="button"
                          onClick={() => setExportRangePreset("custom")}
                          className={`text-[11px] underline ${
                            exportRangePreset === "custom" ? "text-emerald-400" : "text-slate-400"
                          }`}
                        >
                          Use Custom Dates
                        </button>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[10px] text-slate-400 mb-1">From Date</label>
                          <input
                            type="date"
                            value={exportStartDate}
                            onChange={(e) => {
                              setExportStartDate(e.target.value);
                              setExportRangePreset("custom");
                            }}
                            className="w-full px-2 py-1 bg-slate-900 border border-slate-700 rounded text-xs text-white focus:outline-none focus:border-slate-500"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] text-slate-400 mb-1">To Date</label>
                          <input
                            type="date"
                            value={exportEndDate}
                            onChange={(e) => {
                              setExportEndDate(e.target.value);
                              setExportRangePreset("custom");
                            }}
                            className="w-full px-2 py-1 bg-slate-900 border border-slate-700 rounded text-xs text-white focus:outline-none focus:border-slate-500"
                          />
                        </div>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-slate-300 mb-1">
                        Status Filter
                      </label>
                      <select
                        value={exportStatus}
                        onChange={(e) => setExportStatus(e.target.value)}
                        className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white focus:outline-none focus:border-slate-600"
                      >
                        <option value="ALL">All Statuses (SUCCESS, RATE_LIMITED, FAILED)</option>
                        <option value="SUCCESS">Only Successful Calls (200 OK)</option>
                        <option value="RATE_LIMITED">Only Rate-Limited Calls (429)</option>
                        <option value="FAILED">Only Failed Calls</option>
                      </select>
                    </div>

                    <div className="pt-2 border-t border-slate-800 flex items-center justify-end gap-2.5">
                      <button
                        type="button"
                        onClick={() => setShowExportModal(false)}
                        className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium"
                      >
                        Cancel
                      </button>

                      <a
                        href={exportDownloadUrl}
                        download
                        onClick={() => {
                          setTimeout(() => setShowExportModal(false), 500);
                        }}
                        className="px-4 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-lg text-xs transition flex items-center gap-1.5 shadow-sm"
                      >
                        <span>📥</span>
                        <span>Download (.CSV)</span>
                      </a>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* SECTION 5: PENDING APPROVALS */}
          {activeSection === "APPROVALS" && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-bold text-white">
                    Pending Store Admin Signups
                  </h2>
                  {pendingUsers.length > 0 && (
                    <span className="px-2 py-0.5 bg-amber-500/10 text-amber-300 rounded text-xs font-medium border border-amber-500/20 font-mono">
                      {pendingUsers.length} Action Needed
                    </span>
                  )}
                </div>
              </div>

              {pendingUsers.length === 0 ? (
                <div className="p-10 text-center bg-slate-950 rounded-xl border border-slate-800 text-xs text-slate-500">
                  ✅ No pending registration requests. All store admin signups are reviewed and approved.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-400 font-medium">
                        <th className="pb-2.5">Applicant Name</th>
                        <th className="pb-2.5">Work Email</th>
                        <th className="pb-2.5">Shopify Store</th>
                        <th className="pb-2.5">Role</th>
                        <th className="pb-2.5">Submitted At</th>
                        <th className="pb-2.5 text-right">Super Admin Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {pendingUsers.map((p) => (
                        <tr key={p.id} className="hover:bg-slate-800/30 transition">
                          <td className="py-3 font-semibold text-white">{p.name}</td>
                          <td className="py-3 font-mono text-slate-300">{p.email}</td>
                          <td className="py-3 text-slate-300">
                            {p.merchant?.shop || "—"}
                          </td>
                          <td className="py-3">
                            <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-medium text-[10px]">
                              {p.role}
                            </span>
                          </td>
                          <td className="py-3 text-slate-500 font-mono text-[11px]">
                            {new Date(p.createdAt).toLocaleDateString()}
                          </td>
                          <td className="py-3 text-right space-x-2">
                            <Form method="post" className="inline-block">
                              <input type="hidden" name="intent" value="approve_user" />
                              <input type="hidden" name="userId" value={p.id} />
                              <button
                                type="submit"
                                disabled={isSubmitting}
                                className="px-3 py-1 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded text-xs transition"
                              >
                                Approve
                              </button>
                            </Form>

                            <Form method="post" className="inline-block">
                              <input type="hidden" name="intent" value="reject_user" />
                              <input type="hidden" name="userId" value={p.id} />
                              <button
                                type="submit"
                                disabled={isSubmitting}
                                className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-red-300 border border-slate-700 rounded text-xs transition"
                              >
                                Reject
                              </button>
                            </Form>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* SECTION 6: STORES DIRECTORY */}
          {activeSection === "STORES" && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-bold text-white">Registered Stores Directory</h2>
                  <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">
                    {filteredStores.length} of {allStores.length}
                  </span>
                </div>

                <div className="relative w-full sm:w-64">
                  <input
                    type="text"
                    value={storeSearch}
                    onChange={(e) => setStoreSearch(e.target.value)}
                    placeholder="Search shop domain, phone..."
                    className="w-full pl-7 pr-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-slate-600"
                  />
                  <span className="absolute left-2.5 top-2 text-[10px] text-slate-500">🔍</span>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400 font-medium">
                      <th className="pb-2.5">Shopify Domain</th>
                      <th className="pb-2.5">WhatsApp Number</th>
                      <th className="pb-2.5">SaaS Plan</th>
                      <th className="pb-2.5">Quality Health</th>
                      <th className="pb-2.5">Dispatches</th>
                      <th className="pb-2.5">Active Users</th>
                      <th className="pb-2.5 text-right">Inbox</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {filteredStores.map((s) => (
                      <tr key={s.id} className="hover:bg-slate-800/30 transition">
                        <td className="py-3 font-semibold text-white">
                          {s.shop}
                          {s.name && <span className="text-slate-400 font-normal ml-1">({s.name})</span>}
                        </td>
                        <td className="py-3 font-mono text-slate-300">
                          {s.displayPhoneNumber || <span className="text-slate-500 text-[11px]">Not Connected</span>}
                        </td>
                        <td className="py-3">
                          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-300 border border-slate-700">
                            {s.planId || "FREE"}
                          </span>
                        </td>
                        <td className="py-3">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                              s.qualityRating === "GREEN"
                                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                                : s.qualityRating === "YELLOW"
                                ? "bg-amber-500/10 text-amber-300 border border-amber-500/20"
                                : "bg-red-500/10 text-red-400 border border-red-500/20"
                            }`}
                          >
                            {s.qualityRating || "GREEN"}
                          </span>
                        </td>
                        <td className="py-3 font-mono text-white">{s._count.messages}</td>
                        <td className="py-3 font-mono text-slate-400">{s._count.users} members</td>
                        <td className="py-3 text-right">
                          <Link
                            to={`/portal/inbox`}
                            prefetch="intent"
                            className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-medium rounded text-xs transition inline-flex items-center gap-1"
                          >
                            <span>💬 Inbox</span>
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* SECTION 7: USER DIRECTORY */}
          {activeSection === "USERS" && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-bold text-white">Platform User Directory</h2>
                  <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">
                    {filteredUsers.length} of {allUsers.length}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={userRoleFilter}
                    onChange={(e) => setUserRoleFilter(e.target.value)}
                    className="px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-300 focus:outline-none focus:border-slate-600"
                  >
                    <option value="ALL">All Roles</option>
                    <option value="SUPER_ADMIN">👑 Super Admin</option>
                    <option value="OWNER">Store Owner</option>
                    <option value="MANAGER">Store Manager</option>
                    <option value="AGENT">Support Agent</option>
                  </select>

                  <select
                    value={userStatusFilter}
                    onChange={(e) => setUserStatusFilter(e.target.value)}
                    className="px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-300 focus:outline-none focus:border-slate-600"
                  >
                    <option value="ALL">All Status</option>
                    <option value="ACTIVE">Active</option>
                    <option value="PENDING">Pending</option>
                    <option value="REJECTED">Rejected</option>
                    <option value="INACTIVE">Inactive</option>
                  </select>

                  <div className="relative w-full sm:w-56">
                    <input
                      type="text"
                      value={userSearch}
                      onChange={(e) => setUserSearch(e.target.value)}
                      placeholder="Search name, email..."
                      className="w-full pl-7 pr-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-slate-600"
                    />
                    <span className="absolute left-2.5 top-2 text-[10px] text-slate-500">🔍</span>
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400 font-medium">
                      <th className="pb-2.5">User</th>
                      <th className="pb-2.5">Store Domain</th>
                      <th className="pb-2.5">Role</th>
                      <th className="pb-2.5">Approval</th>
                      <th className="pb-2.5">Active State</th>
                      <th className="pb-2.5">Registered</th>
                      <th className="pb-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {filteredUsers.map((u) => (
                      <tr key={u.id} className="hover:bg-slate-800/30 transition">
                        <td className="py-3">
                          <div className="font-semibold text-white">{u.name}</div>
                          <div className="font-mono text-[11px] text-slate-400">{u.email}</div>
                        </td>
                        <td className="py-3 text-slate-300">
                          {u.merchant?.shop || <span className="text-slate-400 font-medium">Global Admin</span>}
                        </td>
                        <td className="py-3">
                          <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-800 text-slate-300 border border-slate-700">
                            {u.role}
                          </span>
                        </td>
                        <td className="py-3">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                              u.approvalStatus === "APPROVED"
                                ? "bg-emerald-500/10 text-emerald-400"
                                : u.approvalStatus === "PENDING"
                                ? "bg-amber-500/10 text-amber-400"
                                : "bg-red-500/10 text-red-400"
                            }`}
                          >
                            {u.approvalStatus}
                          </span>
                        </td>
                        <td className="py-3">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-mono ${
                              u.isActive ? "text-emerald-400 font-semibold" : "text-slate-500"
                            }`}
                          >
                            {u.isActive ? "● Active" : "○ Inactive"}
                          </span>
                        </td>
                        <td className="py-3 text-slate-500 font-mono text-[11px]">
                          {new Date(u.createdAt).toLocaleDateString()}
                        </td>
                        <td className="py-3 text-right space-x-1.5">
                          {u.id !== user.id && (
                            <>
                              <Form method="post" className="inline-block">
                                <input type="hidden" name="intent" value="toggle_user_status" />
                                <input type="hidden" name="userId" value={u.id} />
                                <input
                                  type="hidden"
                                  name="currentStatus"
                                  value={u.isActive.toString()}
                                />
                                <button
                                  type="submit"
                                  disabled={isSubmitting}
                                  className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs transition"
                                >
                                  {u.isActive ? "Deactivate" : "Activate"}
                                </button>
                              </Form>

                              <Form
                                method="post"
                                className="inline-block"
                                onSubmit={(e) => {
                                  if (!confirm(`Delete user ${u.name}?`)) e.preventDefault();
                                }}
                              >
                                <input type="hidden" name="intent" value="delete_user" />
                                <input type="hidden" name="userId" value={u.id} />
                                <button
                                  type="submit"
                                  disabled={isSubmitting}
                                  className="p-1 text-slate-500 hover:text-red-400 transition"
                                  title="Delete user"
                                >
                                  🗑️
                                </button>
                              </Form>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* SECTION 8: BACKGROUND QUEUE */}
          {activeSection === "JOBS" && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-bold text-white">PostgreSQL Background Job Queue</h2>
                  <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">
                    {recentJobs.length} Tasks
                  </span>
                </div>

                <Form method="post">
                  <input type="hidden" name="intent" value="purge_completed_jobs" />
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg text-xs font-medium transition"
                  >
                    Purge Completed Jobs
                  </button>
                </Form>
              </div>

              {recentJobs.length === 0 ? (
                <div className="p-10 text-center bg-slate-950 rounded-xl border border-slate-800 text-xs text-slate-500">
                  ✅ Background job queue is currently clear. No pending or failed tasks.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-400 font-medium">
                        <th className="pb-2.5">Job Type</th>
                        <th className="pb-2.5">Target Store</th>
                        <th className="pb-2.5">Status</th>
                        <th className="pb-2.5">Attempts</th>
                        <th className="pb-2.5">Scheduled / Run At</th>
                        <th className="pb-2.5">Error Details</th>
                        <th className="pb-2.5 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {recentJobs.map((j) => (
                        <tr key={j.id} className="hover:bg-slate-800/30 transition">
                          <td className="py-3 font-semibold font-mono text-slate-200">{j.jobType}</td>
                          <td className="py-3 text-slate-300">{j.merchant?.shop || "Global"}</td>
                          <td className="py-3">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-mono font-semibold ${
                                j.status === "COMPLETED"
                                  ? "bg-emerald-500/10 text-emerald-400"
                                  : j.status === "FAILED"
                                  ? "bg-red-500/10 text-red-400"
                                  : "bg-amber-500/10 text-amber-300"
                              }`}
                            >
                              {j.status}
                            </span>
                          </td>
                          <td className="py-3 font-mono text-slate-400">
                            {j.attempts} / {j.maxAttempts}
                          </td>
                          <td className="py-3 font-mono text-slate-400 text-[11px]">
                            {new Date(j.runAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            })}
                          </td>
                          <td className="py-3 max-w-xs truncate font-mono text-red-400 text-[11px]">
                            {j.error || "—"}
                          </td>
                          <td className="py-3 text-right space-x-1.5">
                            {j.status === "FAILED" && (
                              <Form method="post" className="inline-block">
                                <input type="hidden" name="intent" value="retry_job" />
                                <input type="hidden" name="jobId" value={j.id} />
                                <button
                                  type="submit"
                                  disabled={isSubmitting}
                                  className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-amber-300 border border-slate-700 rounded text-xs transition"
                                >
                                  Retry
                                </button>
                              </Form>
                            )}

                            <Form method="post" className="inline-block">
                              <input type="hidden" name="intent" value="delete_job" />
                              <input type="hidden" name="jobId" value={j.id} />
                              <button
                                type="submit"
                                disabled={isSubmitting}
                                className="p-1 text-slate-500 hover:text-red-400 transition"
                                title="Delete job"
                              >
                                🗑️
                              </button>
                            </Form>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
