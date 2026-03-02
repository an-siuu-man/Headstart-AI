import { NextResponse } from "next/server";
import { applyAuthCookies, resolveRequestUser } from "@/lib/auth/session";

export const runtime = "nodejs";

function toDisplayName(metadata: Record<string, unknown> | null, email: string | null) {
  const candidate = metadata?.full_name;
  if (typeof candidate === "string" && candidate.trim()) {
    return candidate.trim();
  }

  if (email && email.includes("@")) {
    return email.split("@")[0] || "Student";
  }

  return "Student";
}

export async function GET(req: Request) {
  const resolved = await resolveRequestUser(req);

  if (!resolved) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const response = NextResponse.json({
    ok: true,
    user: {
      id: resolved.user.id,
      email: resolved.user.email,
      display_name: toDisplayName(resolved.user.user_metadata, resolved.user.email),
    },
  });

  if (resolved.refreshedSession) {
    applyAuthCookies(response, resolved.refreshedSession);
  }

  return response;
}
