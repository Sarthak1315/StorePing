import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Link, NavLink, Outlet, useLoaderData, useLocation, Form } from "@remix-run/react";
import { requirePortalUser } from "../utils/portal-auth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  if (url.pathname.endsWith("/login")) {
    return json({ user: null });
  }
  const user = await requirePortalUser(request);
  return json({ user });
}

export default function PortalLayout() {
  const { user } = useLoaderData<typeof loader>();
  const location = useLocation();

  if (!user) {
    return <Outlet />;
  }

  const isSuperAdmin = user.role === "SUPER_ADMIN";
  const isOwnerOrAdmin = user.role === "OWNER" || user.role === "MANAGER" || isSuperAdmin;

  const navigation = [
    ...(isSuperAdmin
      ? [
          {
            name: "Platform Governance",
            href: "/portal/admin",
            icon: "👑",
            badge: "Approvals",
          },
        ]
      : []),
    ...(isOwnerOrAdmin
      ? [
          {
            name: "Store Operations",
            href: "/portal/dashboard",
            icon: "📊",
            badge: null,
          },
        ]
      : []),
    {
      name: "Live Support Inbox",
      href: "/portal/inbox",
      icon: "💬",
      badge: "2-Way",
    },
    ...(isOwnerOrAdmin
      ? [
          {
            name: "Team & Roles",
            href: "/portal/team",
            icon: "👥",
            badge: user.role === "SUPER_ADMIN" ? "Admin" : user.role,
          },
        ]
      : []),
  ];

  return (
    <div className="h-screen w-screen overflow-hidden bg-slate-950 text-slate-100 flex flex-col md:flex-row font-sans selection:bg-emerald-500 selection:text-white">
      {/* Left Sidebar - Fixed Width (w-68/w-72) & Full Height */}
      <aside className="w-full md:w-68 lg:w-72 bg-slate-900 border-r border-slate-800 flex flex-col justify-between shrink-0 h-full overflow-y-auto">
        <div className="flex-1 flex flex-col min-h-0">
          {/* Brand Header */}
          <div className="p-4 lg:p-5 border-b border-slate-800/80 flex items-center justify-between shrink-0">
            <Link to="/portal/dashboard" className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center text-lg shadow-lg shadow-emerald-500/20 font-bold text-slate-950 shrink-0">
                💬
              </div>
              <div>
                <div className="font-bold text-base tracking-tight bg-gradient-to-r from-white via-slate-100 to-slate-300 bg-clip-text text-transparent">
                  StorePing
                </div>
                <div className="text-[10px] text-emerald-400 font-medium">
                  Portal & Inbox
                </div>
              </div>
            </Link>
          </div>

          {/* Connected WhatsApp Account Status Pill */}
          <div className="px-4 py-3 border-b border-slate-800/80 bg-slate-950/50 shrink-0">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-400 font-bold mb-1.5">
              <span>Store Organization</span>
              {user.role === "SUPER_ADMIN" && (
                <span className="text-[9px] bg-purple-500/20 text-purple-300 px-1.5 py-0.5 rounded font-bold border border-purple-500/30">
                  SUPER ADMIN
                </span>
              )}
            </div>

            {/* Store Switcher for Super Admin */}
            {user.role === "SUPER_ADMIN" && user.allMerchants && user.allMerchants.length > 1 ? (
              <div className="mt-1 mb-1.5">
                <select
                  value={user.merchant.shop}
                  onChange={(e) => {
                    window.location.href = `${location.pathname}?shop=${e.target.value}`;
                  }}
                  className="w-full px-2 py-1.5 bg-slate-900 border border-purple-500/40 rounded-lg text-xs font-semibold text-purple-200 focus:outline-none focus:ring-1 focus:ring-purple-400 cursor-pointer"
                >
                  {user.allMerchants.map((m) => (
                    <option key={m.id} value={m.shop}>
                      🏬 {m.shop}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <div className="truncate text-xs font-semibold text-slate-200" title={user.merchant.shop}>
                  {user.merchant.shop}
                </div>
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold shrink-0 ${
                    user.merchant.isWhatsAppConnected
                      ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                      : "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                  }`}
                >
                  {user.merchant.isWhatsAppConnected ? "● Live" : "○ Disconnected"}
                </span>
              </div>
            )}

            {user.merchant.displayPhoneNumber && (
              <div className="text-[11px] text-slate-400 mt-1 font-mono tracking-tight">
                {user.merchant.displayPhoneNumber}
              </div>
            )}
          </div>

          {/* Navigation Links */}
          <nav className="p-3 space-y-1 overflow-y-auto flex-1">
            <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Workspace
            </div>
            {navigation.map((item) => {
              const isActive = location.pathname.startsWith(item.href);
              return (
                <NavLink
                  key={item.name}
                  to={item.href}
                  className={`flex items-center justify-between px-3 py-2 rounded-xl text-xs font-semibold transition-all ${
                    isActive
                      ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shadow-sm"
                      : "text-slate-300 hover:bg-slate-800/60 hover:text-white"
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-base">{item.icon}</span>
                    <span>{item.name}</span>
                  </div>
                  {item.badge && (
                    <span className="text-[9px] bg-slate-800 text-slate-400 border border-slate-700/60 px-1.5 py-0.5 rounded font-mono">
                      {item.badge}
                    </span>
                  )}
                </NavLink>
              );
            })}
          </nav>
        </div>

        {/* User Profile & Logout Bottom Box */}
        <div className="p-3.5 border-t border-slate-800/80 bg-slate-950/60 shrink-0">
          <div className="flex items-center justify-between mb-2.5">
            <div className="flex items-center gap-2.5 truncate">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-emerald-400 to-teal-600 flex items-center justify-center font-bold text-xs text-slate-950 shrink-0">
                {user.name.slice(0, 2).toUpperCase()}
              </div>
              <div className="truncate">
                <div className="text-xs font-semibold text-white truncate">
                  {user.name}
                </div>
                <div className="text-[10px] text-emerald-400 font-mono font-medium">
                  {user.role}
                </div>
              </div>
            </div>
          </div>

          <Form method="post" action="/portal/logout">
            <button
              type="submit"
              className="w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-red-400 hover:bg-red-500/10 border border-slate-800 hover:border-red-500/30 transition-all"
            >
              <span>🚪</span> Sign Out
            </button>
          </Form>
        </div>
      </aside>

      {/* Main Content Area - Full Height without outer overflow */}
      <main className="flex-1 flex flex-col min-w-0 bg-slate-950 h-full overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
