# ⚡ Meta WhatsApp Rate Limiting & Tier Architecture Guide

This document outlines Meta's **Application-Level** and **Phone-Number-Level** rate limits, formulas, tier upgrade dynamics, and **StorePing's automated failover & rate-limiting engine**.

---

## 1. 🌐 Application-Level Rate Limits (Meta Graph API)

Meta applies an application-wide call limit to prevent infrastructure abuse across all apps.

### 📐 The Official Meta Formula:
$$\text{Max Hourly API Calls} = 200 \times \text{Total Active Merchants (Users)}$$

### 📊 Capacity Scaling Table:

| Total Merchants Using StorePing | Application Hourly Limit |
| :---: | :---: |
| **1 Store** | 200 calls / hour |
| **10 Stores** | 2,000 calls / hour |
| **50 Stores** | 10,000 calls / hour |
| **100 Stores** | 20,000 calls / hour |
| **1,000 Stores** | **200,000 calls / hour** |

### 💡 Key Principle: Shared App Pool (Not Per-User Cap)
* The rate limit is **pooled across the entire application**.
* If Store A needs to dispatch **1,500 messages in one hour** during a flash sale while Store B is quiet, **Store A can utilize the available app pool without getting blocked**.

---

## 2. 📱 WhatsApp Phone Number Tier Limits (Per Merchant)

Each individual merchant's sending capacity is determined by their **WhatsApp Business Phone Tier** (WABA), which dictates how many unique customers they can message in a rolling 24-hour period.

| Tier Level | Daily Customer Reach (Unique Phone Numbers / 24h) | Qualification Criteria |
| :--- | :--- | :--- |
| **Tier 1 (Unverified)** | **250 customers / 24h** | Default for new, unverified Meta Business accounts. |
| **Tier 1K (Verified)** | **1,000 customers / 24h** | Meta Business Verification completed + GREEN quality rating. |
| **Tier 10K** | **10,000 customers / 24h** | Sent 500+ messages in 7 days with high quality. |
| **Tier 100K** | **100,000 customers / 24h** | High-volume merchant with strong quality metrics. |
| **Tier Unlimited** | **Unlimited customers / 24h** | Enterprise scale with consistent high-volume delivery. |

> [!IMPORTANT]
> **Customer-Initiated Support Replies**: Inbound support conversations from customers inside the 24-hour Customer Service Window (CSW) do **NOT** count towards the tier limit and are completely unlimited.

---

## 3. 🚀 Throughput Speed (Messages Per Second)

Meta WhatsApp Cloud API supports high-speed concurrent delivery:
* **Standard Throughput**: **80 to 250 messages per second** per registered phone number.
* **Concurrency**: Handled automatically via asynchronous non-blocking HTTPS requests.

---

## 4. 🛡️ StorePing Rate-Limiting & Auto-Recovery Engine

StorePing features a multi-tiered protection system built directly into the server backend:

```
                            Outbound Message Request
                                       │
                                       ▼
                      ┌─────────────────────────────────┐
                      │    Sliding 1-Hour Rate Limiter  │
                      │ (Past 60 mins < 200 msgs/store) │
                      └────────────────┬────────────────┘
                                       │
                 ┌─────────────────────┴─────────────────────┐
                 │ Within Limit                              │ Exceeded Limit
                 ▼                                           ▼
   ┌───────────────────────────┐               ┌───────────────────────────┐
   │  Execute Meta API Request │               │  Safe Rate-Limit Cooldown │
   └─────────────┬─────────────┘               │  Queue Rescheduled +15min │
                 │                             └───────────────────────────┘
   ┌─────────────┴─────────────┐
   │ Check Meta Response       │
   ├───────────────────────────┤
   │ 🟢 Status 200 OK          │ ──► Deliver & Record in Database
   │ 🟡 Code 429 / 130429      │ ──► Exponential Backoff (Wait 2s & Auto-Retry)
   │ 🔴 Code 131056 (Tier Cap) │ ──► Trigger Merchant Alert Banner & 15m Queue Delay
   └───────────────────────────┘
```

### Key Technical Implementations:

1. **Sliding-Window Hourly Rate Limiter** (`meta-whatsapp.server.ts`):
   - Computes rolling 60-minute dispatch volume from PostgreSQL logs.
   - Prevents accounts from spamming or exhausting their limits in burst traffic.
2. **Auto-Recovery with Exponential Backoff**:
   - Catches HTTP `429` (Too Many Requests) or Meta error code `130429`.
   - Pauses for **2 seconds** and automatically retries the delivery once.
3. **Queue Rescheduling & Cooldown** (`queue.server.ts`):
   - If an automated abandoned cart or order job hits a rate limit, the background queue worker automatically marks the job with a **15-minute cooldown** instead of marking it failed.
4. **Merchant Alert Banners**:
   - Sets `alertType: "LIMIT_EXCEEDED"` on the merchant record to notify store staff inside Shopify Admin with the exact reset time.

---

## 5. 🌟 Best Practices for Merchants to Upgrade Tiers Fast

1. **Maintain a GREEN Quality Rating**: Avoid spammy marketing; always provide value and clear opt-out commands (`STOP`).
2. **Complete Business Verification**: In Meta Business Manager, verify your legal business documents to instantly unlock Tier 1K.
3. **Double Volume Within 7 Days**: When you reach 50% of your tier limit with high quality, Meta automatically upgrades your phone number to the next tier within 48 hours.
