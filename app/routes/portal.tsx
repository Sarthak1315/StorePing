import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Link, NavLink, Outlet, useLoaderData, useLocation, Form } from "@remix-run/react";
import { requirePortalUser } from "../utils/portal-auth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requirePortalUser(request);
  return json({ user });
}

export default function PortalLayout() {
  const { user } = useLoaderData<typeof loader>();
  const location = useLocation();

  const isAgent = user.role === "AGENT";
  const isOwnerOrAdmin = user.role === "OWNER" || user.role === "MANAGER";

  const navigation = [
    ...(isOwnerOrAdmin
      ? [
          {
            name: "Dashboard",
            href: "/portal/dashboard",
            icon: "📊",
            badge: null,
          },
        ]
      : []),
    {
      name: "Live Inbox",
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
            badge: user.role,
          },
        ]
      : []),
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col md:flex-row font-sans selection:bg-emerald-500 selection:text-white">
      {/* Left Sidebar */}
      <aside className="w-full md:w-64 bg-slate-900/90 border-r border-slate-800/80 flex flex-col justify-between backdrop-blur-xl shrink-0">
        <div>
          {/* Brand Header */}
          <div className="p-5 border-b border-slate-800/70 flex items-center justify-between">
            <Link to="/portal/dashboard" className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center text-xl shadow-lg shadow-emerald-500/20 font-bold text-slate-950">
                💬
              </div>
              <div>
                <div className="font-bold text-base tracking-tight bg-gradient-to-r from-white via-slate-100 to-slate-300 bg-clip-text text-transparent">
                  StorePing
                </div>
                <div className="text-[11px] text-emerald-400 font-medium">
                  Portal & Inbox
                </div>
              </div>
            </Link>
          </div>

          {/* Connected WhatsApp Account Status Pill */}
          <div className="px-4 py-3 border-b border-slate-800/50 bg-slate-950/40">
            <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold mb-1">
              Store Organization
            </div>
            <div className="flex items-center justify-between">
              <div className="truncate text-xs font-semibold text-slate-200">
                {user.merchant.shop}
              </div>
              <span
                className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                  user.merchant.isWhatsAppConnected
                    ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                    : "bg-amber-500/10 text-amber-400 border border-amber-500/30"
                }`}
              >
                {user.merchant.isWhatsAppConnected ? "● Live" : "○ Disconnected"}
              </span>
            </div>
            {user.merchant.displayPhoneNumber && (
              <div className="text-[11px] text-slate-400 mt-1 font-mono">
                {user.merchant.displayPhoneNumber}
              </div>
            )}
          </div>

          {/* Navigation Links */}
          <nav className="p-3 space-y-1.5">
            <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              Workspace
            </div>
            {navigation.map((item) => {
              const isActive = location.pathname.startsWith(item.href);
              return (
                <NavLink
                  key={item.name}
                  to={item.href}
                  className={`flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all ${
                    isActive
                      ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shadow-sm"
                      : "text-slate-300 hover:bg-slate-800/60 hover:text-white"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className="text-base">{item.icon}</span>
                    <span>{item.name}</span>
                  </div>
                  {item.badge && (
                    <span className="text-[10px] bg-slate-800 text-slate-400 border border-slate-700/60 px-2 py-0.5 rounded-md font-mono">
                      {item.badge}
                    </span>
                  )}
                </NavLink>
              );
            })}
          </nav>
        </div>

        {/* User Profile & Logout Bottom Box */}
        <div className="p-4 border-t border-slate-800/70 bg-slate-900/60">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2.5 truncate">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-emerald-400 to-teal-600 flex items-center justify-center font-bold text-xs text-slate-950 shrink-0">
                {user.name.slice(0, 2).toUpperCase()}
              </div>
              <div className="truncate">
                <div className="text-xs font-semibold text-white truncate">
                  {user.name}
                </div>
                <div className="text-[10px] text-emerald-400 font-mono">
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

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-w-0 bg-slate-950 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
