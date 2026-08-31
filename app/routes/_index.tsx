import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { useState } from "react";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (shop) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { isConfigured: true };
};

export default function LandingAndLoginPage() {
  const [shopDomain, setShopDomain] = useState("");

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    let cleanDomain = shopDomain.trim().toLowerCase();
    if (!cleanDomain) {
      e.preventDefault();
      return;
    }
    if (!cleanDomain.includes(".myshopify.com") && !cleanDomain.includes(".")) {
      cleanDomain = `${cleanDomain}.myshopify.com`;
      setShopDomain(cleanDomain);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-emerald-950 to-slate-950 text-white flex flex-col justify-between font-sans selection:bg-emerald-500 selection:text-white">
      {/* Top Navbar */}
      <header className="border-b border-emerald-800/40 backdrop-blur-md bg-slate-900/60 sticky top-0 z-50 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center shadow-lg shadow-emerald-500/20 text-2xl">
              💬
            </div>
            <div>
              <span className="text-xl font-bold tracking-tight bg-gradient-to-r from-white via-emerald-100 to-teal-200 bg-clip-text text-transparent">
                StorePing
              </span>
              <span className="ml-2 text-xs bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2 py-0.5 rounded-full font-medium">
                WhatsApp Automation
              </span>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <Link
              to="/portal/login"
              className="text-sm font-semibold text-emerald-400 hover:text-emerald-300 transition px-3 py-1.5 rounded-lg border border-emerald-500/30 hover:bg-emerald-500/10 flex items-center gap-1.5"
            >
              <span>🔑</span>
              <span>Portal & Inbox Login</span>
            </Link>
            <a
              href="#install"
              className="text-sm font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-950 px-4 py-2 rounded-lg transition shadow-md shadow-emerald-500/20"
            >
              Install on Shopify
            </a>
          </div>
        </div>
      </header>

      {/* Main Hero Section */}
      <main className="flex-1 max-w-7xl mx-auto px-6 py-12 lg:py-16 grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
        {/* Left Column: Value Prop & Login Form */}
        <div className="lg:col-span-7 space-y-8">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-semibold uppercase tracking-wider">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            Meta Cloud API & WhatsApp Embedded Signup
          </div>

          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight leading-[1.15]">
            Recover Lost Carts & Boost Sales with{" "}
            <span className="bg-gradient-to-r from-emerald-400 via-teal-300 to-cyan-400 bg-clip-text text-transparent">
              Automated WhatsApp
            </span>
          </h1>

          <p className="text-slate-300 text-lg sm:text-xl max-w-2xl leading-relaxed">
            Connect your Meta Business WhatsApp in 1 click. Automatically send high-converting abandoned cart reminders, instant order confirmations, live shipping tracking, and customer win-backs.
          </p>

          {/* Shop Install Form */}
          <div
            id="install"
            className="bg-slate-900/80 border border-emerald-500/30 rounded-2xl p-6 shadow-2xl backdrop-blur-md max-w-xl"
          >
            <h2 className="text-lg font-semibold text-white mb-2 flex items-center gap-2">
              <span>🛍️</span> Connect Your Shopify Store
            </h2>
            <p className="text-xs text-slate-400 mb-4">
              Enter your store domain to install StorePing or log into your dashboard:
            </p>

            <Form
              method="post"
              action="/auth/login"
              onSubmit={handleSubmit}
              className="space-y-3"
            >
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="relative flex-1">
                  <input
                    type="text"
                    name="shop"
                    value={shopDomain}
                    onChange={(e) => setShopDomain(e.target.value)}
                    placeholder="your-store-name.myshopify.com"
                    required
                    className="w-full bg-slate-800/90 border border-slate-700 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/20 text-white placeholder-slate-500 text-sm rounded-xl px-4 py-3.5 outline-none transition"
                  />
                </div>
                <button
                  type="submit"
                  className="bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-bold text-sm px-6 py-3.5 rounded-xl transition shadow-lg shadow-emerald-500/25 flex items-center justify-center gap-2 shrink-0 cursor-pointer"
                >
                  <span>Install / Log In</span>
                  <span>→</span>
                </button>
              </div>
              <p className="text-[11px] text-slate-400">
                Example: <span className="text-emerald-400 font-mono">satjewells-2.myshopify.com</span>
              </p>
            </Form>
          </div>

          {/* Key Feature Highlights */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 pt-2">
            <div className="flex items-center gap-2.5 text-sm text-slate-300">
              <span className="text-emerald-400 text-base">✓</span>
              <span>1-Click Meta Signup</span>
            </div>
            <div className="flex items-center gap-2.5 text-sm text-slate-300">
              <span className="text-emerald-400 text-base">✓</span>
              <span>Cancel-on-Purchase</span>
            </div>
            <div className="flex items-center gap-2.5 text-sm text-slate-300">
              <span className="text-emerald-400 text-base">✓</span>
              <span>DPDP Act 2023 Ready</span>
            </div>
            <div className="flex items-center gap-2.5 text-sm text-slate-300">
              <span className="text-emerald-400 text-base">✓</span>
              <span>Visual Template Studio</span>
            </div>
            <div className="flex items-center gap-2.5 text-sm text-slate-300">
              <span className="text-emerald-400 text-base">✓</span>
              <span>Live Limit Alerts</span>
            </div>
            <div className="flex items-center gap-2.5 text-sm text-slate-300">
              <span className="text-emerald-400 text-base">✓</span>
              <span>Zero-Cost Queue Engine</span>
            </div>
          </div>
        </div>

        {/* Right Column: Live Phone Mockup Preview */}
        <div className="lg:col-span-5 flex justify-center">
          <div className="w-full max-w-[340px] bg-slate-950 border-[6px] border-slate-800 rounded-[40px] shadow-2xl p-3 relative overflow-hidden ring-1 ring-emerald-500/20">
            {/* Phone Speaker Notch */}
            <div className="w-24 h-4 bg-slate-800 rounded-full mx-auto mb-3"></div>

            {/* WhatsApp App Header */}
            <div className="bg-[#075E54] text-white p-3 rounded-t-2xl flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-emerald-500 flex items-center justify-center font-bold text-xs">
                  SP
                </div>
                <div>
                  <div className="text-xs font-bold flex items-center gap-1">
                    StorePing Bot
                    <span className="text-[10px] bg-emerald-400 text-slate-950 rounded-full px-1">✓</span>
                  </div>
                  <div className="text-[10px] text-emerald-200">Official Business Account</div>
                </div>
              </div>
              <span className="text-xs opacity-70">12:45 PM</span>
            </div>

            {/* WhatsApp Chat Background */}
            <div className="bg-[#0c141a] p-3 min-h-[380px] rounded-b-2xl flex flex-col justify-end space-y-3 text-xs">
              {/* Message Bubble */}
              <div className="bg-[#005c4b] text-white p-3 rounded-2xl rounded-tl-none shadow-md space-y-2 max-w-[90%] self-start border border-emerald-400/20">
                <div className="font-bold text-emerald-300 text-xs">
                  🛍️ Complete Your Order!
                </div>
                <p className="text-[11px] leading-relaxed text-slate-100">
                  Hi Sarthak! 👋 You left items in your cart. Your cart is reserved for the next 2 hours!
                </p>
                <div className="bg-emerald-950/60 p-2 rounded-lg border border-emerald-500/20 text-[10px] text-slate-200">
                  <div className="font-semibold">Gold Plated Diamond Ring</div>
                  <div className="text-emerald-400 font-bold">Total: ₹2,499 (10% Off Applied)</div>
                </div>
                <div className="flex items-center justify-between pt-1 border-t border-emerald-400/20 text-[9px] text-emerald-200">
                  <span>Reply STOP to opt-out</span>
                  <span>12:45 PM ✓✓</span>
                </div>
              </div>

              {/* Action Button */}
              <div className="bg-[#1f2c34] hover:bg-[#2a3942] text-emerald-400 font-bold p-2.5 rounded-xl text-center text-xs shadow cursor-pointer border border-emerald-500/30 flex items-center justify-center gap-1.5 transition">
                <span>🛒 Checkout Now (10% Off)</span>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800 bg-slate-950/80 px-6 py-6 text-center text-xs text-slate-500">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <p>© 2026 StorePing. Built for high-growth Shopify Merchants.</p>
          <div className="flex gap-6">
            <a href="/app/privacy" className="hover:text-emerald-400 transition">
              DPDP Privacy Policy
            </a>
            <a href="https://shopify.com" target="_blank" rel="noreferrer" className="hover:text-emerald-400 transition">
              Shopify Partners
            </a>
            <a href="https://developers.facebook.com" target="_blank" rel="noreferrer" className="hover:text-emerald-400 transition">
              Meta Business Platform
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
