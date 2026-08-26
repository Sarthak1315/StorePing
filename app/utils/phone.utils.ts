/**
 * Normalizes a phone number to standard E.164 without '+' or special characters.
 * Handles Indian numbers (10 digits starting with 6-9, prefixing '91' automatically).
 */
export function normalizePhoneNumber(phone: string | null | undefined, defaultCountryCode = "91"): string | null {
  if (!phone) return null;

  // Strip all non-digit characters
  let digits = phone.replace(/\D/g, "");

  if (!digits) return null;

  // Handle leading zeros (e.g. 09876543210 -> 9876543210)
  if (digits.startsWith("0")) {
    digits = digits.replace(/^0+/, "");
  }

  // If 10 digits (Standard Indian Mobile), prepend defaultCountryCode (91)
  if (digits.length === 10 && defaultCountryCode === "91") {
    digits = `91${digits}`;
  }

  // Basic length validation (international phone numbers typically 10 to 15 digits)
  if (digits.length < 10 || digits.length > 15) {
    return null;
  }

  return digits;
}

/**
 * Masks a phone number for DPDP compliant logging & UI previews.
 * e.g. "919876543210" -> "+91 98*** **210"
 */
export function maskPhoneNumber(phone: string | null | undefined): string {
  if (!phone) return "N/A";
  const cleaned = phone.replace(/\D/g, "");
  if (cleaned.length < 7) return "***";

  const prefix = cleaned.slice(0, 4);
  const suffix = cleaned.slice(-3);
  return `+${prefix}***${suffix}`;
}
