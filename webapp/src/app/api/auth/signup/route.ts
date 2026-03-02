import { NextResponse } from "next/server";
import {
  createUserWithPassword,
  ensureUserProfile,
  signInWithPassword,
  SupabaseAuthError,
} from "@/lib/supabase-auth";
import { applyAuthCookies } from "@/lib/auth/session";

export const runtime = "nodejs";

function normalizeName(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function buildDisplayName(firstName: string, lastName: string, email: string) {
  const full = `${firstName} ${lastName}`.trim();
  if (full) return full;
  return email.split("@")[0] || "Student";
}

function inferConflict(error: SupabaseAuthError) {
  const text = error.message.toLowerCase();
  return text.includes("already") || text.includes("exists") || error.status === 409;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));

  const firstName = normalizeName(body?.first_name);
  const lastName = normalizeName(body?.last_name);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }
  if (!password) {
    return NextResponse.json({ error: "password is required" }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json(
      { error: "password must be at least 8 characters" },
      { status: 400 },
    );
  }

  const displayName = buildDisplayName(firstName, lastName, email);

  try {
    const createdUser = await createUserWithPassword({
      email,
      password,
      displayName,
    });

    await ensureUserProfile({
      userId: createdUser.id,
      displayName,
    }).catch(() => undefined);

    const session = await signInWithPassword(email, password);

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
    if (error instanceof SupabaseAuthError && inferConflict(error)) {
      return NextResponse.json(
        { error: "An account with this email already exists." },
        { status: 409 },
      );
    }

    const message = error instanceof Error ? error.message : "Unable to create account.";
    return NextResponse.json(
      { error: message },
      { status: 500 },
    );
  }
}
