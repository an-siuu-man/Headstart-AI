import { NextResponse } from "next/server";
import { setAssignmentSubmittedStateForUser } from "@/lib/chat-repository";
import { applyAuthCookies, resolveRequestUser } from "@/lib/auth/session";

export const runtime = "nodejs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function toOptionalString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ assignmentId: string }> },
) {
  const { assignmentId } = await params;
  const resolvedUser = await resolveRequestUser(req);
  const userId = resolvedUser?.user.id ?? "";

  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const normalizedAssignmentId = toOptionalString(assignmentId);
  if (!normalizedAssignmentId || !UUID_PATTERN.test(normalizedAssignmentId)) {
    return NextResponse.json({ error: "Invalid assignment id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawFlag = (body as Record<string, unknown> | null)?.is_submitted;
  if (typeof rawFlag !== "boolean") {
    return NextResponse.json(
      { error: "is_submitted must be a boolean" },
      { status: 400 },
    );
  }

  try {
    const updated = await setAssignmentSubmittedStateForUser({
      userId,
      assignmentId: normalizedAssignmentId,
      isSubmitted: rawFlag,
    });

    if (!updated) {
      return NextResponse.json(
        { error: "Assignment not found for current user" },
        { status: 404 },
      );
    }

    const response = NextResponse.json({
      ok: true,
      assignment_id: updated.assignmentId,
      is_submitted: updated.isSubmitted,
      submitted_at: updated.submittedAt,
    });
    if (resolvedUser?.refreshedSession) {
      applyAuthCookies(response, resolvedUser.refreshedSession);
    }
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "Failed to update submission state", detail: message },
      { status: 500 },
    );
  }
}
