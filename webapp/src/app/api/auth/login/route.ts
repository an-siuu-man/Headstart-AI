import { NextResponse } from "next/server";
import {
  ensureUserProfile,
  signInWithPassword,
  SupabaseAuthError,
} from "@/lib/supabase-auth";
import { applyAuthCookies } from "@/lib/auth/session";

export const runtime = "nodejs";

function toDisplayName(metadata: Record<string, unknown> | null, email: string | null) {
  const fromFullName = metadata?.full_name;
  if (typeof fromFullName === "string" && fromFullName.trim()) {
    return fromFullName.trim();
  }
  if (email) {
    return email.split("@")[0] || "Student";
  }
  return "Student";
}

function toMessage(error: unknown) {
  if (error instanceof SupabaseAuthError) {
    if (error.status === 400 || error.status === 401) {
      return "Invalid email or password.";
    }
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Unable to sign in.";
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));

  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }
  if (!password) {
    return NextResponse.json({ error: "password is required" }, { status: 400 });
  }

  try {
    const session = await signInWithPassword(email, password);
    const displayName = toDisplayName(session.user.user_metadata, session.user.email);

    await ensureUserProfile({
      userId: session.user.id,
      displayName,
    }).catch(() => undefined);

    const response = NextResponse.json({
      ok: true,
      user: {
        id: session.user.id,
        email: session.user.email,
        display_name: displayName,
      },
    });

    applyAuthCookies(response, session);
    return response;
  } catch (error) {
    return NextResponse.json(
      { error: toMessage(error) },
      { status: 401 },
    );
  }
}
