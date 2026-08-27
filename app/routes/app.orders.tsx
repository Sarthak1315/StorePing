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
  Tag,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { sendWhatsAppMessage } from "../utils/meta-whatsapp.server";
import { logInfo, logError } from "../utils/logger.server";
import { normalizePhoneNumber } from "../utils/phone.utils";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const merchant = await db.merchant.findUnique({
    where: { shop },
  });

  // Fetch recent Shopify Orders via GraphQL
  let orders: any[] = [];
  try {
    const response = await admin.graphql(`
      #graphql
      query getOrdersForWhatsApp {
        orders(first: 30, sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              id
              name
              createdAt
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              displayFinancialStatus
              displayFulfillmentStatus
              customer {
                firstName
                lastName
                phone
                email
              }
              shippingAddress {
                phone
                name
                city
              }
              billingAddress {
                phone
              }
              lineItems(first: 5) {
                edges {
                  node {
                    title
                    quantity
                  }
                }
              }
            }
          }
        }
      }
    `);

    const resJson = await response.json();
    orders = resJson.data?.orders?.edges?.map((e: any) => {
      const node = e.node;
      const rawPhone =
        node.customer?.phone ||
        node.shippingAddress?.phone ||
        node.billingAddress?.phone ||
        "";
      const phone = normalizePhoneNumber(rawPhone);
      const customerName =
        node.customer?.firstName
          ? `${node.customer.firstName} ${node.customer.lastName || ""}`.trim()
          : node.shippingAddress?.name || "Customer";

      const items = node.lineItems?.edges
        ?.map((li: any) => `${li.node.title} (x${li.node.quantity})`)
        .join(", ");

      return {
        id: node.id,
        orderNumber: node.name,
        createdAt: node.createdAt,
        total: `${node.totalPriceSet?.shopMoney?.currencyCode || "INR"} ${node.totalPriceSet?.shopMoney?.amount || "0.00"}`,
        totalAmount: node.totalPriceSet?.shopMoney?.amount || "0.00",
        currency: node.totalPriceSet?.shopMoney?.currencyCode || "INR",
        financialStatus: node.displayFinancialStatus || "PAID",
        fulfillmentStatus: node.displayFulfillmentStatus || "UNFULFILLED",
        customerName,
        phone,
        items,
      };
    }) || [];
  } catch (err: any) {
    console.warn("Failed to fetch Shopify orders via GraphQL:", err.message);
  }

  // Fetch Abandoned Carts from Database
  const abandonedCarts = merchant
    ? await db.cartRecovery.findMany({
        where: { merchantId: merchant.id },
        orderBy: { createdAt: "desc" },
        take: 30,
      })
    : [];

  return json({
    shop,
    isWhatsAppConnected: merchant?.isWhatsAppConnected ?? false,
    orders,
    abandonedCarts,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const merchant = await db.merchant.findUnique({ where: { shop } });
  if (!merchant || !merchant.isWhatsAppConnected) {
    return json({ success: false, error: "WhatsApp Business Account is not connected." }, { status: 400 });
  }

  // 1. Manual WhatsApp Send for Order
  if (intent === "sendOrderWhatsApp") {
    const orderNumber = formData.get("orderNumber") as string;
    const customerName = formData.get("customerName") as string || "Valued Customer";
    const totalAmount = formData.get("totalAmount") as string || "0.00";
    const currency = formData.get("currency") as string || "INR";
    const eventType = (formData.get("eventType") as string) || "ORDER_CONFIRM";
    let recipientPhone = (formData.get("phone") as string || "").trim();

    if (!recipientPhone) {
      return json({ success: false, error: "Please provide a valid customer phone number." }, { status: 400 });
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
        return json({ success: false, error: result.error || "Failed to dispatch WhatsApp message" }, { status: 500 });
      }

      await logInfo(`Manual WhatsApp notification sent for order ${orderNumber} to ${cleanPhone}`, {
        shop,
        source: "manual-order",
      });

      return json({ success: true, orderNumber, phone: cleanPhone });
    } catch (err: any) {
      return json({ success: false, error: err.message }, { status: 500 });
    }
  }

  // 2. Manual WhatsApp Send for Abandoned Cart
  if (intent === "sendCartRecovery") {
    const customerName = formData.get("customerName") as string || "there";
    const checkoutUrl = formData.get("checkoutUrl") as string || `https://${shop}/checkout`;
    const discountCode = formData.get("discountCode") as string || "SAVE10";
    let recipientPhone = (formData.get("phone") as string || "").trim();

    if (!recipientPhone) {
      return json({ success: false, error: "Please enter a valid phone number for cart recovery." }, { status: 400 });
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
        return json({ success: false, error: result.error || "Failed to send cart recovery" }, { status: 500 });
      }

      return json({ success: true, phone: cleanPhone, recovered: true });
    } catch (err: any) {
      return json({ success: false, error: err.message }, { status: 500 });
    }
  }

  return json({ success: true });
}

export type ActionData = {
  success?: boolean;
  error?: string;
  phone?: string;
  orderNumber?: string;
  recovered?: boolean;
};

export default function OrdersManualPage() {
  const { isWhatsAppConnected, orders, abandonedCarts } = useLoaderData<typeof loader>();
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
    { id: "orders", content: `📦 Shopify Orders (${orders.length})` },
    { id: "carts", content: `🛒 Abandoned Checkouts (${abandonedCarts.length})` },
  ];

  const orderRows = orders.map((order: any) => [
    <Text as="span" variant="bodySm" fontWeight="bold">
      {order.orderNumber}
    </Text>,
    <Text as="span" variant="bodySm">
      {order.customerName}
    </Text>,
    order.phone ? (
      <Badge tone="success">{order.phone}</Badge>
    ) : (
      <Badge tone="warning">No phone attached</Badge>
    ),
    <Text as="span" variant="bodySm">
      {order.total}
    </Text>,
    <Badge tone={order.fulfillmentStatus === "FULFILLED" ? "success" : "attention"}>
      {order.fulfillmentStatus}
    </Badge>,
    <InlineStack gap="150">
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
          💬 Live Chat
        </Button>
      )}
    </InlineStack>,
  ]);

  const cartRows = abandonedCarts.map((cart: any) => [
    <Text as="span" variant="bodySm" fontWeight="bold">
      {cart.customerName || "Customer"}
    </Text>,
    <Badge tone="success">{cart.customerPhone}</Badge>,
    <Text as="span" variant="bodySm">
      {cart.currency} {parseFloat(cart.cartTotal).toFixed(2)}
    </Text>,
    <Badge tone={cart.status === "RECOVERED" ? "success" : "attention"}>
      {cart.status}
    </Badge>,
    <Text as="span" variant="bodyXs" tone="subdued">
      {new Date(cart.createdAt).toLocaleDateString()}
    </Text>,
    <InlineStack gap="150">
      <Button
        size="slim"
        variant="primary"
        onClick={() => handleOpenCartModal(cart)}
      >
        🛒 Send 1-Click Recovery
      </Button>
      {cart.customerPhone && (
        <Button
          size="slim"
          onClick={() => navigate(`/app/inbox?phone=${cart.customerPhone.replace(/[^0-9]/g, "")}`)}
        >
          💬 Live Chat
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
        {fetcher.data?.success && (
          <Banner title="WhatsApp Message Dispatched!" tone="success">
            <p>Your message was successfully delivered to customer WhatsApp number <b>+{fetcher.data.phone}</b>.</p>
          </Banner>
        )}

        {fetcher.data?.error && (
          <Banner title="Delivery Notice" tone="critical">
            <p>{fetcher.data.error}</p>
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
                          No orders found in Shopify yet. Create an order or test order to see it here!
                        </Text>
                      </Box>
                    ) : (
                      <DataTable
                        columnContentTypes={["text", "text", "text", "text", "text", "text"]}
                        headings={["Order", "Customer", "Mobile Phone", "Total", "Status", "1-Click WhatsApp Actions"]}
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
            <TextField
              label="Recipient Mobile Phone"
              placeholder="+91 9374626600"
              value={customPhone}
              onChange={setCustomPhone}
              autoComplete="off"
              helpText="Enter customer WhatsApp number with country code (e.g. +91 9374626600)."
            />
            <Text as="p" variant="bodyXs" tone="subdued">
              Message will be sent via pre-approved WhatsApp notification template.
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
