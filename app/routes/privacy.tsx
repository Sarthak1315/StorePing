import type { MetaFunction } from "@remix-run/node";

export const meta: MetaFunction = () => {
  return [
    { title: "Privacy Policy - StorePing WhatsApp Automation" },
    { name: "description", content: "StorePing Privacy Policy compliant with Meta Platform Terms, GDPR, and DPDP Act 2023." },
  ];
};

export default function PrivacyPolicyPage() {
  return (
    <div style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif", color: "#1e293b", background: "#f8fafc", minHeight: "100vh", padding: "40px 20px" }}>
      <div style={{ maxWidth: "800px", margin: "0 auto", background: "#ffffff", padding: "48px", borderRadius: "16px", boxShadow: "0 4px 6px -1px rgba(0,0,0,0.05), 0 2px 4px -2px rgba(0,0,0,0.05)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "24px" }}>
          <span style={{ fontSize: "28px" }}>🔔</span>
          <h1 style={{ fontSize: "28px", fontWeight: "700", margin: 0, color: "#0f172a" }}>StorePing — Privacy Policy</h1>
        </div>
        <p style={{ color: "#64748b", fontSize: "14px", marginBottom: "32px" }}>Last Updated: August 26, 2026 • Effective Date: January 1, 2026</p>

        <section style={{ marginBottom: "28px" }}>
          <h2 style={{ fontSize: "18px", fontWeight: "600", color: "#0f172a", marginBottom: "12px" }}>1. Introduction & Scope</h2>
          <p style={{ lineHeight: "1.6", color: "#334155" }}>
            StorePing ("we", "our", or "us"), provided by Everon Lab, is a Shopify application enabling e-commerce merchants to send transactional notifications and provide customer support via the Meta WhatsApp Cloud API. This Privacy Policy describes how we collect, process, protect, and delete personal data in compliance with Meta Platform Terms, the European General Data Protection Regulation (GDPR), and India's Digital Personal Data Protection (DPDP) Act 2023.
          </p>
        </section>

        <section style={{ marginBottom: "28px" }}>
          <h2 style={{ fontSize: "18px", fontWeight: "600", color: "#0f172a", marginBottom: "12px" }}>2. Data We Collect and Process</h2>
          <ul style={{ lineHeight: "1.7", color: "#334155", paddingLeft: "20px" }}>
            <li><strong>Merchant Information:</strong> Store name, shop domain, merchant contact email, and Meta WhatsApp Cloud API credentials (encrypted with AES-256-GCM).</li>
            <li><strong>Transactional & Order Data:</strong> Customer phone numbers, customer names, order IDs, order items, abandoned checkout details, and delivery tracking numbers strictly required for notification delivery.</li>
            <li><strong>Live Chat Messages:</strong> Customer inbound queries and merchant staff replies transmitted via WhatsApp Business Cloud API.</li>
          </ul>
        </section>

        <section style={{ marginBottom: "28px" }}>
          <h2 style={{ fontSize: "18px", fontWeight: "600", color: "#0f172a", marginBottom: "12px" }}>3. How We Use Data</h2>
          <p style={{ lineHeight: "1.6", color: "#334155" }}>
            We only process customer data for:
          </p>
          <ul style={{ lineHeight: "1.7", color: "#334155", paddingLeft: "20px" }}>
            <li>Sending merchant-authorized transactional WhatsApp messages (Order Confirmation, Shipping Updates, Delivery Alerts, Abandoned Cart Recovery).</li>
            <li>Providing the 2-way Support Inbox inside Shopify Admin.</li>
            <li>Tracking delivery receipts (sent, delivered, read) to monitor account messaging quality.</li>
          </ul>
          <p style={{ lineHeight: "1.6", color: "#334155", marginTop: "10px" }}>
            <strong>We NEVER sell, rent, or monetize your customer data or use it for third-party advertising.</strong>
          </p>
        </section>

        <section style={{ marginBottom: "28px" }}>
          <h2 style={{ fontSize: "18px", fontWeight: "600", color: "#0f172a", marginBottom: "12px" }}>4. Data Security & Encryption</h2>
          <p style={{ lineHeight: "1.6", color: "#334155" }}>
            All WhatsApp Access Tokens and sensitive credentials are encrypted at rest using industry-standard AES-256-GCM encryption. All communications between Shopify, our servers, and Meta Cloud API occur strictly over HTTPS/TLS 1.3.
          </p>
        </section>

        <section style={{ marginBottom: "28px" }}>
          <h2 style={{ fontSize: "18px", fontWeight: "600", color: "#0f172a", marginBottom: "12px" }}>5. User Data Deletion & Opt-Out</h2>
          <p style={{ lineHeight: "1.6", color: "#334155" }}>
            Customers can opt out of WhatsApp communications at any time by replying <code>STOP</code> or <code>UNSUBSCRIBE</code>.
          </p>
          <p style={{ lineHeight: "1.6", color: "#334155" }}>
            In accordance with Meta Platform Terms, merchants or users can request immediate data deletion via our automated endpoint:
            <br />
            <code>https://storeping.everonlab.in/api/meta/data-deletion</code>
          </p>
        </section>

        <section style={{ marginBottom: "28px" }}>
          <h2 style={{ fontSize: "18px", fontWeight: "600", color: "#0f172a", marginBottom: "12px" }}>6. Contact & Grievance Officer</h2>
          <p style={{ lineHeight: "1.6", color: "#334155" }}>
            For privacy inquiries, GDPR rights, or DPDP compliance requests, please contact our Data Protection Officer:
          </p>
          <div style={{ background: "#f1f5f9", padding: "16px", borderRadius: "8px", fontSize: "14px", marginTop: "10px" }}>
            <strong>StorePing Data Protection Officer</strong><br />
            Everon Lab<br />
            Email: <a href="mailto:sarthakpatel1315@gmail.com" style={{ color: "#2563eb" }}>sarthakpatel1315@gmail.com</a><br />
            Website: <a href="https://everonlab.in" target="_blank" rel="noreferrer" style={{ color: "#2563eb" }}>https://everonlab.in</a>
          </div>
        </section>
      </div>
    </div>
  );
}
