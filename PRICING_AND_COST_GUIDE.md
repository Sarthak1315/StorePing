# 💰 Meta WhatsApp Cloud API — Pricing & Cost Guide

This guide provides a comprehensive cost breakdown, formulas, free allowances, and real-world calculation models for Shopify merchants sending WhatsApp notifications via **StorePing**.

---

## 1. 📌 Meta's Conversation-Based Pricing Model

Meta charges per **24-Hour Conversation Window** rather than per individual message. 

* When a message is delivered to a customer, a **24-hour conversation session** begins.
* Within this 24-hour window, the merchant can send **multiple messages in the same category without paying additional fees**.

---

## 2. 🎁 What is 100% FREE from Meta?

1. **1,000 Free Service Conversations / Month**:
   * Every connected WhatsApp Business Account (WABA) receives **1,000 Free Service (Support) Conversations** every calendar month.
   * When a customer initiates a message (e.g. support inquiry), all 2-way replies sent by your team within the 24-hour window are **100% free**.
2. **72-Hour Free Window from Meta Ads (Click-to-WhatsApp)**:
   * If a customer clicks a "Click to WhatsApp" button on a Facebook or Instagram ad, all subsequent WhatsApp conversations with that customer are **free for 72 hours**.

---

## 3. 📊 Message Categories & Standard Rates

Meta categorizes messages into 4 distinct types with separate pricing:

| Category | Typical StorePing Use Case | Approx. Cost (India 🇮🇳) | Approx. Cost (USA / Canada 🇺🇸) | Approx. Cost (UK / EU 🇪🇺) |
| :--- | :--- | :--- | :--- | :--- |
| **Utility** | Order Confirmations, Shipping Updates, Delivery Tracking, COD Verification | **~₹0.12** / convo | ~$0.015 / convo | ~$0.035 / convo |
| **Marketing** | Abandoned Cart Recovery, Product Promotions, Discount Offers | **~₹0.80** / convo | ~$0.025 / convo | ~$0.060 / convo |
| **Authentication** | Login OTP, Account Verification | **~₹0.12** / convo | ~$0.014 / convo | ~$0.030 / convo |
| **Service (Support)** | Live 2-Way Customer Support (Customer initiates) | **1,000 FREE/mo**, then ~₹0.30 | **1,000 FREE/mo**, then ~$0.010 | **1,000 FREE/mo**, then ~$0.030 |

---

## 4. 🧮 Mathematical Cost Formula

The total daily cost for a merchant is calculated as:

$$\text{Total Daily Cost} = \sum (\text{Conversations}_c \times \text{Rate}_c)$$

$$\text{Cost} = (N_{\text{utility}} \times R_{\text{utility}}) + (N_{\text{marketing}} \times R_{\text{marketing}}) + (\max(0, N_{\text{service}} - 1000) \times R_{\text{service}})$$

Where:
* $N_{\text{utility}}$ = Number of unique customers receiving utility updates in 24 hours.
* $N_{\text{marketing}}$ = Number of unique customers receiving marketing/cart reminders in 24 hours.
* $R$ = Meta rate for the customer's destination country.

---

## 5. 📦 Real-World Scenario: 24-Hour High-Volume Day

### Scenario Details:
* **500 New Orders** $\rightarrow$ Order Confirmation messages sent.
* **250 Abandoned Carts** $\rightarrow$ Cart Recovery reminders sent with 1-click checkout links.
* **600 Fulfilled Orders** $\rightarrow$ Shipping & live tracking links dispatched.
* **Total Messages Dispatched** = **1,350 messages**.

### Itemized Cost Breakdown:

| Event | Count | Category | Unit Rate (India) | Total Cost (INR) | Total Cost (USD) |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Order Confirmations** | 500 | Utility | ₹0.12 | ₹60.00 | $0.72 |
| **Abandoned Cart Recovery** | 250 | Marketing | ₹0.80 | ₹200.00 | $2.40 |
| **Delivery / Tracking Links** | 600 | Utility | ₹0.12 | ₹72.00 | $0.86 |
| **TOTAL** | **1,350** | — | — | **₹332.00 INR** | **~$3.98 USD** |

> [!NOTE]
> If a customer receives an *Order Confirmation* and a *Shipping Link* within the same 24-hour window, Meta charges only **once** for that utility session!

---

## 6. 📈 Return on Investment (ROI) & Profit Analysis

Spending **₹332 INR ($3.98 USD)** for 1,350 WhatsApp alerts generates substantial returns:

1. **Abandoned Cart Recovery Rate**: WhatsApp recovery messages have an average conversion rate of **15% – 20%**.
   * $250 \text{ carts} \times 16\% = \mathbf{40 \text{ Recovered Orders}}$.
2. **Recovered Revenue**:
   * Assuming an Average Order Value (AOV) of **₹1,000 INR**:
   * $\text{Recovered Revenue} = 40 \times ₹1,000 = \mathbf{₹40,000 \text{ INR}}$ ($480 USD).
3. **Net Profit Return**:
   $$\text{ROI} = \frac{\text{Recovered Revenue} - \text{WhatsApp Cost}}{\text{WhatsApp Cost}} \times 100$$
   $$\text{ROI} = \frac{₹40,000 - ₹332}{₹332} \times 100 = \mathbf{11,948\% \text{ (120x ROI)}}$$

---

## 7. 💳 How Billing Works in StorePing

* **Direct Meta Billing**: Meta charges are billed directly to the merchant's payment card registered inside their **Meta Business Portfolio**.
* **Zero Markup**: StorePing passes WhatsApp Cloud API rates directly from Meta with zero per-message markup.
