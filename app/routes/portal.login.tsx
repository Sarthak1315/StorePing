import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import db from "../db.server";
import {
  createPortalSession,
  getPortalUser,
  hashPassword,
  verifyPassword,
} from "../utils/portal-auth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await getPortalUser(request);
  if (user) {
    return redirect("/portal/dashboard");
  }

  // Count registered merchants to provide onboarding guidance
  const merchants = await db.merchant.findMany({
    select: { id: true, shop: true, name: true },
    take: 5,
  });

  return json({
    hasMerchants: merchants.length > 0,
    merchants,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = formData.get("intent");
  const email = (formData.get("email") as string)?.toLowerCase().trim();
  const password = formData.get("password") as string;
  const returnTo = (formData.get("returnTo") as string) || "/portal/dashboard";

  // Intent 1: Regular Email/Password Login
  if (intent === "login") {
    if (!email || !password) {
      return json({ error: "Please provide both email and password." }, { status: 400 });
    }

    const user = await db.user.findUnique({
      where: { email },
      include: { merchant: true },
    });

    if (!user || !user.isActive) {
      return json({ error: "Invalid email or password." }, { status: 401 });
    }

    const isValid = verifyPassword(password, user.passwordHash);
    if (!isValid) {
      return json({ error: "Invalid email or password." }, { status: 401 });
    }

    // Update last login timestamp
    await db.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const targetUrl = user.role === "AGENT" ? "/portal/inbox" : returnTo;
    return createPortalSession(user.id, targetUrl);
  }

  // Intent 2: First-Time Store Owner Setup (Linking an existing Merchant to a User login)
  if (intent === "claim_store") {
    const shop = (formData.get("shop") as string)?.trim();
    const name = (formData.get("name") as string)?.trim() || "Store Admin";

    if (!shop || !email || !password) {
      return json({ error: "All fields are required to setup the store admin account." }, { status: 400 });
    }

    if (password.length < 6) {
      return json({ error: "Password must be at least 6 characters long." }, { status: 400 });
    }

    // Find the installed merchant record
    const merchant = await db.merchant.findUnique({
      where: { shop },
    });

    if (!merchant) {
      return json(
        {
          error: `Store "${shop}" was not found. Please install StorePing on your Shopify store first.`,
        },
        { status: 404 }
      );
    }

    // Check if an account already exists for this email
    const existingUser = await db.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return json(
        {
          error: "An account with this email already exists. Please log in directly.",
        },
        { status: 400 }
      );
    }

    // Create OWNER user
    const newUser = await db.user.create({
      data: {
        merchantId: merchant.id,
        email,
        name,
        role: "OWNER",
        passwordHash: hashPassword(password),
        lastLoginAt: new Date(),
      },
    });

    return createPortalSession(newUser.id, "/portal/dashboard");
  }

  return json({ error: "Invalid form submission." }, { status: 400 });
}

export default function PortalLoginPage() {
  const { hasMerchants, merchants } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-emerald-950 flex flex-col justify-center items-center px-4 py-12 selection:bg-emerald-500 selection:text-white">
      {/* Container Box */}
      <div className="w-full max-w-md">
        {/* Logo and Brand */}
        <div className="text-center mb-8">
          <Link to="/" className="inline-flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center text-2xl shadow-xl shadow-emerald-500/20 font-bold text-slate-950">
              💬
            </div>
          </Link>
          <h1 className="mt-4 text-3xl font-extrabold text-white tracking-tight">
            StorePing Portal
          </h1>
          <p className="text-sm text-slate-400 mt-2">
            Sign in to manage WhatsApp Automations & Live Support Inbox
          </p>
        </div>

        {/* Card Box */}
        <div className="bg-slate-900/90 border border-slate-800/80 rounded-2xl p-8 backdrop-blur-xl shadow-2xl shadow-black/50">
          {actionData?.error && (
            <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs font-medium flex items-center gap-3">
              <span>⚠️</span>
              <span>{actionData.error}</span>
            </div>
          )}

          <Form method="post" className="space-y-5">
            <input type="hidden" name="intent" value="login" />

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-2">
                Work Email Address
              </label>
              <input
                type="email"
                name="email"
                required
                placeholder="agent@yourbrand.com"
                className="w-full px-4 py-3 bg-slate-950/80 border border-slate-700/70 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300">
                  Password
                </label>
              </div>
              <input
                type="password"
                name="password"
                required
                placeholder="••••••••••••"
                className="w-full px-4 py-3 bg-slate-950/80 border border-slate-700/70 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
              />
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full py-3.5 px-4 bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-bold rounded-xl shadow-lg shadow-emerald-500/25 transition-all text-sm flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {isSubmitting ? "Authenticating..." : "Sign In to Portal"}
            </button>
          </Form>

          {/* Quick First-Time Owner Setup Helper */}
          {hasMerchants && (
            <div className="mt-8 pt-6 border-t border-slate-800/80">
              <details className="group cursor-pointer">
                <summary className="text-xs text-emerald-400 hover:text-emerald-300 font-medium flex items-center justify-between list-none">
                  <span>⚙️ First time? Claim / Setup Store Admin</span>
                  <span className="text-slate-500 group-open:rotate-180 transition-transform">
                    ▼
                  </span>
                </summary>

                <Form method="post" className="mt-4 space-y-4 pt-2">
                  <input type="hidden" name="intent" value="claim_store" />

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                      Select Shopify Store
                    </label>
                    <select
                      name="shop"
                      required
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-xs text-white"
                    >
                      {merchants.map((m) => (
                        <option key={m.id} value={m.shop}>
                          {m.shop} {m.name ? `(${m.name})` : ""}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                      Your Full Name
                    </label>
                    <input
                      type="text"
                      name="name"
                      required
                      placeholder="e.g. Sarthak Patel"
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-xs text-white"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                      Admin Email
                    </label>
                    <input
                      type="email"
                      name="email"
                      required
                      placeholder="admin@brand.com"
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-xs text-white"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                      Set New Password
                    </label>
                    <input
                      type="password"
                      name="password"
                      required
                      minLength={6}
                      placeholder="Min 6 characters"
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-xs text-white"
                    />
                  </div>

                  <button
                    type="submit"
                    className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-emerald-400 border border-emerald-500/30 font-semibold rounded-lg text-xs transition"
                  >
                    Create & Login as Store Owner
                  </button>
                </Form>
              </details>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="mt-8 text-center text-xs text-slate-500">
          Powered by Everon Labs • Meta Cloud API Partner
        </div>
      </div>
    </div>
  );
}
