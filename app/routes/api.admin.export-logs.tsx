import type { LoaderFunctionArgs } from "@remix-run/node";
import db from "../db.server";
import { requireRole } from "../utils/portal-auth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  // Only SUPER_ADMIN allowed
  await requireRole(request, ["SUPER_ADMIN"]);
  const url = new URL(request.url);

  const range = url.searchParams.get("range") || "all";
  const startDate = url.searchParams.get("startDate");
  const endDate = url.searchParams.get("endDate");
  const status = url.searchParams.get("status");

  let dateFilter: any = {};
  const now = Date.now();

  if (range === "today") {
    dateFilter = { gte: new Date(now - 24 * 60 * 60 * 1000) };
  } else if (range === "7d") {
    dateFilter = { gte: new Date(now - 7 * 24 * 60 * 60 * 1000) };
  } else if (range === "1m") {
    dateFilter = { gte: new Date(now - 30 * 24 * 60 * 60 * 1000) };
  } else if (range === "3m") {
    dateFilter = { gte: new Date(now - 90 * 24 * 60 * 60 * 1000) };
  } else if (range === "1y") {
    dateFilter = { gte: new Date(now - 365 * 24 * 60 * 60 * 1000) };
  } else if (startDate && endDate) {
    dateFilter = {
      gte: new Date(startDate),
      lte: new Date(new Date(endDate).setHours(23, 59, 59, 999)),
    };
  } else if (startDate) {
    dateFilter = { gte: new Date(startDate) };
  }

  const exportLogs = await db.metaApiLog.findMany({
    where: {
      ...(Object.keys(dateFilter).length > 0 ? { createdAt: dateFilter } : {}),
      ...(status && status !== "ALL" ? { status } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: {
      merchant: {
        select: { shop: true, name: true },
      },
    },
  });

  const headers = [
    "Log ID",
    "Timestamp (UTC)",
    "Timestamp (Local ISO)",
    "Initiated By / Trigger",
    "Store Domain",
    "HTTP Method",
    "Endpoint",
    "HTTP Status Code",
    "Status",
    "Latency (ms)",
    "Meta Message ID",
    "Rate Limit Usage Header",
    "Error Message",
    "Request Payload",
    "Response Body",
  ];

  const escapeCsv = (val: any) => {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const rows = exportLogs.map((log) => [
    escapeCsv(log.id),
    escapeCsv(log.createdAt.toUTCString()),
    escapeCsv(log.createdAt.toISOString()),
    escapeCsv(log.initiatedBy || "System"),
    escapeCsv(log.merchant?.shop || "Global"),
    escapeCsv(log.httpMethod),
    escapeCsv(log.endpoint),
    escapeCsv(log.statusCode || ""),
    escapeCsv(log.status),
    escapeCsv(log.durationMs || ""),
    escapeCsv(log.metaMessageId || ""),
    escapeCsv(log.rateLimitUsage || ""),
    escapeCsv(log.errorMessage || ""),
    escapeCsv(log.requestPayload || ""),
    escapeCsv(log.responseBody || ""),
  ]);

  const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\r\n");
  const filename = `StorePing_Meta_API_Logs_${new Date().toISOString().slice(0, 10)}.csv`;

  return new Response(csvContent, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
