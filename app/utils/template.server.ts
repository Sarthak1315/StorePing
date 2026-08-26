import db from "../db.server";
export * from "./template.shared";

export const DEFAULT_TEMPLATES = [
  {
    eventType: "CART_RECOVERY_1",
    name: "Abandoned Cart Reminder (Step 1 - 30 min)",
    language: "en",
    headerType: "IMAGE",
    headerText: "",
    headerMediaUrl: "https://cdn.shopify.com/s/files/1/0533/2089/files/cart_preview.png",
    bodyText:
      "Hi {{customer_name}}! 👋 You left items in your cart at *{{store_name}}*.\n\n🛍️ *Your Cart:* {{cart_items}}\n💰 *Total:* {{currency}} {{total_amount}}\n\nYour items are reserved for a limited time! Complete your order before they sell out. 👇",
    footerText: "Reply STOP to unsubscribe",
    buttonType: "CTA_URL",
    buttonText: "🛒 Complete My Order",
    buttonUrl: "{{checkout_url}}",
    isActive: true,
  },
  {
    eventType: "CART_RECOVERY_2",
    name: "Abandoned Cart Urgency + 10% Discount (Step 2 - 6 hr)",
    language: "en",
    headerType: "TEXT",
    headerText: "🎁 Special 10% Off Your Cart!",
    bodyText:
      "Hey {{customer_name}}, we noticed you still haven't checked out your cart at *{{store_name}}*!\n\nUse exclusive coupon code *{{discount_code}}* at checkout to get an instant 10% discount.\n\n⏰ *Offer valid for the next 12 hours only!*",
    footerText: "Reply STOP to unsubscribe",
    buttonType: "CTA_URL",
    buttonText: "⚡ Claim 10% Off & Checkout",
    buttonUrl: "{{checkout_url}}",
    isActive: true,
  },
  {
    eventType: "ORDER_CONFIRM",
    name: "Order Placed & Confirmation",
    language: "en",
    headerType: "TEXT",
    headerText: "🧾 Order Confirmation #{{order_number}}",
    bodyText:
      "Thank you for your order, {{customer_name}}! 🎉\n\nYour order *#{{order_number}}* for *{{currency}} {{total_amount}}* has been received and is being prepared.\n\nWe will notify you once your order is on its way with live tracking.",
    footerText: "{{store_name}}",
    buttonType: "CTA_URL",
    buttonText: "📄 View Order Details",
    buttonUrl: "{{tracking_url}}",
    isActive: true,
  },
  {
    eventType: "ORDER_SHIPPED",
    name: "Order Shipped & Live Tracking",
    language: "en",
    headerType: "TEXT",
    headerText: "🚚 Your Order is On The Way!",
    bodyText:
      "Great news, {{customer_name}}! 📦\n\nYour order *#{{order_number}}* from *{{store_name}}* has been shipped via *{{carrier}}*.\n\nClick below to track your delivery in real-time.",
    footerText: "{{store_name}} Tracking",
    buttonType: "CTA_URL",
    buttonText: "📍 Track Package",
    buttonUrl: "{{tracking_url}}",
    isActive: true,
  },
  {
    eventType: "ORDER_DELIVERED",
    name: "Order Delivered + Review Request",
    language: "en",
    headerType: "TEXT",
    headerText: "📦 Order Delivered!",
    bodyText:
      "Hi {{customer_name}}, your order *#{{order_number}}* from *{{store_name}}* was delivered successfully! 🎉\n\nWe hope you love your purchase. How was your experience? Here is a 10% VIP discount code *{{discount_code}}* for your next order!",
    footerText: "{{store_name}}",
    buttonType: "QUICK_REPLY",
    buttonText: "⭐ Rate Your Experience",
    buttonUrl: "",
    isActive: true,
  },
  {
    eventType: "WIN_BACK",
    name: "Customer Win-Back (Inactive > 45 Days)",
    language: "en",
    headerType: "TEXT",
    headerText: "💖 We Miss You at {{store_name}}!",
    bodyText:
      "Hi {{customer_name}}, it's been a while since your last visit! ✨\n\nWe have added exciting new products to our collection. Enjoy a special welcome-back gift of 15% off with code *{{discount_code}}*.",
    footerText: "{{store_name}}",
    buttonType: "CTA_URL",
    buttonText: "🛍️ Shop New Arrivals",
    buttonUrl: "{{checkout_url}}",
    isActive: false,
  },
];

/**
 * Ensures default templates exist for a merchant in the database.
 */
export async function seedDefaultTemplates(merchantId: string) {
  for (const tpl of DEFAULT_TEMPLATES) {
    const existing = await db.template.findFirst({
      where: { merchantId, eventType: tpl.eventType },
    });

    if (!existing) {
      await db.template.create({
        data: {
          merchantId,
          eventType: tpl.eventType,
          name: tpl.name,
          language: tpl.language,
          headerType: tpl.headerType,
          headerText: tpl.headerText,
          headerMediaUrl: tpl.headerMediaUrl,
          bodyText: tpl.bodyText,
          footerText: tpl.footerText,
          buttonType: tpl.buttonType,
          buttonText: tpl.buttonText,
          buttonUrl: tpl.buttonUrl,
          isActive: tpl.isActive,
        },
      });
    }
  }
}
