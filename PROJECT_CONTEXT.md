# 📱 StorePing — Comprehensive Project Context & Architectural Documentation

> **Application Name**: StorePing  
> **Platform**: Shopify Embedded Application (Remix / Node.js / PostgreSQL / Meta WhatsApp Cloud API)  
> **Author & Maintainer**: Sarthak Patel (Everon Labs)  
> **Tech Stack**: Remix (Vite), React 18, Shopify Polaris v12, Shopify App Bridge v4, Prisma ORM v6, PostgreSQL, Meta Graph API v21.0, Tailwind CSS  
> **Version**: Production v1.0.0 (January 2025 API compatibility)

---

## 1. 🌟 Executive Summary & Core Mission

**StorePing** is a high-performance, enterprise-grade Shopify embedded application that connects Shopify merchants directly with their Meta / Facebook Business Portfolio & WhatsApp Business Accounts (WABA). 

### The Problem It Solves:
Traditional Shopify WhatsApp marketing apps (e.g., Wati, Interakt, BiteSpeed, QuickReply) act as third-party aggregators:
1. They add substantial monthly subscription markups ($49 - $299/mo).
2. They charge heavy per-message markups (2x to 4x Meta's baseline costs).
3. They store merchant customer communications on proprietary servers.

### The StorePing Solution:
- **Direct Meta Cloud API Connection**: Merchants connect their own Meta Business Manager via Facebook Embedded Signup with **zero per-message markup**.
- **1,000 Free Monthly Conversations**: Merchants retain Meta's built-in 1,000 free monthly customer service conversations.
- **Zero Third-Party Middleware Costs**: Built on a single shared PostgreSQL database (`Myshopify`) with an asynchronous database-backed job queue, eliminating the need for paid Redis/BullMQ instances.
- **Bi-Directional Shopify Sync**: Seamlessly syncs WhatsApp customer address confirmations and customer notes directly into Shopify Admin Order tags and timeline notes via Shopify GraphQL Admin API.
- **High ROI**: Delivers up to 120x ROI on abandoned cart recoveries and order verifications.

---

## 2. 🏗️ High-Level System Architecture

```
                                  ┌─────────────────────────────┐
                                  │      Shopify Platform       │
                                  │ (Storefront & Admin Events) │
                                  └──────────────┬──────────────┘
                                                 │
                             Shopify Webhooks    │  Shopify Admin GraphQL
                   (Orders, Checkouts, Fulfill)  │  (Order Tags, Notes, Fetch)
                                                 │
                                                 ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   StorePing Application Server                                 │
│                                                                                                │
│  ┌────────────────────────┐      ┌─────────────────────────┐      ┌─────────────────────────┐  │
│  │   Shopify Auth & SDK   │      │    Remix Server Routes  │      │   PostgreSQL DB Engine  │  │
│  │  @shopify/shopify-app  │◄────►│  (Admin UI + Webhooks)  │◄────►│ (Sessions, Orders, Logs,│  │
│  │        -remix          │      │                         │      │  Templates, Queue Jobs) │  │
│  └────────────────────────┘      └────────────┬────────────┘      └────────────┬────────────┘  │
│                                               │                                │               │
│  ┌────────────────────────┐                   │                                │               │
│  │  Meta WhatsApp Engine  │◄──────────────────┴────────────────────────────────┘               │
│  │  - AES-256 Decryption  │                                                                    │
│  │  - appsecret_proof     │                                                                    │
│  │  - Rate Limiter & Tier │                                                                    │
│  │  - Failover & Recovery │                                                                    │
│  └───────────┬────────────┘                                                                    │
└──────────────┼─────────────────────────────────────────────────────────────────────────────────┘
               │
               │ Meta Cloud API v21.0 (Outbound) & Webhook Ingestion (Inbound)
               ▼
┌─────────────────────────────┐
│   Meta / WhatsApp Cloud API │
│   (WABA & Phone Number ID)  │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│     End Customer Mobile     │
│  (Interactive WhatsApp Chat)│
└─────────────────────────────┘
```

---

## 3. 🗄️ Database Architecture & Data Models (`prisma/schema.prisma`)

All tables are prefixed with `storeping_` to safely co-exist within a shared PostgreSQL database (`Myshopify`).

| Model Name | Table Name | Purpose & Relationships |
| :--- | :--- | :--- |
| `Session` | `storeping_Session` | Stores offline & online Shopify OAuth sessions managed by `PrismaSessionStorage`. |
| `Merchant` | `storeping_Merchant` | Central merchant record containing store metadata, encrypted Meta credentials, automation toggles, tier limits, and alert statuses. |
| `Template` | `storeping_Template` | Custom visual WhatsApp templates with header, body, footer, button configurations, and variable mappings. |
| `OrderConfirmation` | `storeping_OrderConfirmation` | Lifecycle tracking for order/address verification (`PENDING`, `CONFIRMED`, `UPDATE_REQUESTED`, `CANCELLED`) with customer notes and timestamps. |
| `Job` | `storeping_Job` | Zero-cost PostgreSQL-backed async job queue for scheduled message dispatches, delayed cart recovery timers, and retry attempts. |
| `CartRecovery` | `storeping_CartRecovery` | Tracks abandoned checkout tokens, cart items, customer details, discount codes, recovery status, and sequence progression. |
| `MessageLog` | `storeping_MessageLog` | Complete audit trail of outbound WhatsApp messages, Meta message IDs, delivery statuses (`SENT`, `DELIVERED`, `READ`, `FAILED`), and masked PII phone numbers. |
| `Conversation` | `storeping_Conversation` | 2-Way customer support inbox thread per customer phone number, tracking unread counts, status, and 24-hour Customer Service Window (CSW) expiration. |
| `ChatMessage` | `storeping_ChatMessage` | Individual chat messages within a conversation supporting text, templates, interactive buttons, images, videos, voice notes, and documents. |
| `DPDPConsent` | `storeping_DPDPConsent` | DPDP Act 2023 & GDPR consent records with timestamp, IP address, user agent, and itemized purpose authorizations. |
| `Log` | `storeping_Log` | Internal system logs and error audits categorized by source (`auth`, `webhook`, `queue`, `meta`, `cart`, `dpdp`). |

---

## 4. ⚡ Core Modules & Functionality

### 4.1. Meta / Facebook Portfolio Embedded Signup & Onboarding (`app.connect.tsx`)
- **1-Click Embedded Onboarding**: Integrates Facebook JS SDK with Facebook Login for Business to automatically fetch WABA ID, Phone Number ID, and Display Phone Number.
- **Enterprise Token Security**: Merchant WhatsApp access tokens are encrypted at rest using `AES-256-GCM` authenticated encryption (`encryption.server.ts`).
- **Automated Webhook Subscription**: Automatically invokes `subscribeWabaToWebhooks` on Meta Graph API so incoming messages and delivery receipts immediately flow to the app.
- **Auto-Registration**: Automatically handles unregistered phone numbers with Meta Cloud API (error `#133010` auto-recovery).

### 4.2. 7 Core Automated Workflows (`app.automations.tsx` & `webhooks.tsx`)
1. 🧾 **Order & Address Confirmation (Interactive 3-Button)**:
   - Sent immediately upon `ORDERS_CREATE`.
   - Displays complete order summary, line items, and delivery address.
   - Interactive buttons: `✅ Confirm Address`, `✏️ Update Address / Mobile`, `💬 Ask Query`.
2. 📄 **Standard Order Confirmation**:
   - Order summary with a direct CTA URL button (`📄 View Order Details`) pointing to the customer order status page.
3. 💳 **Cash on Delivery (COD) Verification**:
   - For risk mitigation on COD orders.
   - Interactive buttons: `✅ Confirm COD Order`, `❌ Cancel Order`, `💬 Need Help`.
4. 🚚 **Order Shipped & In-Transit Tracking**:
   - Sent immediately on `ORDERS_FULFILLED` / `FULFILLMENTS_CREATE`.
   - Injects carrier name and real-time package tracking URL.
5. 📦 **Order Delivered & Review Request**:
   - Sent when order delivery is confirmed.
   - Requests feedback and provides a VIP discount code for repeat purchases.
6. 🛒 **Abandoned Cart Recovery — Step 1 (30 Min Delay)**:
   - Triggered on `CHECKOUTS_CREATE` / `CHECKOUTS_UPDATE`.
   - Injects cart items, total value, and 1-click checkout recovery link.
7. 🎁 **Abandoned Cart Recovery — Step 2 (6 Hour Delay)**:
   - Adds urgency with an exclusive 10% discount promo code.
   - **Automatic Cancel-on-Purchase**: If the customer completes the order, `cancelCartRecoveryJobs` immediately cancels all queued recovery jobs.

### 4.3. Bi-Directional Shopify Sync (`shopify-order.server.ts` & `api.meta.webhook.tsx`)
- **Confirmation Action**: When a customer clicks `Confirm Address` on WhatsApp:
  1. StorePing marks the local record as `CONFIRMED`.
  2. Executes GraphQL `orderUpdate` on Shopify Admin adding tags: `WhatsApp Confirmed`, `Address Confirmed`.
  3. Appends a verification note to the Shopify Order timeline.
  4. Dispatches an automated instant WhatsApp confirmation message back to the customer.
- **Address Update Action**: When a customer clicks `Update Address / Mobile`:
  1. StorePing marks the order as `UPDATE_REQUESTED`.
  2. Tags the Shopify Order with `Address Update Requested`, `WhatsApp Action Needed`.
  3. Prompts the customer via WhatsApp to reply with their new address.
  4. When the customer replies with their new address text, StorePing stores the note and pushes the updated address directly into the Shopify Order timeline.

### 4.4. Live 2-Way Support Inbox (`app.inbox.tsx`)
- **Real-Time Customer Chat**: Dedicated unified inbox to chat with customers directly over WhatsApp.
- **Customer Service Window (CSW) Management**:
  - Tracks the rolling 24-hour window from the customer's last message.
  - **Inside CSW**: Merchant can send freeform text and rich media (100% free under Meta's 1,000 monthly service conversation allowance).
  - **Outside CSW**: Automatically enables Meta Template selector so merchants can re-open conversations with approved templates.
- **Secure Media Streaming Proxy (`api.meta.media.tsx`)**:
  - Fetches encrypted images, audio notes, video clips, and PDF invoices from Meta Cloud API Lookaside CDN and securely streams them to the browser with caching.

### 4.5. Visual Template Designer & Live WhatsApp Phone Simulator (`app.templates.tsx`)
- **Visual Editor**: Polaris form to configure header (Text/Image), body text, footer text, and buttons (CTA URL, Quick Reply, Multi-Button).
- **Dynamic Variable Pills**: Click-to-insert pills for `{{customer_name}}`, `{{order_number}}`, `{{cart_items}}`, `{{total_amount}}`, `{{shipping_address}}`, `{{discount_code}}`, `{{tracking_url}}`, `{{store_name}}`.
- **Live Interactive Phone Simulator**: Pixel-perfect preview of iOS/Android WhatsApp chat bubble with realistic typography, image rendering, variable interpolation, and interactive button previews.
- **Meta Format Transformer**: Converts named variables to Meta positional placeholders (`{{1}}`, `{{2}}`) and syncs templates directly to Meta WABA.

### 4.6. PostgreSQL-Backed Async Job Queue (`queue.server.ts`)
- **Zero External Dependencies**: Uses `storeping_Job` table to schedule and process jobs.
- **Concurrency & Locking**: Locks jobs during execution (`PROCESSING`) with attempt counters and exponential backoff retry.
- **Delayed Timers**: Supports arbitrary delays (e.g., 30 min, 6 hr, 24 hr) for multi-stage cart recovery funnels.
- **Cron Worker Endpoint (`cron.process-jobs.tsx`)**: Can be invoked via external HTTP cron or internal timer to process due jobs.

### 4.7. Meta Limit, Rate Limiting & Health Monitoring (`meta-whatsapp.server.ts`)
- **Sliding-Window Rate Limiter**: Enforces a 200 msgs/hr safety threshold per store to protect Meta WABA quality scores.
- **Error Detection & Alert Banners**:
  - Catches Error `131048` (Payment Required) $\rightarrow$ Displays payment alert banner with resolution link.
  - Catches Error `130429` / `131056` (Limit Exceeded) $\rightarrow$ Displays tier limit alert banner and reschedules jobs with a 15-minute cooldown.
  - Catches Error `133010` (Unregistered Number) $\rightarrow$ Auto-registers and retries.
- **24-Hour Tier Tracking**: Tracks rolling daily quotas (`TIER_250`, `TIER_1K`, `TIER_10K`, etc.) with automated daily reset.

### 4.8. DPDP Act 2023 & GDPR Privacy Compliance (`app.privacy.tsx` & `dpdp.server.ts`)
- **Purpose Consent Logging**: Logs granular consent versions and purposes in `storeping_DPDPConsent`.
- **PII Masking**: Automatically masks phone numbers in application logs (`+91 98*** **210`).
- **1-Click Data Export**: Exports complete merchant and customer data in structured JSON format.
- **Right to be Forgotten (Data Erasure)**: Permanently purges merchant data, message logs, and conversation history upon request.

---

## 5. 📂 Project File & Directory Map

```
StorePing/
├── app/
│   ├── db.server.ts                     # Prisma Singleton Client
│   ├── shopify.server.ts                # Shopify App Remix config, scopes & webhook subscriptions
│   ├── root.tsx                         # Remix Root HTML Layout & Polaris AppProvider
│   │
│   ├── routes/
│   │   ├── _index.tsx                   # Public landing page (for non-embedded visits)
│   │   ├── app.tsx                      # Embedded App Frame, Polaris Navigation & Loading Bar
│   │   ├── app._index.tsx               # Overview Dashboard (KPIs, Limit Alerts, Activity Feed)
│   │   ├── app.orders.tsx               # Live Orders list, WhatsApp send modal, verification statuses
│   │   ├── app.inbox.tsx                # 2-Way Live WhatsApp Support Inbox & CSW Manager
│   │   ├── app.automations.tsx          # 7 Core Automation Flow Toggles & Queue Manager
│   │   ├── app.templates.tsx            # Visual Template Designer & Live WhatsApp Phone Simulator
│   │   ├── app.connect.tsx              # Facebook / Meta Portfolio 1-Click WhatsApp Onboarding
│   │   ├── app.analytics.tsx            # Sent/Delivered/Read metrics, ROI & conversion analytics
│   │   ├── app.privacy.tsx              # DPDP Consent, 1-Click Data Export & Erasure Center
│   │   ├── app.settings.tsx             # Store Preferences & Live WhatsApp Test Sender
│   │   ├── auth.$.tsx                   # Shopify OAuth Fallback Route
│   │   ├── auth.facebook.tsx            # Facebook OAuth Init Route
│   │   ├── auth.facebook.callback.tsx   # Facebook OAuth Callback & Token Exchange
│   │   ├── api.meta.webhook.tsx         # Inbound Meta WhatsApp Webhook & Quick-Reply Ingestion
│   │   ├── api.meta.media.tsx           # Streaming Proxy for Meta WhatsApp Media (Images/PDFs)
│   │   ├── api.meta.data-deletion.tsx   # Meta App Review Compliance Data Deletion Callback
│   │   ├── cron.process-jobs.tsx        # PostgreSQL Queue Worker Execution Endpoint
│   │   ├── privacy.tsx                  # Public Privacy Policy Page
│   │   ├── terms.tsx                    # Public Terms of Service Page
│   │   ├── webhooks.tsx                 # Central Webhook Router (Shopify & Meta)
│   │   ├── webhooks.app.uninstalled.tsx # App Uninstalled Cleanup Webhook
│   │   ├── webhooks.app.scopes_update.tsx # App Scopes Update Webhook
│   │   └── webhooks.privacy.tsx         # Mandatory Shopify Privacy/GDPR Webhooks
│   │
│   └── utils/
│       ├── encryption.server.ts         # AES-256-GCM Token Encryption & Decryption
│       ├── dpdp.server.ts               # DPDP Act 2023 Consent, Export & Data Erasure Utilities
│       ├── meta-whatsapp.server.ts      # Meta Graph API Client (v21.0) with appsecret_proof & Limits
│       ├── queue.server.ts              # PostgreSQL-backed Async Queue Engine & Job Scheduler
│       ├── shopify-order.server.ts      # Shopify Admin GraphQL Client for Order Tags & Notes
│       ├── template.server.ts           # Server-side Template Seeding & Variable Interpolator
│       ├── template.shared.ts           # Shared Variable Interpolation Utilities for Client/Server
│       ├── phone.utils.ts               # Phone Normalization (E.164) & PII Masking
│       └── logger.server.ts             # PII-Safe System Logging & Audit Trail
│
├── prisma/
│   └── schema.prisma                    # Complete PostgreSQL Database Schema with storeping_ mappings
│
├── shopify.app.toml                     # Shopify CLI Configuration & Required Scopes
├── PRICING_AND_COST_GUIDE.md            # Detailed Meta Pricing, Free Allowances & ROI Calculations
├── RATE_LIMITING_AND_TIERS.md           # Meta Graph API Rate Limits & Phone Tier Scaling Guide
├── README.md                            # High-level Project Overview
├── brain.md                             # Architectural Quick-Reference Map
└── package.json                         # Node.js Dependencies & Build Scripts
```

---

## 6. 🔑 Environment Variables & Configuration

The application requires the following environment variables configured in `.env`:

```env
# Shopify App Credentials
SHOPIFY_API_KEY="your_shopify_api_key"
SHOPIFY_API_SECRET="your_shopify_api_secret"
SHOPIFY_APP_URL="https://storeping.everonlab.in"
SCOPES="read_orders,write_orders,read_checkouts,read_customers,read_fulfillments"

# Meta / Facebook Business Integration
META_APP_ID="your_meta_app_id"
META_APP_SECRET="your_meta_app_secret"
META_CONFIG_ID="your_embedded_signup_config_id"
META_WEBHOOK_VERIFY_TOKEN="storeping_meta_verify_token_secure_2026"

# Security & Encryption (AES-256-GCM requires a 32-byte / 64-hex-char key)
ENCRYPTION_SECRET="your_32_byte_hex_encryption_secret_key"

# Database Configuration (PostgreSQL)
DATABASE_URL="postgresql://user:password@host:5432/Myshopify?schema=public"
DIRECT_URL="postgresql://user:password@host:5432/Myshopify?schema=public"

# App Port & Runtime
PORT=3000
NODE_ENV=production
```

---

## 7. 🚀 Common Workflows & Operational Lifecycle

### Scenario A: New Order Placed (`ORDERS_CREATE`)
1. Shopify dispatches `ORDERS_CREATE` webhook to `/webhooks`.
2. StorePing validates HMAC, cancels any pending `CartRecovery` jobs for this checkout token.
3. Formats customer address, total amount, and line items.
4. Creates an `OrderConfirmation` record (`status: PENDING`).
5. Enqueues immediate job in `storeping_Job` and executes send via `meta-whatsapp.server.ts`.
6. Customer receives interactive 3-button message on WhatsApp.

### Scenario B: Customer Confirms Delivery Address via WhatsApp
1. Customer taps `✅ Confirm Address` on WhatsApp.
2. Meta webhook delivers payload to `/api/meta/webhook`.
3. Webhook extracts order number and updates `OrderConfirmation` to `CONFIRMED`.
4. Invokes `syncOrderUpdateToShopify` to tag the Shopify Order (`WhatsApp Confirmed`, `Address Confirmed`) and append verified timestamp to order note.
5. Bot automatically sends verification confirmation message back to customer.

### Scenario C: Abandoned Checkout Recovery
1. Customer adds items to cart and starts checkout (`CHECKOUTS_CREATE`).
2. StorePing records `CartRecovery` and schedules Step 1 job (+30 min) and Step 2 job (+6 hr).
3. At +30 min, queue worker sends Step 1 reminder with cart items preview and direct checkout URL.
4. If customer purchases, `cancelCartRecoveryJobs` cancels Step 2.
5. If customer does not purchase within 6 hours, Step 2 sends a 10% discount promo code.

---

## 8. 🛡️ Security, Privacy & Compliance Highlights

1. **Zero Raw Token Storage**: All Meta access tokens are encrypted with `AES-256-GCM` using authenticated initialization vectors (IVs) and authentication tags.
2. **Meta appsecret_proof Enforcement**: Every single call to Meta Graph API includes the cryptographic `appsecret_proof` hash to prevent token replay attacks.
3. **PII Redaction**: Customer phone numbers are automatically sanitized and masked in database logs (`+91 98*** **210`).
4. **Data Isolation**: Multi-tenant architecture keyed on `merchantId` and Shopify `shop` domain.
5. **GDPR / DPDP Compliance**: Complete endpoints implemented for customer data requests, store data deletion, and consent revocation.

---
*Documentation compiled and verified against StorePing codebase.*
