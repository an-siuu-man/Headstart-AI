import { NextResponse } from "next/server";
import {
  assertSessionOwnership,
  createChatMessage,
  getNextGuideVersionNumber,
} from "@/lib/chat-repository";
import { emitChatMessageCreated, getRuntimeSession } from "@/lib/chat-runtime-store";
import { startGuideRegeneration } from "@/lib/chat-session-runner";
import { applyAuthCookies, resolveRequestUser } from "@/lib/auth/session";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const resolvedUser = await resolveRequestUser(req);
  const userId = resolvedUser?.user.id ?? "";

  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const session = await assertSessionOwnership(sessionId, userId);
  if (!session) {
    return NextResponse.json({ error: "Session not found for user" }, { status: 404 });
  }

  const runtimeSession = getRuntimeSession(sessionId);
  const effectiveStatus = runtimeSession?.status ?? session.status;

  if (effectiveStatus === "running" || effectiveStatus === "queued") {
    return NextResponse.json(
      { error: "Guide generation or regeneration is already in progress" },
      { status: 409 },
    );
  }

  if (effectiveStatus !== "completed") {
    return NextResponse.json(
      { error: "Guide must be completed before regenerating" },
      { status: 409 },
    );
  }

  const versionNumber = await getNextGuideVersionNumber(sessionId);

  try {
    // Create an empty assistant message that will be streamed into
    const assistantMessage = await createChatMessage({
      sessionId,
      role: "assistant",
      content: "",
      format: "markdown",
      metadata: {
        streaming: true,
        guide_version: versionNumber,
      },
    });

    emitChatMessageCreated(sessionId, assistantMessage);

    startGuideRegeneration({
      sessionId,
      assistantMessageId: assistantMessage.id,
      versionNumber,
      requestUrl: req.url,
    });

    const response = NextResponse.json({
      ok: true,
      version_number: versionNumber,
      assistant_message_id: assistantMessage.id,
    });
    if (resolvedUser?.refreshedSession) {
      applyAuthCookies(response, resolvedUser.refreshedSession);
    }
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "Unable to start guide update", detail: message },
      { status: 500 },
    );
  }
}
