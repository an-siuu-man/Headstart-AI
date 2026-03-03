import { NextResponse } from "next/server";
import { findLatestExistingGuideForAssignment } from "@/lib/chat-repository";
import { applyAuthCookies, resolveRequestUser } from "@/lib/auth/session";

export const runtime = "nodejs";

function toOptionalString(value: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toDomain(value: string | null) {
  const normalized = toOptionalString(value);
  if (!normalized) return null;

  try {
    return new URL(normalized).hostname.toLowerCase();
  } catch {
    return normalized.toLowerCase();
  }
}

export async function GET(req: Request) {
  const resolvedUser = await resolveRequestUser(req);
  const userId = resolvedUser?.user.id ?? "";
  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const url = new URL(req.url);
  const courseId = toOptionalString(url.searchParams.get("course_id"));
  const assignmentId = toOptionalString(url.searchParams.get("assignment_id"));
  const instanceDomain = toDomain(url.searchParams.get("instance_domain"));

  if (!courseId || !assignmentId) {
    return NextResponse.json(
      { error: "course_id and assignment_id are required query params" },
      { status: 400 },
    );
  }

  try {
    const result = await findLatestExistingGuideForAssignment({
      userId,
      courseId,
      assignmentId,
      instanceDomain,
    });

    const response = NextResponse.json({
      ok: true,
      exists: result.exists,
      latest_session_id: result.latestSessionId,
      latest_session_updated_at: result.latestSessionUpdatedAt,
      status: result.status,
    });
    if (resolvedUser?.refreshedSession) {
      applyAuthCookies(response, resolvedUser.refreshedSession);
    }
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "Failed to look up assignment guide status", detail: message },
      { status: 500 },
    );
  }
}
