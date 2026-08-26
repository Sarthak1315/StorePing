import type { MetaFunction } from "@remix-run/node";

export const meta: MetaFunction = () => {
  return [
    { title: "Terms of Service - StorePing WhatsApp Automation" },
    { name: "description", content: "StorePing Terms of Service for Shopify Merchants using Meta WhatsApp Cloud API." },
  ];
};

export default function TermsOfServicePage() {
  return (
    <div style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif", color: "#1e293b", background: "#f8fafc", minHeight: "100vh", padding: "40px 20px" }}>
      <div style={{ maxWidth: "800px", margin: "0 auto", background: "#ffffff", padding: "48px", borderRadius: "16px", boxShadow: "0 4px 6px -1px rgba(0,0,0,0.05), 0 2px 4px -2px rgba(0,0,0,0.05)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "24px" }}>
          <span style={{ fontSize: "28px" }}>📜</span>
          <h1 style={{ fontSize: "28px", fontWeight: "700", margin: 0, color: "#0f172a" }}>StorePing — Terms of Service</h1>
        </div>
        <p style={{ color: "#64748b", fontSize: "14px", marginBottom: "32px" }}>Last Updated: August 26, 2026 • Effective Date: January 1, 2026</p>

        <section style={{ marginBottom: "28px" }}>
          <h2 style={{ fontSize: "18px", fontWeight: "600", color: "#0f172a", marginBottom: "12px" }}>1. Acceptance of Terms</h2>
          <p style={{ lineHeight: "1.6", color: "#334155" }}>
            By installing or using StorePing ("Service"), you agree to be bound by these Terms of Service. If you do not agree to these terms, do not install or use the Service.
          </p>
        </section>

        <section style={{ marginBottom: "28px" }}>
          <h2 style={{ fontSize: "18px", fontWeight: "600", color: "#0f172a", marginBottom: "12px" }}>2. WhatsApp Business Policy Compliance</h2>
          <p style={{ lineHeight: "1.6", color: "#334155" }}>
            StorePing connects with Meta's WhatsApp Business Cloud API. Merchants using the Service must strictly adhere to:
          </p>
          <ul style={{ lineHeight: "1.7", color: "#334155", paddingLeft: "20px" }}>
            <li>WhatsApp Business Messaging Policy and Commerce Policy.</li>
            <li>Obtaining proper opt-in consent from customers before sending marketing notifications.</li>
            <li>Honoring customer opt-out requests (e.g. <code>STOP</code>).</li>
          </ul>
        </section>

        <section style={{ marginBottom: "28px" }}>
          <h2 style={{ fontSize: "18px", fontWeight: "600", color: "#0f172a", marginBottom: "12px" }}>3. Service Availability & Limitations</h2>
          <p style={{ lineHeight: "1.6", color: "#334155" }}>
            While we strive for 99.9% uptime, message delivery is subject to Meta WhatsApp Cloud API network availability, rate limits, and merchant account quality tiers.
          </p>
        </section>

        <section style={{ marginBottom: "28px" }}>
          <h2 style={{ fontSize: "18px", fontWeight: "600", color: "#0f172a", marginBottom: "12px" }}>4. Termination</h2>
          <p style={{ lineHeight: "1.6", color: "#334155" }}>
            You may terminate your use of StorePing at any time by uninstalling the application from your Shopify store. We reserve the right to suspend access to any user who violates WhatsApp anti-spam policies.
          </p>
        </section>

        <section style={{ marginBottom: "28px" }}>
          <h2 style={{ fontSize: "18px", fontWeight: "600", color: "#0f172a", marginBottom: "12px" }}>5. Contact Us</h2>
          <div style={{ background: "#f1f5f9", padding: "16px", borderRadius: "8px", fontSize: "14px", marginTop: "10px" }}>
            <strong>Everon Lab — StorePing Support</strong><br />
            Email: <a href="mailto:sarthakpatel1315@gmail.com" style={{ color: "#2563eb" }}>sarthakpatel1315@gmail.com</a><br />
            Website: <a href="https://everonlab.in" target="_blank" rel="noreferrer" style={{ color: "#2563eb" }}>https://everonlab.in</a>
          </div>
        </section>
      </div>
    </div>
  );
}
