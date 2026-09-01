import db from "../db.server";
export * from "./template.shared";

export const DEFAULT_TEMPLATES = [
  {
    eventType: "ORDER_CONFIRM_ADDRESS",
    name: "Order & Delivery Address Confirmation (Interactive 3-Button)",
    category: "UTILITY",
    language: "en",
    headerType: "TEXT",
    headerText: "🧾 Order & Address Confirmation #{{order_number}}",
    headerMediaUrl: "",
    bodyText:
      "Hello {{customer_name}}! 🎉 Thank you for shopping with *{{store_name}}*.\n\n📦 *Order Summary:*\n• Order: *#{{order_number}}*\n• Total: *{{currency}} {{total_amount}}*\n• Items: {{cart_items}}\n\n📍 *Delivery Address:*\n{{shipping_address}}\n📞 Phone: *+{{customer_phone}}*\n\nPlease tap a button below to confirm your delivery address so we can dispatch your parcel immediately! 👇",
    footerText: "{{store_name}} • 1-Click Verification",
    buttonType: "MULTI_BUTTON",
    buttonText: "✅ Confirm Address",
    buttonUrl: "",
    buttons: [
      { id: "confirm_order", text: "✅ Confirm Address", type: "QUICK_REPLY" },
      { id: "update_address", text: "✏️ Update Address", type: "QUICK_REPLY" },
      { id: "support_query", text: "💬 Ask Query", type: "QUICK_REPLY" },
    ],
    isActive: true,
  },
  {
    eventType: "ORDER_CONFIRM",
    name: "Standard Order Placed Confirmation",
    category: "UTILITY",
    language: "en",
    headerType: "TEXT",
    headerText: "🧾 Order Confirmation #{{order_number}}",
    headerMediaUrl: "",
    bodyText:
      "Thank you for your order, {{customer_name}}! 🎉\n\nYour order *#{{order_number}}* for *{{currency}} {{total_amount}}* has been received and is being prepared.\n\nWe will notify you once your order is on its way with live tracking.",
    footerText: "{{store_name}}",
    buttonType: "CTA_URL",
    buttonText: "📄 View Order Details",
    buttonUrl: "{{tracking_url}}",
    buttons: [
      { id: "view_order", text: "📄 View Order Details", type: "CTA_URL", url: "{{tracking_url}}" },
    ],
    isActive: true,
  },
  {
    eventType: "COD_CONFIRM",
    name: "Cash on Delivery (COD) Verification",
    category: "UTILITY",
    language: "en",
    headerType: "TEXT",
    headerText: "💳 COD Order Verification #{{order_number}}",
    headerMediaUrl: "",
    bodyText:
      "Hi {{customer_name}}, we received your Cash on Delivery (COD) order *#{{order_number}}* of *{{currency}} {{total_amount}}* at *{{store_name}}*.\n\n📍 *Shipping to:*\n{{shipping_address}}\n\nPlease verify your COD order by clicking below so we can ship it right away! 👇",
    footerText: "{{store_name}} COD Security",
    buttonType: "MULTI_BUTTON",
    buttonText: "✅ Confirm COD Order",
    buttonUrl: "",
    buttons: [
      { id: "confirm_cod", text: "✅ Confirm COD Order", type: "QUICK_REPLY" },
      { id: "cancel_cod", text: "❌ Cancel Order", type: "QUICK_REPLY" },
      { id: "support_query", text: "💬 Need Help", type: "QUICK_REPLY" },
    ],
    isActive: true,
  },
  {
    eventType: "ORDER_SHIPPED",
    name: "Order Shipped & Live Tracking",
    category: "UTILITY",
    language: "en",
    headerType: "TEXT",
    headerText: "🚚 Your Order is On The Way!",
    headerMediaUrl: "",
    bodyText:
      "Great news, {{customer_name}}! 📦\n\nYour order *#{{order_number}}* from *{{store_name}}* has been shipped via *{{carrier}}*.\n\nClick below to track your delivery in real-time.",
    footerText: "{{store_name}} Tracking",
    buttonType: "CTA_URL",
    buttonText: "📍 Track Package",
    buttonUrl: "{{tracking_url}}",
    buttons: [
      { id: "track_package", text: "📍 Track Package", type: "CTA_URL", url: "{{tracking_url}}" },
    ],
    isActive: true,
  },
  {
    eventType: "ORDER_DELIVERED",
    name: "Order Delivered + Review Request",
    category: "UTILITY",
    language: "en",
    headerType: "TEXT",
    headerText: "📦 Order Delivered!",
    headerMediaUrl: "",
    bodyText:
      "Hi {{customer_name}}, your order *#{{order_number}}* from *{{store_name}}* was delivered successfully! 🎉\n\nWe hope you love your purchase. How was your experience? Here is a 10% VIP discount code *{{discount_code}}* for your next order!",
    footerText: "{{store_name}}",
    buttonType: "QUICK_REPLY",
    buttonText: "⭐ Rate Your Experience",
    buttonUrl: "",
    buttons: [
      { id: "rate_experience", text: "⭐ Rate Experience", type: "QUICK_REPLY" },
      { id: "support_query", text: "💬 Contact Support", type: "QUICK_REPLY" },
    ],
    isActive: true,
  },
  {
    eventType: "CART_RECOVERY_1",
    name: "Abandoned Cart Reminder (Step 1 - 30 min)",
    category: "MARKETING",
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
    buttons: [
      { id: "checkout_cart", text: "🛒 Complete Order", type: "CTA_URL", url: "{{checkout_url}}" },
    ],
    isActive: true,
  },
  {
    eventType: "CART_RECOVERY_2",
    name: "Abandoned Cart Urgency + 10% Discount (Step 2 - 6 hr)",
    category: "MARKETING",
    language: "en",
    headerType: "TEXT",
    headerText: "🎁 Special 10% Off Your Cart!",
    headerMediaUrl: "",
    bodyText:
      "Hey {{customer_name}}, we noticed you still haven't checked out your cart at *{{store_name}}*!\n\nUse exclusive coupon code *{{discount_code}}* at checkout to get an instant 10% discount.\n\n⏰ *Offer valid for the next 12 hours only!*",
    footerText: "Reply STOP to unsubscribe",
    buttonType: "CTA_URL",
    buttonText: "⚡ Claim 10% Off & Checkout",
    buttonUrl: "{{checkout_url}}",
    buttons: [
      { id: "claim_discount", text: "⚡ Claim 10% Off", type: "CTA_URL", url: "{{checkout_url}}" },
    ],
    isActive: true,
  },
  {
    eventType: "WIN_BACK",
    name: "Customer Win-Back (Inactive > 45 Days)",
    category: "MARKETING",
    language: "en",
    headerType: "TEXT",
    headerText: "💖 We Miss You at {{store_name}}!",
    headerMediaUrl: "",
    bodyText:
      "Hi {{customer_name}}, it's been a while since your last visit! ✨\n\nWe have added exciting new products to our collection. Enjoy a special welcome-back gift of 15% off with code *{{discount_code}}*.",
    footerText: "{{store_name}}",
    buttonType: "CTA_URL",
    buttonText: "🛍️ Shop New Arrivals",
    buttonUrl: "{{checkout_url}}",
    buttons: [
      { id: "shop_new", text: "🛍️ Shop New Arrivals", type: "CTA_URL", url: "{{checkout_url}}" },
    ],
    isActive: false,
  },
  {
    eventType: "SUPPORT_AUTO_REPLY",
    name: "24/7 Support Instant Auto-Greeting",
    category: "UTILITY",
    language: "en",
    headerType: "TEXT",
    headerText: "👋 Welcome to {{store_name}} Support",
    headerMediaUrl: "",
    bodyText:
      "Hi {{customer_name}}! Thanks for reaching out to *{{store_name}}* support. 😊\n\nWe have received your message and an agent will be with you shortly. If you are asking about an existing order, please provide your order number (e.g. #1002).",
    footerText: "{{store_name}} Team",
    buttonType: "NONE",
    buttonText: "",
    buttonUrl: "",
    buttons: [],
    isActive: true,
  },
];

/**
 * Ensures all default templates exist for a merchant in the database,
 * and updates existing templates if needed.
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
          category: tpl.category,
          language: tpl.language,
          headerType: tpl.headerType,
          headerText: tpl.headerText,
          headerMediaUrl: tpl.headerMediaUrl,
          bodyText: tpl.bodyText,
          footerText: tpl.footerText,
          buttonType: tpl.buttonType,
          buttonText: tpl.buttonText,
          buttonUrl: tpl.buttonUrl,
          buttons: tpl.buttons as any,
          isActive: tpl.isActive,
        },
      });
    }
  }
}
