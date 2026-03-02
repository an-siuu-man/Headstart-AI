import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  getUserFromAccessToken,
  refreshSession,
  type AuthSession,
  type AuthUser,
  SupabaseAuthError,
} from "@/lib/supabase-auth";

export const AUTH_ACCESS_COOKIE = "headstart_access_token";
export const AUTH_REFRESH_COOKIE = "headstart_refresh_token";

type CookieWritableResponse = {
  cookies: {
    set: (options: {
      name: string;
      value: string;
      maxAge: number;
      httpOnly: boolean;
      path: string;
      sameSite: "lax";
      secure: boolean;
    }) => void;
  };
};

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

function getCookieValueFromRequest(req: Request, name: string) {
  const cookieHeader = req.headers.get("cookie");
  return parseCookieHeader(cookieHeader).get(name) ?? null;
}

function getAccessTokenFromRequest(req: Request) {
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }

  return getCookieValueFromRequest(req, AUTH_ACCESS_COOKIE);
}

function getRefreshTokenFromRequest(req: Request) {
  return getCookieValueFromRequest(req, AUTH_REFRESH_COOKIE);
}

function isInvalidTokenError(error: unknown) {
  if (!(error instanceof SupabaseAuthError)) return false;
  if (error.status === 401) return true;

  const details = error.details;
  if (!details || typeof details !== "object") return false;

  const code = (details as Record<string, unknown>).code;
  if (typeof code !== "string") return false;

  return code === "invalid_jwt" || code === "bad_jwt";
}

function cookieSettings() {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
  };
}

export function applyAuthCookies(response: CookieWritableResponse, session: AuthSession) {
  response.cookies.set({
    ...cookieSettings(),
    name: AUTH_ACCESS_COOKIE,
    value: session.accessToken,
    maxAge: session.expiresIn,
  });

  response.cookies.set({
    ...cookieSettings(),
    name: AUTH_REFRESH_COOKIE,
    value: session.refreshToken,
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function clearAuthCookies(response: CookieWritableResponse) {
  response.cookies.set({
    ...cookieSettings(),
    name: AUTH_ACCESS_COOKIE,
    value: "",
    maxAge: 0,
  });
  response.cookies.set({
    ...cookieSettings(),
    name: AUTH_REFRESH_COOKIE,
    value: "",
    maxAge: 0,
  });
}

export async function resolveRequestUser(req: Request): Promise<{
  user: AuthUser;
  refreshedSession?: AuthSession;
} | null> {
  const accessToken = getAccessTokenFromRequest(req);
  if (!accessToken) return null;

  try {
    const user = await getUserFromAccessToken(accessToken);
    return { user };
  } catch (error) {
    if (!isInvalidTokenError(error)) {
      return null;
    }

    const refreshToken = getRefreshTokenFromRequest(req);
    if (!refreshToken) {
      return null;
    }

    try {
      const refreshedSession = await refreshSession(refreshToken);
      return {
        user: refreshedSession.user,
        refreshedSession,
      };
    } catch {
      return null;
    }
  }
}

export async function getServerUserFromCookies() {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get(AUTH_ACCESS_COOKIE)?.value;
  if (!accessToken) return null;

  try {
    return await getUserFromAccessToken(accessToken);
  } catch {
    return null;
  }
}

export async function requireServerUser() {
  const user = await getServerUserFromCookies();
  if (!user) {
    redirect("/login");
  }
  return user;
}
