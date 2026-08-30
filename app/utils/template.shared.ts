export interface TemplateVariables {
  customer_name?: string;
  order_id?: string;
  order_number?: string;
  order_name?: string;
  total_amount?: string;
  total_price?: string;
  currency?: string;
  cart_items?: string;
  items?: string;
  shipping_address?: string;
  customer_phone?: string;
  payment_method?: string;
  tracking_url?: string;
  carrier?: string;
  tracking_number?: string;
  discount_code?: string;
  checkout_url?: string;
  store_name?: string;
  [key: string]: string | undefined;
}

export interface TemplateButtonItem {
  id: string;
  text: string;
  type: "QUICK_REPLY" | "CTA_URL";
  url?: string;
}

/**
 * Replaces dynamic variables in text like {{customer_name}} or {{shipping_address}} with real values.
 * Safe to use in both browser/client UI and server.
 */
export function interpolateVariables(
  templateText: string | null | undefined,
  vars: TemplateVariables
): string {
  if (!templateText) return "";

  return templateText.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    // Normalization fallbacks
    if (key === "total_price" && !vars.total_price && vars.total_amount) return vars.total_amount;
    if (key === "total_amount" && !vars.total_amount && vars.total_price) return vars.total_price;
    if (key === "order_name" && !vars.order_name && vars.order_number) return `#${vars.order_number.replace(/^#/, "")}`;
    if (key === "items" && !vars.items && vars.cart_items) return vars.cart_items;
    if (key === "cart_items" && !vars.cart_items && vars.items) return vars.items;

    return vars[key] !== undefined && vars[key] !== null ? vars[key]! : "";
  });
}
