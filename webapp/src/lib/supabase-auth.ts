import { supabaseTableRequest } from "@/lib/supabase-rest";

export type AuthUser = {
  id: string;
  email: string | null;
  user_metadata: Record<string, unknown> | null;
};

export type AuthSession = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
  user: AuthUser;
};

export class SupabaseAuthError extends Error {
  status: number;
  details: unknown;

  constructor(message: string, status: number, details: unknown) {
    super(message);
    this.name = "SupabaseAuthError";
    this.status = status;
    this.details = details;
  }
}

function getAuthPublicEnv() {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "").trim();
  const publishableKey = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY || "").trim();

  if (!url) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL is required for auth.");
  }
  if (!publishableKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY is required for auth.");
  }

  return {
    url: url.replace(/\/$/, ""),
    publishableKey,
  };
}

function getAuthServiceEnv() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

  if (!url) {
    throw new Error("SUPABASE_URL is required for admin auth actions.");
  }
  if (!serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for admin auth actions.");
  }

  return {
    url: url.replace(/\/$/, ""),
    serviceRoleKey,
  };
}

function toAuthUser(value: unknown): AuthUser {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const id = typeof source.id === "string" ? source.id : "";
  const email = typeof source.email === "string" ? source.email : null;
  const rawMetadata = source.user_metadata;
  const userMetadata =
    rawMetadata && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)
      ? (rawMetadata as Record<string, unknown>)
      : null;

  if (!id) {
    throw new Error("Supabase auth response missing user id.");
  }

  return {
    id,
    email,
    user_metadata: userMetadata,
  };
}

function parseJsonBody(raw: string) {
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function readErrorMessage(details: unknown, fallback: string) {
  if (!details || typeof details !== "object") return fallback;
  const source = details as Record<string, unknown>;

  const candidates = [
    source.message,
    source.error_description,
    source.error,
    source.msg,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return fallback;
}

async function authFetch(input: {
  method: "GET" | "POST";
  path: string;
  keyType: "public" | "service";
  token?: string;
  body?: Record<string, unknown>;
}) {
  let baseUrl = "";
  let key = "";

  if (input.keyType === "service") {
    const env = getAuthServiceEnv();
    baseUrl = env.url;
    key = env.serviceRoleKey;
  } else {
    const env = getAuthPublicEnv();
    baseUrl = env.url;
    key = env.publishableKey;
  }

  const response = await fetch(`${baseUrl}${input.path}`, {
    method: input.method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${input.token ?? key}`,
      "Content-Type": "application/json",
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
    cache: "no-store",
  });

  const rawText = await response.text();
  const parsedBody = parseJsonBody(rawText);

  if (!response.ok) {
    throw new SupabaseAuthError(
      readErrorMessage(parsedBody, `Supabase auth request failed (${response.status})`),
      response.status,
      parsedBody,
    );
  }

  return parsedBody;
}

export async function signInWithPassword(email: string, password: string): Promise<AuthSession> {
  const body = await authFetch({
    method: "POST",
    path: "/auth/v1/token?grant_type=password",
    keyType: "public",
    body: {
      email,
      password,
    },
  });

  if (!body || typeof body !== "object") {
    throw new Error("Supabase sign-in returned empty response.");
  }

  const source = body as Record<string, unknown>;

  const accessToken = typeof source.access_token === "string" ? source.access_token : "";
  const refreshToken = typeof source.refresh_token === "string" ? source.refresh_token : "";
  const tokenType = typeof source.token_type === "string" ? source.token_type : "bearer";
  const expiresIn =
    typeof source.expires_in === "number" && Number.isFinite(source.expires_in)
      ? Math.max(1, Math.floor(source.expires_in))
      : 3600;

  if (!accessToken || !refreshToken) {
    throw new Error("Supabase sign-in did not return session tokens.");
  }

  return {
    accessToken,
    refreshToken,
    expiresIn,
    tokenType,
    user: toAuthUser(source.user),
  };
}

export async function refreshSession(refreshToken: string): Promise<AuthSession> {
  const body = await authFetch({
    method: "POST",
    path: "/auth/v1/token?grant_type=refresh_token",
    keyType: "public",
    body: {
      refresh_token: refreshToken,
    },
  });

  if (!body || typeof body !== "object") {
    throw new Error("Supabase refresh returned empty response.");
  }

  const source = body as Record<string, unknown>;
  const accessToken = typeof source.access_token === "string" ? source.access_token : "";
  const nextRefreshToken =
    typeof source.refresh_token === "string" ? source.refresh_token : refreshToken;
  const tokenType = typeof source.token_type === "string" ? source.token_type : "bearer";
  const expiresIn =
    typeof source.expires_in === "number" && Number.isFinite(source.expires_in)
      ? Math.max(1, Math.floor(source.expires_in))
      : 3600;

  if (!accessToken) {
    throw new Error("Supabase refresh did not return an access token.");
  }

  return {
    accessToken,
    refreshToken: nextRefreshToken,
    expiresIn,
    tokenType,
    user: toAuthUser(source.user),
  };
}

export async function getUserFromAccessToken(accessToken: string): Promise<AuthUser> {
  const body = await authFetch({
    method: "GET",
    path: "/auth/v1/user",
    keyType: "public",
    token: accessToken,
  });

  return toAuthUser(body);
}

export async function revokeAccessToken(accessToken: string) {
  await authFetch({
    method: "POST",
    path: "/auth/v1/logout",
    keyType: "public",
    token: accessToken,
    body: {},
  });
}

export async function createUserWithPassword(input: {
  email: string;
  password: string;
  displayName?: string;
}) {
  const body = await authFetch({
    method: "POST",
    path: "/auth/v1/admin/users",
    keyType: "service",
    body: {
      email: input.email,
      password: input.password,
      email_confirm: true,
      user_metadata: input.displayName
        ? {
            full_name: input.displayName,
          }
        : undefined,
    },
  });

  return toAuthUser(body);
}

export async function ensureUserProfile(input: {
  userId: string;
  displayName?: string;
}) {
  await supabaseTableRequest<unknown[]>({
    table: "user_profiles",
    method: "POST",
    query: {
      on_conflict: "user_id",
    },
    headers: {
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: [
      {
        user_id: input.userId,
        display_name: input.displayName ?? null,
        updated_at: new Date().toISOString(),
      },
    ],
  });
}
