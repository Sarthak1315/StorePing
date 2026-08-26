import db from "../db.server";
import { logInfo, logWarn } from "./logger.server";

export const ITEMISED_PURPOSES = [
  {
    key: "abandoned_cart_recovery",
    title: "Abandoned Cart Reminders",
    description: "Processing abandoned checkout customer details and sending automated WhatsApp recovery reminders with 1-click checkout links.",
  },
  {
    key: "order_status_notifications",
    title: "Order & Shipping Notifications",
    description: "Processing customer order numbers and fulfillment tracking links to deliver real-time order confirmation, dispatch, and delivery alerts on WhatsApp.",
  },
  {
    key: "promotions_and_reengagement",
    title: "Promotional & Win-Back Messaging",
    description: "Delivering personalized discount offers and re-engagement campaigns to opted-in customers.",
  },
  {
    key: "meta_portfolio_connection",
    title: "Meta / WhatsApp Portfolio Management",
    description: "Securely storing encrypted WhatsApp Business API credentials to automate outbound WhatsApp notifications.",
  },
];

/**
 * Retrieves DPDP consent record for a shop.
 */
export async function getConsent(shop: string) {
  return await db.dPDPConsent.findUnique({
    where: { shop },
  });
}

/**
 * Saves or updates DPDP consent record with version, timestamp, IP, and purposes.
 */
export async function saveConsent(
  shop: string,
  data: {
    consented: boolean;
    purposes: string[];
    ipAddress?: string | null;
    userAgent?: string | null;
    consentVersion?: string;
  }
) {
  const purposesJson = JSON.stringify(data.purposes);

  const consent = await db.dPDPConsent.upsert({
    where: { shop },
    create: {
      shop,
      consented: data.consented,
      consentVersion: data.consentVersion || "v1.0",
      purposes: purposesJson,
      ipAddress: data.ipAddress || null,
      userAgent: data.userAgent || null,
      consentedAt: new Date(),
    },
    update: {
      consented: data.consented,
      consentVersion: data.consentVersion || "v1.0",
      purposes: purposesJson,
      ipAddress: data.ipAddress || null,
      userAgent: data.userAgent || null,
      withdrawnAt: data.consented ? null : new Date(),
      updatedAt: new Date(),
    },
  });

  await logInfo(`DPDP Consent ${data.consented ? "granted" : "updated"} for shop`, {
    shop,
    source: "dpdp",
    details: { version: consent.consentVersion, purposes: data.purposes },
  });

  return consent;
}

/**
 * Withdraws DPDP consent for a shop.
 */
export async function withdrawConsent(shop: string) {
  const consent = await db.dPDPConsent.update({
    where: { shop },
    data: {
      consented: false,
      withdrawnAt: new Date(),
    },
  });

  await logWarn("DPDP Consent withdrawn by merchant", { shop, source: "dpdp" });
  return consent;
}

/**
 * Exports all data associated with a shop in JSON format (DPDP Right to Data Portability).
 */
export async function exportUserData(shop: string) {
  const merchant = await db.merchant.findUnique({
    where: { shop },
    include: {
      templates: true,
      messages: { take: 100, orderBy: { createdAt: "desc" } },
      cartRecoveries: { take: 100, orderBy: { createdAt: "desc" } },
    },
  });

  const consent = await db.dPDPConsent.findUnique({ where: { shop } });
  const logs = await db.log.findMany({
    where: { shop },
    take: 50,
    orderBy: { createdAt: "desc" },
  });

  return {
    shop,
    exportedAt: new Date().toISOString(),
    complianceStandard: "DPDP Act 2023 / GDPR",
    consent,
    merchantSettings: merchant ? {
      ...merchant,
      waAccessToken: merchant.waAccessToken ? "[ENCRYPTED_TOKEN_STORED]" : null,
    } : null,
    recentMessages: merchant?.messages || [],
    recentCartRecoveries: merchant?.cartRecoveries || [],
    recentLogs: logs,
  };
}

/**
 * Permanently erases all data associated with a shop (DPDP Right to Erasure / GDPR Shop Redact).
 */
export async function eraseUserData(shop: string) {
  await logWarn("Initiating permanent DPDP/GDPR Data Erasure", { shop, source: "dpdp" });

  const merchant = await db.merchant.findUnique({ where: { shop } });
  if (merchant) {
    await db.job.deleteMany({ where: { merchantId: merchant.id } });
    await db.cartRecovery.deleteMany({ where: { merchantId: merchant.id } });
    await db.messageLog.deleteMany({ where: { merchantId: merchant.id } });
    await db.template.deleteMany({ where: { merchantId: merchant.id } });
    await db.merchant.delete({ where: { id: merchant.id } });
  }

  await db.session.deleteMany({ where: { shop } });
  await db.dPDPConsent.deleteMany({ where: { shop } });
  await db.log.deleteMany({ where: { shop } });

  return { success: true, message: `All data for ${shop} has been permanently erased.` };
}
