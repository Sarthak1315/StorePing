import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useSearchParams, useRevalidator } from "@remix-run/react";
import { useState, useEffect, useRef, useMemo } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  Button,
  Banner,
  BlockStack,
  InlineStack,
  Divider,
  TextField,
  Badge,
  Box,
  Tag,
  Avatar,
  Icon,
  Modal,
  FormLayout,
  Tooltip,
  Select,
} from "@shopify/polaris";
import {
  SearchIcon,
  SendIcon,
  ChatIcon,
  PersonIcon,
  ClockIcon,
  CheckIcon,
  RefreshIcon,
  PlusIcon,
} from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { sendWhatsAppMessage, subscribeWabaToWebhooks } from "../utils/meta-whatsapp.server";
import { logInfo, logError } from "../utils/logger.server";
import { interpolateVariables } from "../utils/template.shared";
import {
  formatWhatsAppText,
  insertFormattingIntoText,
  COMMON_WHATSAPP_EMOJIS,
  type WhatsAppFormatType,
} from "../utils/whatsapp-formatter";

export type ChatMessageType = {
  id: string;
  conversationId: string;
  sender: string;
  messageType: string;
  bodyText: string;
  mediaUrl?: string | null;
  mediaId?: string | null;
  mimeType?: string | null;
  caption?: string | null;
  metaMessageId?: string | null;
  status: string;
  errorMessage?: string | null;
  createdAt: Date | string;
};

export type ConversationType = {
  id: string;
  merchantId: string;
  customerPhone: string;
  customerName: string | null;
  lastOrderNumber: string | null;
  lastOrderId: string | null;
  lastMessageText: string | null;
  lastMessageAt: Date | string;
  unreadCount: number;
  status: string;
  cswExpiresAt: Date | string | null;
  messages: ChatMessageType[];
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const searchQuery = (url.searchParams.get("q") || "").trim();
  const selectedPhone = url.searchParams.get("phone") || "";

  try {
    let merchant = await db.merchant.findUnique({
      where: { shop },
    });

    if (!merchant) {
      merchant = await db.merchant.create({
        data: {
          shop,
          name: shop.replace(".myshopify.com", ""),
        },
      });
    }

    // Auto-subscribe WABA to Meta Cloud API webhooks so incoming messages always flow in!
    if (merchant.isWhatsAppConnected && merchant.wabaId) {
      subscribeWabaToWebhooks(merchant.id).catch((err) =>
        console.warn("WABA auto-subscription notice:", err)
      );
    }

    // Build optimized database search filter
    const whereClause: any = {
      merchantId: merchant.id,
    };

    if (searchQuery) {
      const cleanSearch = searchQuery.replace(/[^a-zA-Z0-9#]/g, "");
      whereClause.OR = [
        { customerPhone: { contains: cleanSearch } },
        { customerName: { contains: searchQuery, mode: "insensitive" } },
        { lastOrderNumber: { contains: searchQuery, mode: "insensitive" } },
        { lastMessageText: { contains: searchQuery, mode: "insensitive" } },
      ];
    }

    // Parallel fetch: templates + order confirmations + active conversations in 1 roundtrip
    const [templates, confirmations, conversations] = await Promise.all([
      db.template.findMany({
        where: { merchantId: merchant.id, isActive: true },
        orderBy: { createdAt: "asc" },
      }),
      db.orderConfirmation.findMany({
        where: { merchantId: merchant.id },
      }),
      db.conversation.findMany({
        where: whereClause,
        orderBy: { lastMessageAt: "desc" },
        include: {
          messages: {
            orderBy: { createdAt: "asc" },
            take: 50,
          },
        },
        take: 100,
      }) as Promise<ConversationType[]>,
    ]);

    const activeConversation: ConversationType | null =
      conversations.find((c) => c.customerPhone === selectedPhone) || conversations[0] || null;

    return json({
      merchant,
      conversations,
      activeConversation,
      templates,
      confirmations,
      initialSelectedPhone: selectedPhone || activeConversation?.customerPhone || "",
      searchQuery,
      loadError: null as string | null,
    });
  } catch (err: any) {
    await logError(`Inbox loader error: ${err.message}`, { shop, source: "inbox" });
    return json({
      merchant: { id: "temp", shop, isWhatsAppConnected: false, displayPhoneNumber: null } as any,
      conversations: [] as ConversationType[],
      activeConversation: null as ConversationType | null,
      templates: [] as any[],
      confirmations: [] as any[],
      initialSelectedPhone: "",
      searchQuery,
      loadError: err.message as string | null,
    });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const merchant = await db.merchant.findUnique({ where: { shop } });
  if (!merchant) throw new Response("Merchant not found", { status: 404 });

  // 1. Reply to existing conversation (Supports Text & Media)
  if (intent === "sendReply") {
    const customerPhone = formData.get("customerPhone") as string;
    const messageText = (formData.get("messageText") as string || "").trim();
    const mediaUrl = (formData.get("mediaUrl") as string || "").trim() || null;
    const mediaType = (formData.get("mediaType") as string || "IMAGE") as any;

    if (!customerPhone || (!messageText && !mediaUrl)) {
      return json({ success: false, error: "Message text or media is required.", messageId: null, newPhone: null }, { status: 400 });
    }

    try {
      const result = await sendWhatsAppMessage({
        merchantId: merchant.id,
        recipientPhone: customerPhone,
        customerName: "Customer",
        eventType: "SUPPORT_CHAT",
        bodyText: messageText || undefined,
        mediaUrl: mediaUrl || undefined,
        mediaType: mediaUrl ? mediaType : undefined,
        senderRole: "MERCHANT",
      });

      if (!result.success) {
        return json({ success: false, error: result.error || "Failed to send WhatsApp message", messageId: null, newPhone: null }, { status: 500 });
      }

      // Mark conversation active and clear unread count
      await db.conversation.updateMany({
        where: { merchantId: merchant.id, customerPhone },
        data: { status: "ACTIVE", unreadCount: 0 },
      });

      await logInfo(`Merchant replied to customer ${customerPhone}`, { shop, source: "inbox" });
      return json({ success: true, error: null, messageId: result.messageId, newPhone: null, sentText: messageText, sentMediaUrl: mediaUrl });
    } catch (err: any) {
      await logError(`Failed to send reply: ${err.message}`, { shop, source: "inbox" });
      return json({ success: false, error: err.message, messageId: null, newPhone: null });
    }
  }

  // 2. Direct Template Dispatch from Inbox
  if (intent === "sendTemplate") {
    const customerPhone = formData.get("customerPhone") as string;
    const eventType = (formData.get("eventType") as string) || "ORDER_CONFIRM_ADDRESS";
    const customerName = (formData.get("customerName") as string) || "Customer";
    const orderNumber = (formData.get("orderNumber") as string) || "";

    const template = await db.template.findFirst({
      where: { merchantId: merchant.id, eventType },
    });

    if (!template) {
      return json({ success: false, error: "Template not found.", messageId: null, newPhone: null }, { status: 400 });
    }

    const templateVariables = {
      customer_name: customerName,
      order_number: orderNumber.replace(/^#/, ""),
      order_name: orderNumber || "#1001",
      total_amount: "2,499.00",
      total_price: "2,499.00",
      currency: "INR",
      shipping_address: "Customer Address",
      customer_phone: customerPhone,
      store_name: merchant.name || shop.replace(".myshopify.com", ""),
      tracking_url: `https://${shop}/account/orders`,
      discount_code: "SAVE10",
      checkout_url: `https://${shop}`,
    };

    const interpolatedBody = interpolateVariables(template.bodyText, templateVariables);
    const interpolatedHeader = interpolateVariables(template.headerText, templateVariables);
    const buttons = (template.buttons as any[]) || [];
    const safeOrderNum = orderNumber ? encodeURIComponent(orderNumber) : "1001";
    const formattedButtons = buttons.map((b) => {
      let btnId = b.id;
      if (btnId === "confirm_order") btnId = `confirm_order_${safeOrderNum}`;
      if (btnId === "update_address") btnId = `update_address_${safeOrderNum}`;
      if (btnId === "support_query") btnId = `support_query_${safeOrderNum}`;
      return { ...b, id: btnId };
    });

    try {
      const result = await sendWhatsAppMessage({
        merchantId: merchant.id,
        recipientPhone: customerPhone,
        customerName,
        eventType,
        bodyText: interpolatedBody,
        headerType: template.headerType,
        headerText: interpolatedHeader,
        headerMediaUrl: template.headerMediaUrl,
        footerText: template.footerText ? interpolateVariables(template.footerText, templateVariables) : undefined,
        buttonType: template.buttonType,
        buttonText: template.buttonText,
        buttonUrl: template.buttonUrl,
        buttons: formattedButtons.length > 0 ? formattedButtons : undefined,
        senderRole: "MERCHANT",
      });

      if (!result.success) {
        return json({ success: false, error: result.error || "Failed to send template message", messageId: null, newPhone: null }, { status: 500 });
      }

      await db.conversation.updateMany({
        where: { merchantId: merchant.id, customerPhone },
        data: { status: "ACTIVE", unreadCount: 0 },
      });

      await logInfo(`Template ${eventType} sent to ${customerPhone}`, { shop, source: "inbox" });
      return json({ success: true, error: null, messageId: result.messageId, newPhone: null });
    } catch (err: any) {
      return json({ success: false, error: err.message, messageId: null, newPhone: null });
    }
  }

  // 2.1 Update Conversation Status (Support Queue / Resolution)
  if (intent === "updateStatus") {
    const customerPhone = formData.get("customerPhone") as string;
    const status = (formData.get("status") as string) || "RESOLVED";
    if (customerPhone) {
      await db.conversation.updateMany({
        where: { merchantId: merchant.id, customerPhone },
        data: { status, unreadCount: status === "RESOLVED" ? 0 : undefined },
      });
      await logInfo(`Conversation with ${customerPhone} status updated to ${status}`, { shop, source: "inbox" });
    }
    return json({ success: true, error: null, messageId: null, newPhone: null });
  }

  // 3. Start a New Conversation with Any Number
  if (intent === "startNewConversation") {
    let customerPhone = (formData.get("customerPhone") as string || "").trim();
    const customerName = (formData.get("customerName") as string || "").trim() || "Customer";
    const orderNumber = (formData.get("orderNumber") as string || "").trim();
    const messageText = (formData.get("messageText") as string || "").trim();

    if (!customerPhone || !messageText) {
      return json({ success: false, error: "Please enter a valid phone number and message.", messageId: null, newPhone: null }, { status: 400 });
    }

    let cleanPhone = customerPhone.replace(/[^0-9]/g, "");
    if (cleanPhone.length === 10) cleanPhone = `91${cleanPhone}`;

    try {
      const result = await sendWhatsAppMessage({
        merchantId: merchant.id,
        recipientPhone: cleanPhone,
        customerName,
        eventType: "MANUAL_OUTREACH",
        bodyText: messageText,
        senderRole: "MERCHANT",
      });

      if (!result.success) {
        return json({ success: false, error: result.error || "Failed to deliver WhatsApp message", messageId: null, newPhone: null }, { status: 500 });
      }

      await db.conversation.upsert({
        where: {
          merchantId_customerPhone: {
            merchantId: merchant.id,
            customerPhone: cleanPhone,
          },
        },
        create: {
          merchantId: merchant.id,
          customerPhone: cleanPhone,
          customerName,
          lastOrderNumber: orderNumber || null,
          lastMessageText: messageText,
          lastMessageAt: new Date(),
          status: "ACTIVE",
        },
        update: {
          customerName: customerName || undefined,
          lastOrderNumber: orderNumber || undefined,
          lastMessageText: messageText,
          lastMessageAt: new Date(),
          status: "ACTIVE",
        },
      });

      await logInfo(`Started new conversation with ${cleanPhone}`, { shop, source: "inbox" });
      return json({ success: true, error: null, messageId: result.messageId, newPhone: cleanPhone });
    } catch (err: any) {
      await logError(`Failed to start conversation: ${err.message}`, { shop, source: "inbox" });
      return json({ success: false, error: err.message, messageId: null, newPhone: null });
    }
  }

  // 4. Mark conversation as Read
  if (intent === "markRead") {
    const customerPhone = formData.get("customerPhone") as string;
    if (customerPhone) {
      await db.conversation.updateMany({
        where: { merchantId: merchant.id, customerPhone },
        data: { unreadCount: 0 },
      });
    }
    return json({ success: true, error: null, messageId: null, newPhone: null });
  }

  return json({ success: true, error: null, messageId: null, newPhone: null });
};

export default function LiveInboxPage() {
  const { merchant, conversations, templates, confirmations, initialSelectedPhone, loadError } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [searchParams, setSearchParams] = useSearchParams();
  const revalidator = useRevalidator();

  // Instant 0ms Client State for Conversation Selection
  const [selectedPhone, setSelectedPhone] = useState<string>(initialSelectedPhone);

  // Dual-Engine Search & Support Queue Filter State
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [supportFilter, setSupportFilter] = useState<"ALL" | "NEEDS_REPLY" | "ORDERS" | "RESOLVED">("ALL");
  const [replyText, setReplyText] = useState<string>("");
  const [replyMediaUrl, setReplyMediaUrl] = useState<string>("");
  const [showMediaInput, setShowMediaInput] = useState<boolean>(false);
  const [mediaType, setMediaType] = useState<"IMAGE" | "VIDEO" | "DOCUMENT">("IMAGE");
  const [showEmojiPicker, setShowEmojiPicker] = useState<boolean>(false);
  const [newChatEmojiPicker, setNewChatEmojiPicker] = useState<boolean>(false);

  const handleApplyReplyFormat = (formatType: WhatsAppFormatType, customValue?: string) => {
    const { newText } = insertFormattingIntoText(
      replyText,
      replyText.length,
      replyText.length,
      formatType,
      customValue
    );
    setReplyText(newText);
  };

  const handleApplyNewChatFormat = (formatType: WhatsAppFormatType, customValue?: string) => {
    const { newText } = insertFormattingIntoText(
      newInitialMessage,
      newInitialMessage.length,
      newInitialMessage.length,
      formatType,
      customValue
    );
    setNewInitialMessage(newText);
  };

  // "Start New Chat" Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newPhone, setNewPhone] = useState("");
  const [newName, setNewName] = useState("");
  const [newOrderNumber, setNewOrderNumber] = useState("");
  const [newInitialMessage, setNewInitialMessage] = useState(
    "Hello! This is support. How can we assist you today? 😊"
  );

  // "Send Template" Modal State
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState(false);
  const [selectedTemplateEvent, setSelectedTemplateEvent] = useState("ORDER_CONFIRM_ADDRESS");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isSubmitting = fetcher.state !== "idle";

  const conversationsList = useMemo(() => {
    return (conversations || []) as ConversationType[];
  }, [conversations]);

  const needsReplyCount = useMemo(() => {
    return conversationsList.filter((c) => c.status === "NEEDS_REPLY" || c.unreadCount > 0).length;
  }, [conversationsList]);

  const ordersCount = useMemo(() => {
    return conversationsList.filter((c) => !!c.lastOrderNumber).length;
  }, [conversationsList]);

  const resolvedCount = useMemo(() => {
    return conversationsList.filter((c) => c.status === "RESOLVED").length;
  }, [conversationsList]);

  // Engine 1: Instant 0ms Support Queue & Keystroke Filtering
  const filteredConversations: ConversationType[] = useMemo(() => {
    let list = conversationsList;

    if (supportFilter === "NEEDS_REPLY") {
      list = list.filter((c) => c.status === "NEEDS_REPLY" || c.unreadCount > 0);
    } else if (supportFilter === "ORDERS") {
      list = list.filter((c) => !!c.lastOrderNumber);
    } else if (supportFilter === "RESOLVED") {
      list = list.filter((c) => c.status === "RESOLVED");
    }

    if (!searchTerm.trim()) return list;
    const query = searchTerm.toLowerCase().trim();
    const cleanQuery = query.replace(/[^0-9]/g, "");

    return list.filter((c: ConversationType) => {
      const matchName = c.customerName?.toLowerCase().includes(query);
      const matchPhone = cleanQuery && c.customerPhone.includes(cleanQuery);
      const matchOrder = c.lastOrderNumber?.toLowerCase().includes(query);
      const matchText = c.lastMessageText?.toLowerCase().includes(query);
      return matchName || matchPhone || matchOrder || matchText;
    });
  }, [conversationsList, supportFilter, searchTerm]);

  // Derive Active Conversation in 0ms without server roundtrip
  const activeConversation: ConversationType | null = useMemo(() => {
    return (
      filteredConversations.find((c: ConversationType) => c.customerPhone === selectedPhone) ||
      conversationsList.find((c: ConversationType) => c.customerPhone === selectedPhone) ||
      filteredConversations[0] ||
      conversationsList[0] ||
      null
    );
  }, [filteredConversations, conversationsList, selectedPhone]);

  // Confirmation Record for Active Conversation
  const activeConfirmation = useMemo(() => {
    if (!activeConversation) return null;
    const list = confirmations || [];
    return (
      list.find((c: any) => c.customerPhone === activeConversation.customerPhone) ||
      list.find((c: any) => activeConversation.lastOrderNumber && c.orderNumber === activeConversation.lastOrderNumber) ||
      null
    );
  }, [activeConversation, confirmations]);

  // Keep URL in sync smoothly without triggering full reload
  const handleSelectConversation = (phone: string) => {
    setSelectedPhone(phone);
    const newUrl = new URL(window.location.href);
    newUrl.searchParams.set("phone", phone);
    window.history.replaceState({}, "", newUrl.toString());

    // Mark as read in background
    const form = new FormData();
    form.append("intent", "markRead");
    form.append("customerPhone", phone);
    fetcher.submit(form, { method: "POST" });
  };

  // Scroll to bottom on new message or conversation switch
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeConversation?.messages]);

  // Auto-refresh inbox in background every 10 seconds for real-time live chat
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible" && !isSubmitting) {
        revalidator.revalidate();
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [revalidator, isSubmitting]);

  // Handle successful reply or new conversation creation
  useEffect(() => {
    if (fetcher.data?.success) {
      setReplyText("");
      setReplyMediaUrl("");
      setShowMediaInput(false);
      setIsTemplateModalOpen(false);
      if (fetcher.data.newPhone) {
        setSelectedPhone(fetcher.data.newPhone);
        setIsModalOpen(false);
        setNewPhone("");
        setNewName("");
        setNewOrderNumber("");
      }
    }
  }, [fetcher.data]);

  // 24-Hour Customer Service Window (CSW) Calculation
  const isInsideCSW = useMemo(() => {
    if (!activeConversation?.cswExpiresAt) return true;
    return new Date(activeConversation.cswExpiresAt).getTime() > Date.now();
  }, [activeConversation]);

  const handleSendReply = () => {
    if ((!replyText.trim() && !replyMediaUrl.trim()) || !activeConversation) return;
    const form = new FormData();
    form.append("intent", "sendReply");
    form.append("customerPhone", activeConversation.customerPhone);
    form.append("messageText", replyText.trim());
    if (replyMediaUrl.trim()) {
      form.append("mediaUrl", replyMediaUrl.trim());
      form.append("mediaType", mediaType);
    }
    fetcher.submit(form, { method: "POST" });
  };

  const handleSendTemplateSubmit = () => {
    if (!activeConversation) return;
    const form = new FormData();
    form.append("intent", "sendTemplate");
    form.append("customerPhone", activeConversation.customerPhone);
    form.append("customerName", activeConversation.customerName || "Customer");
    form.append("orderNumber", activeConversation.lastOrderNumber || "");
    form.append("eventType", selectedTemplateEvent);
    fetcher.submit(form, { method: "POST" });
  };

  const handleStartNewChatSubmit = () => {
    if (!newPhone.trim() || !newInitialMessage.trim()) return;
    const form = new FormData();
    form.append("intent", "startNewConversation");
    form.append("customerPhone", newPhone.trim());
    form.append("customerName", newName.trim());
    form.append("orderNumber", newOrderNumber.trim());
    form.append("messageText", newInitialMessage.trim());
    fetcher.submit(form, { method: "POST" });
  };

  // Deep Database Search Trigger on Enter
  const handleDeepSearch = () => {
    const params = new URLSearchParams(searchParams);
    if (searchTerm) {
      params.set("q", searchTerm);
    } else {
      params.delete("q");
    }
    setSearchParams(params);
  };

  return (
    <Page
      fullWidth
      title="Inbox"
      subtitle="Real-time 2-way customer WhatsApp conversations, address confirmations, and order support."
      primaryAction={{
        content: "➕ Start Chat with New Number",
        onAction: () => setIsModalOpen(true),
      }}
      secondaryActions={[
        {
          content: "Refresh",
          icon: RefreshIcon,
          loading: revalidator.state === "loading",
          onAction: () => revalidator.revalidate(),
        },
      ]}
    >
      <BlockStack gap="400">
        {loadError && (
          <Banner title="Notice" tone="warning">
            <p>{loadError}</p>
          </Banner>
        )}

        {fetcher.data?.error && (
          <Banner title="Messaging Error" tone="critical">
            <p>{fetcher.data.error}</p>
          </Banner>
        )}

        {!merchant.isWhatsAppConnected && (
          <Banner
            title="WhatsApp Not Connected"
            tone="warning"
            action={{ content: "Connect WhatsApp", url: "/app/connect" }}
          >
            <p>Connect your Meta WhatsApp Business Account to enable live 2-way customer conversations.</p>
          </Banner>
        )}

        {/* Main Inbox Container */}
        <Layout>
          {/* Left Sidebar: Conversation Thread List */}
          <Layout.Section variant="oneThird">
            <Card padding="0">
              <div style={{ padding: "12px", borderBottom: "1px solid #e2e8f0" }}>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleDeepSearch();
                  }}
                  style={{ display: "flex", gap: "8px", width: "100%" }}
                >
                  <div style={{ flex: 1 }}>
                    <TextField
                      label="Search conversations"
                      labelHidden
                      placeholder="Live search phone, name, or #1001..."
                      value={searchTerm}
                      onChange={setSearchTerm}
                      prefix={<Icon source={SearchIcon} />}
                      autoComplete="off"
                      clearButton
                      onClearButtonClick={() => setSearchTerm("")}
                    />
                  </div>
                  <Button size="slim" submit onClick={handleDeepSearch}>
                    Search
                  </Button>
                </form>
              </div>

              {/* Quick Action: Start New Conversation Button */}
              <div style={{ padding: "8px 12px", borderBottom: "1px solid #f1f5f9" }}>
                <Button
                  fullWidth
                  size="slim"
                  icon={PlusIcon}
                  onClick={() => setIsModalOpen(true)}
                >
                  Start Chat with New Number
                </Button>
              </div>

              {/* Support Queue Filter Segment */}
              <div style={{ padding: "8px 10px", borderBottom: "1px solid #e2e8f0", backgroundColor: "#f8fafc", display: "flex", gap: "4px", flexWrap: "wrap" }}>
                <Button
                  size="micro"
                  variant={supportFilter === "ALL" ? "primary" : "tertiary"}
                  onClick={() => setSupportFilter("ALL")}
                >
                  {`All (${conversationsList.length})`}
                </Button>
                <Button
                  size="micro"
                  tone={needsReplyCount > 0 ? "critical" : undefined}
                  variant={supportFilter === "NEEDS_REPLY" ? "primary" : "tertiary"}
                  onClick={() => setSupportFilter("NEEDS_REPLY")}
                >
                  {`🚨 Queue (${needsReplyCount})`}
                </Button>
                <Button
                  size="micro"
                  variant={supportFilter === "ORDERS" ? "primary" : "tertiary"}
                  onClick={() => setSupportFilter("ORDERS")}
                >
                  {`📦 Orders (${ordersCount})`}
                </Button>
                <Button
                  size="micro"
                  variant={supportFilter === "RESOLVED" ? "primary" : "tertiary"}
                  onClick={() => setSupportFilter("RESOLVED")}
                >
                  {`✅ Resolved (${resolvedCount})`}
                </Button>
              </div>

              {/* Conversation List */}
              <div style={{ maxHeight: "560px", overflowY: "auto" }}>
                {filteredConversations.length === 0 ? (
                  <Box padding="400">
                    <BlockStack gap="200" align="center">
                      <Text as="p" tone="subdued" alignment="center">
                        {searchTerm
                          ? "No conversations match your search."
                          : supportFilter === "NEEDS_REPLY"
                          ? "🎉 No open support tickets waiting in the queue!"
                          : "No WhatsApp conversations in this view."}
                      </Text>
                    </BlockStack>
                  </Box>
                ) : (
                  filteredConversations.map((conv: ConversationType) => {
                    const isSelected = activeConversation?.id === conv.id;
                    const hasUnread = conv.unreadCount > 0;
                    const isNeedsReply = conv.status === "NEEDS_REPLY" || hasUnread;
                    const isResolved = conv.status === "RESOLVED";
                    const cswActive =
                      !conv.cswExpiresAt ||
                      new Date(conv.cswExpiresAt).getTime() > Date.now();

                    return (
                      <div
                        key={conv.id}
                        onClick={() => handleSelectConversation(conv.customerPhone)}
                        style={{
                          padding: "12px 14px",
                          borderBottom: "1px solid #f1f5f9",
                          backgroundColor: isSelected
                            ? "#f0fdf4"
                            : isNeedsReply
                            ? "#fff7ed"
                            : hasUnread
                            ? "#fafafa"
                            : "#ffffff",
                          borderLeft: isSelected
                            ? "4px solid #16a34a"
                            : isNeedsReply
                            ? "4px solid #ea580c"
                            : "4px solid transparent",
                          cursor: "pointer",
                          transition: "all 0.15s ease",
                        }}
                      >
                        <InlineStack align="space-between" blockAlign="start">
                          <InlineStack gap="200" blockAlign="center">
                            <Avatar
                              customer
                              name={conv.customerName || "Customer"}
                              initials={String(conv.customerName || "WA").slice(0, 2).toUpperCase()}
                              size="sm"
                            />
                            <div>
                              <Text
                                as="span"
                                variant="bodySm"
                                fontWeight={isSelected || isNeedsReply || hasUnread ? "bold" : "regular"}
                              >
                                {conv.customerName || "Customer"}
                              </Text>
                              {conv.lastOrderNumber && (
                                <Tag>{String(conv.lastOrderNumber)}</Tag>
                              )}
                            </div>
                          </InlineStack>

                          <InlineStack gap="100" blockAlign="center">
                            <Text as="span" variant="bodyXs" tone="subdued">
                              {new Date(conv.lastMessageAt).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </Text>
                            {hasUnread && (
                              <span
                                style={{
                                  backgroundColor: "#eab308",
                                  color: "#000",
                                  borderRadius: "10px",
                                  padding: "1px 6px",
                                  fontSize: "11px",
                                  fontWeight: "bold",
                                }}
                              >
                                {String(conv.unreadCount)}
                              </span>
                            )}
                          </InlineStack>
                        </InlineStack>

                        <div style={{ marginTop: "4px", paddingLeft: "36px" }}>
                          <Text as="p" variant="bodyXs" tone="subdued" truncate>
                            {conv.lastMessageText || "New conversation"}
                          </Text>
                          <div style={{ marginTop: "4px", display: "flex", gap: "6px", alignItems: "center" }}>
                            {isNeedsReply && (
                              <Badge tone="critical" size="small">
                                🚨 Needs Reply
                              </Badge>
                            )}
                            {isResolved && (
                              <Badge tone="success" size="small">
                                ✅ Resolved
                              </Badge>
                            )}
                            {cswActive ? (
                              <Badge tone="success" size="small">
                                🟢 24h Window Open
                              </Badge>
                            ) : (
                              <Badge tone="info" size="small">
                                Template Reach
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </Card>
          </Layout.Section>

          {/* Right Area: Active Chat Feed & Message Composer */}
          <Layout.Section>
            {activeConversation ? (
              <Card padding="0">
                {/* Active Chat Header */}
                <div
                  style={{
                    padding: "14px 20px",
                    borderBottom: "1px solid #e2e8f0",
                    backgroundColor: "#f8fafc",
                  }}
                >
                  <InlineStack align="space-between" blockAlign="center">
                    <InlineStack gap="300" blockAlign="center">
                      <Avatar
                        customer
                        name={activeConversation.customerName || "Customer"}
                        initials={String(activeConversation.customerName || "WA").slice(0, 2).toUpperCase()}
                        size="md"
                      />
                      <div>
                        <Text as="h2" variant="headingSm">
                          {activeConversation.customerName || "Customer"}
                        </Text>
                        <InlineStack gap="150" blockAlign="center">
                          <Text as="span" variant="bodyXs" tone="subdued">
                            +{activeConversation.customerPhone}
                          </Text>
                          {activeConversation.status === "NEEDS_REPLY" && (
                            <Badge tone="critical">🚨 Support Ticket Open</Badge>
                          )}
                          {activeConversation.status === "RESOLVED" && (
                            <Badge tone="success">✅ Ticket Resolved</Badge>
                          )}
                          {activeConversation.lastOrderNumber && (
                            <Tag>{String(activeConversation.lastOrderNumber)}</Tag>
                          )}
                          {activeConfirmation?.status === "CONFIRMED" && (
                            <Badge tone="success">✅ Address Confirmed</Badge>
                          )}
                          {activeConfirmation?.status === "UPDATE_REQUESTED" && (
                            <Badge tone="attention">⏳ Awaiting Address Text</Badge>
                          )}
                          {activeConfirmation?.status === "ADDRESS_UPDATED" && (
                            <Badge tone="critical">📝 Address Updated</Badge>
                          )}
                          {activeConfirmation?.status === "QUERY_REQUESTED" && (
                            <Badge tone="info">💬 Support Requested</Badge>
                          )}
                        </InlineStack>
                      </div>
                    </InlineStack>

                    <InlineStack gap="200" blockAlign="center">
                      {activeConversation.status === "NEEDS_REPLY" ? (
                        <Button
                          size="slim"
                          variant="primary"
                          onClick={() => {
                            const form = new FormData();
                            form.append("intent", "updateStatus");
                            form.append("customerPhone", activeConversation.customerPhone);
                            form.append("status", "RESOLVED");
                            fetcher.submit(form, { method: "POST" });
                          }}
                        >
                          ✅ Mark as Resolved
                        </Button>
                      ) : (
                        <Button
                          size="slim"
                          onClick={() => {
                            const form = new FormData();
                            form.append("intent", "updateStatus");
                            form.append("customerPhone", activeConversation.customerPhone);
                            form.append("status", "NEEDS_REPLY");
                            fetcher.submit(form, { method: "POST" });
                          }}
                        >
                          🚨 Flag for Support
                        </Button>
                      )}
                      <Button
                        size="slim"
                        onClick={() => setIsTemplateModalOpen(true)}
                      >
                        📋 Send Template
                      </Button>
                    </InlineStack>
                  </InlineStack>

                  {/* Customer Notes Banner (if they submitted updated address) */}
                  {activeConfirmation?.customerNotes && (
                    <div style={{ marginTop: "8px", padding: "8px 12px", backgroundColor: "#fffbeb", border: "1px solid #fef3c7", borderRadius: "6px" }}>
                      <Text as="p" variant="bodyXs" tone="caution">
                        <b>📝 Customer's Address Correction Request:</b> "{activeConfirmation.customerNotes}"
                      </Text>
                    </div>
                  )}
                </div>

                {/* Message Bubble Stream */}
                <div
                  style={{
                    height: "440px",
                    overflowY: "auto",
                    padding: "20px",
                    backgroundColor: "#efeae2",
                    display: "flex",
                    flexDirection: "column",
                    gap: "12px",
                  }}
                >
                  {activeConversation.messages.map((msg) => {
                    const isCustomer = msg.sender === "CUSTOMER";
                    const isMerchant = msg.sender === "MERCHANT";
                    const isImage = msg.messageType === "IMAGE" || (msg.mimeType && msg.mimeType.startsWith("image/")) || (msg.mediaUrl && msg.mediaUrl.match(/\.(jpeg|jpg|png|webp|gif)/i));
                    const isVideo = msg.messageType === "VIDEO" || (msg.mimeType && msg.mimeType.startsWith("video/"));
                    const isDocument = msg.messageType === "DOCUMENT" || msg.mimeType === "application/pdf";
                    const isAudio = msg.messageType === "AUDIO" || (msg.mimeType && msg.mimeType.startsWith("audio/"));
                    const mediaSrc = msg.mediaUrl || (msg.mediaId ? `/api/meta/media?mediaId=${msg.mediaId}` : null);

                    return (
                      <div
                        key={msg.id}
                        style={{
                          alignSelf: isCustomer ? "flex-start" : "flex-end",
                          maxWidth: "75%",
                          backgroundColor: isCustomer ? "#ffffff" : isMerchant ? "#dcf8c6" : "#e0f2fe",
                          borderRadius: "10px",
                          padding: "10px 14px",
                          boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
                          position: "relative",
                        }}
                      >
                        <div
                          style={{
                            fontSize: "10px",
                            fontWeight: 600,
                            color: isCustomer ? "#0284c7" : isMerchant ? "#15803d" : "#475569",
                            marginBottom: "4px",
                          }}
                        >
                          {isCustomer ? "👤 Customer" : isMerchant ? "🧑‍💼 StorePing Merchant" : "🤖 Store Automation"}
                        </div>

                        {/* Media: Image Rendering */}
                        {isImage && mediaSrc && (
                          <div style={{ marginBottom: "6px", borderRadius: "8px", overflow: "hidden", maxWidth: "320px" }}>
                            <a href={mediaSrc} target="_blank" rel="noopener noreferrer">
                              <img
                                src={mediaSrc}
                                alt={msg.caption || "Customer WhatsApp Image"}
                                style={{
                                  width: "100%",
                                  maxHeight: "280px",
                                  objectFit: "cover",
                                  display: "block",
                                  borderRadius: "8px",
                                  cursor: "pointer",
                                }}
                              />
                            </a>
                          </div>
                        )}

                        {/* Media: Video Rendering */}
                        {isVideo && mediaSrc && (
                          <div style={{ marginBottom: "6px", borderRadius: "8px", overflow: "hidden", maxWidth: "320px" }}>
                            <video
                              controls
                              src={mediaSrc}
                              style={{ width: "100%", maxHeight: "260px", borderRadius: "8px", display: "block" }}
                            />
                          </div>
                        )}

                        {/* Media: Document Rendering */}
                        {isDocument && mediaSrc && (
                          <div style={{ marginBottom: "6px" }}>
                            <a
                              href={`${mediaSrc}&download=true`}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "10px",
                                padding: "8px 12px",
                                background: "#f8fafc",
                                borderRadius: "8px",
                                border: "1px solid #e2e8f0",
                                textDecoration: "none",
                                color: "#0f172a",
                              }}
                            >
                              <span style={{ fontSize: "22px" }}>📄</span>
                              <div>
                                <div style={{ fontSize: "12px", fontWeight: 600 }}>{msg.caption || "View Attached Document"}</div>
                                <div style={{ fontSize: "10px", color: "#64748b" }}>Click to download file</div>
                              </div>
                            </a>
                          </div>
                        )}

                        {/* Media: Audio / Voice Note */}
                        {isAudio && mediaSrc && (
                          <div style={{ marginBottom: "6px" }}>
                            <audio controls src={mediaSrc} style={{ width: "100%", maxWidth: "260px" }} />
                          </div>
                        )}

                        {/* Text / Caption */}
                        {msg.bodyText && (!isImage || msg.bodyText !== "📷 Photo") && (!isVideo || msg.bodyText !== "🎥 Video") && (
                          <div
                            style={{
                              fontSize: "13px",
                              lineHeight: "1.45",
                              color: "#1e293b",
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word",
                            }}
                          >
                            {formatWhatsAppText(msg.bodyText, { isPortal: false })}
                          </div>
                        )}

                        <div
                          style={{
                            textAlign: "right",
                            fontSize: "10px",
                            color: "#94a3b8",
                            marginTop: "4px",
                          }}
                        >
                          {new Date(msg.createdAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}{" "}
                          {!isCustomer && (
                            <span style={{ color: msg.status === "READ" ? "#34b7f1" : "#94a3b8" }}>
                              {msg.status === "READ" ? "✓✓" : msg.status === "DELIVERED" ? "✓✓" : "✓"}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  <div ref={messagesEndRef} />
                </div>

                {/* Reply Composer Bar with Media Attachment & Template Selector */}
                <div style={{ padding: "14px 20px", borderTop: "1px solid #e2e8f0", backgroundColor: "#ffffff" }}>
                  <BlockStack gap="300">
                    {/* Quick Response Chips & Attach Button */}
                    <InlineStack gap="200" align="space-between" wrap>
                      <InlineStack gap="150" wrap>
                        <div
                          onClick={() => setReplyText("Hello! Thank you for contacting us. How can we help you today? 😊")}
                          style={{ cursor: "pointer" }}
                        >
                          <Tag>👋 Greeting</Tag>
                        </div>
                        <div
                          onClick={() =>
                            setReplyText(
                              "Great news! Your order is being processed and will be shipped shortly. 🚚"
                            )
                          }
                          style={{ cursor: "pointer" }}
                        >
                          <Tag>🚚 Order Status</Tag>
                        </div>
                        <div
                          onClick={() =>
                            setReplyText(
                              "Here is a special 10% discount code for your next order: SAVE10 🎁"
                            )
                          }
                          style={{ cursor: "pointer" }}
                        >
                          <Tag>🎁 Offer Code</Tag>
                        </div>
                      </InlineStack>

                      <InlineStack gap="150">
                        <Button
                          size="slim"
                          onClick={() => setIsTemplateModalOpen(true)}
                        >
                          📋 Template
                        </Button>
                        <Button
                          size="slim"
                          variant={showMediaInput ? "primary" : "secondary"}
                          onClick={() => setShowMediaInput(!showMediaInput)}
                        >
                          {showMediaInput ? "✕ Close Attachment" : "📷 Attach Image / File"}
                        </Button>
                      </InlineStack>
                    </InlineStack>

                    {/* Media Attachment Input Drawer */}
                    {showMediaInput && (
                      <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                        <BlockStack gap="200">
                          <Text as="p" variant="bodyXs" fontWeight="semibold">
                            Attach Public Image / Document URL (e.g. Shopify Files CDN URL):
                          </Text>
                          <InlineStack gap="200" align="space-between">
                            <div style={{ flex: 1 }}>
                              <TextField
                                label="Media URL"
                                labelHidden
                                placeholder="https://cdn.shopify.com/s/files/.../item.jpg"
                                value={replyMediaUrl}
                                onChange={setReplyMediaUrl}
                                autoComplete="off"
                              />
                            </div>
                            <select
                              value={mediaType}
                              onChange={(e) => setMediaType(e.target.value as any)}
                              style={{
                                padding: "6px 10px",
                                borderRadius: "8px",
                                border: "1px solid #cbd5e1",
                                fontSize: "13px",
                              }}
                            >
                              <option value="IMAGE">📷 Image</option>
                              <option value="VIDEO">🎥 Video</option>
                              <option value="DOCUMENT">📄 PDF / Doc</option>
                            </select>
                          </InlineStack>
                        </BlockStack>
                      </Box>
                    )}

                    {/* WhatsApp Rich Formatting Toolbar for Polaris */}
                    <InlineStack gap="100" blockAlign="center" align="space-between" wrap>
                      <InlineStack gap="100" blockAlign="center">
                        <Button size="micro" onClick={() => handleApplyReplyFormat("bold")}>
                          *B* Bold
                        </Button>
                        <Button size="micro" onClick={() => handleApplyReplyFormat("italic")}>
                          _I_ Italic
                        </Button>
                        <Button size="micro" onClick={() => handleApplyReplyFormat("strike")}>
                          ~S~ Strike
                        </Button>
                        <Button size="micro" onClick={() => handleApplyReplyFormat("code")}>
                          &lt;/&gt; Code
                        </Button>
                        <Button
                          size="micro"
                          onClick={() => {
                            const url = window.prompt("Enter Website URL (e.g. https://yourstore.com):", "https://");
                            if (url) handleApplyReplyFormat("link", url);
                          }}
                        >
                          🔗 Link
                        </Button>
                        <Button size="micro" onClick={() => handleApplyReplyFormat("newline")}>
                          ↵ Line Break
                        </Button>
                        <Button
                          size="micro"
                          pressed={showEmojiPicker}
                          onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                        >
                          😊 Emojis
                        </Button>
                      </InlineStack>
                      <Text as="span" variant="bodyXs" tone="subdued">
                        Supports *bold*, _italic_, ~strike~, `code`, & Enter (newline)
                      </Text>
                    </InlineStack>

                    {/* Emoji Quick Access Pills */}
                    {showEmojiPicker && (
                      <Box padding="200" background="bg-surface-secondary" borderRadius="200">
                        <InlineStack gap="150" wrap>
                          <Text as="span" variant="bodyXs" tone="subdued">Quick Emojis:</Text>
                          {COMMON_WHATSAPP_EMOJIS.map((emoji) => (
                            <div
                              key={emoji}
                              onClick={() => handleApplyReplyFormat("emoji", emoji)}
                              style={{ cursor: "pointer", fontSize: "16px", padding: "2px 4px" }}
                            >
                              {emoji}
                            </div>
                          ))}
                        </InlineStack>
                      </Box>
                    )}

                    {/* Text Reply Input */}
                    <div style={{ display: "flex", gap: "10px", alignItems: "flex-end" }}>
                      <div style={{ flex: 1 }}>
                        <TextField
                          label="Type WhatsApp Reply"
                          labelHidden
                          placeholder={replyMediaUrl ? "Add an optional caption for this image/file..." : "Type your WhatsApp reply (supports *bold*, _italic_, ~strike~, links, and Enter for new lines)..."}
                          value={replyText}
                          onChange={setReplyText}
                          multiline={3}
                          autoComplete="off"
                        />
                      </div>
                      <Button
                        variant="primary"
                        icon={SendIcon}
                        onClick={handleSendReply}
                        loading={isSubmitting}
                      >
                        {replyMediaUrl ? "Send Media" : "Send Reply"}
                      </Button>
                    </div>
                  </BlockStack>
                </div>
              </Card>
            ) : (
              <Card>
                <Box padding="800">
                  <BlockStack gap="200" align="center">
                    <Icon source={ChatIcon} tone="subdued" />
                    <Text as="h3" variant="headingMd" alignment="center">
                      Select a Conversation
                    </Text>
                    <Text as="p" tone="subdued" alignment="center">
                      Choose a customer chat from the list, search by phone, or click "Start New Chat" above.
                    </Text>
                  </BlockStack>
                </Box>
              </Card>
            )}
          </Layout.Section>
        </Layout>
      </BlockStack>

      {/* Direct Template Send Modal in Chat */}
      <Modal
        open={isTemplateModalOpen}
        onClose={() => setIsTemplateModalOpen(false)}
        title={`📋 Send WhatsApp Template to +${activeConversation?.customerPhone || ""}`}
        primaryAction={{
          content: "🚀 Send Template Message",
          onAction: handleSendTemplateSubmit,
          loading: isSubmitting,
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: () => setIsTemplateModalOpen(false),
          },
        ]}
      >
        <Modal.Section>
          <FormLayout>
            <Text as="p" variant="bodySm">
              Recipient: <b>{activeConversation?.customerName || "Customer"}</b> (+{activeConversation?.customerPhone})
              {activeConversation?.lastOrderNumber && ` • Order: ${activeConversation.lastOrderNumber}`}
            </Text>
            <Select
              label="Select Pre-Approved Template"
              options={[
                { label: "🧾 Order & Delivery Address Confirmation (3 Interactive Buttons)", value: "ORDER_CONFIRM_ADDRESS" },
                { label: "📦 Standard Order Confirmation", value: "ORDER_CONFIRM" },
                { label: "💳 Cash On Delivery (COD) Verification", value: "COD_CONFIRM" },
                { label: "🚚 Shipping & Live Tracking Update", value: "ORDER_SHIPPED" },
                { label: "📦 Order Delivered & Review Request", value: "ORDER_DELIVERED" },
                { label: "✨ Inactive Customer Win-Back", value: "WIN_BACK" },
              ]}
              value={selectedTemplateEvent}
              onChange={setSelectedTemplateEvent}
              helpText="Template messages deliver worldwide 24/7 even if customer service window has expired."
            />
          </FormLayout>
        </Modal.Section>
      </Modal>

      {/* Start New Conversation Modal */}
      <Modal
        open={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title="💬 Start New WhatsApp Conversation"
        primaryAction={{
          content: "🚀 Send & Start Chat",
          onAction: handleStartNewChatSubmit,
          loading: isSubmitting,
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: () => setIsModalOpen(false),
          },
        ]}
      >
        <Modal.Section>
          <FormLayout>
            <TextField
              label="Recipient Mobile Number"
              placeholder={merchant?.phone ? `+${merchant.phone.replace(/[^0-9]/g, "")}` : "+91 9876543210"}
              value={newPhone}
              onChange={setNewPhone}
              autoComplete="off"
              helpText="Include country code (e.g. +91 9876543210). 10-digit Indian numbers auto-prefix with 91."
            />
            <TextField
              label="Customer Name (Optional)"
              placeholder="e.g. Rahul Sharma"
              value={newName}
              onChange={setNewName}
              autoComplete="off"
            />
            <TextField
              label="Order Number (Optional)"
              placeholder="e.g. #1025"
              value={newOrderNumber}
              onChange={setNewOrderNumber}
              autoComplete="off"
            />
            <BlockStack gap="200">
              <InlineStack gap="100" blockAlign="center" align="space-between" wrap>
                <InlineStack gap="100" blockAlign="center">
                  <Button size="micro" onClick={() => handleApplyNewChatFormat("bold")}>
                    *B* Bold
                  </Button>
                  <Button size="micro" onClick={() => handleApplyNewChatFormat("italic")}>
                    _I_ Italic
                  </Button>
                  <Button size="micro" onClick={() => handleApplyNewChatFormat("strike")}>
                    ~S~ Strike
                  </Button>
                  <Button size="micro" onClick={() => handleApplyNewChatFormat("code")}>
                    &lt;/&gt; Code
                  </Button>
                  <Button
                    size="micro"
                    onClick={() => {
                      const url = window.prompt("Enter Website URL (e.g. https://yourstore.com):", "https://");
                      if (url) handleApplyNewChatFormat("link", url);
                    }}
                  >
                    🔗 Link
                  </Button>
                  <Button size="micro" onClick={() => handleApplyNewChatFormat("newline")}>
                    ↵ Line Break
                  </Button>
                  <Button
                    size="micro"
                    pressed={newChatEmojiPicker}
                    onClick={() => setNewChatEmojiPicker(!newChatEmojiPicker)}
                  >
                    😊 Emojis
                  </Button>
                </InlineStack>
              </InlineStack>

              {newChatEmojiPicker && (
                <Box padding="200" background="bg-surface-secondary" borderRadius="200">
                  <InlineStack gap="150" wrap>
                    {COMMON_WHATSAPP_EMOJIS.map((emoji) => (
                      <div
                        key={emoji}
                        onClick={() => handleApplyNewChatFormat("emoji", emoji)}
                        style={{ cursor: "pointer", fontSize: "16px", padding: "2px 4px" }}
                      >
                        {emoji}
                      </div>
                    ))}
                  </InlineStack>
                </Box>
              )}

              <TextField
                label="Initial Message Body"
                value={newInitialMessage}
                onChange={setNewInitialMessage}
                multiline={4}
                autoComplete="off"
                helpText="Supports WhatsApp formatting: *bold*, _italic_, ~strike~, `code`, and newlines."
              />
            </BlockStack>
          </FormLayout>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
