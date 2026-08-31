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
      take: 100,
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
    platformSettings,
    platformBilling,
    apiStats: {
      totalApiCalls,
      apiCalls24h,
      rateLimitedCalls,
      failedApiCalls,
      apiSuccessRate,
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
    apiStats,
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
    "OVERVIEW" | "BILLING" | "SETTINGS" | "API_LOGS" | "APPROVALS" | "STORES" | "USERS" | "JOBS"
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
  const [apiSearch, setApiSearch] = useState("");
  const [apiStatusFilter, setApiStatusFilter] = useState("ALL");
  const [apiMethodFilter, setApiMethodFilter] = useState("ALL");
  const [selectedApiLog, setSelectedApiLog] = useState<(typeof apiLogs)[number] | null>(null);

  // Export Modal State
  const [showExportModal, setShowExportModal] = useState(false);
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

  // Filtered API Logs
  const filteredApiLogs = apiLogs.filter((log) => {
    const query = apiSearch.toLowerCase();
    const matchesSearch =
      log.endpoint.toLowerCase().includes(query) ||
      (log.initiatedBy && log.initiatedBy.toLowerCase().includes(query)) ||
      (log.merchant?.shop && log.merchant.shop.toLowerCase().includes(query)) ||
      (log.metaMessageId && log.metaMessageId.toLowerCase().includes(query)) ||
      (log.errorMessage && log.errorMessage.toLowerCase().includes(query)) ||
      (log.statusCode && log.statusCode.toString().includes(query));

    const matchesStatus = apiStatusFilter === "ALL" || log.status === apiStatusFilter;
    const matchesMethod = apiMethodFilter === "ALL" || log.httpMethod === apiMethodFilter;

    return matchesSearch && matchesStatus && matchesMethod;
  });

  const exportDownloadUrl = `/api/admin/export-logs?range=${exportRangePreset}${
    exportRangePreset === "custom" && exportStartDate ? `&startDate=${exportStartDate}` : ""
  }${exportRangePreset === "custom" && exportEndDate ? `&endDate=${exportEndDate}` : ""}&status=${exportStatus}`;

  // Menu items list
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
      id: "API_LOGS" as const,
      label: "Meta API Logs & Telemetry",
      icon: "📡",
      badge: `${apiStats.totalApiCalls}`,
      badgeColor: "bg-slate-800 text-slate-300",
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
              const isActive = activeSection === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveSection(item.id)}
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
                {menuItems.find((m) => m.id === activeSection)?.label || "Super Admin"}
              </h1>
              <p className="text-[11px] text-slate-400 hidden sm:block">
                StorePing multi-tenant platform telemetry, WhatsApp Cloud API billing, and merchant governance.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {activeSection === "API_LOGS" && (
              <button
                type="button"
                onClick={() => setShowExportModal(true)}
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

          {/* SECTION 4: META API LOGS & TELEMETRY */}
          {activeSection === "API_LOGS" && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-sm space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                  <div className="text-[10px] font-bold text-slate-400 uppercase">24-Hour Calls</div>
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

              {/* Search & Filter Bar */}
              <div className="flex flex-wrap items-center gap-2.5 pt-1">
                <select
                  value={apiStatusFilter}
                  onChange={(e) => setApiStatusFilter(e.target.value)}
                  className="px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-300 focus:outline-none focus:border-slate-600"
                >
                  <option value="ALL">All Statuses</option>
                  <option value="SUCCESS">✅ SUCCESS</option>
                  <option value="RATE_LIMITED">⚠️ RATE_LIMITED (429)</option>
                  <option value="FAILED">❌ FAILED</option>
                </select>

                <select
                  value={apiMethodFilter}
                  onChange={(e) => setApiMethodFilter(e.target.value)}
                  className="px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-300 focus:outline-none focus:border-slate-600"
                >
                  <option value="ALL">All HTTP Methods</option>
                  <option value="POST">POST</option>
                  <option value="GET">GET</option>
                  <option value="DELETE">DELETE</option>
                </select>

                <div className="relative flex-1 min-w-[220px]">
                  <input
                    type="text"
                    value={apiSearch}
                    onChange={(e) => setApiSearch(e.target.value)}
                    placeholder="Search endpoint, user, message ID, status code..."
                    className="w-full pl-7 pr-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-slate-600"
                  />
                  <span className="absolute left-2.5 top-2 text-[10px] text-slate-500">🔍</span>
                </div>
              </div>

              {/* Logs Table */}
              {filteredApiLogs.length === 0 ? (
                <div className="p-10 text-center bg-slate-950 rounded-xl border border-slate-800 text-xs text-slate-500">
                  No Meta API audit records matching filter criteria.
                </div>
              ) : (
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
                      {filteredApiLogs.map((log) => (
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
                            {log.merchant?.shop || "Global"}
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
              )}

              {/* Transaction JSON Inspector Modal */}
              {selectedApiLog && (
                <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
                  <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-3xl w-full p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
                    <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                      <div className="flex items-center gap-2">
                        <span className="text-base">📡</span>
                        <h3 className="font-bold text-white text-sm">
                          Meta API Transaction Inspection
                        </h3>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelectedApiLog(null)}
                        className="text-slate-400 hover:text-white text-base"
                      >
                        ✕
                      </button>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-[11px] font-mono">
                      <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800">
                        <span className="text-slate-500 block text-[10px]">TIMESTAMP</span>
                        <span className="text-white">{new Date(selectedApiLog.createdAt).toLocaleString()}</span>
                      </div>
                      <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800">
                        <span className="text-slate-500 block text-[10px]">INITIATED BY</span>
                        <span className="text-white">{selectedApiLog.initiatedBy || "System"}</span>
                      </div>
                      <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800">
                        <span className="text-slate-500 block text-[10px]">STATUS</span>
                        <span className="text-emerald-400 font-semibold">{selectedApiLog.statusCode} ({selectedApiLog.status})</span>
                      </div>
                      <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800">
                        <span className="text-slate-500 block text-[10px]">LATENCY</span>
                        <span className="text-slate-200">{selectedApiLog.durationMs}ms</span>
                      </div>
                    </div>

                    <div>
                      <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">
                        Endpoint
                      </label>
                      <div className="p-2 rounded-lg bg-slate-950 border border-slate-800 font-mono text-xs text-slate-200">
                        {selectedApiLog.httpMethod} {selectedApiLog.endpoint}
                      </div>
                    </div>

                    {selectedApiLog.rateLimitUsage && (
                      <div>
                        <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">
                          Rate Limit Header Usage
                        </label>
                        <div className="p-2 rounded-lg bg-slate-950 border border-slate-800 font-mono text-xs text-amber-300">
                          {selectedApiLog.rateLimitUsage}
                        </div>
                      </div>
                    )}

                    {selectedApiLog.requestPayload && (
                      <div>
                        <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">
                          Sanitized Request Payload
                        </label>
                        <pre className="p-3 rounded-lg bg-slate-950 border border-slate-800 font-mono text-[11px] text-slate-300 overflow-x-auto max-h-48">
                          {selectedApiLog.requestPayload}
                        </pre>
                      </div>
                    )}

                    {selectedApiLog.responseBody && (
                      <div>
                        <label className="block text-[10px] font-bold uppercase text-slate-400 mb-1">
                          Meta API Response Body
                        </label>
                        <pre className="p-3 rounded-lg bg-slate-950 border border-slate-800 font-mono text-[11px] text-slate-300 overflow-x-auto max-h-48">
                          {selectedApiLog.responseBody}
                        </pre>
                      </div>
                    )}

                    {selectedApiLog.errorMessage && (
                      <div>
                        <label className="block text-[10px] font-bold uppercase text-red-400 mb-1">
                          Error Details
                        </label>
                        <div className="p-2 rounded-lg bg-red-950/20 border border-red-800/40 font-mono text-xs text-red-300">
                          {selectedApiLog.errorMessage}
                        </div>
                      </div>
                    )}

                    <div className="pt-2 text-right">
                      <button
                        type="button"
                        onClick={() => setSelectedApiLog(null)}
                        className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-xs font-medium"
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
                            Export Meta API Audit Logs
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
