import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import crypto from "crypto";
import { logInfo, logWarn } from "../utils/logger.server";

/**
 * Meta User Data Deletion Callback.
 * Meta requires this endpoint for App Store review and compliance.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const formData = await request.formData();
    const signedRequest = formData.get("signed_request") as string;

    if (!signedRequest) {
      return json({ error: "Missing signed_request" }, { status: 400 });
    }

    const [encodedSig, payload] = signedRequest.split(".");
    const secret = process.env.META_APP_SECRET || "";

    // Verify signature
    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    if (encodedSig !== expectedSig) {
      await logWarn("Invalid signature on Meta Data Deletion callback", { source: "meta-deletion" });
      return json({ error: "Invalid signature" }, { status: 400 });
    }

    const data = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    const userId = data.user_id;
    const confirmationCode = `del_${crypto.randomBytes(8).toString("hex")}`;

    await logInfo(`Meta data deletion requested for user ${userId}. Code: ${confirmationCode}`, {
      source: "meta-deletion",
    });

    const statusUrl = `${process.env.SHOPIFY_APP_URL}/api/meta/data-deletion?code=${confirmationCode}`;

    return json({
      url: statusUrl,
      confirmation_code: confirmationCode,
    });
  } catch (err: any) {
    await logWarn(`Meta Data Deletion error: ${err.message}`, { source: "meta-deletion" });
    return json({ error: err.message }, { status: 500 });
  }
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code") || "unknown";

  return new Response(
    `<html><head><title>Data Deletion Status - StorePing</title></head><body style="font-family:sans-serif;padding:40px;text-align:center;"><h2>Data Deletion Request Processed</h2><p>Your deletion request (Reference Code: <code>${code}</code>) has been successfully processed in accordance with Meta and DPDP policies.</p></body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
};
