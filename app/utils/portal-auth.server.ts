import { createCookieSessionStorage, redirect } from "@remix-run/node";
import crypto from "crypto";
import db from "../db.server";

// 1. Standalone Portal Session Storage (Cookie-based, independent of Shopify App Bridge)
const sessionSecret = process.env.PORTAL_SESSION_SECRET || "storeping_portal_super_secret_session_key_2026";

export const portalSessionStorage = createCookieSessionStorage({
  cookie: {
    name: "__storeping_portal_session",
    secure: process.env.NODE_ENV === "production",
    secrets: [sessionSecret],
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 Days
    httpOnly: true,
  },
});

// 2. High-Performance Native Password Hashing (PBKDF2 with Cryptographic Salt)
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, combinedHash: string): boolean {
  try {
    const [salt, storedHash] = combinedHash.split(":");
    if (!salt || !storedHash) return false;
    const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, "sha512").toString("hex");
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(storedHash, "hex"));
  } catch {
    return false;
  }
}

// 3. Session Helpers
export async function getPortalSession(request: Request) {
  const cookie = request.headers.get("Cookie");
  return portalSessionStorage.getSession(cookie);
}

export async function createPortalSession(userId: string, redirectTo: string) {
  const session = await portalSessionStorage.getSession();
  session.set("userId", userId);
  return redirect(redirectTo, {
    headers: {
      "Set-Cookie": await portalSessionStorage.commitSession(session),
    },
  });
}

export async function destroyPortalSession(request: Request, redirectTo: string = "/portal/login") {
  const session = await getPortalSession(request);
  return redirect(redirectTo, {
    headers: {
      "Set-Cookie": await portalSessionStorage.destroySession(session),
    },
  });
}

// 4. User Retrieval & RBAC Middleware
export type PortalUser = {
  id: string;
  email: string;
  name: string;
  role: "OWNER" | "MANAGER" | "AGENT" | string;
  merchantId: string;
  avatarUrl: string | null;
  merchant: {
    id: string;
    shop: string;
    name: string | null;
    displayPhoneNumber: string | null;
    isWhatsAppConnected: boolean;
    qualityRating: string | null;
    messagingLimit: string | null;
    phoneNumberId: string | null;
    wabaId: string | null;
  };
};

export async function getPortalUser(request: Request): Promise<PortalUser | null> {
  const session = await getPortalSession(request);
  const userId = session.get("userId");
  if (!userId) return null;

  try {
    const user = await db.user.findUnique({
      where: { id: userId },
      include: {
        merchant: {
          select: {
            id: true,
            shop: true,
            name: true,
            displayPhoneNumber: true,
            isWhatsAppConnected: true,
            qualityRating: true,
            messagingLimit: true,
            phoneNumberId: true,
            wabaId: true,
          },
        },
      },
    });

    if (!user || !user.isActive) return null;
    return user as PortalUser;
  } catch (error) {
    console.error("[PortalAuth] Error fetching user:", error);
    return null;
  }
}

export async function requirePortalUser(
  request: Request,
  redirectTo: string = "/portal/login"
): Promise<PortalUser> {
  const user = await getPortalUser(request);
  if (!user) {
    const url = new URL(request.url);
    const searchParams = new URLSearchParams({ returnTo: url.pathname + url.search });
    throw redirect(`${redirectTo}?${searchParams.toString()}`);
  }
  return user;
}

export async function requireRole(
  request: Request,
  allowedRoles: Array<"OWNER" | "MANAGER" | "AGENT">
): Promise<PortalUser> {
  const user = await requirePortalUser(request);
  if (!allowedRoles.includes(user.role as any)) {
    // If agent tries to access restricted area, redirect to inbox
    if (user.role === "AGENT") {
      throw redirect("/portal/inbox");
    }
    throw new Response("Forbidden: You do not have permission to access this resource", {
      status: 403,
    });
  }
  return user;
}

// 5. Auto-Seed / Provision Default Admin for Merchant if none exists
export async function ensureMerchantOwnerExists(merchantId: string, email: string, name: string) {
  const existing = await db.user.findFirst({
    where: { merchantId, role: "OWNER" },
  });

  if (!existing) {
    const defaultPassword = "AdminPassword@123";
    const passwordHash = hashPassword(defaultPassword);
    
    return await db.user.create({
      data: {
        merchantId,
        email: email.toLowerCase().trim(),
        name,
        role: "OWNER",
        passwordHash,
      },
    });
  }

  return existing;
}
