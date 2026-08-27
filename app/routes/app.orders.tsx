import { useState } from "react";
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  DataTable,
  Text,
  Button,
  Banner,
  Badge,
  BlockStack,
  InlineStack,
  TextField,
  Modal,
  FormLayout,
  Tabs,
  Box,
  Select,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { sendWhatsAppMessage } from "../utils/meta-whatsapp.server";
import { logInfo, logError } from "../utils/logger.server";
import { normalizePhoneNumber } from "../utils/phone.utils";
import { cancelJobById, runJobImmediately } from "../utils/queue.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const merchant = await db.merchant.findUnique({
    where: { shop },
  });

  let ordersList: any[] = [];
  let debugErrors: string[] = [];

  // 1. Fetch Placed / Completed Shopify Orders (e.g. #1001, #1002)
  try {
    const ordersRes = await admin.graphql(`
      #graphql
      query getOrdersForWhatsApp {
        orders(first: 50, sortKey: CREATED_AT, reverse: true) {
          nodes {
            id
            name
            createdAt
            phone
            currentTotalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            displayFinancialStatus
            displayFulfillmentStatus
            customer {
              displayName
              phone
              defaultPhoneNumber {
                phoneNumber
              }
            }
            shippingAddress {
              name
              phone
              city
            }
            billingAddress {
              phone
            }
            lineItems(first: 5) {
              nodes {
                title
                quantity
              }
            }
          }
        }
      }
    `);

    const ordersJson = await ordersRes.json();
    if (ordersJson.errors && ordersJson.errors.length > 0) {
      debugErrors.push(`Orders query: ${ordersJson.errors.map((e: any) => e.message).join(", ")}`);
    }

    if (ordersJson.data?.orders?.nodes) {
      const fetched = ordersJson.data.orders.nodes.map((node: any) => {
        const rawPhone =
          node.phone ||
          node.shippingAddress?.phone ||
          node.customer?.defaultPhoneNumber?.phoneNumber ||
          node.customer?.phone ||
          node.billingAddress?.phone ||
          "";
        const phone = normalizePhoneNumber(rawPhone);
        const customerName =
          node.customer?.displayName ||
          node.shippingAddress?.name ||
          "Customer";

        const items = (node.lineItems?.nodes || [])
          .map((li: any) => `${li.title} (x${li.quantity})`)
          .join(", ");

        return {
          id: node.id,
          orderNumber: node.name,
          createdAt: node.createdAt,
          total: `${node.currentTotalPriceSet?.shopMoney?.currencyCode || "INR"} ${node.currentTotalPriceSet?.shopMoney?.amount || "0.00"}`,
          totalAmount: node.currentTotalPriceSet?.shopMoney?.amount || "0.00",
          currency: node.currentTotalPriceSet?.shopMoney?.currencyCode || "INR",
          financialStatus: node.displayFinancialStatus || "PAID",
          fulfillmentStatus: node.displayFulfillmentStatus || "UNFULFILLED",
          customerName,
          phone,
          items,
          isDraft: false,
        };
      });
      ordersList.push(...fetched);
    }
  } catch (err: any) {
    debugErrors.push(`Orders fetch error: ${err.message}`);
  }

  // 2. Fetch Draft Orders (e.g. #D1, #D2)
  try {
    const draftRes = await admin.graphql(`
      #graphql
      query getDraftOrdersForWhatsApp {
        draftOrders(first: 50, reverse: true) {
          nodes {
            id
            name
            createdAt
            phone
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            status
            customer {
              displayName
              phone
              defaultPhoneNumber {
                phoneNumber
              }
            }
            shippingAddress {
              name
              phone
              city
            }
            billingAddress {
              phone
            }
            lineItems(first: 5) {
              nodes {
                title
                quantity
              }
            }
          }
        }
      }
    `);

    const draftJson = await draftRes.json();
    if (draftJson.errors && draftJson.errors.length > 0) {
      debugErrors.push(`Draft orders query: ${draftJson.errors.map((e: any) => e.message).join(", ")}`);
    }

    if (draftJson.data?.draftOrders?.nodes) {
      const fetchedDrafts = draftJson.data.draftOrders.nodes.map((node: any) => {
        const rawPhone =
          node.phone ||
          node.shippingAddress?.phone ||
          node.customer?.defaultPhoneNumber?.phoneNumber ||
          node.customer?.phone ||
          node.billingAddress?.phone ||
          "";
        const phone = normalizePhoneNumber(rawPhone);
        const customerName =
          node.customer?.displayName ||
          node.shippingAddress?.name ||
          "Customer";

        const items = (node.lineItems?.nodes || [])
          .map((li: any) => `${li.title} (x${li.quantity})`)
          .join(", ");

        return {
          id: node.id,
          orderNumber: node.name,
          createdAt: node.createdAt,
          total: `${node.totalPriceSet?.shopMoney?.currencyCode || "INR"} ${node.totalPriceSet?.shopMoney?.amount || "0.00"}`,
          totalAmount: node.totalPriceSet?.shopMoney?.amount || "0.00",
          currency: node.totalPriceSet?.shopMoney?.currencyCode || "INR",
          financialStatus: node.status === "COMPLETED" ? "COMPLETED" : "OPEN (DRAFT)",
          fulfillmentStatus: "DRAFT",
          customerName,
          phone,
          items,
          isDraft: true,
        };
      });
      ordersList.push(...fetchedDrafts);
    }
  } catch (err: any) {
    debugErrors.push(`Draft orders error: ${err.message}`);
  }

  // Sort combined orders by date descending
  ordersList.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  // 3. Fetch Abandoned Carts from Database
  const abandonedCarts = merchant
    ? await db.cartRecovery.findMany({
        where: { merchantId: merchant.id },
        orderBy: { createdAt: "desc" },
        take: 30,
      })
    : [];

  // 4. Fetch Active Automation Jobs
  const activeJobs = merchant
    ? await db.job.findMany({
        where: { merchantId: merchant.id },
        orderBy: { createdAt: "desc" },
        take: 20,
      })
    : [];

  return json({
    shop,
    isWhatsAppConnected: merchant?.isWhatsAppConnected ?? false,
    orders: ordersList,
    abandonedCarts,
    activeJobs,
    debugErrors,
  });
}

export type ActionData = {
  success?: boolean;
  error?: string;
  phone?: string;
  orderNumber?: string;
  recovered?: boolean;
  message?: string;
};

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const merchant = await db.merchant.findUnique({ where: { shop } });
  if (!merchant || !merchant.isWhatsAppConnected) {
    return json<ActionData>({ success: false, error: "WhatsApp Business Account is not connected." }, { status: 400 });
  }

  // 1. Manual WhatsApp Send for Order
  if (intent === "sendOrderWhatsApp") {
    const orderNumber = formData.get("orderNumber") as string;
    const customerName = (formData.get("customerName") as string) || "Valued Customer";
    const totalAmount = (formData.get("totalAmount") as string) || "0.00";
    const currency = (formData.get("currency") as string) || "INR";
    const eventType = (formData.get("eventType") as string) || "ORDER_CONFIRM";
    let recipientPhone = ((formData.get("phone") as string) || "").trim();

    if (!recipientPhone) {
      return json<ActionData>({ success: false, error: "Please provide a valid customer phone number." }, { status: 400 });
    }

    let cleanPhone = recipientPhone.replace(/[^0-9]/g, "");
    if (cleanPhone.length === 10) cleanPhone = `91${cleanPhone}`;

    let bodyText = "";
    if (eventType === "ORDER_CONFIRM") {
      bodyText = `🎉 Hi ${customerName}, your order ${orderNumber} for ${currency} ${totalAmount} is confirmed! Thank you for shopping with ${merchant.name || shop}.`;
    } else if (eventType === "ORDER_SHIPPED") {
      bodyText = `🚚 Great news ${customerName}! Your order ${orderNumber} has been shipped and is on its way. Track your package updates right here on WhatsApp.`;
    } else if (eventType === "ORDER_DELIVERED") {
      bodyText = `📦 Order Delivered! Hi ${customerName}, your package for order ${orderNumber} has been delivered. We hope you love your purchase! ✨`;
    } else {
      bodyText = `Hello ${customerName}, here is an update regarding your order ${orderNumber}.`;
    }

    try {
      const result = await sendWhatsAppMessage({
        merchantId: merchant.id,
        recipientPhone: cleanPhone,
        customerName,
        eventType,
        bodyText,
        senderRole: "MERCHANT",
      });

      if (!result.success) {
        return json<ActionData>({ success: false, error: result.error || "Failed to dispatch WhatsApp message" }, { status: 500 });
      }

      await logInfo(`Manual WhatsApp notification sent for order ${orderNumber} to ${cleanPhone}`, {
        shop,
        source: "manual-order",
      });

      return json<ActionData>({
        success: true,
        orderNumber,
        phone: cleanPhone,
        message: `WhatsApp notification successfully delivered to +${cleanPhone}!`,
      });
    } catch (err: any) {
      return json<ActionData>({ success: false, error: err.message }, { status: 500 });
    }
  }

  // 2. Manual WhatsApp Send for Abandoned Cart
  if (intent === "sendCartRecovery") {
    const customerName = (formData.get("customerName") as string) || "there";
    const checkoutUrl = (formData.get("checkoutUrl") as string) || `https://${shop}/checkout`;
    const discountCode = (formData.get("discountCode") as string) || "SAVE10";
    let recipientPhone = ((formData.get("phone") as string) || "").trim();

    if (!recipientPhone) {
      return json<ActionData>({ success: false, error: "Please enter a valid phone number for cart recovery." }, { status: 400 });
    }

    let cleanPhone = recipientPhone.replace(/[^0-9]/g, "");
    if (cleanPhone.length === 10) cleanPhone = `91${cleanPhone}`;

    const bodyText = `🛒 Hey ${customerName}, you left items in your shopping cart at ${merchant.name || shop}! Use code ${discountCode} for 10% off your order: ${checkoutUrl}`;

    try {
      const result = await sendWhatsAppMessage({
        merchantId: merchant.id,
        recipientPhone: cleanPhone,
        customerName,
        eventType: "CART_RECOVERY_1",
        bodyText,
        senderRole: "MERCHANT",
      });

      if (!result.success) {
        return json<ActionData>({ success: false, error: result.error || "Failed to send cart recovery" }, { status: 500 });
      }

      return json<ActionData>({
        success: true,
        phone: cleanPhone,
        recovered: true,
        message: `Cart recovery message sent to +${cleanPhone}!`,
      });
    } catch (err: any) {
      return json<ActionData>({ success: false, error: err.message }, { status: 500 });
    }
  }

  // 3. Stop/Cancel Job
  if (intent === "cancelJob") {
    const jobId = formData.get("jobId") as string;
    await cancelJobById(jobId, merchant.id);
    return json<ActionData>({ success: true, message: "Automation message stopped successfully." });
  }

  // 4. Run Job Now
  if (intent === "runJobNow") {
    const jobId = formData.get("jobId") as string;
    await runJobImmediately(jobId, merchant.id);
    return json<ActionData>({ success: true, message: "Automation message triggered immediately!" });
  }

  return json<ActionData>({ success: true });
}

export default function OrdersManualPage() {
  const { isWhatsAppConnected, orders, abandonedCarts, debugErrors } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const navigate = useNavigate();

  const [selectedTab, setSelectedTab] = useState(0);

  // Modal State for Order WhatsApp Send
  const [isOrderModalOpen, setIsOrderModalOpen] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<any>(null);
  const [customPhone, setCustomPhone] = useState("");
  const [selectedEventType, setSelectedEventType] = useState("ORDER_CONFIRM");

  // Modal State for Cart Recovery Send
  const [isCartModalOpen, setIsCartModalOpen] = useState(false);
  const [selectedCart, setSelectedCart] = useState<any>(null);
  const [cartPhone, setCartPhone] = useState("");

  const isSubmitting = fetcher.state !== "idle";

  const handleOpenOrderModal = (order: any, eventType = "ORDER_CONFIRM") => {
    setSelectedOrder(order);
    setSelectedEventType(eventType);
    setCustomPhone(order.phone || "");
    setIsOrderModalOpen(true);
  };

  const handleSendOrderWhatsApp = () => {
    if (!selectedOrder || !customPhone.trim()) return;
    const form = new FormData();
    form.append("intent", "sendOrderWhatsApp");
    form.append("orderNumber", selectedOrder.orderNumber);
    form.append("customerName", selectedOrder.customerName);
    form.append("totalAmount", selectedOrder.totalAmount);
    form.append("currency", selectedOrder.currency);
    form.append("eventType", selectedEventType);
    form.append("phone", customPhone.trim());
    fetcher.submit(form, { method: "POST" });
    setIsOrderModalOpen(false);
  };

  const handleOpenCartModal = (cart: any) => {
    setSelectedCart(cart);
    setCartPhone(cart.customerPhone || "");
    setIsCartModalOpen(true);
  };

  const handleSendCartWhatsApp = () => {
    if (!selectedCart || !cartPhone.trim()) return;
    const form = new FormData();
    form.append("intent", "sendCartRecovery");
    form.append("customerName", selectedCart.customerName);
    form.append("checkoutUrl", selectedCart.checkoutUrl);
    form.append("discountCode", selectedCart.discountCode || "SAVE10");
    form.append("phone", cartPhone.trim());
    fetcher.submit(form, { method: "POST" });
    setIsCartModalOpen(false);
  };

  const tabs = [
    { id: "orders", content: `📦 Shopify Orders & Drafts (${orders.length})` },
    { id: "carts", content: `🛒 Abandoned Checkouts (${abandonedCarts.length})` },
  ];

  const orderRows = orders.map((order: any) => [
    <InlineStack gap="100" blockAlign="center" key={order.id}>
      <Text as="span" variant="bodySm" fontWeight="bold">
        {order.orderNumber}
      </Text>
      {order.isDraft && <Badge tone="info">Draft</Badge>}
    </InlineStack>,
    <Text as="span" variant="bodySm" key={`cust-${order.id}`}>
      {order.customerName}
    </Text>,
    order.phone ? (
      <Badge tone="success" key={`phone-${order.id}`}>{`+${order.phone}`}</Badge>
    ) : (
      <Badge tone="warning" key={`phone-${order.id}`}>No phone attached</Badge>
    ),
    <Text as="span" variant="bodySm" key={`total-${order.id}`}>
      {order.total}
    </Text>,
    <Badge
      key={`status-${order.id}`}
      tone={order.financialStatus === "PAID" || order.financialStatus === "COMPLETED" ? "success" : "attention"}
    >
      {order.financialStatus}
    </Badge>,
    <InlineStack gap="150" key={`actions-${order.id}`}>
      <Button
        size="slim"
        variant="primary"
        onClick={() => handleOpenOrderModal(order, "ORDER_CONFIRM")}
      >
        📲 Send Confirmation
      </Button>
      <Button
        size="slim"
        onClick={() => handleOpenOrderModal(order, "ORDER_SHIPPED")}
      >
        🚚 Send Tracking
      </Button>
      {order.phone && (
        <Button
          size="slim"
          onClick={() => navigate(`/app/inbox?phone=${order.phone.replace(/[^0-9]/g, "")}`)}
        >
          💬 Chat
        </Button>
      )}
    </InlineStack>,
  ]);

  const cartRows = abandonedCarts.map((cart: any) => [
    <Text as="span" variant="bodySm" fontWeight="bold" key={cart.id}>
      {cart.customerName || "Customer"}
    </Text>,
    <Badge tone="success" key={`phone-${cart.id}`}>{`+${cart.customerPhone}`}</Badge>,
    <Text as="span" variant="bodySm" key={`total-${cart.id}`}>
      {cart.currency} {parseFloat(cart.cartTotal).toFixed(2)}
    </Text>,
    <Badge tone={cart.status === "RECOVERED" ? "success" : "attention"} key={`status-${cart.id}`}>
      {cart.status}
    </Badge>,
    <Text as="span" variant="bodyXs" tone="subdued" key={`date-${cart.id}`}>
      {new Date(cart.createdAt).toLocaleDateString()}
    </Text>,
    <InlineStack gap="150" key={`actions-${cart.id}`}>
      <Button
        size="slim"
        variant="primary"
        onClick={() => handleOpenCartModal(cart)}
      >
        🛒 1-Click Recovery
      </Button>
      {cart.customerPhone && (
        <Button
          size="slim"
          onClick={() => navigate(`/app/inbox?phone=${cart.customerPhone.replace(/[^0-9]/g, "")}`)}
        >
          💬 Chat
        </Button>
      )}
    </InlineStack>,
  ]);

  return (
    <Page
      title="Orders & Manual WhatsApp Outreach"
      subtitle="Send 1-click WhatsApp order confirmations, delivery tracking, and abandoned cart recoveries manually or automatically."
    >
      <BlockStack gap="400">
        {fetcher.data?.message && (
          <Banner title="Action Successful" tone="success">
            <p>{fetcher.data.message}</p>
          </Banner>
        )}

        {fetcher.data?.error && (
          <Banner title="Delivery Notice" tone="critical">
            <p>{fetcher.data.error}</p>
          </Banner>
        )}

        {debugErrors && debugErrors.length > 0 && (
          <Banner title="Shopify API Scope Notice" tone="info">
            <p>{debugErrors.join(" | ")}</p>
          </Banner>
        )}

        {!isWhatsAppConnected && (
          <Banner title="WhatsApp Not Connected" tone="warning" action={{ content: "Connect WhatsApp", url: "/app/connect" }}>
            <p>Please connect your WhatsApp Business Account to enable 1-click order notifications.</p>
          </Banner>
        )}

        <Layout>
          <Layout.Section>
            <Card padding="0">
              <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
                <Box padding="300">
                  {selectedTab === 0 ? (
                    orderRows.length === 0 ? (
                      <Box padding="600">
                        <Text as="p" tone="subdued" alignment="center">
                          No orders or draft orders found in Shopify yet.
                        </Text>
                      </Box>
                    ) : (
                      <DataTable
                        columnContentTypes={["text", "text", "text", "text", "text", "text"]}
                        headings={["Order / Draft", "Customer", "Mobile Phone", "Total", "Status", "1-Click WhatsApp Actions"]}
                        rows={orderRows}
                      />
                    )
                  ) : cartRows.length === 0 ? (
                    <Box padding="600">
                      <Text as="p" tone="subdued" alignment="center">
                        No abandoned checkouts recorded yet. When a customer leaves items in checkout, they will appear here!
                      </Text>
                    </Box>
                  ) : (
                    <DataTable
                      columnContentTypes={["text", "text", "text", "text", "text", "text"]}
                      headings={["Customer", "Mobile Phone", "Cart Value", "Status", "Date", "1-Click WhatsApp Recovery"]}
                      rows={cartRows}
                    />
                  )}
                </Box>
              </Tabs>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>

      {/* Manual Order WhatsApp Send Modal */}
      <Modal
        open={isOrderModalOpen}
        onClose={() => setIsOrderModalOpen(false)}
        title={`📲 Send WhatsApp for ${selectedOrder?.orderNumber || "Order"}`}
        primaryAction={{
          content: "🚀 Send WhatsApp Message",
          onAction: handleSendOrderWhatsApp,
          loading: isSubmitting,
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: () => setIsOrderModalOpen(false),
          },
        ]}
      >
        <Modal.Section>
          <FormLayout>
            <Text as="p" variant="bodySm">
              Customer: <b>{selectedOrder?.customerName}</b> • Total: <b>{selectedOrder?.total}</b>
            </Text>
            <Select
              label="Notification Type"
              options={[
                { label: "🧾 Order Confirmation", value: "ORDER_CONFIRM" },
                { label: "🚚 Shipping & Tracking Update", value: "ORDER_SHIPPED" },
                { label: "📦 Order Delivery & Review", value: "ORDER_DELIVERED" },
              ]}
              value={selectedEventType}
              onChange={setSelectedEventType}
            />
            <TextField
              label="Recipient WhatsApp Mobile Phone"
              placeholder="+91 9374626600"
              value={customPhone}
              onChange={setCustomPhone}
              autoComplete="off"
              helpText="Auto-populated from Shopify customer/shipping address. You can also edit it before sending."
            />
            <Text as="p" variant="bodyXs" tone="subdued">
              Message will be sent via pre-approved WhatsApp notification template and logged in your Live Inbox.
            </Text>
          </FormLayout>
        </Modal.Section>
      </Modal>

      {/* Manual Cart Recovery Send Modal */}
      <Modal
        open={isCartModalOpen}
        onClose={() => setIsCartModalOpen(false)}
        title="🛒 Send WhatsApp Abandoned Cart Recovery"
        primaryAction={{
          content: "🚀 Send Cart Recovery Message",
          onAction: handleSendCartWhatsApp,
          loading: isSubmitting,
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: () => setIsCartModalOpen(false),
          },
        ]}
      >
        <Modal.Section>
          <FormLayout>
            <Text as="p" variant="bodySm">
              Customer: <b>{selectedCart?.customerName || "Customer"}</b> • Value: <b>{selectedCart?.currency} {selectedCart?.cartTotal}</b>
            </Text>
            <TextField
              label="Customer WhatsApp Number"
              placeholder="+91 9374626600"
              value={cartPhone}
              onChange={setCartPhone}
              autoComplete="off"
              helpText="Include country code (e.g. +91 9374626600)."
            />
            <Text as="p" variant="bodyXs" tone="subdued">
              Includes a 1-click checkout recovery link with discount code <b>{selectedCart?.discountCode || "SAVE10"}</b>.
            </Text>
          </FormLayout>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
