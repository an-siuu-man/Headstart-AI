import { NextResponse } from "next/server";
import {
  AUTH_ACCESS_COOKIE,
  clearAuthCookies,
} from "@/lib/auth/session";
import { revokeAccessToken } from "@/lib/supabase-auth";

export const runtime = "nodejs";

function parseCookieHeader(headerValue: string | null) {
  if (!headerValue) return new Map<string, string>();

  const map = new Map<string, string>();
  for (const segment of headerValue.split(";")) {
    const [rawKey, ...rawValueParts] = segment.split("=");
    const key = rawKey?.trim();
    if (!key) continue;
    const value = rawValueParts.join("=").trim();
    map.set(key, decodeURIComponent(value));
  }
  return map;
}

function getAccessToken(req: Request) {
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }

  const cookieMap = parseCookieHeader(req.headers.get("cookie"));
  return cookieMap.get(AUTH_ACCESS_COOKIE) ?? null;
}

export async function POST(req: Request) {
  const accessToken = getAccessToken(req);

  if (accessToken) {
    await revokeAccessToken(accessToken).catch(() => undefined);
  }

  const response = NextResponse.json({ ok: true });
  clearAuthCookies(response);
  return response;
}
