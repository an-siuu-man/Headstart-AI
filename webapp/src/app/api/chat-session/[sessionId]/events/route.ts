import { NextResponse } from "next/server";
import {
  getRuntimeSession,
  subscribeToRuntimeSession,
  type RuntimeChatEvent,
} from "@/lib/chat-runtime-store";
import {
  assertSessionOwnership,
  getPersistedSessionSnapshot,
} from "@/lib/chat-repository";
import { buildSessionDto, type ChatSessionDto } from "@/lib/chat-types";
import { resolveRequestUser } from "@/lib/auth/session";

export const runtime = "nodejs";

const encoder = new TextEncoder();

function formatSseEvent(event: string, data: unknown, eventId?: string) {
  const lines: string[] = [];
  if (eventId) {
    lines.push(`id: ${eventId}`);
  }
  lines.push(`event: ${event}`);

  const payload = JSON.stringify(data);
  for (const line of payload.split("\n")) {
    lines.push(`data: ${line}`);
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

function upsertMessage(
  session: ChatSessionDto,
  message: ChatSessionDto["messages"][number],
) {
  const index = session.messages.findIndex((entry) => entry.id === message.id);
  if (index === -1) {
    session.messages.push(message);
    session.messages.sort((a, b) => a.message_index - b.message_index);
    return;
  }
  session.messages[index] = message;
}

function patchMessageContent(
  session: ChatSessionDto,
  messageId: string,
  updater: (prev: string) => string,
) {
  const index = session.messages.findIndex((entry) => entry.id === messageId);
  if (index === -1) return;

  const existing = session.messages[index];
  session.messages[index] = {
    ...existing,
    content_text: updater(existing.content_text),
  };
}

function applyRuntimeEvent(session: ChatSessionDto, event: RuntimeChatEvent) {
  if (event.type === "session.update") {
    const runtime = event.runtime;
    session.status = runtime.status;
    session.stage = runtime.stage;
    session.progress_percent = runtime.progressPercent;
    session.status_message = runtime.statusMessage;
    session.streamed_guide_markdown = runtime.streamedGuideMarkdown;
    session.assignment_category = runtime.assignmentCategory ?? session.assignment_category ?? null;
    session.result = runtime.result ?? session.result;
    session.error = runtime.error ?? null;
    session.updated_at = Math.max(session.updated_at, runtime.updatedAt);
    return;
  }

  session.updated_at = Math.max(session.updated_at, event.at);

  if (event.type === "chat.message.created") {
    upsertMessage(session, event.message);
    return;
  }

  if (event.type === "chat.message.delta") {
    patchMessageContent(session, event.messageId, (prev) => `${prev}${event.delta}`);
    return;
  }

  if (event.type === "chat.message.completed") {
    patchMessageContent(session, event.messageId, () => event.content);
    return;
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const resolvedUser = await resolveRequestUser(req);
  const userId = resolvedUser?.user.id ?? "";

  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const ownedSession = await assertSessionOwnership(sessionId, userId);
  if (!ownedSession) {
    return NextResponse.json(
      { error: "session not found or expired" },
      { status: 404 },
    );
  }

  const snapshot = await getPersistedSessionSnapshot(sessionId);

  if (!snapshot) {
    return NextResponse.json(
      { error: "session not found or expired" },
      { status: 404 },
    );
  }

  const runtime = getRuntimeSession(sessionId);
  const initialSession = buildSessionDto(snapshot, runtime);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      let unsubscribe = () => {};
      const currentSession: ChatSessionDto = structuredClone(initialSession);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        unsubscribe();
        req.signal.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          // Ignore close races.
        }
      };

      const emit = (event: string, data: unknown, eventId?: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(formatSseEvent(event, data, eventId)));
        } catch {
          cleanup();
        }
      };

      const onRuntimeEvent = (event: RuntimeChatEvent) => {
        if (closed) return;

        applyRuntimeEvent(currentSession, event);

        if (event.type === "session.update") {
          emit(
            "session.update",
            {
              status: currentSession.status,
              stage: currentSession.stage,
              progress_percent: currentSession.progress_percent,
              status_message: currentSession.status_message,
              streamed_guide_markdown: currentSession.streamed_guide_markdown,
              assignment_category: currentSession.assignment_category,
              result: currentSession.result,
              error: currentSession.error,
              updated_at: currentSession.updated_at,
            },
            String(currentSession.updated_at),
          );
          return;
        }

        if (event.type === "chat.message.created") {
          emit("chat.message.created", event.message, `${event.at}-created`);
          return;
        }

        if (event.type === "chat.message.delta") {
          emit(
            "chat.message.delta",
            {
              message_id: event.messageId,
              delta: event.delta,
              content: event.content,
            },
            `${event.at}-delta`,
          );
          return;
        }

        if (event.type === "chat.message.completed") {
          emit(
            "chat.message.completed",
            {
              message_id: event.messageId,
              content: event.content,
            },
            `${event.at}-completed`,
          );
          return;
        }

        if (event.type === "chat.error") {
          emit(
            "chat.error",
            {
              message: event.message,
              message_id: event.messageId,
            },
            `${event.at}-error`,
          );
          return;
        }

        if (event.type === "calendar.proposal") {
          emit(
            "calendar.proposal",
            {
              assistant_message_id: event.assistantMessageId,
              assignment_id: event.assignmentId,
              sessions: event.sessions,
            },
            `${event.at}-proposal`,
          );
        }
      };

      const onAbort = () => {
        cleanup();
      };

      emit("session.snapshot", currentSession, String(currentSession.updated_at));
      if (closed) {
        return;
      }

      unsubscribe = subscribeToRuntimeSession(sessionId, onRuntimeEvent);

      heartbeatTimer = setInterval(() => {
        emit("session.heartbeat", { ts: Date.now() });
      }, 15000);

      req.signal.addEventListener("abort", onAbort);
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    },
  });
}
