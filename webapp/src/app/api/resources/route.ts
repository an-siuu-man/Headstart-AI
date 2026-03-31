import { NextResponse } from "next/server";
import { applyAuthCookies, resolveRequestUser } from "@/lib/auth/session";
import { listResourcesForUser } from "@/lib/chat-repository";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 250;

function parseLimit(req: Request) {
  const url = new URL(req.url);
  const raw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  if (!Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(500, Math.floor(raw)));
}

export async function GET(req: Request) {
  const resolvedUser = await resolveRequestUser(req);
  const userId = resolvedUser?.user.id ?? "";
  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const limit = parseLimit(req);

  try {
    const resources = await listResourcesForUser({ userId, limit });

    const response = NextResponse.json({
      ok: true,
      generated_at: Date.now(),
      recent: resources.recent,
      items: resources.items,
      facets: resources.facets,
    });
    if (resolvedUser?.refreshedSession) {
      applyAuthCookies(response, resolvedUser.refreshedSession);
    }
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "Failed to load resources", detail: message },
      { status: 500 },
    );
  }
}
