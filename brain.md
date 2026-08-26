# StorePing — Architectural & Codebase Map

## Overview & Purpose
**StorePing** is a high-reliability, zero-cost automated WhatsApp customer communication and marketing app for Shopify merchants. It connects merchants with their Meta / Facebook Business Portfolio to trigger automated messages on WhatsApp for abandoned carts, order confirmations, shipping updates, delivery reviews, and win-back offers.

---

## Key Capabilities
- **Meta / Facebook Portfolio Integration**: Embedded Signup with direct WABA auto-discovery and `AES-256-GCM` token encryption.
- **Shopify Webhook Ingestion**: Real-time handling of `orders/create`, `orders/fulfilled`, `fulfillments/update`, `checkouts/create`, and `checkouts/update`.
- **PostgreSQL Async Queue Engine**: Zero-cost queuing and delayed scheduling via `storeping_Job` and `storeping_CartRecovery` with automatic cancel-on-purchase logic.
- **Custom Visual Template Designer**: Polaris-based template editor with dynamic variable pills (`{{customer_name}}`, `{{cart_items}}`, etc.) and a real-time live WhatsApp phone simulator.
- **Meta Limit & Payment Alert Monitoring**: Real-time 24h tier tracking, quality score monitoring, and automated high-visibility alert banners for payment or limit issues.
- **DPDP Act 2023 & GDPR Compliance**: Purpose-specific consent records, 1-click JSON data export, and complete data erasure capabilities.

---

## Tech Stack
- **Framework & Runtime**: Node.js (>=20 LTS), Remix (with Vite plugin)
- **UI Components & Styling**: `@shopify/polaris`, `@shopify/app-bridge-react`, Tailwind CSS
- **Database & ORM**: PostgreSQL (`Myshopify`), Prisma ORM (`@prisma/client`) with `storeping_` table mapping
- **Integrations**: Shopify Remix SDK (`@shopify/shopify-app-remix`), Meta Graph API v21.0
- **Security**: AES-256-GCM authenticated encryption, HMAC-SHA256 signatures, `appsecret_proof`

---

## Directory Structure Map

```
StorePing/
├── app/
│   ├── db.server.ts                   # Prisma Singleton Client
│   ├── shopify.server.ts              # Shopify API & Webhook Configuration
│   ├── root.tsx                       # Remix HTML shell & Polaris Provider
│   ├── routes/
│   │   ├── app._index.tsx             # Overview Dashboard (KPIs, Alert Banners, Activity Feed)
│   │   ├── app.connect.tsx            # Facebook / Meta Portfolio 1-Click WhatsApp Onboarding
│   │   ├── app.automations.tsx        # Event triggers & delay controls
│   │   ├── app.templates.tsx          # Custom Visual Template Designer + Live Phone Simulator
│   │   ├── app.analytics.tsx          # Sent, Delivered, Read, Recovery Revenue Metrics
│   │   ├── app.privacy.tsx            # DPDP Consent, Data Export & Erasure Center
│   │   ├── app.settings.tsx           # Store Preferences & Live WhatsApp Test Sender
│   │   ├── app.tsx                    # Embedded App Frame & Navigation
│   │   ├── auth.$.tsx                 # Shopify OAuth routing fallback
│   │   ├── api.meta.webhook.tsx       # Meta Webhook Ingestion & opt-out handler
│   │   ├── api.meta.data-deletion.tsx # Meta App Review Data Deletion Callback
│   │   ├── cron.process-jobs.tsx      # PostgreSQL Queue worker runner
│   │   └── webhooks.*.tsx             # Shopify & GDPR Webhook Listeners
│   └── utils/
│       ├── encryption.server.ts       # AES-256-GCM Token Encryption & Decryption
│       ├── dpdp.server.ts             # DPDP Consent, Export & Data Erasure Utilities
│       ├── meta-whatsapp.server.ts    # Meta Graph API caller with appsecret_proof & limit handling
│       ├── queue.server.ts            # PostgreSQL-backed job runner & scheduler
│       ├── template.server.ts         # Dynamic variable engine & default templates
│       ├── phone.utils.ts             # Phone number formatting (+91 E.164 sanitization & masking)
│       └── logger.server.ts           # PII-safe application logging
├── prisma/
│   └── schema.prisma                  # Prisma Models with storeping_ table mappings
├── shopify.app.toml                   # Shopify CLI Config
└── package.json
```
