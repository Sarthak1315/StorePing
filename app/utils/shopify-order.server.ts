import { unauthenticated } from "../shopify.server";
import db from "../db.server";
import { logInfo, logError, logWarn } from "./logger.server";
import { logShopifyApiCall } from "./shopify-audit.server";

export interface SyncOrderToShopifyOptions {
  shop: string;
  orderId?: string | null;
  orderNumber: string;
  status: "CONFIRMED" | "UPDATE_REQUESTED";
  customerNotes?: string | null;
}

/**
 * Updates an order in Shopify Admin with WhatsApp verification tags and customer notes.
 * Automatically handles GraphQL GID resolution, note appending, and tag updates.
 */
export async function syncOrderUpdateToShopify(options: SyncOrderToShopifyOptions) {
  const { shop, orderId, orderNumber, status, customerNotes } = options;
  const startTime = Date.now();

  try {
    const { admin } = await unauthenticated.admin(shop);
    if (!admin) {
      await logWarn(`Cannot sync order to Shopify: No admin client for shop ${shop}`, {
        shop,
        source: "shopify-sync",
      });
      return { success: false, error: "No admin client available" };
    }

    let targetGid = orderId;

    // Format target GID if numeric
    if (targetGid && /^\d+$/.test(targetGid)) {
      targetGid = `gid://shopify/Order/${targetGid}`;
    }

    // If targetGid is missing or not a full GID, search by order name/number
    if (!targetGid || !targetGid.startsWith("gid://shopify/Order/")) {
      const cleanNum = orderNumber.replace(/^#/, "");
      const searchRes = await admin.graphql(
        `#graphql
        query findOrderByNumber($query: String!) {
          orders(first: 1, query: $query) {
            nodes {
              id
              name
              note
              tags
            }
          }
        }`,
        {
          variables: {
            query: `name:#${cleanNum} OR name:${cleanNum}`,
          },
        }
      );

      const searchJson = await searchRes.json();
      const foundOrder = searchJson.data?.orders?.nodes?.[0];
      if (foundOrder?.id) {
        targetGid = foundOrder.id;
      }
    }

    if (!targetGid) {
      await logWarn(`Could not locate Shopify Order GID for order ${orderNumber}`, {
        shop,
        source: "shopify-sync",
      });
      return { success: false, error: `Order ${orderNumber} not found in Shopify` };
    }

    // Fetch current order's note and tags
    const currentOrderRes = await admin.graphql(
      `#graphql
      query getOrderDetails($id: ID!) {
        order(id: $id) {
          id
          name
          note
          tags
        }
      }`,
      {
        variables: { id: targetGid },
      }
    );

    const currentOrderJson = await currentOrderRes.json();
    const currentOrder = currentOrderJson.data?.order;
    const existingNote = currentOrder?.note || "";
    const existingTags: string[] = currentOrder?.tags || [];

    const nowStr = new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      dateStyle: "medium",
      timeStyle: "short",
    });

    let newTags = [...existingTags];
    let noteAddition = "";

    if (status === "CONFIRMED") {
      // Add confirmed tags, remove pending/update tags
      newTags = newTags.filter(
        (t) => t !== "Address Update Requested" && t !== "WhatsApp Update Needed"
      );
      if (!newTags.includes("WhatsApp Confirmed")) newTags.push("WhatsApp Confirmed");
      if (!newTags.includes("Address Confirmed")) newTags.push("Address Confirmed");

      noteAddition = `\n\n[StorePing] ✅ Delivery address verified by customer via WhatsApp on ${nowStr}.`;
    } else if (status === "UPDATE_REQUESTED") {
      // Add update requested tags
      if (!newTags.includes("Address Update Requested")) newTags.push("Address Update Requested");
      if (!newTags.includes("WhatsApp Action Needed")) newTags.push("WhatsApp Action Needed");

      if (customerNotes) {
        noteAddition = `\n\n[StorePing] ⚠️ Customer updated delivery details via WhatsApp on ${nowStr}:\n"${customerNotes}"`;
      } else {
        noteAddition = `\n\n[StorePing] ⚠️ Customer requested address/contact change via WhatsApp on ${nowStr}. Awaiting customer input.`;
      }
    }

    // Append to note if not already present
    let updatedNote = existingNote;
    if (noteAddition && !existingNote.includes(noteAddition.trim())) {
      updatedNote = existingNote ? `${existingNote}${noteAddition}` : noteAddition.trim();
    }

    // Execute orderUpdate mutation in Shopify Admin
    const updateRes = await admin.graphql(
      `#graphql
      mutation updateShopifyOrderNoteAndTags($input: OrderInput!) {
        orderUpdate(input: $input) {
          order {
            id
            name
            note
            tags
          }
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          input: {
            id: targetGid,
            note: updatedNote,
            tags: newTags,
          },
        },
      }
    );

    const updateJson = await updateRes.json();
    const userErrors = updateJson.data?.orderUpdate?.userErrors || [];
    const durationMs = Date.now() - startTime;

    if (userErrors.length > 0) {
      const errorMsg = userErrors.map((e: any) => e.message).join(", ");
      await logShopifyApiCall({
        shop,
        topic: "admin/graphql:orderUpdate",
        apiType: "GRAPHQL",
        httpMethod: "GRAPHQL",
        statusCode: 400,
        durationMs,
        status: "FAILED",
        requestPayload: { targetGid, tags: newTags, note: updatedNote },
        responseBody: updateJson,
        errorMessage: errorMsg,
        initiatedBy: "APP_ORDERS_SYNC",
      });

      await logWarn(`Shopify orderUpdate userErrors for ${orderNumber}: ${errorMsg}`, {
        shop,
        source: "shopify-sync",
      });
      return { success: false, error: errorMsg };
    }

    await logShopifyApiCall({
      shop,
      topic: "admin/graphql:orderUpdate",
      apiType: "GRAPHQL",
      httpMethod: "GRAPHQL",
      statusCode: 200,
      durationMs,
      status: "SUCCESS",
      requestPayload: { targetGid, tags: newTags, note: updatedNote },
      responseBody: updateJson,
      initiatedBy: "APP_ORDERS_SYNC",
    });

    await logInfo(
      `Successfully synced order ${orderNumber} to Shopify Admin (Status: ${status}, Note updated, Tags: ${newTags.join(", ")})`,
      { shop, source: "shopify-sync" }
    );

    return {
      success: true,
      updatedOrder: updateJson.data?.orderUpdate?.order,
    };
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    await logShopifyApiCall({
      shop,
      topic: "admin/graphql:orderUpdate",
      apiType: "GRAPHQL",
      httpMethod: "GRAPHQL",
      statusCode: 500,
      durationMs,
      status: "FAILED",
      requestPayload: { orderId, orderNumber, status, customerNotes },
      errorMessage: err?.message || String(err),
      initiatedBy: "APP_ORDERS_SYNC",
    });

    await logError(`Failed to sync order update to Shopify: ${err.message}`, {
      shop,
      source: "shopify-sync",
    });
    return { success: false, error: err.message };
  }
}
