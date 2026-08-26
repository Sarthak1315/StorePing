import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useSearchParams } from "@remix-run/react";
import { useState, useEffect, useRef } from "react";
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
} from "@shopify/polaris";
import { SearchIcon, SendIcon, ChatIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { sendWhatsAppMessage } from "../utils/meta-whatsapp.server";
import { logInfo, logError } from "../utils/logger.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const searchQuery = (url.searchParams.get("q") || "").trim();
  const filterTab = url.searchParams.get("filter") || "all";
  const selectedPhone = url.searchParams.get("phone") || "";

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

  // Seed sample conversation if table is completely empty
  const count = await db.conversation.count({ where: { merchantId: merchant.id } });
  if (count === 0) {
    try {
      const welcomeConv = await db.conversation.create({
        data: {
          merchantId: merchant.id,
          customerPhone: "919374626600",
          customerName: "Sarthak Patel",
          lastOrderNumber: "#1001",
          lastMessageText: "Hello! Welcome to StorePing WhatsApp Live Inbox.",
          lastMessageAt: new Date(),
          unreadCount: 0,
          status: "ACTIVE",
          cswExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });

      await db.chatMessage.create({
        data: {
          conversationId: welcomeConv.id,
          sender: "BOT",
          messageType: "TEXT",
          bodyText: "Hello! Welcome to StorePing WhatsApp Live Inbox. All customer chats and order notifications appear here in real time.",
          status: "DELIVERED",
        },
      });
    } catch (seedErr: any) {
      console.warn("Seeding initial conversation warning:", seedErr);
    }
  }

  // Build Prisma search filter
  const whereClause: any = {
    merchantId: merchant.id,
  };

  if (searchQuery) {
    whereClause.OR = [
      { customerPhone: { contains: searchQuery } },
      { customerName: { contains: searchQuery, mode: "insensitive" } },
      { lastOrderNumber: { contains: searchQuery, mode: "insensitive" } },
      { lastMessageText: { contains: searchQuery, mode: "insensitive" } },
    ];
  }

  if (filterTab === "unread") {
    whereClause.unreadCount = { gt: 0 };
  } else if (filterTab === "active") {
    whereClause.status = "ACTIVE";
  }

  const conversations = await db.conversation.findMany({
    where: whereClause,
    orderBy: { lastMessageAt: "desc" },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
      },
    },
    take: 50,
  });

  // Select active conversation
  const activeConversation =
    conversations.find((c) => c.customerPhone === selectedPhone) || conversations[0] || null;

  return json({
    merchant,
    conversations,
    activeConversation,
    searchQuery,
    filterTab,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const merchant = await db.merchant.findUnique({ where: { shop } });
  if (!merchant) throw new Response("Merchant not found", { status: 404 });

  if (intent === "sendReply") {
    const customerPhone = formData.get("customerPhone") as string;
    const messageText = (formData.get("messageText") as string || "").trim();

    if (!customerPhone || !messageText) {
      return json({ success: false, error: "Message text cannot be empty.", messageId: null }, { status: 400 });
    }

    try {
      const result = await sendWhatsAppMessage({
        merchantId: merchant.id,
        recipientPhone: customerPhone,
        customerName: "Customer",
        eventType: "SUPPORT_CHAT",
        bodyText: messageText,
        senderRole: "MERCHANT",
      });

      if (!result.success) {
        return json({ success: false, error: result.error || "Failed to send WhatsApp message", messageId: null }, { status: 500 });
      }

      await logInfo(`Merchant replied to customer ${customerPhone}`, { shop, source: "inbox" });
      return json({ success: true, error: null, messageId: result.messageId });
    } catch (err: any) {
      await logError(`Failed to send reply: ${err.message}`, { shop, source: "inbox" });
      return json({ success: false, error: err.message, messageId: null }, { status: 500 });
    }
  }

  if (intent === "resolveConversation") {
    const conversationId = formData.get("conversationId") as string;
    await db.conversation.update({
      where: { id: conversationId },
      data: { status: "RESOLVED", unreadCount: 0 },
    });
    return json({ success: true, error: null, messageId: null });
  }

  return json({ success: true, error: null, messageId: null });
};

export default function WhatsAppInboxPage() {
  const { merchant, conversations, activeConversation, searchQuery, filterTab } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const actionData = fetcher.data as any;
  const [searchParams, setSearchParams] = useSearchParams();

  const [localSearch, setLocalSearch] = useState(searchQuery);
  const [replyText, setReplyText] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll chat to bottom on load/update
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeConversation?.messages]);

  // Clear reply input after successful send
  useEffect(() => {
    if (actionData?.success && fetcher.state === "idle") {
      setReplyText("");
    }
  }, [actionData, fetcher.state]);

  const handleSearchSubmit = () => {
    const params = new URLSearchParams(searchParams);
    if (localSearch) {
      params.set("q", localSearch);
    } else {
      params.delete("q");
    }
    setSearchParams(params);
  };

  const handleSelectConversation = (phone: string) => {
    const params = new URLSearchParams(searchParams);
    params.set("phone", phone);
    setSearchParams(params);
  };

  const handleSendReply = () => {
    if (!replyText.trim() || !activeConversation) return;
    const form = new FormData();
    form.append("intent", "sendReply");
    form.append("customerPhone", activeConversation.customerPhone);
    form.append("messageText", replyText);
    fetcher.submit(form, { method: "POST" });
  };

  const isCSWOpen =
    activeConversation?.cswExpiresAt &&
    new Date(activeConversation.cswExpiresAt).getTime() > Date.now();

  const isSending = fetcher.state !== "idle";

  return (
    <Page
      title="WhatsApp Live Conversations & Support Inbox"
      subtitle="Search, view, and reply to all customer WhatsApp chats and order inquiries in real time."
      fullWidth
    >
      <BlockStack gap="400">
        {actionData?.error && (
          <Banner title="Failed to Send Reply" tone="critical" onDismiss={() => {}}>
            {actionData.error}
          </Banner>
        )}

        <Layout>
          {/* Left Column: Search & Conversations List */}
          <Layout.Section variant="oneThird">
            <Card padding="300">
              <BlockStack gap="300">
                {/* Search Bar */}
                <div style={{ display: "flex", gap: "8px" }}>
                  <div style={{ flex: 1 }}>
                    <TextField
                      label="Search Conversations"
                      labelHidden
                      placeholder="Search phone, name, or Order #1001..."
                      value={localSearch}
                      onChange={setLocalSearch}
                      autoComplete="off"
                      prefix={<Icon source={SearchIcon} />}
                      clearButton
                      onClearButtonClick={() => {
                        setLocalSearch("");
                        const params = new URLSearchParams(searchParams);
                        params.delete("q");
                        setSearchParams(params);
                      }}
                    />
                  </div>
                  <Button onClick={handleSearchSubmit}>Search</Button>
                </div>

                <Divider />

                {/* Conversation List */}
                <div style={{ maxHeight: "650px", overflowY: "auto" }}>
                  {conversations.length === 0 ? (
                    <Box padding="400">
                      <Text as="p" tone="subdued" alignment="center">
                        No conversations found.
                      </Text>
                    </Box>
                  ) : (
                    <BlockStack gap="100">
                      {conversations.map((conv) => {
                        const isSelected = activeConversation?.id === conv.id;
                        const hasCSW =
                          conv.cswExpiresAt &&
                          new Date(conv.cswExpiresAt).getTime() > Date.now();

                        return (
                          <div
                            key={conv.id}
                            onClick={() => handleSelectConversation(conv.customerPhone)}
                            style={{
                              padding: "12px",
                              borderRadius: "8px",
                              backgroundColor: isSelected ? "#f0fdf4" : "transparent",
                              border: isSelected ? "1px solid #86efac" : "1px solid transparent",
                              cursor: "pointer",
                              transition: "all 0.15s ease",
                            }}
                          >
                            <InlineStack align="space-between" blockAlign="start">
                              <InlineStack gap="200" blockAlign="center">
                                <Avatar
                                  customer
                                  size="md"
                                  name={conv.customerName || conv.customerPhone}
                                />
                                <div>
                                  <Text as="span" variant="bodyMd" fontWeight="semibold">
                                    {conv.customerName || `+${conv.customerPhone}`}
                                  </Text>
                                  {conv.lastOrderNumber && (
                                    <div style={{ marginTop: "2px" }}>
                                      <Tag>{conv.lastOrderNumber}</Tag>
                                    </div>
                                  )}
                                </div>
                              </InlineStack>
                              <div style={{ textAlign: "right" }}>
                                <Text as="span" variant="bodyXs" tone="subdued">
                                  {new Date(conv.lastMessageAt).toLocaleTimeString([], {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}
                                </Text>
                                {conv.unreadCount > 0 && (
                                  <div style={{ marginTop: "4px" }}>
                                    <Badge tone="attention">{String(conv.unreadCount)}</Badge>
                                  </div>
                                )}
                              </div>
                            </InlineStack>

                            {/* Snippet */}
                            <div
                              style={{
                                marginTop: "6px",
                                fontSize: "12px",
                                color: "#64748b",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {conv.lastMessageText || "No messages yet"}
                            </div>

                            {/* Status Badges */}
                            <div style={{ marginTop: "6px" }}>
                              {hasCSW ? (
                                <Badge tone="success">🟢 24h Window Open (Free)</Badge>
                              ) : (
                                <Badge tone="info">Template Reach</Badge>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </BlockStack>
                  )}
                </div>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* Right Column: Chat History & Real-Time Reply Box */}
          <Layout.Section>
            {activeConversation ? (
              <Card padding="0">
                {/* Chat Header */}
                <div
                  style={{
                    padding: "16px 20px",
                    borderBottom: "1px solid #e2e8f0",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    backgroundColor: "#f8fafc",
                  }}
                >
                  <InlineStack gap="300" blockAlign="center">
                    <Avatar
                      customer
                      size="lg"
                      name={activeConversation.customerName || activeConversation.customerPhone}
                    />
                    <div>
                      <Text as="h3" variant="headingMd">
                        {activeConversation.customerName || `Customer (+${activeConversation.customerPhone})`}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        Phone: +{activeConversation.customerPhone}
                        {activeConversation.lastOrderNumber && ` • Order: ${activeConversation.lastOrderNumber}`}
                      </Text>
                    </div>
                  </InlineStack>

                  <div>
                    {isCSWOpen ? (
                      <Badge tone="success">🟢 24h Service Window Active (Free Replies)</Badge>
                    ) : (
                      <Badge tone="warning">⚠️ Customer Service Window Closed</Badge>
                    )}
                  </div>
                </div>

                {/* Messages Feed */}
                <div
                  style={{
                    backgroundColor: "#efeae2",
                    padding: "20px",
                    height: "440px",
                    overflowY: "auto",
                    display: "flex",
                    flexDirection: "column",
                    gap: "12px",
                  }}
                >
                  {activeConversation.messages.map((msg) => {
                    const isCustomer = msg.sender === "CUSTOMER";
                    const isMerchant = msg.sender === "MERCHANT";

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
                            marginBottom: "3px",
                          }}
                        >
                          {isCustomer ? "👤 Customer" : isMerchant ? "🧑‍💼 Support Staff" : "🤖 Store Automation"}
                        </div>

                        <div
                          style={{
                            fontSize: "13px",
                            lineHeight: "1.4",
                            color: "#1e293b",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                          }}
                        >
                          {msg.bodyText}
                        </div>

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

                {/* Reply Composer Bar */}
                <div style={{ padding: "16px 20px", borderTop: "1px solid #e2e8f0", backgroundColor: "#ffffff" }}>
                  <BlockStack gap="300">
                    {/* Quick Response Chips */}
                    <InlineStack gap="200" wrap>
                      <div
                        onClick={() => setReplyText("Hello! Thank you for contacting us. How can we help you today? 😊")}
                        style={{ cursor: "pointer" }}
                      >
                        <Tag>👋 Greeting</Tag>
                      </div>
                      <div
                        onClick={() =>
                          setReplyText(
                            "Great news! Your order is being processed and will be shipped within 24 hours. 🚚"
                          )
                        }
                        style={{ cursor: "pointer" }}
                      >
                        <Tag>🚚 Order Update</Tag>
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

                    <div style={{ display: "flex", gap: "10px", alignItems: "flex-end" }}>
                      <div style={{ flex: 1 }}>
                        <TextField
                          label="Type WhatsApp Reply"
                          labelHidden
                          placeholder="Type your WhatsApp reply to this customer..."
                          value={replyText}
                          onChange={setReplyText}
                          multiline={2}
                          autoComplete="off"
                        />
                      </div>
                      <Button
                        variant="primary"
                        icon={SendIcon}
                        onClick={handleSendReply}
                        loading={isSending}
                      >
                        Send Reply
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
                      Choose a customer chat from the list or search by phone number or order number.
                    </Text>
                  </BlockStack>
                </Box>
              </Card>
            )}
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
