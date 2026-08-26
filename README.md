# 📱 StorePing — Automated WhatsApp Marketing & Order Notification Platform for Shopify

**StorePing** is a high-performance Shopify embedded application that connects merchants directly with their Meta / Facebook Business Portfolio & WhatsApp Business Accounts. It automates abandoned cart recovery, order confirmation, shipping tracking, delivery follow-ups, and customer win-back campaigns at zero developer markup.

---

## 🌟 Key Features

1. **Meta / Facebook Portfolio Embedded Signup (1-Click Onboarding)**:
   - Direct integration via Facebook JS SDK with auto-discovery of WABA (WhatsApp Business Account) and Phone Number IDs.
   - Zero API markup — merchants use Meta's direct free tier (1,000 free conversations/month).
   - Enterprise `AES-256-GCM` token encryption at rest.

2. **Automated WhatsApp Notification Workflows**:
   - 🛒 **Abandoned Cart Recovery**: Multi-step automated sequences (30 min / 6 hr) with dynamic discount codes, product image previews, and automatic cancel-on-purchase checks.
   - 🧾 **Order Confirmation**: Instant prepaid and COD order summaries.
   - 🚚 **Order Shipped & In-Transit**: Real-time courier tracking links upon fulfillment.
   - 📦 **Order Delivered**: Post-purchase review requests and repeat buyer perks.
   - 🔁 **Customer Win-Back**: Re-engages customers inactive for >45 days.

3. **Visual Template Designer & Live WhatsApp Phone Simulator**:
   - Real-time phone simulator showing realistic WhatsApp chat bubble, product images, formatted text (*bold*, _italic_), and interactive action buttons (Quick Reply & CTA URLs).
   - Click-to-insert dynamic variable pills (`{{customer_name}}`, `{{order_number}}`, `{{cart_items}}`, `{{total_amount}}`, `{{tracking_url}}`, `{{discount_code}}`, `{{store_name}}`).

4. **Meta Limit & Payment Health Monitoring 🚨**:
   - Real-time tier limit tracking (`TIER_250`, `TIER_1K`, `TIER_10K`, etc.) and rolling 24-hour quota progress.
   - Automatic error detection for Meta payment method requirements (Error `131048`) and quota exhaustion (Error `130429`/`131056`), triggering high-visibility dashboard alert banners with 1-click resolution links.

5. **DPDP Act 2023 & GDPR Compliance**:
   - Itemized purpose consent capture with timestamp and IP audit log (`storeping_DPDPConsent`).
   - 1-Click JSON Store Data Export & Permanent Data Erasure (Right to be Forgotten).
   - PII masking in application logs (`+91 98*** **210`).

6. **Zero-Cost Free Architecture**:
   - Single shared PostgreSQL database (`Myshopify`) using `storeping_` table prefixes.
   - Robust PostgreSQL-backed asynchronous queue (`storeping_Job`) without requiring external Redis or paid services.

---

## 📁 Directory Structure

```
StorePing/
├── app/
│   ├── routes/
│   │   ├── app._index.tsx             # Overview Dashboard (KPIs, Limit Alerts, Live Feed)
│   │   ├── app.connect.tsx            # Facebook / Meta Embedded Signup & Onboarding
│   │   ├── app.automations.tsx        # Event triggers & delay controls
│   │   ├── app.templates.tsx          # Visual Template Designer & Live Phone Simulator
│   │   ├── app.analytics.tsx          # In-depth ROI, delivery rate, open rate metrics
│   │   ├── app.privacy.tsx            # DPDP Consent, Data Export & Erasure Center
│   │   ├── app.settings.tsx           # Preferences & Live Test WhatsApp Sender
│   │   ├── app.tsx                    # Embedded App Frame & Navigation
│   │   ├── auth.$.tsx                 # Shopify OAuth
│   │   ├── api.meta.webhook.tsx       # WhatsApp delivery status & opt-out handler
│   │   ├── api.meta.data-deletion.tsx # Meta Data Deletion callback
│   │   ├── cron.process-jobs.tsx      # PostgreSQL Queue worker runner
│   │   └── webhooks.*.tsx             # Shopify & GDPR webhooks
│   ├── utils/
│   │   ├── encryption.server.ts       # AES-256-GCM Token Encryption
│   │   ├── dpdp.server.ts             # DPDP Act 2023 compliance handlers
│   │   ├── meta-whatsapp.server.ts    # Meta Graph API v21.0 with appsecret_proof
│   │   ├── queue.server.ts            # PostgreSQL-backed async job engine
│   │   ├── template.server.ts         # Dynamic variable engine & default templates
│   │   ├── phone.utils.ts             # E.164 normalization & PII masking
│   │   └── logger.server.ts           # PII-safe application logging
│   ├── shopify.server.ts              # Shopify API & Webhook Configuration
│   ├── db.server.ts                   # Prisma Singleton Client
│   └── root.tsx                       # Remix Root Layout
├── prisma/
│   └── schema.prisma                  # Prisma Models with storeping_ table mappings
├── shopify.app.toml                   # Shopify CLI Config
└── package.json
```
