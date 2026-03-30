import { NextResponse } from "next/server";
import { assertSessionOwnership, getGuideVersionContent } from "@/lib/chat-repository";
import { applyAuthCookies, resolveRequestUser } from "@/lib/auth/session";

export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ sessionId: string; versionNumber: string }> },
) {
  const { sessionId, versionNumber: versionNumberRaw } = await params;

  const resolvedUser = await resolveRequestUser(req);
  const userId = resolvedUser?.user.id ?? "";

  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const versionNumber = parseInt(versionNumberRaw, 10);
  if (!Number.isFinite(versionNumber) || versionNumber < 1) {
    return NextResponse.json({ error: "Invalid version number" }, { status: 400 });
  }

  const session = await assertSessionOwnership(sessionId, userId);
  if (!session) {
    return NextResponse.json({ error: "Session not found for user" }, { status: 404 });
  }

  const contentText = await getGuideVersionContent(sessionId, versionNumber);
  if (contentText === null) {
    return NextResponse.json({ error: "Guide version not found" }, { status: 404 });
  }

  const response = NextResponse.json({ ok: true, version_number: versionNumber, content_text: contentText });
  if (resolvedUser?.refreshedSession) {
    applyAuthCookies(response, resolvedUser.refreshedSession);
  }
  return response;
}
