import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation, useSearchParams } from "@remix-run/react";
import { useState } from "react";
import db from "../db.server";
import { requirePortalUser } from "../utils/portal-auth.server";
import { sendWhatsAppMessage } from "../utils/meta-whatsapp.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requirePortalUser(request);
  const url = new URL(request.url);
  const selectedPhone = url.searchParams.get("phone");
  const filter = url.searchParams.get("filter") || "ALL";

  // Fetch all conversations for this merchant
  const conversations = await db.conversation.findMany({
    where: { merchantId: user.merchantId },
    orderBy: { lastMessageAt: "desc" },
    include: {
      messages: {
        take: 1,
        orderBy: { createdAt: "desc" },
      },
    },
  });

  // If a conversation is selected, fetch full chat messages and associated order details
  let activeConversation = null;
  let activeOrder = null;

  if (selectedPhone) {
    activeConversation = await db.conversation.findUnique({
      where: {
        merchantId_customerPhone: {
          merchantId: user.merchantId,
          customerPhone: selectedPhone,
        },
      },
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (activeConversation) {
      activeOrder = await db.orderConfirmation.findFirst({
        where: {
          merchantId: user.merchantId,
          customerPhone: selectedPhone,
        },
        orderBy: { createdAt: "desc" },
      });
    }
  } else if (conversations.length > 0) {
    // Default to first conversation
    const firstPhone = conversations[0].customerPhone;
    activeConversation = await db.conversation.findUnique({
      where: {
        merchantId_customerPhone: {
          merchantId: user.merchantId,
          customerPhone: firstPhone,
        },
      },
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (activeConversation) {
      activeOrder = await db.orderConfirmation.findFirst({
        where: {
          merchantId: user.merchantId,
          customerPhone: firstPhone,
        },
        orderBy: { createdAt: "desc" },
      });
    }
  }

  // Approved templates for quick dispatch
  const templates = await db.template.findMany({
    where: { merchantId: user.merchantId, isActive: true },
    select: { id: true, name: true, eventType: true, bodyText: true },
  });

  return json({
    user,
    conversations,
    activeConversation,
    activeOrder,
    templates,
    selectedPhone: activeConversation?.customerPhone || null,
    filter,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const user = await requirePortalUser(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const customerPhone = formData.get("customerPhone") as string;

  if (!customerPhone) {
    return json({ error: "No customer phone specified." }, { status: 400 });
  }

  // 1. Send Outbound Text or PDF Message
  if (intent === "send_message") {
    const messageText = (formData.get("messageText") as string)?.trim();
    const mediaUrl = (formData.get("mediaUrl") as string)?.trim() || null;
    const mediaType = (formData.get("mediaType") as "IMAGE" | "DOCUMENT" | null) || null;
    const documentName = (formData.get("documentName") as string)?.trim() || "Document.pdf";

    if (!messageText && !mediaUrl) {
      return json({ error: "Message text or attachment is required." }, { status: 400 });
    }

    try {
      const result = await sendWhatsAppMessage({
        merchantId: user.merchantId,
        recipientPhone: customerPhone,
        customerName: "Valued Customer",
        eventType: "SUPPORT_CHAT",
        bodyText: mediaType === "DOCUMENT" ? documentName : (messageText || "Attached File"),
        mediaUrl: mediaUrl || undefined,
        mediaType: mediaType || undefined,
      });

      if (!result.success) {
        return json({ error: result.error || "Failed to send message via WhatsApp." }, { status: 400 });
      }

      // Record outbound message in database
      const conversation = await db.conversation.upsert({
        where: {
          merchantId_customerPhone: {
            merchantId: user.merchantId,
            customerPhone,
          },
        },
        create: {
          merchantId: user.merchantId,
          customerPhone,
          lastMessageText: messageText || (mediaType === "DOCUMENT" ? `📄 ${documentName}` : "📷 Image"),
          lastMessageAt: new Date(),
          unreadCount: 0,
        },
        update: {
          lastMessageText: messageText || (mediaType === "DOCUMENT" ? `📄 ${documentName}` : "📷 Image"),
          lastMessageAt: new Date(),
          unreadCount: 0,
        },
      });

      await db.chatMessage.create({
        data: {
          conversationId: conversation.id,
          sender: "MERCHANT",
          messageType: mediaType || "TEXT",
          bodyText: messageText || "",
          mediaUrl: mediaUrl || null,
          caption: mediaType === "DOCUMENT" ? documentName : null,
          metaMessageId: result.messageId || `portal_${Date.now()}`,
          status: "SENT",
        },
      });

      return json({ success: true });
    } catch (err: any) {
      return json({ error: err.message || "An error occurred." }, { status: 500 });
    }
  }

  // 2. Order Confirmation Status Update
  if (intent === "update_order_status") {
    const orderId = formData.get("orderId") as string;
    const newStatus = formData.get("status") as string;

    if (orderId && newStatus) {
      await db.orderConfirmation.update({
        where: { id: orderId },
        data: {
          status: newStatus,
          confirmedAt: newStatus === "CONFIRMED" ? new Date() : undefined,
        },
      });
      return json({ success: true, updatedStatus: newStatus });
    }
  }

  return json({ error: "Invalid action" }, { status: 400 });
}

export default function PortalInbox() {
  const { conversations, activeConversation, activeOrder, templates, selectedPhone } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSending = navigation.state === "submitting";

  const [messageInput, setMessageInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showAttachModal, setShowAttachModal] = useState(false);
  const [attachUrl, setAttachUrl] = useState("");
  const [attachType, setAttachType] = useState<"DOCUMENT" | "IMAGE">("DOCUMENT");
  const [attachFileName, setAttachFileName] = useState("Invoice.pdf");

  // Filter conversations
  const filteredConversations = conversations.filter((c) => {
    const matchesSearch =
      c.customerPhone.includes(searchQuery) ||
      (c.customerName && c.customerName.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (c.lastOrderNumber && c.lastOrderNumber.toLowerCase().includes(searchQuery.toLowerCase()));
    return matchesSearch;
  });

  return (
    <div className="flex-1 flex flex-col lg:flex-row h-[calc(100vh)] overflow-hidden bg-slate-950">
      {/* 1. Left Conversation Directory Pane */}
      <div className="w-full lg:w-80 border-r border-slate-800/80 bg-slate-900/60 flex flex-col shrink-0">
        {/* Search & Header */}
        <div className="p-4 border-b border-slate-800/80">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <span>💬</span> Chats
            </h2>
            <span className="text-xs bg-slate-800 text-emerald-400 font-mono px-2 py-0.5 rounded-full">
              {conversations.length} Active
            </span>
          </div>

          <div className="relative">
            <input
              type="text"
              placeholder="Search phone or customer..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            <span className="absolute left-3 top-2.5 text-xs text-slate-500">🔍</span>
          </div>
        </div>

        {/* Contact List Feed */}
        <div className="flex-1 overflow-y-auto divide-y divide-slate-800/40">
          {filteredConversations.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500">
              No conversations found.
            </div>
          ) : (
            filteredConversations.map((c) => {
              const isSelected = selectedPhone === c.customerPhone;
              return (
                <a
                  key={c.id}
                  href={`/portal/inbox?phone=${c.customerPhone}`}
                  className={`flex items-start gap-3 p-3.5 transition-all cursor-pointer block ${
                    isSelected
                      ? "bg-slate-800/80 border-l-4 border-emerald-500"
                      : "hover:bg-slate-800/30"
                  }`}
                >
                  <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-slate-800 to-slate-700 flex items-center justify-center font-bold text-xs text-emerald-400 shrink-0">
                    {(c.customerName || c.customerPhone.slice(-4)).slice(0, 2).toUpperCase()}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-bold text-slate-200 truncate">
                        {c.customerName || `+${c.customerPhone}`}
                      </h4>
                      <span className="text-[10px] text-slate-500 font-mono">
                        {new Date(c.lastMessageAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>

                    <p className="text-[11px] text-slate-400 truncate mt-0.5">
                      {c.lastMessageText || "New WhatsApp message"}
                    </p>

                    {c.lastOrderNumber && (
                      <span className="inline-block mt-1 text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded font-mono">
                        Order {c.lastOrderNumber}
                      </span>
                    )}
                  </div>

                  {c.unreadCount > 0 && (
                    <span className="w-4 h-4 rounded-full bg-emerald-500 text-slate-950 font-bold text-[10px] flex items-center justify-center">
                      {c.unreadCount}
                    </span>
                  )}
                </a>
              );
            })
          )}
        </div>
      </div>

      {/* 2. Middle Live WhatsApp Chat Pane */}
      {activeConversation ? (
        <div className="flex-1 flex flex-col min-w-0 bg-slate-950 relative">
          {/* Chat Header Bar */}
          <div className="px-6 py-3.5 border-b border-slate-800/80 bg-slate-900/80 flex items-center justify-between backdrop-blur-md shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-sm">
                💬
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-sm text-white">
                    {activeConversation.customerName || `Customer (+${activeConversation.customerPhone})`}
                  </h3>
                  <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded font-semibold">
                    ✓ Verified WhatsApp
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 font-mono">
                  +{activeConversation.customerPhone}
                </div>
              </div>
            </div>

            {/* 24-hour Customer Service Window Badge */}
            <div className="text-right">
              <span className="inline-flex items-center gap-1.5 text-[11px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-2.5 py-1 rounded-full font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                24h Window Active
              </span>
            </div>
          </div>

          {/* Action Error Alerts */}
          {actionData?.error && (
            <div className="p-3 bg-red-500/10 border-b border-red-500/30 text-red-400 text-xs font-medium text-center">
              ⚠️ {actionData.error}
            </div>
          )}

          {/* Chat Message Stream */}
          <div className="flex-1 overflow-y-auto p-6 space-y-4 bg-slate-950/60">
            <div className="text-center my-2">
              <span className="px-3 py-1 rounded-full bg-slate-900 border border-slate-800 text-[10px] text-slate-500 font-mono">
                🔒 End-to-end encrypted with WhatsApp Cloud API
              </span>
            </div>

            {activeConversation.messages.length === 0 ? (
              <div className="text-center py-12 text-xs text-slate-500">
                No message history yet. Type a message below to start chatting.
              </div>
            ) : (
              activeConversation.messages.map((msg) => {
                const isMerchant = msg.sender === "MERCHANT";
                const isDoc = msg.messageType === "DOCUMENT" || (msg.caption && msg.caption.endsWith(".pdf"));
                const isImage = msg.messageType === "IMAGE";

                return (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${isMerchant ? "items-end" : "items-start"}`}
                  >
                    <div
                      className={`max-w-md lg:max-w-lg rounded-2xl p-4 text-xs ${
                        isMerchant
                          ? "bg-gradient-to-br from-emerald-600 to-teal-700 text-white rounded-br-none shadow-md shadow-emerald-950/40"
                          : "bg-slate-900 border border-slate-800 text-slate-200 rounded-bl-none shadow-md"
                      }`}
                    >
                      {/* Document / PDF Card Rendering */}
                      {isDoc && (
                        <div className="mb-2 p-3 rounded-xl bg-slate-950/60 border border-white/10 flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2.5 truncate">
                            <span className="text-xl">📄</span>
                            <div className="truncate">
                              <div className="font-bold text-[11px] truncate text-white">
                                {msg.caption || "Attached Document.pdf"}
                              </div>
                              <div className="text-[10px] text-slate-400">PDF File</div>
                            </div>
                          </div>
                          {msg.mediaUrl && (
                            <a
                              href={msg.mediaUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="px-2.5 py-1 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-[10px] rounded-lg transition shrink-0"
                            >
                              Download ⬇
                            </a>
                          )}
                        </div>
                      )}

                      {/* Image Attachment Rendering */}
                      {isImage && msg.mediaUrl && (
                        <div className="mb-2 rounded-lg overflow-hidden border border-white/10">
                          <img src={msg.mediaUrl} alt="Attached Media" className="max-h-48 w-full object-cover" />
                        </div>
                      )}

                      {/* Message Body Text */}
                      {msg.bodyText && <p className="leading-relaxed whitespace-pre-wrap">{msg.bodyText}</p>}

                      {/* Message Meta Info */}
                      <div
                        className={`flex items-center justify-end gap-1.5 mt-2 text-[10px] font-mono ${
                          isMerchant ? "text-emerald-200" : "text-slate-500"
                        }`}
                      >
                        <span>
                          {new Date(msg.createdAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        {isMerchant && (
                          <span className="font-bold text-emerald-200">
                            {msg.status === "READ" ? "✓✓" : msg.status === "DELIVERED" ? "✓✓" : "✓"}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Quick Template Picker Chips */}
          <div className="px-6 py-2 border-t border-slate-800/60 bg-slate-900/40 flex items-center gap-2 overflow-x-auto">
            <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider shrink-0">
              Templates:
            </span>
            {templates.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                onClick={() => setMessageInput(tpl.bodyText)}
                className="px-2.5 py-1 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 text-[11px] font-medium transition shrink-0 border border-slate-700/60"
              >
                {tpl.name}
              </button>
            ))}
          </div>

          {/* Input Bar */}
          <div className="p-4 border-t border-slate-800 bg-slate-900/90 shrink-0">
            <Form
              method="post"
              onSubmit={() => {
                setTimeout(() => setMessageInput(""), 100);
              }}
              className="flex items-center gap-3"
            >
              <input type="hidden" name="intent" value="send_message" />
              <input type="hidden" name="customerPhone" value={activeConversation.customerPhone} />

              {/* Attach PDF/Image Trigger */}
              <button
                type="button"
                onClick={() => setShowAttachModal(!showAttachModal)}
                className="p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm transition"
                title="Attach PDF or Image"
              >
                📎
              </button>

              <input
                type="text"
                name="messageText"
                value={messageInput}
                onChange={(e) => setMessageInput(e.target.value)}
                placeholder="Type your WhatsApp message..."
                required={!attachUrl}
                className="flex-1 px-4 py-3 bg-slate-950 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />

              <button
                type="submit"
                disabled={isSending}
                className="px-5 py-3 bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-bold rounded-xl text-sm transition shadow-lg shadow-emerald-500/20 disabled:opacity-50 flex items-center gap-2"
              >
                <span>{isSending ? "Sending..." : "Send"}</span>
                <span>➤</span>
              </button>
            </Form>
          </div>

          {/* Attachment Modal */}
          {showAttachModal && (
            <div className="absolute bottom-20 left-6 p-4 rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl z-30 w-80">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-xs font-bold text-white">Attach File (PDF / Image)</h4>
                <button
                  type="button"
                  onClick={() => setShowAttachModal(false)}
                  className="text-slate-400 hover:text-white text-xs"
                >
                  ✕
                </button>
              </div>

              <Form
                method="post"
                onSubmit={() => {
                  setShowAttachModal(false);
                }}
                className="space-y-3"
              >
                <input type="hidden" name="intent" value="send_message" />
                <input type="hidden" name="customerPhone" value={activeConversation.customerPhone} />

                <div>
                  <label className="block text-[10px] text-slate-400 mb-1">Attachment Type</label>
                  <select
                    name="mediaType"
                    value={attachType}
                    onChange={(e: any) => setAttachType(e.target.value)}
                    className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-xs text-white"
                  >
                    <option value="DOCUMENT">📄 PDF Document</option>
                    <option value="IMAGE">📷 Image (JPG/PNG)</option>
                  </select>
                </div>

                {attachType === "DOCUMENT" && (
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-1">Document Display Name</label>
                    <input
                      type="text"
                      name="documentName"
                      value={attachFileName}
                      onChange={(e) => setAttachFileName(e.target.value)}
                      placeholder="e.g. Invoice_#1024.pdf"
                      className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-xs text-white"
                      required
                    />
                  </div>
                )}

                <div>
                  <label className="block text-[10px] text-slate-400 mb-1">Public File URL (e.g. CDN Link)</label>
                  <input
                    type="url"
                    name="mediaUrl"
                    value={attachUrl}
                    onChange={(e) => setAttachUrl(e.target.value)}
                    placeholder="https://cdn.shopify.com/.../invoice.pdf"
                    className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-xs text-white"
                    required
                  />
                </div>

                <button
                  type="submit"
                  className="w-full py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-lg text-xs transition"
                >
                  Send Attached File
                </button>
              </Form>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center p-8 text-center text-slate-500 text-sm">
          Select a customer conversation from the left to start chatting.
        </div>
      )}

      {/* 3. Right Sidebar (Shopify Order Profile) */}
      {activeOrder && (
        <div className="w-full lg:w-72 border-l border-slate-800/80 bg-slate-900/40 p-5 shrink-0 overflow-y-auto hidden xl:block">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-4">
            Shopify Order Context
          </h3>

          <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-white">{activeOrder.orderNumber}</span>
              <span
                className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                  activeOrder.status === "CONFIRMED"
                    ? "bg-emerald-500/20 text-emerald-400"
                    : activeOrder.status === "CANCELLED"
                    ? "bg-red-500/20 text-red-400"
                    : "bg-amber-500/20 text-amber-400"
                }`}
              >
                {activeOrder.status}
              </span>
            </div>

            <div className="text-xs text-slate-300">
              <span className="text-slate-500">Customer:</span> {activeOrder.customerName || "—"}
            </div>

            <div className="text-xs text-slate-300">
              <span className="text-slate-500">Amount:</span>{" "}
              <strong className="text-white font-mono">
                {activeOrder.currency} {activeOrder.totalAmount || "0.00"}
              </strong>
            </div>

            <div className="text-xs text-slate-300 border-t border-slate-800/80 pt-2">
              <span className="text-slate-500 block mb-1">Shipping Address:</span>
              <p className="text-[11px] text-slate-400 leading-relaxed font-sans">
                {activeOrder.shippingAddress || "Standard shipping address recorded."}
              </p>
            </div>
          </div>

          {/* Order Quick Actions */}
          <div className="mt-5 space-y-2">
            <Form method="post">
              <input type="hidden" name="intent" value="update_order_status" />
              <input type="hidden" name="customerPhone" value={activeOrder.customerPhone} />
              <input type="hidden" name="orderId" value={activeOrder.id} />
              <input type="hidden" name="status" value="CONFIRMED" />
              <button
                type="submit"
                className="w-full py-2 px-3 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 text-xs font-semibold transition"
              >
                ✓ Mark Address Confirmed
              </button>
            </Form>

            <Form method="post">
              <input type="hidden" name="intent" value="update_order_status" />
              <input type="hidden" name="customerPhone" value={activeOrder.customerPhone} />
              <input type="hidden" name="orderId" value={activeOrder.id} />
              <input type="hidden" name="status" value="UPDATE_REQUESTED" />
              <button
                type="submit"
                className="w-full py-2 px-3 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs font-semibold transition"
              >
                ✏️ Flag Address Update
              </button>
            </Form>
          </div>
        </div>
      )}
    </div>
  );
}
