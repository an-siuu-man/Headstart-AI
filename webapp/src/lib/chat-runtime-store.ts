import {
  type ChatMessageDto,
  type ChatSessionStage,
  type ChatSessionStatus,
  type RuntimeSessionState,
} from "@/lib/chat-types";

type RuntimeEventBase = {
  sessionId: string;
  at: number;
};

export type RuntimeChatEvent =
  | ({ type: "session.update"; runtime: RuntimeSessionState } & RuntimeEventBase)
  | ({ type: "chat.message.created"; message: ChatMessageDto } & RuntimeEventBase)
  | ({ type: "chat.message.delta"; messageId: string; delta: string; content: string } & RuntimeEventBase)
  | ({ type: "chat.message.completed"; messageId: string; content: string } & RuntimeEventBase)
  | ({ type: "chat.error"; message: string; messageId?: string } & RuntimeEventBase);

type RuntimeListener = (event: RuntimeChatEvent) => void;

declare global {
  var __headstartRuntimeSessions: Map<string, RuntimeSessionState> | undefined;
  var __headstartRuntimeListeners: Map<string, Set<RuntimeListener>> | undefined;
}

const runtimeSessions =
  globalThis.__headstartRuntimeSessions ?? new Map<string, RuntimeSessionState>();
const runtimeListeners =
  globalThis.__headstartRuntimeListeners ?? new Map<string, Set<RuntimeListener>>();

if (!globalThis.__headstartRuntimeSessions) {
  globalThis.__headstartRuntimeSessions = runtimeSessions;
}
if (!globalThis.__headstartRuntimeListeners) {
  globalThis.__headstartRuntimeListeners = runtimeListeners;
}

function toBoundedPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function notify(event: RuntimeChatEvent) {
  const listeners = runtimeListeners.get(event.sessionId);
  if (!listeners || listeners.size === 0) return;

  for (const listener of Array.from(listeners)) {
    try {
      listener(event);
    } catch {
      // Ignore listener errors to protect event fanout.
    }
  }
}

export function ensureRuntimeSession(sessionId: string) {
  const existing = runtimeSessions.get(sessionId);
  if (existing) return existing;

  const created: RuntimeSessionState = {
    sessionId,
    status: "queued",
    stage: "queued",
    progressPercent: 5,
    statusMessage: "Queued",
    streamedGuideMarkdown: "",
    updatedAt: Date.now(),
  };
  runtimeSessions.set(sessionId, created);
  return created;
}

export function getRuntimeSession(sessionId: string) {
  return runtimeSessions.get(sessionId) ?? null;
}

export function removeRuntimeSession(sessionId: string) {
  runtimeSessions.delete(sessionId);
  runtimeListeners.delete(sessionId);
}

function setRuntimeSession(sessionId: string, next: RuntimeSessionState) {
  runtimeSessions.set(sessionId, next);
  notify({
    type: "session.update",
    sessionId,
    runtime: next,
    at: Date.now(),
  });
  return next;
}

export function patchRuntimeSession(
  sessionId: string,
  patch: Partial<Omit<RuntimeSessionState, "sessionId" | "updatedAt">>,
) {
  const current = ensureRuntimeSession(sessionId);
  const next: RuntimeSessionState = {
    ...current,
    ...patch,
    progressPercent:
      patch.progressPercent != null
        ? toBoundedPercent(patch.progressPercent)
        : current.progressPercent,
    updatedAt: Date.now(),
  };
  return setRuntimeSession(sessionId, next);
}

export function appendRuntimeGuideDelta(
  sessionId: string,
  delta: string,
  input?: {
    progressPercent?: number;
    statusMessage?: string;
  },
) {
  const current = ensureRuntimeSession(sessionId);
  const next: RuntimeSessionState = {
    ...current,
    status: "running",
    stage: "streaming_output",
    streamedGuideMarkdown: `${current.streamedGuideMarkdown}${delta}`,
    progressPercent:
      input?.progressPercent != null
        ? toBoundedPercent(input.progressPercent)
        : Math.max(current.progressPercent, 66),
    statusMessage: input?.statusMessage ?? "Generating guide",
    updatedAt: Date.now(),
    error: undefined,
  };
  return setRuntimeSession(sessionId, next);
}

export function markRuntimeFailed(sessionId: string, error: string) {
  const current = ensureRuntimeSession(sessionId);
  return setRuntimeSession(sessionId, {
    ...current,
    status: "failed",
    stage: "failed",
    progressPercent: 100,
    statusMessage: "Guide generation failed",
    error,
    updatedAt: Date.now(),
  });
}

export function markRuntimeCompleted(sessionId: string, guideMarkdown: string) {
  const current = ensureRuntimeSession(sessionId);
  return setRuntimeSession(sessionId, {
    ...current,
    status: "completed",
    stage: "completed",
    progressPercent: 100,
    statusMessage: "Guide ready",
    streamedGuideMarkdown: guideMarkdown || current.streamedGuideMarkdown,
    result: {
      guideMarkdown: guideMarkdown || current.streamedGuideMarkdown,
    },
    error: undefined,
    updatedAt: Date.now(),
  });
}

export function emitChatMessageCreated(sessionId: string, message: ChatMessageDto) {
  notify({
    type: "chat.message.created",
    sessionId,
    message,
    at: Date.now(),
  });
}

export function emitChatMessageDelta(
  sessionId: string,
  input: {
    messageId: string;
    delta: string;
    content: string;
  },
) {
  notify({
    type: "chat.message.delta",
    sessionId,
    messageId: input.messageId,
    delta: input.delta,
    content: input.content,
    at: Date.now(),
  });
}

export function emitChatMessageCompleted(
  sessionId: string,
  input: {
    messageId: string;
    content: string;
  },
) {
  notify({
    type: "chat.message.completed",
    sessionId,
    messageId: input.messageId,
    content: input.content,
    at: Date.now(),
  });
}

export function emitChatError(
  sessionId: string,
  input: {
    message: string;
    messageId?: string;
  },
) {
  notify({
    type: "chat.error",
    sessionId,
    message: input.message,
    messageId: input.messageId,
    at: Date.now(),
  });
}

export function subscribeToRuntimeSession(
  sessionId: string,
  listener: RuntimeListener,
) {
  const listeners = runtimeListeners.get(sessionId) ?? new Set<RuntimeListener>();
  listeners.add(listener);
  runtimeListeners.set(sessionId, listeners);

  return () => {
    const current = runtimeListeners.get(sessionId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      runtimeListeners.delete(sessionId);
    }
  };
}

export function setRuntimeProgress(input: {
  sessionId: string;
  status?: ChatSessionStatus;
  stage?: ChatSessionStage;
  progressPercent?: number;
  statusMessage?: string;
  clearError?: boolean;
}) {
  const patch: Partial<Omit<RuntimeSessionState, "sessionId" | "updatedAt">> = {};
  if (input.status) patch.status = input.status;
  if (input.stage) patch.stage = input.stage;
  if (input.progressPercent != null) patch.progressPercent = input.progressPercent;
  if (input.statusMessage) patch.statusMessage = input.statusMessage;
  if (input.clearError) patch.error = undefined;
  return patchRuntimeSession(input.sessionId, patch);
}
