import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { sendWhatsAppMessage } from "./meta-whatsapp.server";
import { interpolateVariables, seedDefaultTemplates } from "./template.server";
import { createDynamicOneTimeDiscount } from "./shopify-discount.server";
import { logInfo, logWarn, logError } from "./logger.server";

export interface JobPayload {
  recipientPhone: string;
  customerName?: string;
  eventType: string;
  templateVariables: Record<string, string | undefined>;
  checkoutToken?: string; // For cart recovery cancellation checks
  orderId?: string;
}

/**
 * Adds an async job to the PostgreSQL queue (storeping_Job).
 * @param merchantId Merchant ID
 * @param jobType e.g. "SEND_WHATSAPP" | "CART_RECOVERY"
 * @param payload Job payload data
 * @param delayMinutes Minutes to delay execution (0 = immediate)
 */
export async function enqueueJob(
  merchantId: string,
  jobType: string,
  payload: JobPayload,
  delayMinutes = 0
) {
  const runAt = new Date(Date.now() + delayMinutes * 60 * 1000);

  const job = await db.job.create({
    data: {
      merchantId,
      jobType,
      payload: payload as any,
      status: "PENDING",
      runAt,
    },
  });

  return job;
}

/**
 * Automatically cancels pending recovery jobs when a customer completes checkout or places an order.
 */
export async function cancelCartRecoveryJobs(merchantId: string, checkoutToken: string) {
  try {
    // 1. Mark CartRecovery record as RECOVERED
    await db.cartRecovery.updateMany({
      where: { merchantId, checkoutToken },
      data: { status: "RECOVERED", recoveredAt: new Date() },
    });

    // 2. Find and cancel pending jobs
    const pendingJobs = await db.job.findMany({
      where: {
        merchantId,
        status: "PENDING",
      },
    });

    const jobsToCancel = pendingJobs.filter((job) => {
      const p = job.payload as any;
      return p?.checkoutToken === checkoutToken;
    });

    if (jobsToCancel.length > 0) {
      await db.job.updateMany({
        where: { id: { in: jobsToCancel.map((j) => j.id) } },
        data: { status: "CANCELLED" },
      });

      await logInfo(`Cancelled ${jobsToCancel.length} pending recovery jobs for completed checkout`, {
        source: "queue",
        details: { checkoutToken },
      });
    }
  } catch (err: any) {
    await logWarn(`Error cancelling recovery jobs: ${err.message}`, { source: "queue" });
  }
}

/**
 * Processes all pending jobs whose scheduled runAt <= now().
 * Can be called via cron endpoint or background worker runner.
 */
export async function processPendingJobs(limit = 20) {
  const now = new Date();

  // Find due jobs
  const pendingJobs = await db.job.findMany({
    where: {
      status: "PENDING",
      runAt: { lte: now },
    },
    include: {
      merchant: true,
    },
    take: limit,
    orderBy: { runAt: "asc" },
  });

  if (pendingJobs.length === 0) return { processed: 0 };

  let processedCount = 0;

  for (const job of pendingJobs) {
    // Lock job status
    await db.job.update({
      where: { id: job.id },
      data: { status: "PROCESSING", attempts: { increment: 1 } },
    });

    const payload = job.payload as any as JobPayload;
    const { merchant } = job;

    if (!merchant || !merchant.isWhatsAppConnected) {
      await db.job.update({
        where: { id: job.id },
        data: { status: "FAILED", error: "Merchant not found or WhatsApp disconnected." },
      });
      continue;
    }

    // Ensure templates exist
    await seedDefaultTemplates(merchant.id);

    // If this is a cart recovery job, check if already completed/cancelled
    if (payload.checkoutToken) {
      const cart = await db.cartRecovery.findUnique({
        where: { checkoutToken: payload.checkoutToken },
      });

      if (cart && (cart.status === "RECOVERED" || cart.status === "CANCELLED")) {
        await db.job.update({
          where: { id: job.id },
          data: { status: "CANCELLED" },
        });
        continue;
      }
    }

    // If this is a CART_RECOVERY_2 job and merchant uses dynamic single-use coupons, generate the code in Shopify
    if (
      payload.eventType === "CART_RECOVERY_2" &&
      merchant.cartRecoveryStrategy === "DYNAMIC_ONETIME"
    ) {
      try {
        const { admin } = await unauthenticated.admin(merchant.shop);
        if (admin) {
          const dynamicResult = await createDynamicOneTimeDiscount(admin, {
            prefix: merchant.cartDiscountPrefix || "CART",
            percent: merchant.cartDiscountPercent || 10,
            expiryHours: merchant.cartDiscountExpiryHours || 24,
            checkoutToken: payload.checkoutToken,
          });

          if (dynamicResult.success && dynamicResult.code) {
            payload.templateVariables.discount_code = dynamicResult.code;

            // Append discount to checkout URL
            const rawUrl = payload.templateVariables.checkout_url || `https://${merchant.shop}/checkout`;
            const cleanUrl = rawUrl.replace(/([?&])discount=[^&]*/g, "").replace(/[?&]$/, "");
            payload.templateVariables.checkout_url = `${cleanUrl}${cleanUrl.includes("?") ? "&" : "?"}discount=${encodeURIComponent(dynamicResult.code)}`;

            // Update CartRecovery tracking record
            if (payload.checkoutToken) {
              await db.cartRecovery.updateMany({
                where: { merchantId: merchant.id, checkoutToken: payload.checkoutToken },
                data: { discountCode: dynamicResult.code },
              });
            }
          }
        }
      } catch (discErr: any) {
        await logWarn(`Failed to generate dynamic discount for ${job.id}: ${discErr.message}`, {
          source: "queue",
        });
      }
    }

    // Find the active template for this event
    const template = await db.template.findFirst({
      where: {
        merchantId: merchant.id,
        eventType: payload.eventType,
        isActive: true,
      },
    });

    if (!template) {
      await db.job.update({
        where: { id: job.id },
        data: { status: "FAILED", error: `No active template found for ${payload.eventType}` },
      });
      continue;
    }

    // Interpolate dynamic template text
    const interpolatedBody = interpolateVariables(template.bodyText, payload.templateVariables);
    const interpolatedHeader = interpolateVariables(template.headerText, payload.templateVariables);
    const interpolatedButtonUrl = interpolateVariables(template.buttonUrl, payload.templateVariables);

    // Format buttons with order ID if applicable
    const orderNumber = payload.templateVariables?.order_number || payload.templateVariables?.order_id || "";
    const rawButtons = (template.buttons as any[]) || [];
    const formattedButtons = rawButtons.map((b) => {
      let btnId = b.id;
      if (btnId === "confirm_order" && orderNumber) btnId = `confirm_order_${orderNumber.replace(/[^a-zA-Z0-9]/g, "")}`;
      if (btnId === "update_address" && orderNumber) btnId = `update_address_${orderNumber.replace(/[^a-zA-Z0-9]/g, "")}`;
      if (btnId === "support_query" && orderNumber) btnId = `support_query_${orderNumber.replace(/[^a-zA-Z0-9]/g, "")}`;
      if (btnId === "confirm_cod" && orderNumber) btnId = `confirm_cod_${orderNumber.replace(/[^a-zA-Z0-9]/g, "")}`;
      if (btnId === "cancel_cod" && orderNumber) btnId = `cancel_cod_${orderNumber.replace(/[^a-zA-Z0-9]/g, "")}`;

      return {
        ...b,
        id: btnId,
        url: b.url ? interpolateVariables(b.url, payload.templateVariables) : undefined,
      };
    });

    // Send WhatsApp message
    const result = await sendWhatsAppMessage({
      merchantId: merchant.id,
      recipientPhone: payload.recipientPhone,
      customerName: payload.customerName,
      eventType: payload.eventType,
      bodyText: interpolatedBody,
      headerType: template.headerType,
      headerText: interpolatedHeader,
      headerMediaUrl: template.headerMediaUrl,
      footerText: template.footerText,
      buttonType: template.buttonType,
      buttonText: template.buttonText,
      buttonUrl: interpolatedButtonUrl,
      buttons: formattedButtons.length > 0 ? formattedButtons : undefined,
    });

    if (result.success) {
      await db.job.update({
        where: { id: job.id },
        data: { status: "COMPLETED", processedAt: new Date() },
      });
      processedCount++;
    } else {
      const isRateLimited = result.rateLimited || result.errorCode === 130429 || result.errorCode === 131056;
      const isExhausted = job.attempts + 1 >= (isRateLimited ? 6 : job.maxAttempts);

      const retryDelayMs = isRateLimited
        ? 15 * 60 * 1000 // 15-minute rate limit cooldown
        : 2 * (job.attempts + 1) * 60 * 1000;

      await db.job.update({
        where: { id: job.id },
        data: {
          status: isExhausted ? "FAILED" : "PENDING",
          error: result.error,
          runAt: isExhausted ? job.runAt : new Date(Date.now() + retryDelayMs),
        },
      });
    }
  }

  return { processed: processedCount, totalFound: pendingJobs.length };
}

/**
 * Manually cancels a scheduled or pending job.
 */
export async function cancelJobById(jobId: string, merchantId: string) {
  return await db.job.updateMany({
    where: { id: jobId, merchantId, status: { in: ["PENDING", "PROCESSING"] } },
    data: { status: "CANCELLED" },
  });
}

/**
 * Manually triggers a scheduled job immediately without waiting for delay timer.
 */
export async function runJobImmediately(jobId: string, merchantId: string) {
  await db.job.updateMany({
    where: { id: jobId, merchantId },
    data: { status: "PENDING", runAt: new Date() },
  });
  return await processPendingJobs(10);
}

/**
 * Retries a failed or halted job.
 */
export async function retryJobById(jobId: string, merchantId: string) {
  await db.job.updateMany({
    where: { id: jobId, merchantId },
    data: { status: "PENDING", attempts: 0, runAt: new Date(), error: null },
  });
  return await processPendingJobs(10);
}
