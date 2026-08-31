import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { useState } from "react";
import db from "../db.server";
import { requireRole } from "../utils/portal-auth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  // Only SUPER_ADMIN allowed
  const user = await requireRole(request, ["SUPER_ADMIN"]);

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  // Run all global platform telemetry queries in parallel for instant sub-200ms response
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
    db.messageLog.count({
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
  ]);

  const activeWabas = allStores.filter((s) => s.isWhatsAppConnected).length;
  const activeUsersCount = allUsers.filter((u) => u.isActive).length || 1;

  // Official Meta Application-Level Rate Limit Formula:
  // Total hourly calls allowed across the app = 200 * number of users
  const maxHourlyAppLimit = activeUsersCount * 200;
  const rateLimitUsedPercent = Math.min(
    100,
    Math.round((callsInLastHour / maxHourlyAppLimit) * 100)
  );
  const rateLimitRemainingPercent = Math.max(0, 100 - rateLimitUsedPercent);

  return json({
    user,
    pendingUsers,
    allStores,
    allUsers,
    recentJobs,
    rateLimitStats: {
      appId: "1083822394035933",
      appName: "StorePing",
      activeUsersCount,
      maxHourlyAppLimit,
      callsInLastHour,
      rateLimitUsedPercent,
      rateLimitRemainingPercent,
    },
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

  // 1. Approve User Registration Request
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
    });
  }

  // 2. Reject User Registration Request
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
    });
  }

  // 3. Toggle User Active/Inactive
  if (intent === "toggle_user_status") {
    const currentStatus = formData.get("currentStatus") === "true";
    if (targetUserId === user.id) {
      return json({ error: "Cannot deactivate Super Admin account." }, { status: 400 });
    }
    await db.user.update({
      where: { id: targetUserId },
      data: { isActive: !currentStatus },
    });
    return json({ success: "User status updated." });
  }

  // 4. Delete User Account
  if (intent === "delete_user") {
    if (targetUserId === user.id) {
      return json({ error: "Cannot delete Super Admin account." }, { status: 400 });
    }
    await db.user.delete({ where: { id: targetUserId } });
    return json({ success: "User account deleted." });
  }

  // 5. Retry Background Job
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
    return json({ success: "Job reset to PENDING for immediate retry." });
  }

  // 6. Delete Background Job
  if (intent === "delete_job" && jobId) {
    await db.job.delete({ where: { id: jobId } });
    return json({ success: "Job removed from queue." });
  }

  // 7. Purge Completed Jobs
  if (intent === "purge_completed_jobs") {
    const res = await db.job.deleteMany({
      where: { status: "COMPLETED" },
    });
    return json({ success: `Purged ${res.count} completed jobs from history.` });
  }

  return json({ error: "Unknown action" }, { status: 400 });
}

export default function SuperAdminDashboard() {
  const { user, pendingUsers, allStores, allUsers, recentJobs, rateLimitStats, stats } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  // Tab State
  const [activeTab, setActiveTab] = useState<
    "OVERVIEW" | "APPROVALS" | "STORES" | "USERS" | "JOBS"
  >("OVERVIEW");

  // Filter & Search States
  const [userSearch, setUserSearch] = useState("");
  const [userRoleFilter, setUserRoleFilter] = useState("ALL");
  const [userStatusFilter, setUserStatusFilter] = useState("ALL");

  const [storeSearch, setStoreSearch] = useState("");
  const [showRateLimitDetails, setShowRateLimitDetails] = useState(false);

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

  return (
    <div className="flex-1 overflow-y-auto p-6 lg:p-10 w-full bg-slate-950 text-slate-100">
      <div className="max-w-7xl mx-auto space-y-7">
        {/* 1. Super Admin Top Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-6">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-xs bg-purple-500/20 text-purple-300 font-bold border border-purple-500/30 px-2.5 py-0.5 rounded-full flex items-center gap-1.5">
                <span>👑</span>
                <span>SUPER ADMIN GOVERNANCE CENTER</span>
              </span>
              <span className="text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded-full font-mono">
                Platform Live
              </span>
            </div>
            <h1 className="text-2xl lg:text-3xl font-extrabold text-white tracking-tight">
              Super Admin Control Panel
            </h1>
            <p className="text-sm text-slate-400 mt-1">
              Global multi-tenant governance, Meta Application Rate Limit monitoring, store directory, and user approvals.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Link
              to="/portal/inbox"
              prefetch="intent"
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold rounded-xl text-xs border border-slate-700 transition flex items-center gap-1.5 shadow-sm"
            >
              <span>💬</span>
              <span>Global Support Inbox</span>
            </Link>
          </div>
        </div>

        {/* Action Alerts */}
        {actionData?.success && (
          <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-semibold flex items-center gap-2">
            <span>✅</span>
            <span>{actionData.success}</span>
          </div>
        )}
        {actionData?.error && (
          <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs font-semibold flex items-center gap-2">
            <span>⚠️</span>
            <span>{actionData.error}</span>
          </div>
        )}

        {/* 2. Navigation Tabs */}
        <div className="flex items-center gap-2 border-b border-slate-800 pb-2 overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveTab("OVERVIEW")}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-2 shrink-0 ${
              activeTab === "OVERVIEW"
                ? "bg-purple-600 text-white shadow-lg shadow-purple-600/30"
                : "bg-slate-900 text-slate-400 hover:text-white hover:bg-slate-800"
            }`}
          >
            <span>📊</span>
            <span>Overview & Rate Limits</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("APPROVALS")}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-2 shrink-0 ${
              activeTab === "APPROVALS"
                ? "bg-purple-600 text-white shadow-lg shadow-purple-600/30"
                : "bg-slate-900 text-slate-400 hover:text-white hover:bg-slate-800"
            }`}
          >
            <span>⏳</span>
            <span>Pending Approvals</span>
            {pendingUsers.length > 0 && (
              <span className="px-1.5 py-0.5 bg-amber-400 text-slate-950 text-[10px] font-black rounded-full font-mono">
                {pendingUsers.length}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("STORES")}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-2 shrink-0 ${
              activeTab === "STORES"
                ? "bg-purple-600 text-white shadow-lg shadow-purple-600/30"
                : "bg-slate-900 text-slate-400 hover:text-white hover:bg-slate-800"
            }`}
          >
            <span>🏬</span>
            <span>Stores Directory ({allStores.length})</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("USERS")}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-2 shrink-0 ${
              activeTab === "USERS"
                ? "bg-purple-600 text-white shadow-lg shadow-purple-600/30"
                : "bg-slate-900 text-slate-400 hover:text-white hover:bg-slate-800"
            }`}
          >
            <span>👥</span>
            <span>User Directory ({allUsers.length})</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("JOBS")}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-2 shrink-0 ${
              activeTab === "JOBS"
                ? "bg-purple-600 text-white shadow-lg shadow-purple-600/30"
                : "bg-slate-900 text-slate-400 hover:text-white hover:bg-slate-800"
            }`}
          >
            <span>⚙️</span>
            <span>Background Queue ({recentJobs.length})</span>
          </button>
        </div>

        {/* TAB 1: OVERVIEW & RATE LIMITS */}
        {activeTab === "OVERVIEW" && (
          <div className="space-y-6">
            {/* Meta Application-Level Rate Limit Card (Matches Meta Dev Portal) */}
            <div className="p-6 rounded-2xl bg-gradient-to-br from-slate-900 via-slate-900/90 to-slate-900/60 border border-slate-800 shadow-xl relative overflow-hidden">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-blue-600 to-teal-400 p-0.5 shadow-md shrink-0 flex items-center justify-center">
                    <div className="w-full h-full bg-slate-950 rounded-[10px] flex items-center justify-center text-xl">
                      💬
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                      Application Rate Limit
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <h3 className="text-base font-extrabold text-white">{rateLimitStats.appName}</h3>
                      <span className="text-xs font-mono text-slate-400">
                        App ID: {rateLimitStats.appId}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">
                      Meta Cloud API rolling 1-hour quota across all merchant access tokens.
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setShowRateLimitDetails(!showRateLimitDetails)}
                    className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-xl text-xs font-semibold transition"
                  >
                    {showRateLimitDetails ? "Hide Details" : "View Details"}
                  </button>
                </div>
              </div>

              {/* Progress Bar Display */}
              <div className="mt-5 pt-4 border-t border-slate-800/80">
                <div className="flex items-center justify-between text-xs font-bold mb-2">
                  <span className="text-slate-300">
                    {rateLimitStats.rateLimitUsedPercent}% of limit used
                  </span>
                  <span className="text-emerald-400 font-mono">
                    {rateLimitStats.rateLimitRemainingPercent}% Remaining
                  </span>
                </div>

                <div className="w-full h-2.5 bg-slate-800 rounded-full overflow-hidden p-0.5">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
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

                <div className="flex items-center justify-between text-[11px] text-slate-400 mt-2 font-mono">
                  <span>Calls in last 60m: {rateLimitStats.callsInLastHour} API calls</span>
                  <span>
                    App Max Quota: {rateLimitStats.maxHourlyAppLimit} calls/hr (200 × {rateLimitStats.activeUsersCount} active users)
                  </span>
                </div>
              </div>

              {/* Collapsible Details Explaining Meta's Application Rate Limiting */}
              {showRateLimitDetails && (
                <div className="mt-4 p-4 rounded-xl bg-slate-950/80 border border-slate-800 text-xs space-y-2">
                  <h4 className="font-bold text-white flex items-center gap-1.5">
                    <span>ℹ️</span>
                    <span>About Application-Level Rate Limiting</span>
                  </h4>
                  <p className="text-slate-300 leading-relaxed">
                    Rate limiting defines limits on how many API calls can be made within a specified time period. Application-level rate limits apply to calls made using any access token other than a Page access token and ads APIs calls.
                  </p>
                  <p className="text-slate-300 leading-relaxed font-semibold">
                    The total number of calls your app can make per hour is <span className="text-emerald-400">200 times the number of users</span>. Please note this isn't a per-user limit. Any individual user can make more than 200 calls per hour, as long as the total for all users does not exceed the app maximum.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 text-slate-400 font-mono text-[11px]">
                    <div className="p-2 rounded bg-slate-900 border border-slate-800">
                      Total Active Users: <span className="text-white font-bold">{rateLimitStats.activeUsersCount}</span>
                    </div>
                    <div className="p-2 rounded bg-slate-900 border border-slate-800">
                      Hourly App Quota: <span className="text-emerald-400 font-bold">{rateLimitStats.maxHourlyAppLimit} calls/hr</span>
                    </div>
                    <div className="p-2 rounded bg-slate-900 border border-slate-800">
                      Rolling Window: <span className="text-teal-400 font-bold">60 Minutes</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Global Platform Telemetry Grid */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Total Stores
                </div>
                <div className="text-2xl font-extrabold text-white mt-1.5 font-mono">
                  {stats.totalStores}
                </div>
                <div className="text-[10px] text-emerald-400 mt-1">
                  {stats.activeWabas} Active WhatsApp WABAs
                </div>
              </div>

              <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Pending Registrations
                </div>
                <div className="text-2xl font-extrabold text-amber-400 mt-1.5 font-mono">
                  {stats.pendingCount}
                </div>
                <div className="text-[10px] text-amber-300 mt-1">
                  Requires Super Admin Approval
                </div>
              </div>

              <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Platform Dispatches
                </div>
                <div className="text-2xl font-extrabold text-white mt-1.5 font-mono">
                  {stats.totalDispatches}
                </div>
                <div className="text-[10px] text-teal-400 mt-1">
                  Automated WhatsApp Messages
                </div>
              </div>

              <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  2-Way Support Chats
                </div>
                <div className="text-2xl font-extrabold text-white mt-1.5 font-mono">
                  {stats.totalConversations}
                </div>
                <div className="text-[10px] text-emerald-400 mt-1">
                  Active Live Inbox Conversations
                </div>
              </div>

              <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Order Confirmations
                </div>
                <div className="text-2xl font-extrabold text-white mt-1.5 font-mono">
                  {stats.totalOrderConfirmations}
                </div>
                <div className="text-[10px] text-slate-400 mt-1">COD & Address Actions</div>
              </div>

              <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Cart Recoveries
                </div>
                <div className="text-2xl font-extrabold text-white mt-1.5 font-mono">
                  {stats.totalCartRecoveries}
                </div>
                <div className="text-[10px] text-purple-400 mt-1">
                  Abandoned Checkout Automations
                </div>
              </div>

              <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Platform Users
                </div>
                <div className="text-2xl font-extrabold text-purple-400 mt-1.5 font-mono">
                  {stats.totalUsers}
                </div>
                <div className="text-[10px] text-slate-400 mt-1">Store Owners & Staff</div>
              </div>

              <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Queue Health
                </div>
                <div className="text-2xl font-extrabold text-emerald-400 mt-1.5 font-mono">
                  {recentJobs.filter((j) => j.status === "PENDING" || j.status === "PROCESSING").length} Pending
                </div>
                <div className="text-[10px] text-slate-400 mt-1">
                  PostgreSQL Async Worker
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: PENDING APPROVALS */}
        {activeTab === "APPROVALS" && (
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xl">⏳</span>
                <h2 className="text-base font-bold text-white">
                  Pending Store Admin Registration Requests
                </h2>
                {pendingUsers.length > 0 && (
                  <span className="px-2 py-0.5 bg-amber-500/20 text-amber-300 rounded-full text-xs font-bold font-mono">
                    {pendingUsers.length} Action Needed
                  </span>
                )}
              </div>
            </div>

            {pendingUsers.length === 0 ? (
              <div className="p-12 text-center bg-slate-950/60 rounded-xl border border-slate-800/80 text-xs text-slate-500">
                ✅ No pending registration requests. All store admin signups are reviewed and approved.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400 font-semibold">
                      <th className="pb-3">Applicant Name</th>
                      <th className="pb-3">Work Email</th>
                      <th className="pb-3">Target Shopify Store</th>
                      <th className="pb-3">Requested Role</th>
                      <th className="pb-3">Submitted At</th>
                      <th className="pb-3 text-right">Super Admin Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {pendingUsers.map((p) => (
                      <tr key={p.id} className="hover:bg-slate-800/30 transition">
                        <td className="py-3.5 font-bold text-white">{p.name}</td>
                        <td className="py-3.5 font-mono text-slate-300">{p.email}</td>
                        <td className="py-3.5 font-semibold text-emerald-400">
                          {p.merchant?.shop || "—"}
                        </td>
                        <td className="py-3.5">
                          <span className="px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 font-bold text-[10px]">
                            {p.role}
                          </span>
                        </td>
                        <td className="py-3.5 text-slate-500 font-mono">
                          {new Date(p.createdAt).toLocaleDateString()}{" "}
                          {new Date(p.createdAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </td>
                        <td className="py-3.5 text-right space-x-2">
                          <Form method="post" className="inline-block">
                            <input type="hidden" name="intent" value="approve_user" />
                            <input type="hidden" name="userId" value={p.id} />
                            <button
                              type="submit"
                              disabled={isSubmitting}
                              className="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-lg text-xs transition shadow-sm"
                            >
                              ✅ Approve & Activate
                            </button>
                          </Form>

                          <Form method="post" className="inline-block">
                            <input type="hidden" name="intent" value="reject_user" />
                            <input type="hidden" name="userId" value={p.id} />
                            <button
                              type="submit"
                              disabled={isSubmitting}
                              className="px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/40 font-semibold rounded-lg text-xs transition"
                            >
                              ❌ Reject
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

        {/* TAB 3: STORES DIRECTORY */}
        {activeTab === "STORES" && (
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <span>🏬 Registered Stores Directory</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 font-mono">
                    {filteredStores.length} of {allStores.length}
                  </span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Inspect WhatsApp WABAs, Tier Limits, and dispatches across all stores.
                </p>
              </div>

              {/* Store Search */}
              <div className="relative w-full sm:w-72">
                <input
                  type="text"
                  value={storeSearch}
                  onChange={(e) => setStoreSearch(e.target.value)}
                  placeholder="Search store, shopify domain, phone..."
                  className="w-full pl-8 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-purple-500"
                />
                <span className="absolute left-2.5 top-2.5 text-xs text-slate-500">🔍</span>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400 font-semibold">
                    <th className="pb-3">Shopify Domain</th>
                    <th className="pb-3">WhatsApp Number</th>
                    <th className="pb-3">Quality Health</th>
                    <th className="pb-3">Tier Limit</th>
                    <th className="pb-3">Dispatches</th>
                    <th className="pb-3">Active Users</th>
                    <th className="pb-3 text-right">Switch / Manage</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {filteredStores.map((s) => (
                    <tr key={s.id} className="hover:bg-slate-800/30 transition">
                      <td className="py-3.5 font-bold text-slate-200">
                        {s.shop}
                        {s.name && (
                          <span className="text-slate-400 font-normal ml-1">({s.name})</span>
                        )}
                      </td>
                      <td className="py-3.5 font-mono text-slate-300">
                        {s.displayPhoneNumber || (
                          <span className="text-amber-400/80 text-[11px]">Not Connected</span>
                        )}
                      </td>
                      <td className="py-3.5">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            s.qualityRating === "GREEN"
                              ? "bg-emerald-500/20 text-emerald-300"
                              : s.qualityRating === "YELLOW"
                              ? "bg-amber-500/20 text-amber-300"
                              : "bg-red-500/20 text-red-300"
                          }`}
                        >
                          {s.qualityRating || "GREEN"}
                        </span>
                      </td>
                      <td className="py-3.5 font-mono text-emerald-400">
                        {s.messagingLimit || "TIER_250"}
                      </td>
                      <td className="py-3.5 font-mono text-white">{s._count.messages}</td>
                      <td className="py-3.5 font-mono text-slate-400">
                        {s._count.users} members
                      </td>
                      <td className="py-3.5 text-right">
                        <Link
                          to={`/portal/inbox?phone=`}
                          prefetch="intent"
                          className="px-3 py-1 bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border border-purple-500/40 font-semibold rounded-lg text-xs transition inline-flex items-center gap-1"
                        >
                          <span>💬 View Inbox</span>
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 4: USER DIRECTORY (WITH LIVE SEARCH & FILTERING) */}
        {activeTab === "USERS" && (
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <span>👥 Global Platform User Directory</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 font-mono">
                    {filteredUsers.length} of {allUsers.length}
                  </span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Search, filter, and manage permissions across all platform members.
                </p>
              </div>

              {/* Filters & Search Controls */}
              <div className="flex flex-wrap items-center gap-2.5">
                {/* Role Filter */}
                <select
                  value={userRoleFilter}
                  onChange={(e) => setUserRoleFilter(e.target.value)}
                  className="px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-purple-500"
                >
                  <option value="ALL">All Roles</option>
                  <option value="SUPER_ADMIN">👑 Super Admin</option>
                  <option value="OWNER">Store Owner</option>
                  <option value="MANAGER">Store Manager</option>
                  <option value="AGENT">Support Agent</option>
                </select>

                {/* Status Filter */}
                <select
                  value={userStatusFilter}
                  onChange={(e) => setUserStatusFilter(e.target.value)}
                  className="px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-purple-500"
                >
                  <option value="ALL">All Status</option>
                  <option value="ACTIVE">✅ Active</option>
                  <option value="PENDING">⏳ Pending</option>
                  <option value="REJECTED">❌ Rejected</option>
                  <option value="INACTIVE">Inactive</option>
                </select>

                {/* Search Bar */}
                <div className="relative w-full sm:w-64">
                  <input
                    type="text"
                    value={userSearch}
                    onChange={(e) => setUserSearch(e.target.value)}
                    placeholder="Search name, email, store..."
                    className="w-full pl-8 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-purple-500"
                  />
                  <span className="absolute left-2.5 top-2.5 text-xs text-slate-500">🔍</span>
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400 font-semibold">
                    <th className="pb-3">User</th>
                    <th className="pb-3">Store Domain</th>
                    <th className="pb-3">Role</th>
                    <th className="pb-3">Approval Status</th>
                    <th className="pb-3">Active State</th>
                    <th className="pb-3">Registered At</th>
                    <th className="pb-3 text-right">Super Admin Control</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {filteredUsers.map((u) => (
                    <tr key={u.id} className="hover:bg-slate-800/30 transition">
                      <td className="py-3.5">
                        <div className="font-bold text-white">{u.name}</div>
                        <div className="font-mono text-[11px] text-slate-400">{u.email}</div>
                      </td>
                      <td className="py-3.5 font-semibold text-slate-300">
                        {u.merchant?.shop || (
                          <span className="text-purple-400 font-bold">Global Super Admin</span>
                        )}
                      </td>
                      <td className="py-3.5">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            u.role === "SUPER_ADMIN"
                              ? "bg-purple-500/20 text-purple-300 border border-purple-500/40"
                              : u.role === "OWNER"
                              ? "bg-emerald-500/20 text-emerald-300"
                              : u.role === "MANAGER"
                              ? "bg-blue-500/20 text-blue-300"
                              : "bg-slate-700 text-slate-300"
                          }`}
                        >
                          {u.role}
                        </span>
                      </td>
                      <td className="py-3.5">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold ${
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
                      <td className="py-3.5">
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold font-mono ${
                            u.isActive
                              ? "bg-emerald-500/20 text-emerald-400"
                              : "bg-red-500/20 text-red-400"
                          }`}
                        >
                          {u.isActive ? "● ACTIVE" : "○ INACTIVE"}
                        </span>
                      </td>
                      <td className="py-3.5 text-slate-500 font-mono text-[11px]">
                        {new Date(u.createdAt).toLocaleDateString()}
                      </td>
                      <td className="py-3.5 text-right space-x-2">
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
                                className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-semibold transition"
                              >
                                {u.isActive ? "Deactivate" : "Activate"}
                              </button>
                            </Form>

                            <Form
                              method="post"
                              className="inline-block"
                              onSubmit={(e) => {
                                if (!confirm(`Are you sure you want to delete user ${u.name}?`)) {
                                  e.preventDefault();
                                }
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

        {/* TAB 5: BACKGROUND JOBS & QUEUE TELEMETRY */}
        {activeTab === "JOBS" && (
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <span>⚙️ PostgreSQL Background Job Queue</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 font-mono">
                    {recentJobs.length} Recent Tasks
                  </span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Real-time monitoring of asynchronous WhatsApp dispatchers, abandoned cart timers, and webhook jobs.
                </p>
              </div>

              <Form method="post">
                <input type="hidden" name="intent" value="purge_completed_jobs" />
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-xl text-xs font-semibold transition"
                >
                  🧹 Purge Completed Jobs
                </button>
              </Form>
            </div>

            {recentJobs.length === 0 ? (
              <div className="p-12 text-center bg-slate-950/60 rounded-xl border border-slate-800/80 text-xs text-slate-500">
                ✅ Background job queue is currently clear. No pending or failed tasks.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400 font-semibold">
                      <th className="pb-3">Job Type</th>
                      <th className="pb-3">Target Store</th>
                      <th className="pb-3">Status</th>
                      <th className="pb-3">Attempts</th>
                      <th className="pb-3">Scheduled / Run At</th>
                      <th className="pb-3">Error Details</th>
                      <th className="pb-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {recentJobs.map((j) => (
                      <tr key={j.id} className="hover:bg-slate-800/30 transition">
                        <td className="py-3.5 font-bold font-mono text-purple-300">{j.jobType}</td>
                        <td className="py-3.5 text-slate-300">{j.merchant?.shop || "Global"}</td>
                        <td className="py-3.5">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold font-mono ${
                              j.status === "COMPLETED"
                                ? "bg-emerald-500/20 text-emerald-300"
                                : j.status === "FAILED"
                                ? "bg-red-500/20 text-red-300"
                                : j.status === "PROCESSING"
                                ? "bg-blue-500/20 text-blue-300 animate-pulse"
                                : "bg-amber-500/20 text-amber-300"
                            }`}
                          >
                            {j.status}
                          </span>
                        </td>
                        <td className="py-3.5 font-mono text-slate-400">
                          {j.attempts} / {j.maxAttempts}
                        </td>
                        <td className="py-3.5 font-mono text-slate-400 text-[11px]">
                          {new Date(j.runAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </td>
                        <td className="py-3.5 max-w-xs truncate font-mono text-red-400 text-[11px]">
                          {j.error || "—"}
                        </td>
                        <td className="py-3.5 text-right space-x-2">
                          {j.status === "FAILED" && (
                            <Form method="post" className="inline-block">
                              <input type="hidden" name="intent" value="retry_job" />
                              <input type="hidden" name="jobId" value={j.id} />
                              <button
                                type="submit"
                                disabled={isSubmitting}
                                className="px-2.5 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 rounded-lg text-xs font-semibold transition"
                              >
                                🔄 Retry
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
    </div>
  );
}
