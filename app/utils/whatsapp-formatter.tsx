import React from "react";

export type WhatsAppFormatType =
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "codeblock"
  | "link"
  | "newline"
  | "bullet"
  | "emoji";

/**
 * Inserts WhatsApp formatting (*bold*, _italic_, ~strike~, `code`, ```codeblock```, link, newline)
 * into a text string while taking into account the user's cursor selection.
 * Returns the updated text string along with the new cursor start & end positions.
 */
export function insertFormattingIntoText(
  currentText: string,
  selectionStart: number = 0,
  selectionEnd: number = 0,
  formatType: WhatsAppFormatType,
  customValue?: string
): { newText: string; newCursorPos: number; newSelectionEnd: number } {
  const text = currentText || "";
  const start = Math.min(selectionStart, selectionEnd);
  const end = Math.max(selectionStart, selectionEnd);
  const selectedText = text.substring(start, end);

  let prefix = "";
  let suffix = "";
  let defaultPlaceholder = "";

  switch (formatType) {
    case "bold":
      prefix = "*";
      suffix = "*";
      defaultPlaceholder = "bold text";
      break;
    case "italic":
      prefix = "_";
      suffix = "_";
      defaultPlaceholder = "italic text";
      break;
    case "strike":
      prefix = "~";
      suffix = "~";
      defaultPlaceholder = "strikethrough text";
      break;
    case "code":
      prefix = "`";
      suffix = "`";
      defaultPlaceholder = "code";
      break;
    case "codeblock":
      prefix = "```\n";
      suffix = "\n```";
      defaultPlaceholder = "code block";
      break;
    case "link":
      if (customValue) {
        const linkUrl = customValue.startsWith("http") ? customValue : `https://${customValue}`;
        if (selectedText) {
          prefix = "";
          suffix = ` (${linkUrl})`;
        } else {
          prefix = linkUrl;
          suffix = "";
        }
      } else {
        prefix = "https://";
        suffix = "";
        defaultPlaceholder = "example.com";
      }
      break;
    case "newline":
      prefix = "\n\n";
      suffix = "";
      break;
    case "bullet":
      prefix = "\n• ";
      suffix = "";
      defaultPlaceholder = "List item";
      break;
    case "emoji":
      prefix = customValue || "😊";
      suffix = "";
      break;
    default:
      break;
  }

  if (selectedText.length > 0) {
    // Wrap existing selection
    const replacement = `${prefix}${selectedText}${suffix}`;
    const newText = text.substring(0, start) + replacement + text.substring(end);
    const newCursorPos = start + prefix.length;
    const newSelectionEnd = newCursorPos + selectedText.length;
    return { newText, newCursorPos, newSelectionEnd };
  } else {
    // Insert with placeholder
    const content = defaultPlaceholder;
    const replacement = `${prefix}${content}${suffix}`;
    const newText = text.substring(0, start) + replacement + text.substring(end);
    const newCursorPos = start + prefix.length;
    const newSelectionEnd = newCursorPos + content.length;
    return { newText, newCursorPos, newSelectionEnd };
  }
}

/**
 * Parses inline formatting (bold, italic, strikethrough, inline code, and URLs)
 * safely into React elements without dangerous innerHTML.
 */
function parseInlineFormatting(
  text: string,
  keyPrefix: string = "",
  options?: { isPortal?: boolean }
): React.ReactNode[] {
  if (!text) return [];

  // Match bold *text*, italic _text_, strike ~text~, inline code `text`, and URLs
  // Note: We use regex tokenization that preserves ordering.
  const regex = /(\*([^\*\n]+?)\*|_([^_\n]+?)|~([^~\n]+?)~|`([^`\n]+?)`|(https?:\/\/[^\s<]+|www\.[^\s<]+))/g;

  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let tokenIdx = 0;

  while ((match = regex.exec(text)) !== null) {
    // Push preceding plain text
    if (match.index > lastIndex) {
      nodes.push(
        <React.Fragment key={`${keyPrefix}-t-${tokenIdx++}`}>
          {text.substring(lastIndex, match.index)}
        </React.Fragment>
      );
    }

    const boldContent = match[2];
    const italicContent = match[3];
    const strikeContent = match[4];
    const codeContent = match[5];
    const urlMatch = match[6];

    if (boldContent !== undefined) {
      nodes.push(
        <strong
          key={`${keyPrefix}-b-${tokenIdx++}`}
          style={{ fontWeight: 700 }}
          className={options?.isPortal ? "font-bold text-[#e9edef]" : "font-bold"}
        >
          {parseInlineFormatting(boldContent, `${keyPrefix}-b-${tokenIdx}`, options)}
        </strong>
      );
    } else if (italicContent !== undefined) {
      nodes.push(
        <em
          key={`${keyPrefix}-i-${tokenIdx++}`}
          style={{ fontStyle: "italic" }}
          className={options?.isPortal ? "italic text-[#e9edef]" : "italic"}
        >
          {parseInlineFormatting(italicContent, `${keyPrefix}-i-${tokenIdx}`, options)}
        </em>
      );
    } else if (strikeContent !== undefined) {
      nodes.push(
        <del
          key={`${keyPrefix}-s-${tokenIdx++}`}
          style={{ textDecoration: "line-through" }}
          className="line-through opacity-80"
        >
          {parseInlineFormatting(strikeContent, `${keyPrefix}-s-${tokenIdx}`, options)}
        </del>
      );
    } else if (codeContent !== undefined) {
      nodes.push(
        <code
          key={`${keyPrefix}-c-${tokenIdx++}`}
          style={{
            fontFamily: "monospace",
            backgroundColor: options?.isPortal ? "rgba(0,0,0,0.3)" : "rgba(0,0,0,0.06)",
            padding: "1px 5px",
            borderRadius: "4px",
            fontSize: "0.9em",
          }}
          className={options?.isPortal ? "bg-black/30 px-1 py-0.5 rounded text-[11px] font-mono text-[#00a884]" : "bg-slate-100 px-1 py-0.5 rounded text-[11px] font-mono"}
        >
          {codeContent}
        </code>
      );
    } else if (urlMatch !== undefined) {
      const href = urlMatch.startsWith("http") ? urlMatch : `https://${urlMatch}`;
      nodes.push(
        <a
          key={`${keyPrefix}-u-${tokenIdx++}`}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: options?.isPortal ? "#53bdeb" : "#005bd3",
            textDecoration: "underline",
            wordBreak: "break-all",
          }}
          className={options?.isPortal ? "underline text-[#53bdeb] hover:text-[#7fd4f8] transition" : "underline text-[#005bd3] hover:text-[#004299]"}
          onClick={(e) => e.stopPropagation()}
        >
          {urlMatch}
        </a>
      );
    }

    lastIndex = regex.lastIndex;
  }

  // Push remaining text
  if (lastIndex < text.length) {
    nodes.push(
      <React.Fragment key={`${keyPrefix}-t-end`}>
        {text.substring(lastIndex)}
      </React.Fragment>
    );
  }

  return nodes;
}

/**
 * Parses full WhatsApp Markdown text including multi-line code blocks and line breaks.
 * Safe for React rendering without dangerouslySetInnerHTML.
 */
export function formatWhatsAppText(
  rawText: string | null | undefined,
  options?: { isPortal?: boolean }
): React.ReactNode {
  if (!rawText) return null;

  // Normalize all Windows/Mac line endings (\r\n or \r) to \n
  const text = String(rawText).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Step 1: Split text by multi-line code blocks (```code```)
  const codeBlockRegex = /```([\s\S]*?)```/g;
  const blocks: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let blockIdx = 0;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const normalText = text.substring(lastIndex, match.index);
      blocks.push(
        <React.Fragment key={`blk-${blockIdx++}`}>
          {renderNormalTextLines(normalText, `nt-${blockIdx}`, options)}
        </React.Fragment>
      );
    }

    const codeContent = match[1];
    blocks.push(
      <pre
        key={`codeblk-${blockIdx++}`}
        style={{
          backgroundColor: options?.isPortal ? "#111b21" : "#f1f5f9",
          color: options?.isPortal ? "#e9edef" : "#0f172a",
          padding: "8px 12px",
          borderRadius: "6px",
          fontFamily: "monospace",
          fontSize: "11px",
          lineHeight: "1.4",
          overflowX: "auto",
          margin: "6px 0",
          border: options?.isPortal ? "1px solid #2a3942" : "1px solid #e2e8f0",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
        }}
      >
        <code>{codeContent}</code>
      </pre>
    );

    lastIndex = codeBlockRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    const remainingText = text.substring(lastIndex);
    blocks.push(
      <React.Fragment key={`blk-${blockIdx++}`}>
        {renderNormalTextLines(remainingText, `nt-${blockIdx}`, options)}
      </React.Fragment>
    );
  }

  return blocks.length === 1 ? blocks[0] : <>{blocks}</>;
}

/**
 * Splits standard text into lines and renders inline formatting per line with <br /> separators.
 */
function renderNormalTextLines(
  text: string,
  keyPrefix: string,
  options?: { isPortal?: boolean }
): React.ReactNode {
  const lines = text.split("\n");
  return lines.map((line, idx) => (
    <React.Fragment key={`${keyPrefix}-ln-${idx}`}>
      {parseInlineFormatting(line, `${keyPrefix}-l-${idx}`, options)}
      {idx < lines.length - 1 && <br />}
    </React.Fragment>
  ));
}

/**
 * Common quick-access emojis for WhatsApp business support
 */
export const COMMON_WHATSAPP_EMOJIS = [
  "👋",
  "📦",
  "🚚",
  "✅",
  "💳",
  "🎁",
  "💬",
  "📍",
  "📞",
  "🤝",
  "🕒",
  "💡",
  "🙏",
  "🚀",
  "❤️",
];
