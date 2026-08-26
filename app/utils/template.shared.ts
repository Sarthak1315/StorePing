export interface TemplateVariables {
  customer_name?: string;
  order_id?: string;
  order_number?: string;
  total_amount?: string;
  currency?: string;
  cart_items?: string;
  tracking_url?: string;
  carrier?: string;
  discount_code?: string;
  checkout_url?: string;
  store_name?: string;
  [key: string]: string | undefined;
}

/**
 * Replaces dynamic variables in text like {{customer_name}} with real values.
 * Safe to use in both browser/client UI and server.
 */
export function interpolateVariables(
  templateText: string | null | undefined,
  vars: TemplateVariables
): string {
  if (!templateText) return "";

  return templateText.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    return vars[key] || "";
  });
}
