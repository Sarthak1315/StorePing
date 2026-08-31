import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import db from "../db.server";
import { requirePortalUser } from "../utils/portal-auth.server";
import { getMerchantBillingSummary } from "../utils/meta-pricing.server";
import { SHOPIFY_PLANS } from "../utils/shopify-billing.server";
import { getPlatformSettings } from "../utils/platform-settings.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requirePortalUser(request);

  if (!user.merchantId) {
    throw new Error("No merchant store associated with user account.");
  }

  const [billingSummary, platformSettings, merchant] = await Promise.all([
    getMerchantBillingSummary(user.merchantId),
    getPlatformSettings(),
    db.merchant.findUnique({
      where: { id: user.merchantId },
      include: {
        _count: {
          select: {
            users: true,
            cartRecoveries: { where: { status: "RECOVERED" } },
          },
        },
      },
    }),
  ]);

  const activePlanId = (merchant?.planId || "FREE") as keyof typeof SHOPIFY_PLANS;
  const activePlan = SHOPIFY_PLANS[activePlanId] || SHOPIFY_PLANS.FREE;

  return json({
    user,
    merchant,
    activePlan,
    billingSummary,
    platformSettings,
    allPlans: SHOPIFY_PLANS,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const user = await requirePortalUser(request);
  if (!user.merchantId) {
    return json({ success: null as string | null, error: "Unauthorized" }, { status: 403 });
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "update_budget_limit") {
    const rawBudget = formData.get("monthlyBudgetLimit") as string;
    const newBudget = parseFloat(rawBudget);

    if (isNaN(newBudget) || newBudget <= 0) {
      return json({ success: null as string | null, error: "Please enter a valid positive budget amount." }, { status: 400 });
    }

    await db.merchant.update({
      where: { id: user.merchantId },
      data: {
        monthlyBudgetLimit: newBudget,
        budgetAlert50Sent: false,
        budgetAlert80Sent: false,
        budgetAlert100Sent: false,
      },
    });

    return json({ success: `Monthly budget limit updated to ${newBudget.toFixed(2)}.`, error: null as string | null });
  }

  return json({ success: null as string | null, error: "Unknown action" }, { status: 400 });
}

export default function PortalBilling() {
  const { user, merchant, activePlan, billingSummary, platformSettings } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const currencySymbol = billingSummary.currencySymbol || "₹";

  return (
    <div className="flex-1 overflow-y-auto bg-slate-950 text-slate-100 p-6 lg:p-8 space-y-6 font-sans">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xl">💳</span>
            <h1 className="text-xl font-bold text-white tracking-tight">
              Subscription & WhatsApp Billing
            </h1>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Manage your StorePing SaaS plan subscription and monitor live Meta WhatsApp message consumption.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <a
            href="https://business.facebook.com/billing_hub"
            target="_blank"
            rel="noopener noreferrer"
            className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-semibold transition flex items-center gap-1.5"
          >
            <span>↗</span>
            <span>Meta Billing Hub</span>
          </a>
        </div>
      </div>

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

      {/* Meta Card Decline Alert Banner */}
      {merchant?.alertType === "PAYMENT_REQUIRED" && (
        <div className="p-4 rounded-xl bg-red-950/40 border border-red-800/80 text-red-300 text-xs space-y-2">
          <div className="flex items-center justify-between font-bold text-red-200">
            <span className="flex items-center gap-1.5">
              <span>⚠️</span>
              <span>WhatsApp Card Payment Required on Meta Business Suite</span>
            </span>
            <a
              href="https://business.facebook.com/billing_hub"
              target="_blank"
              rel="noopener noreferrer"
              className="px-2.5 py-1 bg-red-800 hover:bg-red-700 text-white rounded text-[11px] font-semibold transition"
            >
              Update Card ↗
            </a>
          </div>
          <p className="leading-relaxed">
            Meta was unable to process message charges on your linked card. Please update your card in Meta Business Suite to avoid message delivery pauses.
          </p>
        </div>
      )}

      {/* 1. TOP CARDS: SAAS PLAN & WHATSAPP CONSUMPTION */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Active Shopify Plan Status */}
        <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Active SaaS Plan
            </div>
            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
              ● {billingSummary.subscriptionStatus}
            </span>
          </div>

          <div>
            <div className="text-lg font-bold text-white">{activePlan.name}</div>
            <div className="text-sm font-semibold text-emerald-400 font-mono mt-0.5">
              ${activePlan.price} / month (approx. ₹{activePlan.inrPrice})
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Billed automatically via your Shopify 30-day invoice.
            </p>
          </div>

          <div className="pt-3 border-t border-slate-800/80 space-y-2 text-xs">
            <div className="flex items-center justify-between text-slate-300">
              <span>Team Member Seats:</span>
              <span className="font-mono text-white">
                {merchant?._count.users || 1} / {activePlan.teamSeatsLimit === 999 ? "Unlimited" : activePlan.teamSeatsLimit}
              </span>
            </div>
            <div className="flex items-center justify-between text-slate-300">
              <span>Monthly Recoveries:</span>
              <span className="font-mono text-white">
                {activePlan.monthlyRecoveryLimit === -1 ? "Unlimited" : `${activePlan.monthlyRecoveryLimit} max`}
              </span>
            </div>
          </div>
        </div>

        {/* Center: Live Meta WhatsApp Consumption Meter */}
        <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-4 lg:col-span-2">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Meta WhatsApp Cloud API Spend
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-2xl font-bold text-white font-mono">
                  {currencySymbol}
                  {billingSummary.totalEstimatedSpend.toFixed(2)}
                </span>
                <span className="text-xs text-slate-400">spent this month</span>
              </div>
            </div>

            <div className="text-right">
              <div className="text-[10px] text-slate-400 font-medium">Monthly Budget Limit</div>
              <div className="text-sm font-bold text-white font-mono">
                {currencySymbol}
                {billingSummary.monthlyBudgetLimit.toFixed(2)}
              </div>
            </div>
          </div>

          {/* Progress Bar */}
          <div className="space-y-1.5 pt-1">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-slate-400">
                {billingSummary.budgetUsedPercent}% of budget used
              </span>
              <span className="text-emerald-400 font-semibold">
                {currencySymbol}
                {billingSummary.budgetRemaining.toFixed(2)} Remaining
              </span>
            </div>

            <div className="w-full h-2.5 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
              <div
                className={`h-full rounded-full transition-all duration-300 ${
                  billingSummary.budgetUsedPercent > 80
                    ? "bg-red-500"
                    : billingSummary.budgetUsedPercent > 50
                    ? "bg-amber-400"
                    : "bg-emerald-500"
                }`}
                style={{ width: `${Math.max(2, billingSummary.budgetUsedPercent)}%` }}
              />
            </div>
          </div>

          {/* Category Breakdown Badges */}
          <div className="grid grid-cols-3 gap-2.5 pt-2 font-mono text-[11px]">
            <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
              <span className="text-slate-500 block text-[10px]">MARKETING ({billingSummary.marketingCount} msgs)</span>
              <span className="text-white font-bold">{currencySymbol}{billingSummary.marketingSpend.toFixed(2)}</span>
            </div>

            <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
              <span className="text-slate-500 block text-[10px]">UTILITY ({billingSummary.utilityCount} msgs)</span>
              <span className="text-white font-bold">{currencySymbol}{billingSummary.utilitySpend.toFixed(2)}</span>
            </div>

            <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
              <span className="text-slate-500 block text-[10px]">SUPPORT CHAT ({billingSummary.freeServiceCount} msgs)</span>
              <span className="text-emerald-400 font-bold">100% FREE (₹0.00)</span>
            </div>
          </div>
        </div>
      </div>

      {/* 2. LOWER SECTION: BUDGET LIMIT CONFIGURATOR & EVERON LABS DYNAMIC SUPPORT */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Cols: Budget Limit Editor & Recent Billable Logs */}
        <div className="lg:col-span-2 space-y-6">
          {/* Budget Limit Form */}
          <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <span>⚙️</span>
              <span>Monthly WhatsApp Budget Threshold</span>
            </h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Set a monthly spending milestone. StorePing will automatically notify you when your message spend reaches 50%, 80%, and 100% of this limit.
            </p>

            <Form method="post" className="flex items-center gap-3 pt-2">
              <input type="hidden" name="intent" value="update_budget_limit" />
              <div className="relative w-48">
                <span className="absolute left-3 top-2 text-xs font-mono text-slate-500">
                  {currencySymbol}
                </span>
                <input
                  type="number"
                  step="50"
                  name="monthlyBudgetLimit"
                  defaultValue={billingSummary.monthlyBudgetLimit}
                  className="w-full pl-7 pr-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white font-mono focus:outline-none focus:border-slate-600"
                />
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-white border border-slate-700 rounded-lg text-xs font-medium transition"
              >
                {isSubmitting ? "Saving..." : "Save Limit"}
              </button>
            </Form>
          </div>

          {/* Recent Billable Messages Table */}
          <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <span>📋</span>
                <span>Recent Billable WhatsApp Deliveries</span>
              </h3>
              <span className="text-xs text-slate-400 font-mono">
                {billingSummary.recentBillableLogs.length} Records
              </span>
            </div>

            {billingSummary.recentBillableLogs.length === 0 ? (
              <div className="p-8 text-center bg-slate-950 rounded-xl border border-slate-800 text-xs text-slate-500">
                No message deliveries recorded yet for this billing cycle.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400 font-medium">
                      <th className="pb-2">Timestamp</th>
                      <th className="pb-2">Event Flow</th>
                      <th className="pb-2">Category</th>
                      <th className="pb-2">Status</th>
                      <th className="pb-2 text-right">Est. Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
                    {billingSummary.recentBillableLogs.map((log) => (
                      <tr key={log.id} className="hover:bg-slate-800/30 transition">
                        <td className="py-2.5 text-slate-400">
                          {new Date(log.createdAt).toLocaleDateString()}{" "}
                          <span className="text-slate-500">
                            {new Date(log.createdAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        </td>
                        <td className="py-2.5 font-sans text-slate-200">{log.eventType}</td>
                        <td className="py-2.5">
                          <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300 border border-slate-700">
                            {log.pricingCategory || "UTILITY"}
                          </span>
                        </td>
                        <td className="py-2.5">
                          <span className="text-emerald-400 font-semibold">{log.status}</span>
                        </td>
                        <td className="py-2.5 text-right font-bold text-white">
                          {log.isBillable ? `${currencySymbol}${log.estimatedCost.toFixed(2)}` : "FREE"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Right Col: DYNAMIC EVERON LABS DEDICATED SUPPORT CARD */}
        <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-4 h-fit">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center text-lg shrink-0">
              🏢
            </div>
            <div>
              <div className="text-sm font-bold text-white">Everon Labs Support</div>
              <div className="text-[10px] text-slate-400 font-medium">Billing & Technical Assistance</div>
            </div>
          </div>

          <div className="pt-3 border-t border-slate-800/80 space-y-2.5 text-xs">
            <div>
              <div className="text-[10px] text-slate-500 uppercase font-bold">Billing Support Email</div>
              <a
                href={`mailto:${platformSettings.supportEmail}`}
                className="text-white hover:text-emerald-400 font-medium transition"
              >
                {platformSettings.supportEmail}
              </a>
            </div>

            <div>
              <div className="text-[10px] text-slate-500 uppercase font-bold">Direct Phone Number</div>
              <div className="text-slate-200 font-mono">{platformSettings.supportPhone}</div>
            </div>

            <div>
              <div className="text-[10px] text-slate-500 uppercase font-bold">Support Hours</div>
              <div className="text-slate-300 text-[11px] leading-relaxed">{platformSettings.supportHours}</div>
            </div>
          </div>

          <div className="pt-3 border-t border-slate-800/80 space-y-2">
            <a
              href={`https://wa.me/${platformSettings.supportWhatsApp}?text=Hello%20Everon%20Labs%20Team%2C%20I%20need%20help%20with%20StorePing%20Billing%20for%20${merchant?.shop}`}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-xl text-xs transition flex items-center justify-center gap-1.5 shadow-sm"
            >
              <span>💬</span>
              <span>Chat with Support on WhatsApp</span>
            </a>

            <a
              href={`mailto:${platformSettings.supportEmail}?subject=StorePing%20Billing%20Assistance%20-%20${merchant?.shop}`}
              className="w-full py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-xl text-xs font-medium transition flex items-center justify-center gap-1.5"
            >
              <span>✉️</span>
              <span>Email Support Team</span>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
