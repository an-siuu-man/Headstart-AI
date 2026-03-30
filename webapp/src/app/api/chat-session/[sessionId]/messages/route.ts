import { NextResponse } from "next/server";
import {
  assertSessionOwnership,
  createChatMessage,
} from "@/lib/chat-repository";
import { emitChatMessageCreated, getRuntimeSession } from "@/lib/chat-runtime-store";
import { startFollowupChatRun } from "@/lib/chat-session-runner";
import { applyAuthCookies, resolveRequestUser } from "@/lib/auth/session";

export const runtime = "nodejs";

function isGuideReady(sessionStatus: string, runtimeStatus: string | undefined) {
  return sessionStatus === "completed" || runtimeStatus === "completed";
}

type ChatAttachment = {
  filename: string;
  file_sha256: string;
  storage_path: string;
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const body = await req.json();

  const resolvedUser = await resolveRequestUser(req);
  const userId = resolvedUser?.user.id ?? "";
  const content = typeof body?.content === "string" ? body.content.trim() : "";
  const rawAttachments = Array.isArray(body?.attachments) ? body.attachments : [];
  const attachments: ChatAttachment[] = rawAttachments
    .slice(0, 3)
    .filter(
      (a: unknown): a is ChatAttachment =>
        typeof a === "object" &&
        a !== null &&
        typeof (a as Record<string, unknown>).filename === "string" &&
        typeof (a as Record<string, unknown>).file_sha256 === "string" &&
        typeof (a as Record<string, unknown>).storage_path === "string",
    );

  if (!userId) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  }

  if (!content && attachments.length === 0) {
    return NextResponse.json(
      { error: "content or attachments are required" },
      { status: 400 },
    );
  }

  if (content.length > 8000) {
    return NextResponse.json(
      { error: "content is too long" },
      { status: 400 },
    );
  }

  const session = await assertSessionOwnership(sessionId, userId);
  if (!session) {
    return NextResponse.json(
      { error: "session not found for user" },
      { status: 404 },
    );
  }

  const runtime = getRuntimeSession(sessionId);
  if (!isGuideReady(session.status, runtime?.status)) {
    return NextResponse.json(
      { error: "Guide generation is still in progress" },
      { status: 409 },
    );
  }

  try {
    const userMessage = await createChatMessage({
      sessionId,
      role: "user",
      content,
      format: "markdown",
      metadata: {
        source: "dashboard",
        ...(attachments.length > 0 ? { attachments } : {}),
      },
    });

    const assistantMessage = await createChatMessage({
      sessionId,
      role: "assistant",
      content: "",
      format: "markdown",
      metadata: {
        streaming: true,
      },
    });

    emitChatMessageCreated(sessionId, userMessage);
    emitChatMessageCreated(sessionId, assistantMessage);

    startFollowupChatRun({
      sessionId,
      assistantMessageId: assistantMessage.id,
      userMessageContent: content,
      requestUrl: req.url,
      attachments,
    });

    const response = NextResponse.json({
      ok: true,
      session_id: sessionId,
      user_message_id: userMessage.id,
      assistant_message_id: assistantMessage.id,
    });
    if (resolvedUser?.refreshedSession) {
      applyAuthCookies(response, resolvedUser.refreshedSession);
    }
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "Unable to send message", detail: message },
      { status: 500 },
    );
  }
}
