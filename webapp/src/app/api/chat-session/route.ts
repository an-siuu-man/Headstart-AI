import { NextResponse } from "next/server";
import { ensureRuntimeSession, getRuntimeSession } from "@/lib/chat-runtime-store";
import {
  createPersistedChatSession,
  getPersistedSessionSnapshot,
  listPersistedChatSessionsForUser,
} from "@/lib/chat-repository";
import { startChatSessionRun } from "@/lib/chat-session-runner";
import { buildSessionDto } from "@/lib/chat-types";
import { applyAuthCookies, resolveRequestUser } from "@/lib/auth/session";

export const runtime = "nodejs";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(req: Request) {
  const resolvedUser = await resolveRequestUser(req);
  const userId = resolvedUser?.user.id ?? "";
  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const sessions = await listPersistedChatSessionsForUser(userId);
    const response = NextResponse.json({
      ok: true,
      sessions: sessions.map((session) => ({
        session_id: session.sessionId,
        assignment_uuid: session.assignmentUuid,
        title: session.title,
        status: session.status,
        created_at: session.createdAt,
        updated_at: session.updatedAt,
        context: {
          assignment_title: session.context.assignmentTitle,
          course_name: session.context.courseName,
          due_at_iso: session.context.dueAtISO,
          attachment_count: session.context.attachmentCount,
        },
      })),
    });
    if (resolvedUser?.refreshedSession) {
      applyAuthCookies(response, resolvedUser.refreshedSession);
    }
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "Failed to load chat sessions", detail: message },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const body = await req.json();
  const payload = body?.payload;
  const fallbackUserId = typeof body?.user_id === "string" ? body.user_id.trim() : "";
  const resolvedUser = await resolveRequestUser(req);
  const userId = resolvedUser?.user.id ?? fallbackUserId;

  if (!resolvedUser?.user.id && fallbackUserId && !UUID_PATTERN.test(fallbackUserId)) {
    return NextResponse.json(
      {
        error:
          "user_id must be a valid Supabase Auth UUID. Sign in on the webapp and retry.",
      },
      { status: 400 },
    );
  }

  if (!userId) {
    return NextResponse.json(
      {
        error:
          "Authentication required. Sign in on the webapp before generating a guide.",
      },
      { status: 401 },
    );
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return NextResponse.json(
      { error: "payload is required and must be an object" },
      { status: 400 },
    );
  }

  const requestId = crypto.randomUUID();

  try {
    const created = await createPersistedChatSession({
      userId,
      payload: payload as Record<string, unknown>,
      requestId,
    });

    ensureRuntimeSession(created.sessionId);

    startChatSessionRun({
      sessionId: created.sessionId,
      assignmentUuid: created.assignmentUuid,
      payload: created.payload,
    });

    const snapshot = await getPersistedSessionSnapshot(created.sessionId);
    if (!snapshot) {
      return NextResponse.json(
        { error: "session created but unavailable" },
        { status: 500 },
      );
    }

    const runtimeState = getRuntimeSession(created.sessionId);
    const response = NextResponse.json(buildSessionDto(snapshot, runtimeState));
    if (resolvedUser?.refreshedSession) {
      applyAuthCookies(response, resolvedUser.refreshedSession);
    }
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "Failed to create chat session", detail: message },
      { status: 500 },
    );
  }
}
