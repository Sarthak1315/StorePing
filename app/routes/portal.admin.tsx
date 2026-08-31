import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import db from "../db.server";
import { requireRole } from "../utils/portal-auth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  // Only SUPER_ADMIN allowed
  const user = await requireRole(request, ["SUPER_ADMIN"]);

  // 1. Pending Approvals Queue
  const pendingUsers = await db.user.findMany({
    where: { approvalStatus: "PENDING" },
    include: {
      merchant: {
        select: { id: true, shop: true, name: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // 2. All Registered Stores & WABA stats
  const allStores = await db.merchant.findMany({
    include: {
      _count: {
        select: {
          users: true,
          messages: true,
          conversations: true,
          orderConfirmations: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // 3. All Platform Users
  const allUsers = await db.user.findMany({
    include: {
      merchant: {
        select: { id: true, shop: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // Global Totals
  const totalDispatches = await db.messageLog.count();
  const totalConversations = await db.conversation.count();
  const activeWabas = allStores.filter((s) => s.isWhatsAppConnected).length;

  return json({
    user,
    pendingUsers,
    allStores,
    allUsers,
    stats: {
      totalStores: allStores.length,
      activeWabas,
      totalDispatches,
      totalConversations,
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

  // 1. Approve User Registration Request
  if (intent === "approve_user") {
    const updated = await db.user.update({
      where: { id: targetUserId },
      data: {
        approvalStatus: "APPROVED",
        isActive: true,
      },
    });
    return json({ success: `Approved account for ${updated.name} (${updated.email}). User can now log in!` });
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
    return json({ success: `Rejected registration request for ${updated.email}.` });
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

  return json({ error: "Unknown action" }, { status: 400 });
}

export default function SuperAdminDashboard() {
  const { user, pendingUsers, allStores, allUsers, stats } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div className="flex-1 overflow-y-auto p-6 lg:p-10 w-full">
      <div className="max-w-7xl mx-auto space-y-8">
        {/* Top Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs bg-purple-500/20 text-purple-300 font-bold border border-purple-500/30 px-2.5 py-0.5 rounded-full">
              👑 SUPER ADMIN CONTROL PANEL
            </span>
          </div>
          <h1 className="text-2xl lg:text-3xl font-extrabold text-white tracking-tight">
            Platform Governance & Store Approvals
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Cross-tenant overview of all connected Shopify stores, WhatsApp WABAs, and team access.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <a
            href="/portal/inbox"
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold rounded-xl text-xs border border-slate-700 transition"
          >
            💬 Open Global Inbox
          </a>
          <a
            href="/portal/dashboard"
            className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-xl text-xs transition"
          >
            📊 Active Store Dashboard
          </a>
        </div>
      </div>

      {actionData?.success && (
        <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-semibold">
          ✅ {actionData.success}
        </div>
      )}
      {actionData?.error && (
        <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs font-semibold">
          ⚠️ {actionData.error}
        </div>
      )}

      {/* 1. Global Platform Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Total Stores</div>
          <div className="text-2xl font-extrabold text-white mt-1.5 font-mono">{stats.totalStores}</div>
          <div className="text-[10px] text-emerald-400 mt-1">{stats.activeWabas} Active WABAs</div>
        </div>

        <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Pending Approvals</div>
          <div className="text-2xl font-extrabold text-amber-400 mt-1.5 font-mono">{stats.pendingCount}</div>
          <div className="text-[10px] text-amber-300 mt-1">Requires Super Admin</div>
        </div>

        <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Platform Messages</div>
          <div className="text-2xl font-extrabold text-white mt-1.5 font-mono">{stats.totalDispatches}</div>
          <div className="text-[10px] text-teal-400 mt-1">Automated WhatsApps</div>
        </div>

        <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Global Chats</div>
          <div className="text-2xl font-extrabold text-white mt-1.5 font-mono">{stats.totalConversations}</div>
          <div className="text-[10px] text-emerald-400 mt-1">2-Way Support Sessions</div>
        </div>

        <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800 col-span-2 lg:col-span-1">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Total Users</div>
          <div className="text-2xl font-extrabold text-purple-400 mt-1.5 font-mono">{stats.totalUsers}</div>
          <div className="text-[10px] text-slate-400 mt-1">Owners & Agents</div>
        </div>
      </div>

      {/* 2. Pending Approvals Queue */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="text-xl">⏳</span>
            <h2 className="text-base font-bold text-white">Pending Store Admin Registration Requests</h2>
            {pendingUsers.length > 0 && (
              <span className="px-2 py-0.5 bg-amber-500/20 text-amber-300 rounded-full text-xs font-bold font-mono">
                {pendingUsers.length} Action Needed
              </span>
            )}
          </div>
        </div>

        {pendingUsers.length === 0 ? (
          <div className="p-8 text-center bg-slate-950/60 rounded-xl border border-slate-800/80 text-xs text-slate-500">
            ✅ No pending approval requests. All registered store accounts are reviewed.
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
                  <th className="pb-3">Requested At</th>
                  <th className="pb-3 text-right">Super Admin Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {pendingUsers.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-800/30 transition">
                    <td className="py-3.5 font-bold text-white">{p.name}</td>
                    <td className="py-3.5 font-mono text-slate-300">{p.email}</td>
                    <td className="py-3.5 font-semibold text-emerald-400">{p.merchant?.shop || "—"}</td>
                    <td className="py-3.5">
                      <span className="px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 font-bold text-[10px]">
                        {p.role}
                      </span>
                    </td>
                    <td className="py-3.5 text-slate-500 font-mono">
                      {new Date(p.createdAt).toLocaleDateString()} {new Date(p.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
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

      {/* 3. All Registered Stores Directory */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl">
        <h2 className="text-base font-bold text-white mb-4 flex items-center justify-between">
          <span>🏬 All Registered Stores ({allStores.length})</span>
          <span className="text-xs text-slate-400 font-normal">Cross-Tenant Access</span>
        </h2>

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
                <th className="pb-3 text-right">Switch / Inspect</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {allStores.map((s) => (
                <tr key={s.id} className="hover:bg-slate-800/30 transition">
                  <td className="py-3.5 font-bold text-slate-200">
                    {s.shop}
                    {s.name && <span className="text-slate-400 font-normal ml-1">({s.name})</span>}
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
                  <td className="py-3.5 font-mono text-emerald-400">{s.messagingLimit || "TIER_250"}</td>
                  <td className="py-3.5 font-mono text-white">{s._count.messages}</td>
                  <td className="py-3.5 font-mono text-slate-400">{s._count.users} members</td>
                  <td className="py-3.5 text-right">
                    <a
                      href={`/portal/dashboard?shop=${s.shop}`}
                      className="px-3 py-1 bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border border-purple-500/40 font-semibold rounded-lg text-xs transition inline-flex items-center gap-1"
                    >
                      <span>🏬 Switch to Store</span>
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 4. All Users Table */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl">
        <h2 className="text-base font-bold text-white mb-4">
          👥 Platform Users Directory ({allUsers.length})
        </h2>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 font-semibold">
                <th className="pb-3">User</th>
                <th className="pb-3">Store Domain</th>
                <th className="pb-3">Role</th>
                <th className="pb-3">Status</th>
                <th className="pb-3">Last Login</th>
                <th className="pb-3 text-right">Control</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {allUsers.map((u) => (
                <tr key={u.id} className="hover:bg-slate-800/30 transition">
                  <td className="py-3 font-semibold text-white">
                    {u.name}
                    <div className="text-[11px] text-slate-400 font-mono font-normal">{u.email}</div>
                  </td>
                  <td className="py-3 font-mono text-slate-300">{u.merchant?.shop || "Platform Root"}</td>
                  <td className="py-3">
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        u.role === "SUPER_ADMIN"
                          ? "bg-purple-500/20 text-purple-300 border border-purple-500/40"
                          : u.role === "OWNER"
                          ? "bg-emerald-500/20 text-emerald-300"
                          : "bg-blue-500/20 text-blue-300"
                      }`}
                    >
                      {u.role}
                    </span>
                  </td>
                  <td className="py-3">
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        u.isActive && u.approvalStatus === "APPROVED"
                          ? "bg-emerald-500/20 text-emerald-400"
                          : u.approvalStatus === "PENDING"
                          ? "bg-amber-500/20 text-amber-400"
                          : "bg-red-500/20 text-red-400"
                      }`}
                    >
                      {u.approvalStatus === "PENDING"
                        ? "PENDING"
                        : u.isActive
                        ? "ACTIVE"
                        : "INACTIVE"}
                    </span>
                  </td>
                  <td className="py-3 text-slate-500 font-mono">
                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : "Never"}
                  </td>
                  <td className="py-3 text-right space-x-2">
                    {u.role !== "SUPER_ADMIN" && (
                      <>
                        <Form method="post" className="inline-block">
                          <input type="hidden" name="intent" value="toggle_user_status" />
                          <input type="hidden" name="userId" value={u.id} />
                          <input type="hidden" name="currentStatus" value={u.isActive ? "true" : "false"} />
                          <button
                            type="submit"
                            className="text-xs text-slate-400 hover:text-white px-2 py-1 bg-slate-800 rounded border border-slate-700"
                          >
                            {u.isActive ? "Deactivate" : "Activate"}
                          </button>
                        </Form>

                        <Form method="post" className="inline-block">
                          <input type="hidden" name="intent" value="delete_user" />
                          <input type="hidden" name="userId" value={u.id} />
                          <button
                            type="submit"
                            onClick={(e) => {
                              if (!confirm(`Delete ${u.email}?`)) e.preventDefault();
                            }}
                            className="text-slate-500 hover:text-red-400 text-xs px-1.5 py-1"
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
    </div>
  </div>
);
}
