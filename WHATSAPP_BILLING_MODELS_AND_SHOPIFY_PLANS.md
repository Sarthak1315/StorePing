# 📊 StorePing: WhatsApp Billing & Business Pricing Strategy Blueprint

> **Document Type:** Executive Business & Financial Strategy Document  
> **Audience:** Founders, Product Managers, Finance & Operations Teams  
> **Format:** Formatted with Universal Visual Box Diagrams (renders in all markdown viewers)

---

## 📑 Table of Contents
1. [Executive Summary & High-Level Architecture](#1-executive-summary--high-level-architecture)
2. [End-to-End Merchant Onboarding & Plan Selection Flow](#2-end-to-end-merchant-onboarding--plan-selection-flow)
3. [Meta WhatsApp Pricing Engine (Per-Message Model)](#3-meta-whatsapp-pricing-engine-per-message-model)
4. [Model 1: Direct Meta Billing (BYOC – Bring Your Own Card)](#4-model-1-direct-meta-billing-byoc--bring-your-own-card)
5. [Model 2: StorePing Managed Usage Billing (Shopify Billing API)](#5-model-2-storeping-managed-usage-billing-shopify-billing-api)
6. [Free Starter Plan with Pay-As-You-Go Usage ($0 Base + Usage Cap)](#6-free-starter-plan-with-pay-as-you-go-usage-0-base--usage-cap)
7. [Merchant Decision Guide: Choosing Model 1 vs. Model 2](#7-merchant-decision-guide-choosing-model-1-vs-model-2)
8. [Unit Economics & Profit Margin Projections](#8-unit-economics--profit-margin-projections)
9. [Shopify App Store Billing & Compliance Rules](#9-shopify-app-store-billing--compliance-rules)
10. [Strategic Comparison & Risk Matrix](#10-strategic-comparison--risk-matrix)

---

## 1. 🌟 Executive Summary & High-Level Architecture

StorePing offers a **Hybrid Billing System** designed to eliminate onboarding friction for Shopify merchants while securing recurring SaaS subscription revenue and message profit margins.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        Shopify Store Merchant Installs StorePing                       │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        Onboarding & Billing Model Selection                            │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │
                   ┌────────────────────────┴────────────────────────┐
                   │                                                 │
                   ▼                                                 ▼
┌─────────────────────────────────────┐           ┌─────────────────────────────────────┐
│  OPTION A: Direct Meta Card (BYOC)  │           │   OPTION B: Shopify Usage Billing   │
├─────────────────────────────────────┤           ├─────────────────────────────────────┤
│ • Merchant pays Meta card directly  │           │ • All message costs on Shopify bill │
│ • StorePing charges SaaS Plan       │           │ • No Meta credit card required      │
│ • Zero Financial Risk for StorePing │           │ • StorePing earns SaaS + 18% margin │
└──────────────────┬──────────────────┘           └──────────────────┬──────────────────┘
                   │                                                 │
                   ▼                                                 ▼
┌─────────────────────────────────────┐           ┌─────────────────────────────────────┐
│      Predictable SaaS Revenue       │           │     SaaS Revenue + Message Profit   │
│       $19 - $49 / month/store       │           │    $19 - $49/mo + $10 - $250/mo     │
└─────────────────────────────────────┘           └─────────────────────────────────────┘
```

---

## 2. 🗺️ End-to-End Merchant Onboarding & Plan Selection Flow

```
                      [ STEP 1: INSTALLATION ]
     Merchant installs StorePing from the Shopify App Store
                                │
                                ▼
                   [ STEP 2: WHATSAPP CONNECT ]
     Connects WhatsApp Business Account via Meta Embedded Signup
                                │
                                ▼
                [ STEP 3: BILLING MODEL SELECTION ]
  ┌─────────────────────────────────────────────────────────────┐
  │ "How would you like to pay for WhatsApp messages?"          │
  └───────────────┬─────────────────────────────┬───────────────┘
                  │                             │
       [ I have a Meta Card ]         [ Put it on my Shopify Bill ]
                  │                             │
                  ▼                             ▼
       ┌──────────────────────┐      ┌──────────────────────┐
       │   MODEL 1: DIRECT    │      │   MODEL 2: MANAGED   │
       ├──────────────────────┤      ├──────────────────────┤
       │ Select SaaS Plan:    │      │ Select Plan with Cap:│
       │ • Free Starter ($0)  │      │ • $0 Base + $50 Cap  │
       │ • Growth ($19/mo)    │      │ • $19 Base + $100 Cap│
       │ • Pro ($49/mo)       │      │ • $49 Base + $250 Cap│
       └──────────┬───────────┘      └──────────┬───────────┘
                  │                             │
                  ▼                             ▼
       ┌──────────────────────┐      ┌──────────────────────┐
       │ Meta auto-charges    │      │ Shopify charges msg  │
       │ merchant's card      │      │ costs to 30-day bill │
       │ directly per message │      │ ($0.012 / ₹1.00 each)│
       └──────────┬───────────┘      └──────────┬───────────┘
                  │                             │
                  ▼                             ▼
       ┌────────────────────────────────────────────────────┐
       │          STOREPING AUTOMATIONS FULLY ACTIVE        │
       │  • Abandoned Cart Recovery 1, 2 & 3                │
       │  • COD & Order Confirmation Verification           │
       │  • 2-Way Customer Support Inbox (Free CSW)         │
       └────────────────────────────────────────────────────┘
```

---

## 3. 🌐 Meta WhatsApp Pricing Engine (Per-Message Model)

Effective **July 1, 2025**, Meta charges on a **Per-Message Delivered** basis.

### 🏷️ Category & Window Charge Matrix

| Message Category | StorePing Feature | In 24h Customer Service Window (CSW)? | In 72h Free Entry Point (FEP)? | Meta Charge Status |
| :--- | :--- | :--- | :--- | :--- |
| **Marketing** | Abandoned Cart Recovery, Broadcasts | Yes / No | No | **Always Charged** (Marketing Rate) |
| **Utility** | Order Confirmation, Tracking Updates | Outside CSW (Business-initiated) | No | **Charged** (Utility Rate) |
| **Utility** | Order Update in ongoing conversation | Inside CSW (Customer replied) | No | **FREE** *(Until Oct 1, 2026)* |
| **Service** | Live Support Inbox (Text / Image / Media) | Inside CSW | No | **FREE** *(Until Oct 1, 2026)* |
| **Any Message** | Click-to-WhatsApp Ads / FB CTA Button | Inside FEP | **Yes (72 Hours)** | **100% FREE for 72 Hours** |

### 🌍 Official Meta Base Rates (Key Markets)

| Market | Currency | Marketing Base Rate | Utility Base Rate | Authentication Base Rate |
| :--- | :--- | :--- | :--- | :--- |
| **India (`+91`)** | **INR (₹)** | **₹0.85** / msg | **₹0.15** / msg | **₹0.15** / msg |
| **North America (`+1`)** | **USD ($)** | **$0.025** / msg | **$0.005** / msg | **$0.0135** / msg |
| **United Kingdom (`+44`)** | **GBP (£)** | **£0.045** / msg | **£0.018** / msg | **£0.018** / msg |
| **United Arab Emirates (`+971`)** | **AED (د.إ)** | **AED 0.16** / msg | **AED 0.08** / msg | **AED 0.08** / msg |
| **Brazil (`+55`)** | **BRL (R$)** | **R$ 0.35** / msg | **R$ 0.04** / msg | **R$ 0.04** / msg |

---

## 4. 🏛️ Model 1: Direct Meta Billing (BYOC – Bring Your Own Card)

### 📌 Flow Diagram: How Money & Messages Move in Model 1

```
  [ Shopper leaves checkout ]
               │
               ▼
  ┌─────────────────────────┐
  │     StorePing App       │────── Dispatches Message ──────► ┌──────────────────────┐
  └─────────────────────────┘                                  │ Meta WhatsApp Cloud  │
               │                                               └──────────┬───────────┘
               │                                                          │
   Charges Monthly SaaS Plan                                    Delivers WhatsApp Msg
        ($19 / $49)                                                       │
               │                                                          ▼
               ▼                                               ┌──────────────────────┐
  ┌─────────────────────────┐                                  │       Shopper        │
  │  Merchant's Shopify     │                                  └──────────────────────┘
  │       Bill              │
  └─────────────────────────┘
               ▲
               │ Meta auto-charges merchant's card directly (₹0.85 / $0.025)
  ┌─────────────────────────┐
  │  Merchant's Card on     │
  │   Meta Business Suite   │
  └─────────────────────────┘

  ════════════════════════════════════════════════════════════════════════════════
  FINANCIAL OUTCOME:
  • StorePing receives: 100% of SaaS Subscription ($19 - $49/mo).
  • StorePing pays Meta: $0.00 (Zero financial risk / zero message debt liability).
  ════════════════════════════════════════════════════════════════════════════════
```

---

## 5. 💳 Model 2: StorePing Managed Usage Billing (Shopify Billing API)

### 📌 Flow Diagram: How Money & Messages Move in Model 2

```
  [ Shopper leaves checkout ]
               │
               ▼
  ┌─────────────────────────┐
  │     StorePing App       │────── Dispatches via StorePing Line of Credit ──► ┌─────────────────────┐
  └────────────┬────────────┘                                                   │ Meta WhatsApp Cloud │
               │                                                                └──────────┬──────────┘
               │ 1. Records usage charge ($0.012 / ₹1.00)                                  │
               ▼                                                                 Delivers WhatsApp Msg
  ┌─────────────────────────┐                                                              │
  │  Shopify Billing API    │                                                              ▼
  └────────────┬────────────┘                                                   ┌─────────────────────┐
               │ 2. Adds charge to monthly bill                                 │       Shopper       │
               ▼                                                                └─────────────────────┘
  ┌─────────────────────────┐
  │ Merchant's Unified      │
  │   Shopify Invoice       │
  └────────────┬────────────┘
               │ 3. Payout collected revenue (e.g. $1,200)
               ▼
  ┌─────────────────────────┐
  │ StorePing Bank Account  │────── Pays Wholesale Invoice ($1,000) ──────────► ┌─────────────────────┐
  └─────────────────────────┘                                                   │ Meta Line of Credit │
                                                                                └─────────────────────┘

  ════════════════════════════════════════════════════════════════════════════════
  FINANCIAL OUTCOME:
  • Merchant pays: Single bill on Shopify (SaaS Plan + $0.012 per message).
  • StorePing pays Meta: Wholesale rate ($0.010 / ₹0.85 per message).
  • StorePing keeps: SaaS Plan Revenue + 15% to 20% Net Message Margin!
  ════════════════════════════════════════════════════════════════════════════════
```

---

## 6. 🆓 Free Starter Plan with Pay-As-You-Go Usage ($0 Base + Usage Cap)

### 📌 How a $0 Plan Operates on Shopify Billing

Shopify officially supports **Usage-Only / Pay-As-You-Go Plans**. The merchant approves a **$0.00 recurring monthly base fee** with an authorized **Usage Spending Cap (e.g., $50.00)**.

```
                      [ MERCHANT INSTALLS FREE PLAN ]
                                    │
                                    ▼
                 [ SHOPIFY NATIVE APPROVAL SCREEN ]
      ┌───────────────────────────────────────────────────────────┐
      │ Plan: Free Starter (Pay-As-You-Go)                        │
      │ Base recurring fee: $0.00 every 30 days                   │
      │ Usage limit approved: Up to $50.00 / 30 days              │
      │                                                           │
      │ Terms: $0.012 (₹1.00) per delivered WhatsApp message      │
      └─────────────────────────────┬─────────────────────────────┘
                                    │ Merchant clicks 'Approve'
                                    ▼
                 [ MONTHLY MESSAGE USAGE SCENARIOS ]
                                    │
         ┌──────────────────────────┼──────────────────────────┐
         │                          │                          │
         ▼                          ▼                          ▼
   [ 0 Messages ]            [ 100 Messages ]           [ Approaching $50 Cap ]
   Bill = $0.00              Bill = $1.20 (₹100)        In-app banner prompts
   Merchant pays $0          Added to Shopify bill      to increase spending cap
```

### 📋 Key Rules of the Free Plan:
1. **$0 Upfront:** The merchant is **never** charged $50 upfront. $50 is strictly the approved spending limit.
2. **True Pay-As-You-Go:** If a store sends 50 messages, they pay only **$0.60** on their monthly Shopify bill.
3. **Zero Barrier to Entry:** Maximizes app installations by eliminating all financial hesitation.

---

## 7. 🔀 Merchant Decision Guide: Choosing Model 1 vs. Model 2

```
                       [ MERCHANT ONBOARDING ]
                                  │
                                  ▼
      ┌───────────────────────────────────────────────────────┐
      │ Do you have a Meta Business Credit Card or Line of    │
      │ Credit attached to your Meta Business Suite?          │
      └───────────────────────────┬───────────────────────────┘
                                  │
                 ┌────────────────┴────────────────┐
                 │ YES                             │ NO
                 ▼                                 ▼
  ┌───────────────────────────────┐ ┌───────────────────────────────┐
  │ Do you want official Meta tax │ │ 🌟 OPTION B: SHOPIFY USAGE    │
  │ invoices in your company name?│ │ • No Meta credit card needed  │
  └──────────────┬────────────────┘ │ • Charges appear on Shopify   │
                 │                  │ • Instant 1-click activation  │
         ┌───────┴───────┐          └───────────────────────────────┘
         │ YES           │ NO                      ▲
         ▼               ▼                         │
  ┌──────────────┐ ┌───────────────────────────────┘
  │ 🌟 OPTION A: │ │ Prefer single unified bill?
  │ DIRECT META  │
  │ • Base rates │
  │ • BYOC Card  │
  └──────────────┘
```

---

## 8. 📈 Unit Economics & Profit Margin Projections

### 📦 SaaS Subscription Tiers (Both Models)

| Tier | Monthly SaaS Fee | Included Recoveries & Features | Target Merchant Segment |
| :--- | :--- | :--- | :--- |
| **Free Starter** | **$0 / month** | • Up to 50 Cart Recoveries<br>• COD Verification<br>• 1 Team Member | New / Testing Stores |
| **Growth** | **$19 / month** (₹1,599) | • Unlimited Cart Recoveries<br>• Dynamic 1-Time Discount Codes<br>• 2-Way Live Support Inbox<br>• 3 Team Members | Growing Direct-to-Consumer Brands |
| **Pro / Scale** | **$49 / month** (₹3,999) | • Priority Dispatch Queue<br>• Unlimited Staff Seats<br>• Custom Analytics & CSV Export<br>• Dedicated Account Manager | High-Volume Enterprise Stores |

---

### 💰 Model 2: Message Margin Economics

#### India Market (`+91` Numbers)
* **Meta Wholesale Cost:** **₹0.85** per marketing message
* **StorePing Retail Price:** **₹1.00** per marketing message ($0.012 USD)
* **Net Margin per Message:** **₹0.15 (17.6% Gross Margin)**

| Monthly Volume (India) | Total Billed to Merchant | Wholesale Meta Cost | Net Monthly Message Margin | Monthly SaaS Plan Fee | **Total Monthly Revenue** |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **5,000 messages** | ₹5,000 | ₹4,250 | **₹750** | ₹1,599 ($19) | **₹2,349 / store** |
| **20,000 messages** | ₹20,000 | ₹17,000 | **₹3,000** | ₹1,599 ($19) | **₹4,599 / store** |
| **100,000 messages** | ₹100,000 | ₹85,000 | **₹15,000** | ₹3,999 ($49) | **₹18,999 / store** |

#### US & Global Markets (`+1` Numbers)
* **Meta Wholesale Cost:** **$0.0250** per marketing message
* **StorePing Retail Price:** **$0.0300** per marketing message
* **Net Margin per Message:** **$0.0050 (20.0% Gross Margin)**

| Monthly Volume (US/Global) | Total Billed to Merchant | Wholesale Meta Cost | Net Monthly Message Margin | Monthly SaaS Plan Fee | **Total Monthly Revenue** |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **2,000 messages** | $60.00 | $50.00 | **$10.00** | $19.00 | **$29.00 / store** |
| **10,000 messages** | $300.00 | $250.00 | **$50.00** | $19.00 | **$69.00 / store** |
| **50,000 messages** | $1,500.00 | $1,250.00 | **$250.00** | $49.00 | **$299.00 / store** |

---

## 9. 🛡️ Shopify App Store Billing & Compliance Rules

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        SHOPIFY APP STORE BILLING COMPLIANCE RULES                      │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. Mandatory Shopify Billing API                                                       │
│    All merchant fees (SaaS & usage) must be processed through Shopify's Billing API.   │
│    Zero external Stripe/Razorpay forms allowed inside the Shopify admin iframe.        │
│                                                                                        │
│ 2. Transparent Pricing Disclosure                                                      │
│    Usage terms must clearly state exact unit rates (e.g. '$0.012 per message').        │
│                                                                                        │
│ 3. Usage Cap Protection                                                                │
│    The app must respect the merchant's approved spending limit and prompt to increase. │
│                                                                                        │
│ 4. 0% Revenue Share Advantage                                                          │
│    Shopify takes 0% revenue share on your first $1,000,000 USD in annual app revenue.  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 10. ⚖️ Strategic Comparison & Risk Matrix

| Dimension | Model 1: Direct Meta Card (BYOC) | Model 2: Shopify Usage Billing |
| :--- | :--- | :--- |
| **Merchant Experience** | Card charged directly by Meta Business Suite | Consolidated single invoice on Shopify |
| **Onboarding Friction** | Medium (Requires Meta Credit Card setup) | **Zero Friction (One-click Shopify approval)** |
| **Financial Risk to StorePing** | **0.00% (Zero Risk)** | **Near-Zero (Protected by Usage Cap)** |
| **Revenue Streams** | SaaS Subscription ($19 / $49 / mo) | **SaaS Subscription + 15–20% Message Margins** |
| **Billing Operations** | Handled 100% by Meta | Handled 100% by Shopify Billing API |
| **Ideal Customer Profile** | Enterprise stores with corporate cards | Small/Medium & Indian Direct-to-Consumer stores |

---

### 🏁 Final Recommendation

By offering **both Model 1 (Direct Meta)** and **Model 2 (Shopify Usage Billing with a $0 Free Base)**, StorePing achieves:
1. **Maximum Conversion Rates** by letting merchants start instantly without a Meta credit card.
2. **100% Compliance** with Shopify App Review guidelines.
3. **Dual Revenue Streams** from SaaS subscription fees and per-message profit margins.
