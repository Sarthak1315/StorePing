import { useState, useMemo, useEffect } from "react";
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
  Tooltip,
  Divider,
  Icon,
} from "@shopify/polaris";
import { CheckIcon, AlertCircleIcon, ChatIcon, SendIcon, SearchIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { sendWhatsAppMessage } from "../utils/meta-whatsapp.server";
import { logInfo, logError } from "../utils/logger.server";
import { normalizePhoneNumber } from "../utils/phone.utils";
import { seedDefaultTemplates } from "../utils/template.server";
import { interpolateVariables } from "../utils/template.shared";
import { syncOrderUpdateToShopify } from "../utils/shopify-order.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  let merchant = await db.merchant.findUnique({
    where: { shop },
  });

  if (!merchant) {
    merchant = await db.merchant.create({
      data: { shop, name: shop.replace(".myshopify.com", "") },
    });
  }

  const debugErrors: string[] = [];

  // Parallel Query Execution: Shopify GraphQL + Database records all fetched concurrently!
  const [ordersRes, confirmations, templates, abandonedCarts] = await Promise.all([
    admin.graphql(`
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
              address1
              address2
              city
              province
              zip
              country
              phone
            }
            billingAddress {
              address1
              city
              province
              zip
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
    `),
    db.orderConfirmation.findMany({
      where: { merchantId: merchant.id },
    }),
    db.template.findMany({
      where: { merchantId: merchant.id },
      orderBy: { createdAt: "asc" },
    }),
    db.cartRecovery.findMany({
      where: { merchantId: merchant.id },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
  ]);

  let ordersList: any[] = [];

  try {
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

        const addr = node.shippingAddress || node.billingAddress || {};
        const addressParts = [
          addr.address1,
          addr.address2,
          addr.city,
          addr.province,
          addr.zip,
          addr.country,
        ].filter(Boolean);
        const shippingAddress = addressParts.length > 0 ? addressParts.join(", ") : "Standard Delivery Address";

        const items = (node.lineItems?.nodes || [])
          .map((li: any) => `${li.title} (x${li.quantity})`)
          .join(", ") || "Ordered Items";

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
          shippingAddress,
          items,
          isDraft: false,
        };
      });
      ordersList.push(...fetched);
    }
  } catch (err: any) {
    debugErrors.push(`Orders fetch error: ${err.message}`);
  }

  // Build confirmation lookup map in O(1)
  const confirmationMap = new Map<string, any>();
  confirmations.forEach((c) => {
    confirmationMap.set(c.orderNumber, c);
    confirmationMap.set(c.orderNumber.replace(/^#/, ""), c);
  });

  // Attach confirmation status to orders
  const enrichedOrders = ordersList.map((o) => {
    const record = confirmationMap.get(o.orderNumber) || confirmationMap.get(o.orderNumber.replace(/^#/, ""));
    return {
      ...o,
      confirmationStatus: record?.status || "NOT_SENT",
      confirmedAt: record?.confirmedAt ? new Date(record.confirmedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }) : null,
      customerNotes: record?.customerNotes || null,
      lastSentAt: record?.lastSentAt || null,
    };
  });

  return json({
    shop,
    merchant,
    isWhatsAppConnected: merchant?.isWhatsAppConnected ?? false,
    orders: enrichedOrders,
    templates,
    abandonedCarts,
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
    return json<ActionData>({ success: false, error: "WhatsApp Business Account is not connected. Please connect WhatsApp first." }, { status: 400 });
  }

  // 1. Direct WhatsApp Send for Order (With Template Selection & Interactive Buttons)
  if (intent === "sendOrderWhatsApp") {
    const orderId = (formData.get("orderId") as string) || "";
    const orderNumber = (formData.get("orderNumber") as string) || "";
    const customerName = (formData.get("customerName") as string) || "Customer";
    const totalAmount = (formData.get("totalAmount") as string) || "0.00";
    const currency = (formData.get("currency") as string) || "INR";
    const shippingAddress = (formData.get("shippingAddress") as string) || "Customer Address";
    const items = (formData.get("items") as string) || "Order Items";
    const eventType = (formData.get("eventType") as string) || "ORDER_CONFIRM_ADDRESS";
    let recipientPhone = ((formData.get("phone") as string) || "").trim();

    if (!recipientPhone) {
      return json<ActionData>({ success: false, error: "Please provide a valid customer phone number." }, { status: 400 });
    }

    let cleanPhone = recipientPhone.replace(/[^0-9]/g, "");
    if (cleanPhone.length === 10) cleanPhone = `91${cleanPhone}`;

    // Find template or construct message
    const template = await db.template.findFirst({
      where: { merchantId: merchant.id, eventType },
    });

    const templateVariables = {
      customer_name: customerName,
      order_number: orderNumber.replace(/^#/, ""),
      order_name: orderNumber,
      total_amount: totalAmount,
      total_price: totalAmount,
      currency,
      cart_items: items,
      items,
      shipping_address: shippingAddress,
      customer_phone: cleanPhone,
      tracking_url: `https://${shop}/account/orders`,
      store_name: merchant.name || shop.replace(".myshopify.com", ""),
      discount_code: "SAVE10",
      checkout_url: `https://${shop}`,
    };

    let bodyText = "";
    let headerText = "";
    let buttonType = template?.buttonType || "MULTI_BUTTON";
    let buttonText = template?.buttonText || "Confirm";
    let buttonUrl = template?.buttonUrl || "";
    let buttons = (template?.buttons as any[]) || [];

    if (template) {
      bodyText = interpolateVariables(template.bodyText, templateVariables);
      headerText = interpolateVariables(template.headerText, templateVariables);
      buttonUrl = interpolateVariables(template.buttonUrl, templateVariables);
    } else {
      bodyText = `Hello ${customerName}! Thank you for your order ${orderNumber} for ${currency} ${totalAmount} at ${merchant.name || shop}. Address: ${shippingAddress}. Please confirm below:`;
      headerText = `🧾 Order & Address Confirmation ${orderNumber}`;
    }

    // Format interactive buttons with order ID
    const cleanNum = orderNumber.replace(/[^a-zA-Z0-9]/g, "");
    const formattedButtons = buttons.map((b) => {
      let btnId = b.id;
      if (btnId === "confirm_order") btnId = `confirm_order_${cleanNum}`;
      if (btnId === "update_address") btnId = `update_address_${cleanNum}`;
      if (btnId === "support_query") btnId = `support_query_${cleanNum}`;
      if (btnId === "confirm_cod") btnId = `confirm_cod_${cleanNum}`;
      if (btnId === "cancel_cod") btnId = `cancel_cod_${cleanNum}`;
      return { ...b, id: btnId };
    });

    try {
      const result = await sendWhatsAppMessage({
        merchantId: merchant.id,
        recipientPhone: cleanPhone,
        customerName,
        eventType,
        bodyText,
        headerType: template?.headerType || "TEXT",
        headerText: headerText || undefined,
        headerMediaUrl: template?.headerMediaUrl || undefined,
        footerText: template?.footerText || `${merchant.name || shop} • 1-Click Verification`,
        buttonType,
        buttonText,
        buttonUrl,
        buttons: formattedButtons.length > 0 ? formattedButtons : undefined,
        senderRole: "MERCHANT",
      });

      if (!result.success) {
        return json<ActionData>({ success: false, error: result.error || "Failed to dispatch WhatsApp message" }, { status: 500 });
      }

      // Upsert OrderConfirmation tracking record
      await db.orderConfirmation.upsert({
        where: {
          merchantId_orderNumber: {
            merchantId: merchant.id,
            orderNumber,
          },
        },
        create: {
          merchantId: merchant.id,
          orderId: orderId || orderNumber,
          orderNumber,
          customerPhone: cleanPhone,
          customerName,
          totalAmount,
          currency,
          shippingAddress,
          itemsSummary: items,
          status: "PENDING",
          lastSentAt: new Date(),
        },
        update: {
          customerPhone: cleanPhone,
          customerName,
          totalAmount,
          shippingAddress,
          itemsSummary: items,
          status: "PENDING",
          lastSentAt: new Date(),
        },
      });

      await logInfo(`Direct WhatsApp notification sent for order ${orderNumber} to ${cleanPhone}`, {
        shop,
        source: "orders",
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
        buttonType: "CTA_URL",
        buttonText: "🛒 Complete My Order",
        buttonUrl: checkoutUrl,
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

  // 3. Sync Confirmation or Customer Address Note directly to Shopify Admin Order
  if (intent === "syncToShopify") {
    const orderId = (formData.get("orderId") as string) || "";
    const orderNumber = (formData.get("orderNumber") as string) || "";
    const status = (formData.get("status") as any) || "CONFIRMED";
    const customerNotes = (formData.get("customerNotes") as string) || "";

    const syncRes = await syncOrderUpdateToShopify({
      shop,
      orderId,
      orderNumber,
      status,
      customerNotes,
    });

    if (!syncRes.success) {
      return json<ActionData>(
        { success: false, error: syncRes.error || "Failed to update order in Shopify Admin." },
        { status: 500 }
      );
    }

    return json<ActionData>({
      success: true,
      orderNumber,
      message: `Order ${orderNumber} note and tags successfully updated in Shopify Admin! 🎉`,
    });
  }

  return json<ActionData>({ success: true });
}

export default function OrdersManualPage() {
  const { shop, merchant, isWhatsAppConnected, orders, templates, abandonedCarts, debugErrors } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const navigate = useNavigate();

  const [selectedTab, setSelectedTab] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");

  // Modal State for Unified Order WhatsApp Send
  const [isOrderModalOpen, setIsOrderModalOpen] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<any>(null);
  const [customPhone, setCustomPhone] = useState("");
  const [selectedEventType, setSelectedEventType] = useState("ORDER_CONFIRM_ADDRESS");

  // Modal State for Cart Recovery Send
  const [isCartModalOpen, setIsCartModalOpen] = useState(false);
  const [selectedCart, setSelectedCart] = useState<any>(null);
  const [cartPhone, setCartPhone] = useState("");

  const isSubmitting = fetcher.state !== "idle";

  const handleOpenOrderModal = (order: any, defaultEvent = "ORDER_CONFIRM_ADDRESS") => {
    setSelectedOrder(order);
    setSelectedEventType(defaultEvent);
    setCustomPhone(order.phone || "");
    setIsOrderModalOpen(true);
  };

  const handleSyncToShopify = (order: any) => {
    const form = new FormData();
    form.append("intent", "syncToShopify");
    form.append("orderId", order.id);
    form.append("orderNumber", order.orderNumber);
    form.append("status", order.confirmationStatus);
    form.append("customerNotes", order.customerNotes || "");
    fetcher.submit(form, { method: "POST" });
  };

  const handleSendOrderWhatsApp = () => {
    if (!selectedOrder || !customPhone.trim()) return;
    const form = new FormData();
    form.append("intent", "sendOrderWhatsApp");
    form.append("orderId", selectedOrder.id);
    form.append("orderNumber", selectedOrder.orderNumber);
    form.append("customerName", selectedOrder.customerName);
    form.append("totalAmount", selectedOrder.totalAmount);
    form.append("currency", selectedOrder.currency);
    form.append("shippingAddress", selectedOrder.shippingAddress || "");
    form.append("items", selectedOrder.items || "");
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

  // Find currently selected template for preview in modal
  const activeModalTemplate = useMemo(() => {
    return templates.find((t: any) => t.eventType === selectedEventType) || templates[0];
  }, [templates, selectedEventType]);

  // Interpolated Live Preview in Modal
  const previewData = useMemo(() => {
    if (!selectedOrder || !activeModalTemplate) return { body: "", header: "", buttons: [] };

    const vars = {
      customer_name: selectedOrder.customerName || "Customer",
      order_number: (selectedOrder.orderNumber || "").replace(/^#/, ""),
      order_name: selectedOrder.orderNumber || "#1001",
      total_amount: selectedOrder.totalAmount || "0.00",
      total_price: selectedOrder.totalAmount || "0.00",
      currency: selectedOrder.currency || "INR",
      cart_items: selectedOrder.items || "Selected Items",
      items: selectedOrder.items || "Selected Items",
      shipping_address: selectedOrder.shippingAddress || "123 Main St, City, State",
      customer_phone: customPhone || (merchant?.phone ? merchant.phone.replace(/[^0-9]/g, "") : "919876543210"),
      tracking_url: `https://${shop}/account/orders`,
      store_name: merchant?.name || shop.replace(".myshopify.com", ""),
      discount_code: "SAVE10",
      checkout_url: `https://${shop}`,
    };

    const body = interpolateVariables(activeModalTemplate.bodyText, vars);
    const header = interpolateVariables(activeModalTemplate.headerText, vars);
    const buttons = (activeModalTemplate.buttons as any[]) || [];

    return { body, header, buttons };
  }, [selectedOrder, activeModalTemplate, customPhone, shop, merchant]);

  // Floating Toast Notification Handler (No top banners)
  useEffect(() => {
    if (fetcher.data) {
      if ((fetcher.data as any).message) {
        try {
          if (typeof window !== "undefined" && (window as any).shopify?.toast) {
            (window as any).shopify.toast.show((fetcher.data as any).message, { duration: 4000 });
          }
        } catch {}
      } else if ((fetcher.data as any).error) {
        try {
          if (typeof window !== "undefined" && (window as any).shopify?.toast) {
            (window as any).shopify.toast.show((fetcher.data as any).error, { isError: true, duration: 5000 });
          }
        } catch {}
      }
    }
  }, [fetcher.data]);

  // Instant Client-Side Filter: Tabs + Search Query (Order #, Name, Mobile, Address, Notes)
  const filteredOrders = useMemo(() => {
    let list = orders;
    if (selectedTab === 1) list = list.filter((o: any) => o.confirmationStatus === "CONFIRMED");
    if (selectedTab === 2) list = list.filter((o: any) => o.confirmationStatus === "UPDATE_REQUESTED");

    if (!searchQuery.trim()) return list;

    const q = searchQuery.trim().toLowerCase();
    const cleanDigits = q.replace(/[^0-9]/g, "");
    const cleanAlphaNum = q.replace(/[^a-z0-9]/g, "");

    return list.filter((o: any) => {
      const orderNum = (o.orderNumber || "").toLowerCase();
      const cleanOrderNum = orderNum.replace(/[^a-z0-9]/g, "");
      const custName = (o.customerName || "").toLowerCase();
      const phone = (o.phone || "").toLowerCase();
      const cleanPhone = phone.replace(/[^0-9]/g, "");
      const shipping = (o.shippingAddress || "").toLowerCase();
      const notes = (o.customerNotes || "").toLowerCase();
      const items = (o.items || "").toLowerCase();

      return (
        orderNum.includes(q) ||
        (cleanAlphaNum.length > 0 && cleanOrderNum.includes(cleanAlphaNum)) ||
        custName.includes(q) ||
        phone.includes(q) ||
        (cleanDigits.length > 0 && cleanPhone.includes(cleanDigits)) ||
        shipping.includes(q) ||
        notes.includes(q) ||
        items.includes(q)
      );
    });
  }, [orders, selectedTab, searchQuery]);

  // Instant Client-Side Filter for Abandoned Carts
  const filteredCarts = useMemo(() => {
    if (!searchQuery.trim()) return abandonedCarts;

    const q = searchQuery.trim().toLowerCase();
    const cleanDigits = q.replace(/[^0-9]/g, "");

    return abandonedCarts.filter((c: any) => {
      const name = (c.customerName || "").toLowerCase();
      const phone = (c.customerPhone || "").toLowerCase();
      const cleanPhone = phone.replace(/[^0-9]/g, "");
      const email = (c.customerEmail || "").toLowerCase();

      return (
        name.includes(q) ||
        phone.includes(q) ||
        (cleanDigits.length > 0 && cleanPhone.includes(cleanDigits)) ||
        email.includes(q)
      );
    });
  }, [abandonedCarts, searchQuery]);

  const confirmedCount = orders.filter((o: any) => o.confirmationStatus === "CONFIRMED").length;
  const updateReqCount = orders.filter((o: any) => o.confirmationStatus === "UPDATE_REQUESTED").length;

  const tabs = [
    { id: "all-orders", content: `📦 All Orders & Drafts (${orders.length})` },
    { id: "confirmed-orders", content: `✅ Address Confirmed (${confirmedCount})` },
    { id: "update-orders", content: `⚠️ Update Requested (${updateReqCount})` },
    { id: "carts", content: `🛒 Abandoned Checkouts (${abandonedCarts.length})` },
  ];

  // Helper to render confirmation badge
  const renderConfirmationBadge = (order: any) => {
    switch (order.confirmationStatus) {
      case "CONFIRMED":
        return (
          <Tooltip content={`Confirmed by customer on WhatsApp ${order.confirmedAt ? `at ${order.confirmedAt}` : ""}`}>
            <Badge tone="success">✅ Address Confirmed</Badge>
          </Tooltip>
        );
      case "UPDATE_REQUESTED":
        return (
          <Tooltip content={order.customerNotes ? `Customer Note: "${order.customerNotes}"` : "Customer requested address or mobile change via WhatsApp"}>
            <BlockStack gap="050">
              <Badge tone="critical">⚠️ Update Requested</Badge>
              {order.customerNotes && (
                <Text as="span" variant="bodyXs" tone="critical" truncate>
                  📝 {order.customerNotes.slice(0, 30)}...
                </Text>
              )}
            </BlockStack>
          </Tooltip>
        );
      case "PENDING":
        return (
          <Tooltip content="WhatsApp confirmation sent, awaiting customer response">
            <Badge tone="info">⏳ Pending Confirmation</Badge>
          </Tooltip>
        );
      default:
        return <Text as="span" variant="bodySm" tone="subdued">— Not Sent</Text>;
    }
  };

  const orderRows = filteredOrders.map((order: any) => [
    <InlineStack gap="100" blockAlign="center" key={order.id}>
      <Text as="span" variant="bodySm" fontWeight="bold">
        {order.orderNumber}
      </Text>
      {order.isDraft && <Badge tone="info">Draft</Badge>}
    </InlineStack>,
    <BlockStack gap="050" key={`cust-${order.id}`}>
      <Text as="span" variant="bodySm" fontWeight="medium">
        {order.customerName}
      </Text>
      <Text as="span" variant="bodyXs" tone="subdued" truncate>
        📍 {order.shippingAddress}
      </Text>
    </BlockStack>,
    order.phone ? (
      <Badge tone="success" key={`phone-${order.id}`}>{`+${order.phone}`}</Badge>
    ) : (
      <Badge tone="warning" key={`phone-${order.id}`}>No Phone</Badge>
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
    <div key={`conf-${order.id}`}>
      {renderConfirmationBadge(order)}
    </div>,
    <InlineStack gap="150" key={`actions-${order.id}`}>
      <Button
        size="slim"
        variant="primary"
        onClick={() => handleOpenOrderModal(order, "ORDER_CONFIRM_ADDRESS")}
      >
        📲 Send WhatsApp
      </Button>
      {order.phone && (
        <Button
          size="slim"
          onClick={() => navigate(`/app/inbox?phone=${order.phone.replace(/[^0-9]/g, "")}`)}
        >
          💬 Chat
        </Button>
      )}
      {(order.confirmationStatus === "UPDATE_REQUESTED" || order.confirmationStatus === "CONFIRMED") && (
        <Tooltip content="Sync confirmation tag & customer's address note directly into Shopify Admin Order">
          <Button
            size="slim"
            onClick={() => handleSyncToShopify(order)}
            loading={isSubmitting}
          >
            {order.confirmationStatus === "UPDATE_REQUESTED" ? "📝 Push to Shopify" : "🔄 Sync Shopify"}
          </Button>
        </Tooltip>
      )}
    </InlineStack>,
  ]);

  const cartRows = filteredCarts.map((cart: any) => [
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
      fullWidth
      title="Orders"
      subtitle="Send WhatsApp confirmations, address verifications, and recovery alerts."
    >
      <BlockStack gap="400">

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

        <Card padding="0">
          {/* Instant Client-Side Search Bar */}
          <div style={{ padding: "12px 16px", borderBottom: "1px solid #e1e3e5", display: "flex", gap: "12px", alignItems: "center" }}>
            <div style={{ flex: 1 }}>
              <TextField
                label="Search orders"
                labelHidden
                prefix={<Icon source={SearchIcon} />}
                placeholder="Live search by order ID (e.g. #1001), customer name, or mobile number (+91)..."
                value={searchQuery}
                onChange={setSearchQuery}
                autoComplete="off"
                clearButton
                onClearButtonClick={() => setSearchQuery("")}
              />
            </div>
            {searchQuery && (
              <InlineStack gap="200" blockAlign="center">
                <Badge tone="info">
                  {selectedTab <= 2 ? `${filteredOrders.length} found` : `${filteredCarts.length} found`}
                </Badge>
                <Button size="slim" onClick={() => setSearchQuery("")}>
                  Clear
                </Button>
              </InlineStack>
            )}
          </div>

          <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
            <Box padding="300">
              {selectedTab <= 2 ? (
                orderRows.length === 0 ? (
                  <Box padding="600">
                    <BlockStack gap="200" align="center">
                      <Text as="p" tone="subdued" alignment="center">
                        {searchQuery
                          ? `No orders match "${searchQuery}". Try searching by order #, mobile, or name.`
                          : selectedTab === 1
                          ? "No confirmed orders yet. Once customers tap 'Confirm Address' on WhatsApp, they will appear here!"
                          : selectedTab === 2
                          ? "No address update requests found."
                          : "No orders found in Shopify yet."}
                      </Text>
                      {searchQuery && (
                        <div style={{ display: "flex", justifyContent: "center" }}>
                          <Button size="slim" onClick={() => setSearchQuery("")}>
                            Reset Search
                          </Button>
                        </div>
                      )}
                    </BlockStack>
                  </Box>
                ) : (
                  <DataTable
                    columnContentTypes={["text", "text", "text", "text", "text", "text", "text"]}
                    headings={["Order", "Customer & Address", "Mobile Phone", "Total", "Payment", "Address Confirmation", "1-Click Actions"]}
                    rows={orderRows}
                  />
                )
              ) : cartRows.length === 0 ? (
                <Box padding="600">
                  <BlockStack gap="200" align="center">
                    <Text as="p" tone="subdued" alignment="center">
                      {searchQuery
                        ? `No abandoned checkouts match "${searchQuery}".`
                        : "No abandoned checkouts recorded yet. When a customer leaves items in checkout, they will appear here!"}
                    </Text>
                    {searchQuery && (
                      <div style={{ display: "flex", justifyContent: "center" }}>
                        <Button size="slim" onClick={() => setSearchQuery("")}>
                          Reset Search
                        </Button>
                      </div>
                    )}
                  </BlockStack>
                </Box>
              ) : (
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "text", "text"]}
                  headings={["Customer", "Mobile Phone", "Cart Value", "Status", "Date", "1-Click Recovery"]}
                  rows={cartRows}
                />
              )}
            </Box>
          </Tabs>
        </Card>
      </BlockStack>

      {/* Rich Template Selection & Live Preview Modal */}
      <Modal
        open={isOrderModalOpen}
        onClose={() => setIsOrderModalOpen(false)}
        title={`📲 Send WhatsApp Notification for ${selectedOrder?.orderNumber || "Order"}`}
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
            <InlineStack align="space-between">
              <Text as="p" variant="bodySm">
                Customer: <b>{selectedOrder?.customerName}</b> • Total: <b>{selectedOrder?.total}</b>
              </Text>
              {selectedOrder?.isDraft && <Badge tone="info">Draft Order</Badge>}
            </InlineStack>

            <Select
              label="Select WhatsApp Notification Template"
              options={[
                { label: "🧾 Order & Delivery Address Confirmation (3 Interactive Buttons)", value: "ORDER_CONFIRM_ADDRESS" },
                { label: "📦 Standard Order Confirmation", value: "ORDER_CONFIRM" },
                { label: "💳 Cash On Delivery (COD) Verification", value: "COD_CONFIRM" },
                { label: "🚚 Shipping & Tracking Update", value: "ORDER_SHIPPED" },
                { label: "📦 Order Delivery & Review Request", value: "ORDER_DELIVERED" },
                { label: "✨ Inactive Customer Win-Back", value: "WIN_BACK" },
              ]}
              value={selectedEventType}
              onChange={setSelectedEventType}
              helpText="Dispatched directly via Meta Cloud API with interactive quick-reply buttons."
            />

            <TextField
              label="Recipient WhatsApp Mobile Phone"
              placeholder={merchant?.phone ? `+${merchant.phone.replace(/[^0-9]/g, "")}` : "+91 9876543210"}
              value={customPhone}
              onChange={setCustomPhone}
              autoComplete="off"
              helpText="Auto-populated from Shopify. Verify or edit country code (+91) before dispatching."
            />

            {/* Live Message Preview Card */}
            <Box
              background="bg-surface-secondary"
              padding="300"
              borderRadius="200"
              borderWidth="025"
              borderColor="border"
            >
              <BlockStack gap="200">
                <Text as="p" variant="headingXs" tone="subdued">
                  📱 LIVE WHATSAPP MESSAGE PREVIEW
                </Text>
                <div
                  style={{
                    backgroundColor: "#e7fed8",
                    padding: "12px",
                    borderRadius: "8px",
                    borderLeft: "4px solid #25d366",
                    fontSize: "13px",
                    lineHeight: "1.45",
                    whiteSpace: "pre-wrap",
                    color: "#111827",
                  }}
                >
                  {previewData.header && (
                    <div style={{ fontWeight: "bold", marginBottom: "6px", color: "#075e54" }}>
                      {previewData.header}
                    </div>
                  )}
                  <div>{previewData.body}</div>
                  <div style={{ fontSize: "11px", color: "#6b7280", marginTop: "8px" }}>
                    {activeModalTemplate?.footerText || `${merchant?.name || shop} • 1-Click Verification`}
                  </div>

                  {/* Interactive Button Preview */}
                  {previewData.buttons && previewData.buttons.length > 0 && (
                    <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "6px" }}>
                      {previewData.buttons.map((b: any, idx: number) => (
                        <div
                          key={idx}
                          style={{
                            backgroundColor: "#ffffff",
                            color: "#00a884",
                            fontWeight: 600,
                            padding: "8px 12px",
                            borderRadius: "6px",
                            textAlign: "center",
                            border: "1px solid #d1d5db",
                            fontSize: "12px",
                          }}
                        >
                          {b.text || b.title}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </BlockStack>
            </Box>
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
              placeholder={merchant?.phone ? `+${merchant.phone.replace(/[^0-9]/g, "")}` : "+91 9876543210"}
              value={cartPhone}
              onChange={setCartPhone}
              autoComplete="off"
              helpText="Include country code (e.g. +91 9876543210)."
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
