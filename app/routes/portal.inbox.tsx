import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useNavigation, useSearchParams } from "@remix-run/react";
import { useState } from "react";
import db from "../db.server";
import { requirePortalUser } from "../utils/portal-auth.server";
import { sendWhatsAppMessage, uploadMediaToMeta } from "../utils/meta-whatsapp.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requirePortalUser(request);
  const url = new URL(request.url);
  const selectedPhone = url.searchParams.get("phone");
  const filter = url.searchParams.get("filter") || "ALL";

  const conversationsPromise = db.conversation.findMany({
    where: { merchantId: user.merchantId },
    orderBy: { lastMessageAt: "desc" },
    include: {
      messages: {
        take: 1,
        orderBy: { createdAt: "desc" },
      },
    },
  });

  const templatesPromise = db.template.findMany({
    where: { merchantId: user.merchantId, isActive: true },
    take: 6,
  });

  const activeConversationPromise = selectedPhone
    ? db.conversation.findUnique({
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
      })
    : null;

  const activeOrderPromise = selectedPhone
    ? db.orderConfirmation.findFirst({
        where: {
          merchantId: user.merchantId,
          customerPhone: selectedPhone,
        },
        orderBy: { createdAt: "desc" },
      })
    : null;

  // Run all queries concurrently in parallel
  const [conversations, templates, activeConversation, activeOrder] = await Promise.all([
    conversationsPromise,
    templatesPromise,
    activeConversationPromise,
    activeOrderPromise,
  ]);

  // Mark unread messages as read asynchronously without blocking UI
  if (activeConversation && activeConversation.unreadCount > 0) {
    db.conversation.update({
      where: { id: activeConversation.id },
      data: { unreadCount: 0 },
    }).catch(() => {});
  }

  return json({
    user,
    conversations: conversations.map((c) => ({
      id: c.id,
      customerPhone: c.customerPhone,
      customerName: c.customerName,
      lastMessageText: c.lastMessageText,
      lastMessageAt: c.lastMessageAt,
      unreadCount: c.unreadCount,
      lastOrderNumber: c.lastOrderNumber,
    })),
    activeConversation,
    activeOrder,
    templates,
    selectedPhone,
    filter,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const user = await requirePortalUser(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const customerPhone = formData.get("customerPhone") as string;

  if (!customerPhone) {
    return json({ success: false, error: "No customer phone specified.", updatedStatus: null as string | null }, { status: 400 });
  }

  // 1. Send Outbound Text or PDF / Image Message (Supports Direct File Upload from Computer)
  if (intent === "send_message") {
    const messageText = (formData.get("messageText") as string)?.trim();
    const mediaUrl = (formData.get("mediaUrl") as string)?.trim() || null;
    let mediaType = (formData.get("mediaType") as "IMAGE" | "DOCUMENT" | null) || null;
    let documentName = (formData.get("documentName") as string)?.trim() || null;
    const file = formData.get("file") as File | null;

    let uploadedMediaId: string | null = null;

    try {
      // If user selected a file from their local computer
      if (file && typeof file === "object" && file.size > 0) {
        const arrayBuffer = await file.arrayBuffer();
        const fileBuffer = Buffer.from(arrayBuffer);
        const fileName = file.name || "Attachment.pdf";
        documentName = fileName;
        
        let mimeType = file.type;
        if (!mimeType || mimeType === "application/octet-stream") {
          if (fileName.toLowerCase().endsWith(".pdf")) mimeType = "application/pdf";
          else if (fileName.toLowerCase().endsWith(".png")) mimeType = "image/png";
          else if (fileName.toLowerCase().endsWith(".jpg") || fileName.toLowerCase().endsWith(".jpeg")) mimeType = "image/jpeg";
          else mimeType = "application/pdf";
        }

        if (mimeType.includes("pdf") || mimeType.includes("document") || mimeType.includes("msword")) {
          mediaType = "DOCUMENT";
        } else if (mimeType.startsWith("image/")) {
          mediaType = "IMAGE";
        } else {
          mediaType = "DOCUMENT";
        }

        // Upload file directly to Meta WhatsApp Cloud API endpoint
        const uploadResult = await uploadMediaToMeta(user.merchantId, {
          fileBuffer,
          fileName,
          mimeType,
        });

        uploadedMediaId = uploadResult.mediaId;
      }

      if (!messageText && !mediaUrl && !uploadedMediaId) {
        return json({ success: false, error: "Please provide message text, select a file from your computer, or enter a URL.", updatedStatus: null as string | null }, { status: 400 });
      }

      const result = await sendWhatsAppMessage({
        merchantId: user.merchantId,
        recipientPhone: customerPhone,
        customerName: "Valued Customer",
        eventType: "SUPPORT_CHAT",
        bodyText: messageText || (mediaType === "DOCUMENT" ? (documentName || "Attached Document.pdf") : ""),
        mediaUrl: mediaUrl || undefined,
        mediaId: uploadedMediaId || undefined,
        fileName: documentName || undefined,
        mediaType: mediaType || undefined,
      });

      if (!result.success) {
        return json({ success: false, error: result.error || "Failed to send message via WhatsApp.", updatedStatus: null as string | null }, { status: 400 });
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
          lastMessageText: messageText || (mediaType === "DOCUMENT" ? `📄 ${documentName || "Document.pdf"}` : "📷 Image"),
          lastMessageAt: new Date(),
          unreadCount: 0,
        },
        update: {
          lastMessageText: messageText || (mediaType === "DOCUMENT" ? `📄 ${documentName || "Document.pdf"}` : "📷 Image"),
          lastMessageAt: new Date(),
          unreadCount: 0,
        },
      });

      await db.chatMessage.create({
        data: {
          conversationId: conversation.id,
          sender: "MERCHANT",
          messageType: mediaType || "TEXT",
          bodyText: messageText || (mediaType === "DOCUMENT" ? (documentName || "Attached File") : ""),
          mediaUrl: mediaUrl || null,
          caption: mediaType === "DOCUMENT" ? (documentName || "Document.pdf") : null,
          metaMessageId: result.messageId || `portal_${Date.now()}`,
          status: "SENT",
        },
      });

      return json({ success: true, error: null as string | null, updatedStatus: null as string | null });
    } catch (err: any) {
      return json({ success: false, error: err.message || "An error occurred.", updatedStatus: null as string | null }, { status: 500 });
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
      return json({ success: true, error: null as string | null, updatedStatus: newStatus });
    }
  }

  return json({ success: false, error: "Invalid action", updatedStatus: null as string | null }, { status: 400 });
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
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [attachUrl, setAttachUrl] = useState("");
  const [attachType, setAttachType] = useState<"DOCUMENT" | "IMAGE">("DOCUMENT");
  const [attachFileName, setAttachFileName] = useState("Invoice.pdf");

  // Filter conversations
  const filteredConversations = conversations.filter((c: (typeof conversations)[number]) => {
    const matchesSearch =
      c.customerPhone.includes(searchQuery) ||
      (c.customerName && c.customerName.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (c.lastOrderNumber && c.lastOrderNumber.toLowerCase().includes(searchQuery.toLowerCase()));
    return matchesSearch;
  });

  return (
    <div className="flex-1 flex flex-col md:flex-row h-full w-full overflow-hidden bg-[#0c1317]">
      {/* 1. Left Conversation Directory Pane */}
      <div className="w-full md:w-80 lg:w-88 border-r border-[#222d34] bg-[#111b21] flex flex-col shrink-0 h-full">
        {/* Search & Header */}
        <div className="p-3.5 border-b border-[#222d34] bg-[#111b21]">
          <div className="flex items-center justify-between mb-2.5">
            <h2 className="text-sm font-bold text-[#e9edef] flex items-center gap-2">
              <span className="text-base">💬</span>
              <span>Chats</span>
            </h2>
            <span className="text-[11px] bg-[#202c33] text-[#00a884] font-mono px-2 py-0.5 rounded-full border border-[#2a3942]">
              {conversations.length} Active
            </span>
          </div>

          <div className="relative">
            <input
              type="text"
              placeholder="Search phone or customer..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 bg-[#202c33] border border-[#2a3942] rounded-lg text-xs text-[#e9edef] placeholder-[#8696a0] focus:outline-none focus:border-[#00a884] transition"
            />
            <span className="absolute left-2.5 top-2 text-xs text-[#8696a0]">🔍</span>
          </div>
        </div>

        {/* Contact List Feed */}
        <div className="flex-1 overflow-y-auto divide-y divide-[#222d34]/60">
          {filteredConversations.length === 0 ? (
            <div className="p-8 text-center text-xs text-[#8696a0]">
              No conversations found.
            </div>
          ) : (
            filteredConversations.map((c: (typeof conversations)[number]) => {
              const isSelected = selectedPhone === c.customerPhone;
              const displayName =
                !c.customerName || c.customerName.trim() === "." || c.customerName.trim() === "-"
                  ? `+${c.customerPhone}`
                  : c.customerName;

              return (
                <Link
                  key={c.id}
                  to={`/portal/inbox?phone=${c.customerPhone}`}
                  prefetch="intent"
                  className={`flex items-start gap-3 p-3 transition-all cursor-pointer block ${
                    isSelected
                      ? "bg-[#2a3942] border-l-4 border-[#00a884]"
                      : "hover:bg-[#202c33]"
                  }`}
                >
                  <div className="w-10 h-10 rounded-full bg-[#202c33] border border-[#2a3942] flex items-center justify-center font-bold text-xs text-[#00a884] shrink-0">
                    {displayName.replace(/^\+/, "").slice(0, 2).toUpperCase()}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-bold text-[#e9edef] truncate">
                        {displayName}
                      </h4>
                      <span className="text-[10px] text-[#8696a0] font-mono">
                        {new Date(c.lastMessageAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>

                    <p className="text-[11px] text-[#8696a0] truncate mt-0.5">
                      {c.lastMessageText || "New WhatsApp message"}
                    </p>

                    {c.lastOrderNumber && (
                      <span className="inline-block mt-1 text-[10px] bg-[#202c33] text-[#8696a0] px-1.5 py-0.2 rounded font-mono border border-[#2a3942]">
                        Order {c.lastOrderNumber}
                      </span>
                    )}
                  </div>

                  {c.unreadCount > 0 && (
                    <span className="w-4 h-4 rounded-full bg-[#00a884] text-slate-950 font-bold text-[10px] flex items-center justify-center">
                      {c.unreadCount}
                    </span>
                  )}
                </Link>
              );
            })
          )}
        </div>
      </div>

      {/* 2. Middle Live WhatsApp Chat Pane */}
      {activeConversation ? (
        <div className="flex-1 flex flex-col min-w-0 bg-[#0b141a] relative h-full">
          {/* Chat Header Bar */}
          <div className="px-4 lg:px-6 py-3 border-b border-[#222d34] bg-[#111b21] flex items-center justify-between shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-[#202c33] border border-[#2a3942] text-[#00a884] flex items-center justify-center font-bold text-xs shrink-0">
                💬
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-xs sm:text-sm text-[#e9edef]">
                    {!activeConversation.customerName ||
                    activeConversation.customerName.trim() === "." ||
                    activeConversation.customerName.trim() === "-"
                      ? `+${activeConversation.customerPhone}`
                      : activeConversation.customerName}
                  </h3>
                  <span className="text-[10px] bg-[#00a884]/20 text-[#00a884] px-1.5 py-0.2 rounded font-semibold border border-[#00a884]/30">
                    ✓ Verified WhatsApp
                  </span>
                </div>
                <div className="text-[11px] text-[#8696a0] font-mono">
                  +{activeConversation.customerPhone}
                </div>
              </div>
            </div>

            {/* 24-hour Customer Service Window Badge */}
            <div className="text-right">
              <span className="inline-flex items-center gap-1.5 text-[10px] bg-[#00a884]/15 text-[#00a884] border border-[#00a884]/30 px-2.5 py-1 rounded-full font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-[#00a884] animate-pulse"></span>
                24h Window Active
              </span>
            </div>
          </div>

          {/* Action Error Alerts */}
          {actionData?.error && (
            <div className="p-2.5 bg-red-500/10 border-b border-red-500/30 text-red-400 text-xs font-medium text-center">
              ⚠️ {actionData.error}
            </div>
          )}

          {/* Chat Message Stream */}
          <div className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-3 bg-[#0b141a]">
            <div className="text-center my-1">
              <span className="px-3 py-1 rounded-full bg-[#182229] border border-[#222d34] text-[10px] text-[#8696a0] font-mono">
                🔒 End-to-end encrypted with WhatsApp Cloud API
              </span>
            </div>

            {activeConversation.messages.length === 0 ? (
              <div className="text-center py-12 text-xs text-[#8696a0]">
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
                      className={`max-w-[85%] md:max-w-[70%] lg:max-w-[58%] rounded-2xl p-3 text-xs shadow-sm break-words ${
                        isMerchant
                          ? "bg-[#005c4b] text-[#e9edef] rounded-tr-none"
                          : "bg-[#202c33] text-[#e9edef] rounded-tl-none border border-[#2a3942]"
                      }`}
                    >
                      {/* Document / PDF Card Rendering */}
                      {isDoc && (
                        <div className="mb-2 p-2.5 rounded-xl bg-black/30 border border-white/10 flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 truncate">
                            <span className="text-lg">📄</span>
                            <div className="truncate">
                              <div className="font-bold text-[11px] truncate text-white">
                                {msg.caption || "Attached Document.pdf"}
                              </div>
                              <div className="text-[9px] text-slate-400">PDF File</div>
                            </div>
                          </div>
                          {msg.mediaUrl && (
                            <a
                              href={msg.mediaUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="px-2 py-1 bg-[#00a884] hover:bg-[#02906f] text-slate-950 font-bold text-[10px] rounded transition shrink-0"
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
                      {msg.bodyText && <p className="leading-relaxed whitespace-pre-wrap text-[12.5px]">{msg.bodyText}</p>}

                      {/* Message Meta Info */}
                      <div
                        className={`flex items-center justify-end gap-1 mt-1 text-[10px] font-mono ${
                          isMerchant ? "text-[#aebac1]" : "text-[#8696a0]"
                        }`}
                      >
                        <span>
                          {new Date(msg.createdAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        {isMerchant && (
                          <span className="font-bold text-[#53bdeb]">
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

          {/* Quick Template Picker Chips (Hidden Scrollbar) */}
          <div
            className="px-4 py-2 border-t border-[#222d34] bg-[#111b21] flex items-center gap-2 overflow-x-auto shrink-0"
            style={{
              scrollbarWidth: "none",
              msOverflowStyle: "none",
            }}
          >
            <span className="text-[10px] text-[#8696a0] font-semibold uppercase tracking-wider shrink-0">
              Templates:
            </span>
            {templates.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                onClick={() => setMessageInput(tpl.bodyText)}
                className="px-2.5 py-1 rounded-full bg-[#202c33] hover:bg-[#2a3942] text-[#d1d7db] text-[11px] font-medium transition shrink-0 border border-[#2a3942]"
              >
                {tpl.name}
              </button>
            ))}
          </div>

          {/* Input Bar */}
          <div className="p-3 border-t border-[#222d34] bg-[#202c33] shrink-0">
            <Form
              method="post"
              onSubmit={() => {
                setTimeout(() => setMessageInput(""), 100);
              }}
              className="flex items-center gap-2"
            >
              <input type="hidden" name="intent" value="send_message" />
              <input type="hidden" name="customerPhone" value={activeConversation.customerPhone} />

              {/* Attach PDF/Image Trigger */}
              <button
                type="button"
                onClick={() => setShowAttachModal(!showAttachModal)}
                className="p-2 rounded-lg bg-[#2a3942] hover:bg-[#324552] text-[#8696a0] hover:text-white text-sm transition"
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
                className="flex-1 px-3.5 py-2.5 bg-[#2a3942] border border-transparent rounded-lg text-xs text-[#e9edef] placeholder-[#8696a0] focus:outline-none focus:border-[#00a884]"
              />

              <button
                type="submit"
                disabled={isSending}
                className="px-4 py-2.5 bg-[#00a884] hover:bg-[#02906f] text-slate-950 font-bold rounded-lg text-xs transition shadow-sm disabled:opacity-50 flex items-center gap-1.5"
              >
                <span>{isSending ? "Sending..." : "Send"}</span>
                <span>➤</span>
              </button>
            </Form>
          </div>

          {/* Attachment Modal (Direct File Upload from Computer) */}
          {showAttachModal && (
            <div className="absolute bottom-20 left-6 p-5 rounded-2xl bg-[#111b21] border border-[#2a3942] shadow-2xl z-30 w-88 max-w-[90vw]">
              <div className="flex items-center justify-between mb-3 border-b border-[#222d34] pb-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-base">📎</span>
                  <h4 className="text-xs font-bold text-[#e9edef]">Attach File from Computer</h4>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setShowAttachModal(false);
                    setSelectedFile(null);
                  }}
                  className="text-[#8696a0] hover:text-white text-xs p-1"
                >
                  ✕
                </button>
              </div>

              <Form
                method="post"
                encType="multipart/form-data"
                onSubmit={() => {
                  setShowAttachModal(false);
                  setTimeout(() => setSelectedFile(null), 500);
                }}
                className="space-y-3.5"
              >
                <input type="hidden" name="intent" value="send_message" />
                <input type="hidden" name="customerPhone" value={activeConversation.customerPhone} />
                <input type="hidden" name="mediaType" value={attachType} />

                {/* File Dropzone / Selector */}
                <div>
                  <label className="block p-4 border-2 border-dashed border-[#2a3942] hover:border-[#00a884] bg-[#202c33]/70 hover:bg-[#202c33] rounded-xl text-center cursor-pointer transition">
                    <input
                      type="file"
                      name="file"
                      accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.webp"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) {
                          setSelectedFile(f);
                          if (f.name.toLowerCase().endsWith(".pdf") || f.name.toLowerCase().endsWith(".doc") || f.name.toLowerCase().endsWith(".docx")) {
                            setAttachType("DOCUMENT");
                          } else {
                            setAttachType("IMAGE");
                          }
                        }
                      }}
                      className="hidden"
                    />
                    {selectedFile ? (
                      <div className="space-y-1">
                        <div className="text-2xl">{selectedFile.name.toLowerCase().endsWith(".pdf") ? "📄" : "📷"}</div>
                        <div className="text-xs font-bold text-[#e9edef] truncate">{selectedFile.name}</div>
                        <div className="text-[10px] text-[#00a884] font-mono font-semibold">
                          {(selectedFile.size / 1024).toFixed(1)} KB • Selected from PC
                        </div>
                        <div className="text-[10px] text-slate-400 mt-1 underline">Click to change file</div>
                      </div>
                    ) : (
                      <div className="space-y-1 py-1">
                        <div className="text-2xl">📁</div>
                        <div className="text-xs font-bold text-[#e9edef]">Choose File from Your PC</div>
                        <div className="text-[10px] text-[#8696a0]">PDF, Invoice, Catalog, Images (JPG/PNG)</div>
                        <div className="inline-block mt-2 px-3 py-1 bg-[#2a3942] hover:bg-[#324552] text-[#e9edef] rounded-lg text-[10px] font-semibold">
                          Browse Local Files...
                        </div>
                      </div>
                    )}
                  </label>
                </div>

                {/* Optional Caption / Message */}
                <div>
                  <label className="block text-[10px] font-semibold text-[#8696a0] mb-1">
                    Caption or Note (Optional)
                  </label>
                  <input
                    type="text"
                    name="messageText"
                    placeholder="e.g. Here is your official invoice copy..."
                    className="w-full px-3 py-2 bg-[#202c33] border border-[#2a3942] rounded-lg text-xs text-[#e9edef] placeholder-[#8696a0] focus:outline-none focus:border-[#00a884]"
                  />
                </div>

                <button
                  type="submit"
                  disabled={!selectedFile || isSending}
                  className="w-full py-2.5 bg-[#00a884] hover:bg-[#02906f] text-slate-950 font-bold rounded-lg text-xs transition shadow-sm disabled:opacity-40 flex items-center justify-center gap-1.5"
                >
                  <span>{isSending ? "Uploading to WhatsApp..." : "📤 Upload & Send from PC"}</span>
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
