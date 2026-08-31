import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import db from "../db.server";
import { requireRole } from "../utils/portal-auth.server";
import { sendWhatsAppMessage } from "../utils/meta-whatsapp.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireRole(request, ["OWNER", "MANAGER"]);

  const [merchant, deliveredCount, readCount] = await Promise.all([
    db.merchant.findUnique({
      where: { id: user.merchantId },
      include: {
        _count: {
          select: {
            messages: true,
            conversations: true,
            cartRecoveries: true,
            orderConfirmations: true,
          },
        },
        messages: {
          take: 10,
          orderBy: { createdAt: "desc" },
        },
      },
    }),
    db.messageLog.count({
      where: { merchantId: user.merchantId, status: "DELIVERED" },
    }),
    db.messageLog.count({
      where: { merchantId: user.merchantId, status: "READ" },
    }),
  ]);

  if (!merchant) {
    throw new Response("Merchant not found", { status: 404 });
  }

  const totalSent = merchant._count.messages;

  return json({
    user,
    merchant,
    stats: {
      totalSent,
      deliveredCount,
      readCount,
      activeConversations: merchant._count.conversations,
      cartRecoveries: merchant._count.cartRecoveries,
      orderConfirmations: merchant._count.orderConfirmations,
    },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireRole(request, ["OWNER", "MANAGER"]);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "test_whatsapp") {
    const testPhone = (formData.get("testPhone") as string)?.replace(/\D/g, "");
    if (!testPhone) {
      return json({ testSuccess: null as string | null, testError: "Please enter a valid phone number with country code.", error: null as string | null }, { status: 400 });
    }

    try {
      const result = await sendWhatsAppMessage({
        merchantId: user.merchantId,
        recipientPhone: testPhone,
        customerName: "Portal Tester",
        eventType: "TEST_DISPATCH",
        bodyText: `👋 Hello from StorePing Web Portal! Your WhatsApp Business Cloud API connection is active and working seamlessly. (Sent by ${user.name})`,
        buttons: [
          { id: "test_reply_ok", text: "✅ Confirmed", type: "QUICK_REPLY" },
          { id: "test_reply_help", text: "💬 Ask Question", type: "QUICK_REPLY" },
        ],
      });

      if (result.success) {
        return json({ testSuccess: `Test message dispatched successfully to +${testPhone} (Message ID: ${result.messageId})`, testError: null as string | null, error: null as string | null });
      } else {
        return json({ testSuccess: null as string | null, testError: result.error || "Failed to dispatch test message.", error: null as string | null }, { status: 400 });
      }
    } catch (err: any) {
      return json({ testSuccess: null as string | null, testError: err.message || "An unexpected error occurred.", error: null as string | null }, { status: 500 });
    }
  }

  return json({ testSuccess: null as string | null, testError: null as string | null, error: "Unknown action" }, { status: 400 });
}

export default function PortalDashboard() {
  const { user, merchant, stats } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSendingTest = navigation.state === "submitting";

  // Tier limit display map
  const tierMap: Record<string, number> = {
    TIER_250: 250,
    TIER_1K: 1000,
    TIER_10K: 10000,
    TIER_100K: 100000,
    UNLIMITED: 999999,
  };
  const tierLimit = tierMap[merchant.messagingLimit || "TIER_250"] || 250;
  const usagePercentage = Math.min(100, Math.round((merchant.dailySentCount / tierLimit) * 100));

  return (
    <div className="flex-1 overflow-y-auto p-6 lg:p-10 w-full">
      <div className="max-w-7xl mx-auto space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl lg:text-3xl font-extrabold text-white tracking-tight">
            WhatsApp Connection & Operations
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Store: <span className="font-semibold text-slate-200">{merchant.shop}</span> • Logged in as{" "}
            <span className="text-emerald-400 font-semibold">{user.name}</span> ({user.role})
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold ${
              merchant.isWhatsAppConnected
                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                : "bg-red-500/10 text-red-400 border border-red-500/30"
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                merchant.isWhatsAppConnected ? "bg-emerald-400 animate-pulse" : "bg-red-400"
              }`}
            ></span>
            {merchant.isWhatsAppConnected ? "WhatsApp Cloud API Active" : "WhatsApp Disconnected"}
          </span>
        </div>
      </div>

      {/* 1. Meta WhatsApp Assets & Health Center (Hero Card) */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 lg:p-8 backdrop-blur-xl shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-800/80 pb-5 mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-xl">
              📱
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">Connected WhatsApp Asset Details</h2>
              <p className="text-xs text-slate-400">Meta Business Account & WABA Configuration</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400">Quality Rating:</span>
            <span
              className={`px-2.5 py-1 rounded-lg text-xs font-bold ${
                merchant.qualityRating === "GREEN"
                  ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                  : merchant.qualityRating === "YELLOW"
                  ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                  : "bg-red-500/20 text-red-300 border border-red-500/40"
              }`}
            >
              {merchant.qualityRating || "GREEN"}
            </span>
          </div>
        </div>

        {/* Grid of Key WhatsApp Identifiers */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-4 rounded-xl bg-slate-950/70 border border-slate-800/80">
            <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold mb-1">
              Display Phone Number
            </div>
            <div className="text-base font-bold text-white font-mono">
              {merchant.displayPhoneNumber || "Not Set"}
            </div>
          </div>

          <div className="p-4 rounded-xl bg-slate-950/70 border border-slate-800/80">
            <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold mb-1">
              Phone Number ID
            </div>
            <div className="text-sm font-semibold text-slate-300 font-mono truncate">
              {merchant.phoneNumberId || "—"}
            </div>
          </div>

          <div className="p-4 rounded-xl bg-slate-950/70 border border-slate-800/80">
            <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold mb-1">
              WhatsApp Business Account (WABA ID)
            </div>
            <div className="text-sm font-semibold text-slate-300 font-mono truncate">
              {merchant.wabaId || "—"}
            </div>
          </div>

          <div className="p-4 rounded-xl bg-slate-950/70 border border-slate-800/80">
            <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold mb-1">
              Messaging Tier Limit
            </div>
            <div className="text-base font-bold text-emerald-400 font-mono">
              {merchant.messagingLimit || "TIER_250"}
            </div>
          </div>
        </div>

        {/* Quota Consumption Progress Bar */}
        <div className="mt-6 p-4 rounded-xl bg-slate-950/40 border border-slate-800/60">
          <div className="flex items-center justify-between text-xs mb-2">
            <span className="font-semibold text-slate-300">
              24-Hour Business Initiated Quota Usage
            </span>
            <span className="font-mono text-slate-400">
              <strong className="text-white">{merchant.dailySentCount}</strong> / {tierLimit} sent ({usagePercentage}%)
            </span>
          </div>
          <div className="w-full h-2.5 bg-slate-800 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ${
                usagePercentage > 80 ? "bg-amber-500" : "bg-gradient-to-r from-emerald-500 to-teal-400"
              }`}
              style={{ width: `${Math.max(3, usagePercentage)}%` }}
            ></div>
          </div>
        </div>
      </div>

      {/* 2. Key Metrics & Analytics Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        <div className="p-6 rounded-2xl bg-slate-900/90 border border-slate-800">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Total Dispatches</div>
          <div className="text-3xl font-extrabold text-white mt-2 font-mono">{stats.totalSent}</div>
          <div className="text-[11px] text-emerald-400 mt-1">Live Automated Messages</div>
        </div>

        <div className="p-6 rounded-2xl bg-slate-900/90 border border-slate-800">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Active Conversations</div>
          <div className="text-3xl font-extrabold text-white mt-2 font-mono">{stats.activeConversations}</div>
          <div className="text-[11px] text-teal-400 mt-1">2-Way Support Chats</div>
        </div>

        <div className="p-6 rounded-2xl bg-slate-900/90 border border-slate-800">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Order Confirmations</div>
          <div className="text-3xl font-extrabold text-white mt-2 font-mono">{stats.orderConfirmations}</div>
          <div className="text-[11px] text-emerald-400 mt-1">COD & Address Actions</div>
        </div>

        <div className="p-6 rounded-2xl bg-slate-900/90 border border-slate-800">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Cart Recoveries</div>
          <div className="text-3xl font-extrabold text-white mt-2 font-mono">{stats.cartRecoveries}</div>
          <div className="text-[11px] text-teal-400 mt-1">Abandoned Checkout Triggers</div>
        </div>
      </div>

      {/* 3. Quick Test Message Dispatcher & Recent Dispatches */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left: Test Message Trigger */}
        <div className="lg:col-span-5 bg-slate-900/90 border border-slate-800 rounded-2xl p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold">
              ⚡
            </div>
            <div>
              <h3 className="font-bold text-white text-base">Quick WhatsApp Send Test</h3>
              <p className="text-xs text-slate-400">Verify end-to-end delivery to your test device</p>
            </div>
          </div>

          {actionData?.testSuccess && (
            <div className="mb-4 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs">
              {actionData.testSuccess}
            </div>
          )}
          {actionData?.testError && (
            <div className="mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
              {actionData.testError}
            </div>
          )}

          <Form method="post" className="space-y-4">
            <input type="hidden" name="intent" value="test_whatsapp" />

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Recipient Phone Number (with Country Code)
              </label>
              <input
                type="tel"
                name="testPhone"
                defaultValue={merchant.phone || "919374626600"}
                placeholder="e.g. 919374626600"
                className="w-full px-4 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-sm text-white font-mono focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                required
              />
              <span className="text-[11px] text-slate-500 mt-1 block">
                Do not include +, spaces, or dashes (e.g. 919876543210).
              </span>
            </div>

            <button
              type="submit"
              disabled={isSendingTest}
              className="w-full py-3 bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-bold rounded-xl text-sm transition shadow-lg shadow-emerald-500/20 disabled:opacity-50"
            >
              {isSendingTest ? "Dispatching..." : "Send Test WhatsApp Message"}
            </button>
          </Form>
        </div>

        {/* Right: Recent Dispatches Stream */}
        <div className="lg:col-span-7 bg-slate-900/90 border border-slate-800 rounded-2xl p-6">
          <h3 className="font-bold text-white text-base mb-4 flex items-center justify-between">
            <span>Recent Message Activity</span>
            <span className="text-xs text-slate-500 font-normal">Last 10 Logs</span>
          </h3>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="pb-3 font-semibold">Recipient</th>
                  <th className="pb-3 font-semibold">Event</th>
                  <th className="pb-3 font-semibold">Status</th>
                  <th className="pb-3 font-semibold">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {merchant.messages.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-slate-500">
                      No message logs yet. Send a test message to verify.
                    </td>
                  </tr>
                ) : (
                  merchant.messages.map((msg) => (
                    <tr key={msg.id} className="hover:bg-slate-800/30 transition">
                      <td className="py-3 font-mono text-slate-300">{msg.recipientPhone}</td>
                      <td className="py-3 text-slate-300 font-semibold">{msg.eventType}</td>
                      <td className="py-3">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            msg.status === "DELIVERED" || msg.status === "READ"
                              ? "bg-emerald-500/20 text-emerald-400"
                              : msg.status === "FAILED"
                              ? "bg-red-500/20 text-red-400"
                              : "bg-blue-500/20 text-blue-400"
                          }`}
                        >
                          {msg.status}
                        </span>
                      </td>
                      <td className="py-3 text-slate-500 font-mono">
                        {new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>
);
}
