import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { processPendingJobs } from "../utils/queue.server";
import { logInfo, logError } from "../utils/logger.server";

/**
 * Cron trigger endpoint to process pending WhatsApp queue jobs.
 * Protected by CRON_SECRET or session.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret");
  const expectedSecret = process.env.CRON_SECRET || "storeping_cron_secret_worker_auth_key_2026";

  if (secret !== expectedSecret && process.env.NODE_ENV === "production") {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await processPendingJobs(25);
    return json({ success: true, timestamp: new Date().toISOString(), ...result });
  } catch (err: any) {
    await logError(`Queue cron processing failed: ${err.message}`, { source: "cron" });
    return json({ success: false, error: err.message }, { status: 500 });
  }
};
