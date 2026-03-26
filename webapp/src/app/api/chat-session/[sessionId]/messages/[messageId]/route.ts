import { NextResponse } from "next/server";
import {
  assertSessionOwnership,
  getPersistedSessionSnapshot,
  updateChatMessageMetadata,
} from "@/lib/chat-repository";
import { resolveRequestUser } from "@/lib/auth/session";

export const runtime = "nodejs";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ sessionId: string; messageId: string }> },
) {
  const { sessionId, messageId } = await params;

  const resolvedUser = await resolveRequestUser(req);
  const userId = resolvedUser?.user.id ?? "";
  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const ownedSession = await assertSessionOwnership(sessionId, userId);
  if (!ownedSession) {
    return NextResponse.json({ error: "Session not found or expired" }, { status: 404 });
  }

  let body: Record<string, unknown> | null = null;
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body?.calendar_proposal_scheduled !== true) {
    return NextResponse.json(
      { error: "Only calendar_proposal_scheduled: true is accepted" },
      { status: 400 },
    );
  }

  // Find the message in the snapshot to get existing metadata for merging
  const snapshot = await getPersistedSessionSnapshot(sessionId);
  if (!snapshot) {
    return NextResponse.json({ error: "Session not found or expired" }, { status: 404 });
  }

  const message = snapshot.messages.find((m) => m.id === messageId);
  if (!message) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }

  const mergedMetadata: Record<string, unknown> = {
    ...(message.metadata as Record<string, unknown> | null ?? {}),
    calendar_proposal_scheduled: true,
  };

  await updateChatMessageMetadata(sessionId, messageId, mergedMetadata);

  return NextResponse.json({ ok: true });
}
