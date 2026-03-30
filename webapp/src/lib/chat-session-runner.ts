import {
  appendRuntimeGuideDelta,
  emitCalendarProposal,
  emitChatError,
  emitChatMessageCompleted,
  emitChatMessageDelta,
  markRuntimeCompleted,
  markRuntimeFailed,
  patchRuntimeSession,
  setRuntimeProgress,
} from "@/lib/chat-runtime-store";
import {
  getHighestMessageIndex,
  getSessionGuideAndRecentHistory,
  insertGuideVersion,
  listSignedSnapshotPdfFiles,
  updateChatMessageContent,
  updateChatSessionStatus,
} from "@/lib/chat-repository";
import { supabaseStorageCreateSignedUrl } from "@/lib/supabase-rest";
import { getSharedAssignmentCalendarContextForChat } from "@/lib/assignment-calendar-context";
import { type AssignmentPayload } from "@/lib/chat-types";
import { type SseMessage, readSseStream } from "@/lib/sse";
import { retrieveLexicalContext } from "@/lib/rag/lexical-retriever";

type AgentRunEventName =
  | "run.started"
  | "run.stage"
  | "run.delta"
  | "run.completed"
  | "run.error"
  | "run.heartbeat";

type AgentChatEventName =
  | "chat.started"
  | "chat.delta"
  | "chat.completed"
  | "chat.error"
  | "chat.heartbeat";

const CHAT_PAYLOAD_DROP_KEYS = new Set([
  "base64Data",
  "base64_data",
  "pdfAttachments",
  "pdf_files",
  "pdfFiles",
  "pdfs",
  "raw_payload",
  "rawPayload",
]);
const MAX_CHAT_FIELD_TEXT_CHARS = 2200;
const MAX_CHAT_ARRAY_ITEMS = 20;
const MAX_CHAT_OBJECT_KEYS = 40;
const MAX_CHAT_OBJECT_DEPTH = 4;
const FOLLOWUP_CHAT_HISTORY_LIMIT = 8;
const ASSISTANT_PERSIST_INTERVAL_MS = 1500;

function toErrorMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  return String(err);
}

function truncateForChat(value: string, maxChars = MAX_CHAT_FIELD_TEXT_CHARS) {
  if (value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n...[truncated ${omitted} chars]`;
}

function looksLikeBase64Blob(value: string) {
  const compact = value.replace(/\s+/g, "");
  if (compact.length < 1200) return false;
  const sample = compact.slice(0, 2000);
  return /^[A-Za-z0-9+/=]+$/.test(sample);
}

function sanitizePayloadValueForChat(value: unknown, depth = 0): unknown {
  if (value == null) return null;
  if (typeof value === "boolean" || typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    if (looksLikeBase64Blob(value)) {
      return "[omitted binary/base64 content]";
    }
    return truncateForChat(value);
  }
  if (Array.isArray(value)) {
    const limited = value
      .slice(0, MAX_CHAT_ARRAY_ITEMS)
      .map((item) => sanitizePayloadValueForChat(item, depth + 1));
    if (value.length > MAX_CHAT_ARRAY_ITEMS) {
      limited.push(`[${value.length - MAX_CHAT_ARRAY_ITEMS} more items omitted]`);
    }
    return limited;
  }
  if (typeof value === "object") {
    if (depth >= MAX_CHAT_OBJECT_DEPTH) {
      return "[omitted nested object]";
    }
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    let written = 0;

    for (const [key, entry] of Object.entries(source)) {
      if (CHAT_PAYLOAD_DROP_KEYS.has(key)) continue;
      if (written >= MAX_CHAT_OBJECT_KEYS) {
        output._omitted_keys = `${Object.keys(source).length - written} keys omitted`;
        break;
      }
      output[key] = sanitizePayloadValueForChat(entry, depth + 1);
      written += 1;
    }
    return output;
  }
  return truncateForChat(String(value));
}

function sanitizeAssignmentPayloadForFollowup(payload: AssignmentPayload) {
  const sanitized = sanitizePayloadValueForChat(payload);
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    return {};
  }
  return sanitized as Record<string, unknown>;
}

function parseJsonObject(raw: string) {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected SSE data to be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function parseRunEvent(message: SseMessage) {
  const eventName = message.event as AgentRunEventName;
  if (!eventName.startsWith("run.")) {
    return null;
  }

  const data = message.data ? parseJsonObject(message.data) : {};
  return {
    event: eventName,
    data,
  };
}

function parseChatEvent(message: SseMessage) {
  const eventName = message.event as AgentChatEventName;
  if (!eventName.startsWith("chat.")) {
    return null;
  }

  const data = message.data ? parseJsonObject(message.data) : {};
  return {
    event: eventName,
    data,
  };
}

function toStage(value: unknown) {
  if (typeof value !== "string") return "calling_agent";
  if (
    value === "queued" ||
    value === "preparing_payload" ||
    value === "extracting_pdf" ||
    value === "calling_agent" ||
    value === "streaming_output" ||
    value === "validating_output" ||
    value === "parsing_response" ||
    value === "completed" ||
    value === "failed" ||
    value === "chat_streaming"
  ) {
    return value;
  }
  return "calling_agent";
}

function toPercent(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function toOptionalString(value: unknown) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

async function openAgentRunStream(agentUrl: string, body: string) {
  const primaryUrl = `${agentUrl}/api/v1/runs/stream`;
  const primary = await fetch(primaryUrl, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body,
  });

  if (primary.status !== 404) {
    return primary;
  }

  return fetch(`${agentUrl}/run-agent/stream`, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body,
  });
}

async function openAgentChatStream(agentUrl: string, body: string) {
  const primary = await fetch(`${agentUrl}/api/v1/chats/stream`, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body,
  });

  if (primary.status !== 404) {
    return primary;
  }

  return fetch(`${agentUrl}/chat/stream`, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body,
  });
}

async function runInitialGuide(input: {
  sessionId: string;
  assignmentUuid: string;
  payload: AssignmentPayload;
}) {
  const { sessionId, assignmentUuid, payload } = input;
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let bufferedDelta = "";
  let bufferedProgress: number | null = null;
  let bufferedStatusMessage: string | null = null;

  const flushBufferedDelta = () => {
    if (!bufferedDelta && bufferedProgress === null && !bufferedStatusMessage) {
      return;
    }

    if (bufferedDelta) {
      appendRuntimeGuideDelta(sessionId, bufferedDelta, {
        progressPercent: bufferedProgress ?? undefined,
        statusMessage: bufferedStatusMessage ?? undefined,
      });
    } else {
      setRuntimeProgress({
        sessionId,
        status: "running",
        stage: "streaming_output",
        progressPercent: bufferedProgress ?? 66,
        statusMessage: bufferedStatusMessage ?? "Generating guide",
        clearError: true,
      });
    }

    bufferedDelta = "";
    bufferedProgress = null;
    bufferedStatusMessage = null;
  };

  try {
    await updateChatSessionStatus(sessionId, "running");
    patchRuntimeSession(sessionId, {
      status: "running",
      stage: "preparing_payload",
      progressPercent: 15,
      statusMessage: "Preparing assignment payload",
      error: undefined,
    });

    const snapshotPdfFiles = await listSignedSnapshotPdfFiles(assignmentUuid);

    const payloadWithoutPdfs = { ...payload } as AssignmentPayload;
    delete payloadWithoutPdfs.pdfAttachments;
    const pdfFiles = snapshotPdfFiles.map((file) => ({
      filename: file.filename,
      file_sha256: file.fileSha256,
      storage_url: file.signedUrl,
    }));

    const agentUrl = process.env.AGENT_SERVICE_URL;
    if (!agentUrl) {
      throw new Error("AGENT_SERVICE_URL not set");
    }

    setRuntimeProgress({
      sessionId,
      status: "running",
      stage: "calling_agent",
      progressPercent: 56,
      statusMessage: "Connecting to agent stream",
      clearError: true,
    });

    const requestBody = JSON.stringify({
      assignment_uuid: assignmentUuid,
      payload: {
        ...payloadWithoutPdfs,
        assignment_uuid: assignmentUuid,
      },
      pdf_text: "",
      pdf_files: pdfFiles,
    });

    const streamResponse = await openAgentRunStream(agentUrl, requestBody);
    if (!streamResponse.ok) {
      const rawText = await streamResponse.text();
      throw new Error(`Agent service stream error (${streamResponse.status}): ${rawText}`);
    }

    if (!streamResponse.body) {
      throw new Error("Agent stream response has no body");
    }

    flushTimer = setInterval(flushBufferedDelta, 80);
    let hasCompleted = false;

    for await (const message of readSseStream(streamResponse.body)) {
      const parsedEvent = parseRunEvent(message);
      if (!parsedEvent) continue;

      const { event, data } = parsedEvent;

      if (event === "run.started" || event === "run.stage") {
        flushBufferedDelta();
        setRuntimeProgress({
          sessionId,
          status: "running",
          stage: toStage(data.stage),
          progressPercent: toPercent(data.progress_percent, 56),
          statusMessage:
            typeof data.status_message === "string"
              ? data.status_message
              : "Generating guide",
          clearError: true,
        });
        continue;
      }

      if (event === "run.delta") {
        if (typeof data.delta === "string" && data.delta.length > 0) {
          bufferedDelta += data.delta;
        }
        if (data.progress_percent !== undefined) {
          bufferedProgress = toPercent(data.progress_percent, bufferedProgress ?? 66);
        }
        if (typeof data.status_message === "string" && data.status_message.trim()) {
          bufferedStatusMessage = data.status_message;
        }
        continue;
      }

      if (event === "run.completed") {
        flushBufferedDelta();
        const guideMarkdown =
          typeof data.guideMarkdown === "string" ? data.guideMarkdown : "";

        if (!guideMarkdown.trim()) {
          throw new Error("Agent returned empty guide markdown");
        }

        await updateChatSessionStatus(sessionId, "completed");

        markRuntimeCompleted(sessionId, guideMarkdown);

        // Persist v1 — best-effort; don't fail the whole run if this errors
        insertGuideVersion({
          sessionId,
          versionNumber: 1,
          contentText: guideMarkdown,
          source: "initial_run",
          messageIndexAtCreation: 0,
        }).catch((err: unknown) => {
          console.error("[chat-runner] Failed to persist guide v1:", err);
        });

        hasCompleted = true;
        break;
      }

      if (event === "run.error") {
        flushBufferedDelta();
        const errorMessage =
          typeof data.message === "string" && data.message.trim()
            ? data.message
            : "Guide generation failed";
        throw new Error(errorMessage);
      }
    }

    flushBufferedDelta();
    if (!hasCompleted) {
      throw new Error("Agent stream ended before completion.");
    }
  } catch (err) {
    const message = toErrorMessage(err);
    await updateChatSessionStatus(sessionId, "failed").catch(() => undefined);
    markRuntimeFailed(sessionId, message);
  } finally {
    if (flushTimer) {
      clearInterval(flushTimer);
    }
  }
}

export function startChatSessionRun(input: {
  sessionId: string;
  assignmentUuid: string;
  payload: AssignmentPayload;
}) {
  void runInitialGuide(input);
}

function toAgentHistory(messages: Array<{ sender_role: string; content_text: string }>) {
  return messages
    .filter((message) => {
      if (!message.content_text.trim()) return false;
      return (
        message.sender_role === "user" ||
        message.sender_role === "assistant" ||
        message.sender_role === "system"
      );
    })
    .map((message) => ({
      role: message.sender_role,
      content: message.content_text,
    }));
}

async function runFollowupChat(input: {
  sessionId: string;
  assistantMessageId: string;
  userMessageContent: string;
  requestUrl: string;
  attachments?: Array<{ filename: string; file_sha256: string; storage_path: string }>;
}) {
  const { sessionId, assistantMessageId, userMessageContent, requestUrl, attachments } = input;

  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let bufferedDelta = "";
  let assistantContent = "";
  let persistChain: Promise<void> = Promise.resolve();
  let lastPersistAt = 0;
  let pendingPersist = false;

  const persistAssistant = (content: string, metadata: Record<string, unknown>) => {
    persistChain = persistChain
      .then(async () => {
        await updateChatMessageContent({
          messageId: assistantMessageId,
          content,
          metadata,
        });
      })
      .catch(() => undefined);
  };

  const maybePersistAssistant = (force = false) => {
    const now = Date.now();
    if (!force && now - lastPersistAt < ASSISTANT_PERSIST_INTERVAL_MS) {
      pendingPersist = true;
      return;
    }

    pendingPersist = false;
    lastPersistAt = now;
    persistAssistant(assistantContent, {
      streaming: true,
    });
  };

  const flushDelta = () => {
    if (!bufferedDelta) return;
    const delta = bufferedDelta;
    bufferedDelta = "";
    assistantContent += delta;

    emitChatMessageDelta(sessionId, {
      messageId: assistantMessageId,
      delta,
      content: assistantContent,
    });
    maybePersistAssistant();
  };

  try {
    patchRuntimeSession(sessionId, {
      status: "running",
      stage: "chat_streaming",
      statusMessage: "Generating follow-up response",
      progressPercent: 97,
      error: undefined,
    });

    const sessionContext = await getSessionGuideAndRecentHistory(
      sessionId,
      FOLLOWUP_CHAT_HISTORY_LIMIT,
    );
    if (!sessionContext) {
      throw new Error("Session context not found.");
    }

    const retrievalContext = retrieveLexicalContext({
      guideMarkdown: sessionContext.guideMarkdown,
      payload: sessionContext.payload,
      query: userMessageContent,
      maxChunks: 6,
      maxChars: 700,
    });

    const agentUrl = process.env.AGENT_SERVICE_URL;
    if (!agentUrl) {
      throw new Error("AGENT_SERVICE_URL not set");
    }

    const chatHistory = toAgentHistory(sessionContext.messages)
      .filter((message) => message.content.trim().length > 0)
      .slice(-FOLLOWUP_CHAT_HISTORY_LIMIT);
    const assignmentPayload = sanitizeAssignmentPayloadForFollowup(sessionContext.payload);
    const fallbackTimezone = String(sessionContext.payload.userTimezone ?? "UTC");

    let calendarContext: object | null = null;
    let resolvedAssignmentRecordId: string | null = null;
    const resolvedContext = await getSharedAssignmentCalendarContextForChat({
      userId: sessionContext.userId,
      assignmentRecordId: sessionContext.assignmentRecordId ?? null,
      courseId: toOptionalString(sessionContext.payload.courseId),
      providerAssignmentId: toOptionalString(sessionContext.payload.assignmentId),
      assignmentUrl: toOptionalString(sessionContext.payload.url),
      requestUrl,
      timezone: fallbackTimezone,
    }).catch(() => ({
      assignment_id: sessionContext.assignmentRecordId ?? null,
      timezone: fallbackTimezone,
      availability_reason: "calendar_fetch_failed" as const,
      integration: {
        google: {
          status: "disconnected" as const,
          connected: false,
        },
      },
      no_slots_found: false,
      free_slots: [],
      recommended_sessions: [],
    }));
    if (resolvedContext) {
      calendarContext = resolvedContext;
      resolvedAssignmentRecordId = resolvedContext.assignment_id ?? null;
    }

    // Generate signed URLs for user-attached PDFs
    const userPdfFiles: Array<{ filename: string; storage_url: string; file_sha256: string }> = [];
    if (attachments && attachments.length > 0) {
      const chatUploadBucket = process.env.SUPABASE_ASSIGNMENT_PDF_BUCKET ?? "assignment-pdfs";
      const signedUrlTtl = 600;
      for (const attachment of attachments) {
        try {
          const signedUrl = await supabaseStorageCreateSignedUrl({
            bucket: chatUploadBucket,
            path: attachment.storage_path,
            expiresInSeconds: signedUrlTtl,
          });
          userPdfFiles.push({
            filename: attachment.filename,
            storage_url: signedUrl,
            file_sha256: attachment.file_sha256,
          });
        } catch (err) {
          console.error(`[chat-runner] Failed to sign URL for attachment "${attachment.filename}":`, err);
        }
      }
    }

    const streamResponse = await openAgentChatStream(
      agentUrl,
      JSON.stringify({
        assignment_payload: assignmentPayload,
        guide_markdown: sessionContext.guideMarkdown,
        chat_history: chatHistory,
        retrieval_context: retrievalContext,
        user_message: userMessageContent,
        thinking_mode: false,
        calendar_context: calendarContext,
        ...(userPdfFiles.length > 0 ? { user_pdf_files: userPdfFiles } : {}),
      }),
    );

    if (!streamResponse.ok) {
      const rawText = await streamResponse.text();
      throw new Error(`Agent chat stream error (${streamResponse.status}): ${rawText}`);
    }
    if (!streamResponse.body) {
      throw new Error("Agent chat stream has no body.");
    }

    flushTimer = setInterval(flushDelta, 80);
    let hasCompleted = false;

    for await (const message of readSseStream(streamResponse.body)) {
      const parsed = parseChatEvent(message);
      if (!parsed) continue;

      const { event, data } = parsed;

      if (event === "chat.started") {
        patchRuntimeSession(sessionId, {
          status: "running",
          stage: "chat_streaming",
          progressPercent: toPercent(data.progress_percent, 97),
          statusMessage:
            typeof data.status_message === "string"
              ? data.status_message
              : "Generating follow-up response",
        });
        continue;
      }

      if (event === "chat.delta") {
        if (typeof data.delta === "string" && data.delta.length > 0) {
          bufferedDelta += data.delta;
        }
        continue;
      }

      if (event === "chat.completed") {
        flushDelta();
        if (pendingPersist) {
          maybePersistAssistant(true);
        }

        if (typeof data.assistant_message === "string") {
          const completedText = data.assistant_message;
          if (completedText.trim().length > 0) {
            assistantContent = completedText;
          }
        }

        await persistChain;

        // Extract <calendar_proposal> blocks before persisting visible content
        const PROPOSAL_RE = /<calendar_proposal>([\s\S]*?)<\/calendar_proposal>/g;
        let proposalMatch: RegExpExecArray | null;
        let firstProposal: { assignmentId: string; sessions: unknown[] } | null = null;
        while ((proposalMatch = PROPOSAL_RE.exec(assistantContent)) !== null) {
          try {
            const parsed = JSON.parse(proposalMatch[1].trim()) as { sessions?: unknown[] };
            if (Array.isArray(parsed.sessions) && parsed.sessions.length > 0) {
              emitCalendarProposal(sessionId, {
                assistantMessageId,
                assignmentId: resolvedAssignmentRecordId ?? "",
                sessions: parsed.sessions,
              });
              if (!firstProposal) {
                firstProposal = {
                  assignmentId: resolvedAssignmentRecordId ?? "",
                  sessions: parsed.sessions,
                };
              }
            }
          } catch {
            // Silently ignore malformed proposal blocks
          }
        }
        // Strip the raw tag from the stored/displayed content
        assistantContent = assistantContent
          .replace(/<calendar_proposal>[\s\S]*?<\/calendar_proposal>/g, "")
          .trim();

        await updateChatMessageContent({
          messageId: assistantMessageId,
          content: assistantContent,
          metadata: {
            streaming: false,
            completed: true,
            ...(firstProposal ? { calendar_proposal: firstProposal } : {}),
          },
        });

        emitChatMessageCompleted(sessionId, {
          messageId: assistantMessageId,
          content: assistantContent,
        });

        patchRuntimeSession(sessionId, {
          status: "completed",
          stage: "completed",
          progressPercent: 100,
          statusMessage: "Response ready",
          error: undefined,
        });

        hasCompleted = true;
        break;
      }

      if (event === "chat.error") {
        const messageText =
          typeof data.message === "string" && data.message.trim()
            ? data.message
            : "Follow-up response failed.";
        throw new Error(messageText);
      }
    }

    flushDelta();
    if (!hasCompleted) {
      throw new Error("Chat stream ended before completion.");
    }
  } catch (err) {
    flushDelta();
    if (pendingPersist) {
      maybePersistAssistant(true);
    }
    await persistChain;

    const errorMessage = toErrorMessage(err);
    emitChatError(sessionId, {
      message: errorMessage,
      messageId: assistantMessageId,
    });

    const fallbackMessage = assistantContent.trim()
      ? `${assistantContent}\n\nUnable to complete response: ${errorMessage}`
      : `Unable to complete response: ${errorMessage}`;

    await updateChatMessageContent({
      messageId: assistantMessageId,
      content: fallbackMessage,
      metadata: {
        streaming: false,
        failed: true,
        error: errorMessage,
      },
    }).catch(() => undefined);

    patchRuntimeSession(sessionId, {
      status: "completed",
      stage: "completed",
      progressPercent: 100,
      statusMessage: "Follow-up failed",
      error: errorMessage,
    });
  } finally {
    if (flushTimer) {
      clearInterval(flushTimer);
    }
  }
}

export function startFollowupChatRun(input: {
  sessionId: string;
  assistantMessageId: string;
  userMessageContent: string;
  requestUrl: string;
  attachments?: Array<{ filename: string; file_sha256: string; storage_path: string }>;
}) {
  void runFollowupChat(input);
}

// ---------------------------------------------------------------------------
// Guide regeneration — streams a new guide version as a chat message
// ---------------------------------------------------------------------------

const REGEN_CHAT_HISTORY_LIMIT = 50;
const REGEN_ASSISTANT_PERSIST_INTERVAL_MS = 1500;

async function runGuideRegeneration(input: {
  sessionId: string;
  assistantMessageId: string;
  versionNumber: number;
  requestUrl: string;
}) {
  const { sessionId, assistantMessageId, versionNumber } = input;
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let bufferedDelta = "";
  let assistantContent = "";
  let persistChain: Promise<void> = Promise.resolve();
  let lastPersistAt = 0;
  let pendingPersist = false;

  const persistAssistant = (content: string, metadata: Record<string, unknown>) => {
    persistChain = persistChain
      .then(async () => {
        await updateChatMessageContent({ messageId: assistantMessageId, content, metadata });
      })
      .catch(() => undefined);
  };

  const maybePersistAssistant = (force = false) => {
    const now = Date.now();
    if (!force && now - lastPersistAt < REGEN_ASSISTANT_PERSIST_INTERVAL_MS) {
      pendingPersist = true;
      return;
    }
    pendingPersist = false;
    lastPersistAt = now;
    persistAssistant(assistantContent, { streaming: true, guide_version: versionNumber });
  };

  const flushDelta = () => {
    if (!bufferedDelta) return;
    const delta = bufferedDelta;
    bufferedDelta = "";
    assistantContent += delta;
    emitChatMessageDelta(sessionId, {
      messageId: assistantMessageId,
      delta,
      content: assistantContent,
    });
    maybePersistAssistant();
  };

  try {
    patchRuntimeSession(sessionId, {
      status: "running",
      stage: "chat_streaming",
      progressPercent: 97,
      statusMessage: `Updating guide (v${versionNumber})`,
      error: undefined,
    });

    const sessionContext = await getSessionGuideAndRecentHistory(
      sessionId,
      REGEN_CHAT_HISTORY_LIMIT,
    );
    if (!sessionContext) {
      throw new Error("Session context not found.");
    }

    const retrievalContext = retrieveLexicalContext({
      guideMarkdown: sessionContext.guideMarkdown,
      payload: sessionContext.payload,
      query: "regenerate full study guide",
      maxChunks: 6,
      maxChars: 700,
    });

    const agentUrl = process.env.AGENT_SERVICE_URL;
    if (!agentUrl) {
      throw new Error("AGENT_SERVICE_URL not set");
    }

    const chatHistory = toAgentHistory(sessionContext.messages)
      .filter((message) => message.content.trim().length > 0)
      .slice(-REGEN_CHAT_HISTORY_LIMIT);
    const assignmentPayload = sanitizeAssignmentPayloadForFollowup(sessionContext.payload);

    const regenerationInstruction =
      `Based on everything we have discussed so far and any files I've attached, ` +
      `please regenerate a complete, updated study guide for this assignment. ` +
      `Output ONLY the full guide in markdown — no conversational text, no preamble. ` +
      `Do NOT include calendar scheduling proposals or time-block suggestions.`;

    const streamResponse = await openAgentChatStream(
      agentUrl,
      JSON.stringify({
        assignment_payload: assignmentPayload,
        guide_markdown: sessionContext.guideMarkdown,
        chat_history: chatHistory,
        retrieval_context: retrievalContext,
        user_message: regenerationInstruction,
        thinking_mode: false,
        // Omit calendar_context entirely — guide updates should not include scheduling
      }),
    );

    if (!streamResponse.ok) {
      const rawText = await streamResponse.text();
      throw new Error(`Agent chat stream error (${streamResponse.status}): ${rawText}`);
    }
    if (!streamResponse.body) {
      throw new Error("Agent chat stream has no body.");
    }

    flushTimer = setInterval(flushDelta, 80);
    let hasCompleted = false;

    for await (const message of readSseStream(streamResponse.body)) {
      const parsed = parseChatEvent(message);
      if (!parsed) continue;
      const { event, data } = parsed;

      if (event === "chat.started") {
        patchRuntimeSession(sessionId, {
          status: "running",
          stage: "chat_streaming",
          progressPercent: toPercent(data.progress_percent, 97),
          statusMessage: `Updating guide (v${versionNumber})`,
        });
        continue;
      }

      if (event === "chat.delta") {
        if (typeof data.delta === "string" && data.delta.length > 0) {
          bufferedDelta += data.delta;
        }
        continue;
      }

      if (event === "chat.completed") {
        flushDelta();
        if (pendingPersist) maybePersistAssistant(true);

        if (typeof data.assistant_message === "string" && data.assistant_message.trim()) {
          assistantContent = data.assistant_message;
        }

        await persistChain;

        // Strip any calendar_proposal tags the model may emit
        const guideMarkdown = assistantContent
          .replace(/<calendar_proposal>[\s\S]*?<\/calendar_proposal>/g, "")
          .trim();

        if (!guideMarkdown) {
          throw new Error("Agent returned empty guide markdown during regeneration.");
        }

        const highestIndex = await getHighestMessageIndex(sessionId).catch(() => 0);

        await insertGuideVersion({
          sessionId,
          versionNumber,
          contentText: guideMarkdown,
          source: "regenerated",
          messageIndexAtCreation: highestIndex,
        });

        await updateChatMessageContent({
          messageId: assistantMessageId,
          content: guideMarkdown,
          metadata: {
            streaming: false,
            completed: true,
            guide_version: versionNumber,
          },
        });

        emitChatMessageCompleted(sessionId, {
          messageId: assistantMessageId,
          content: guideMarkdown,
        });

        patchRuntimeSession(sessionId, {
          status: "completed",
          stage: "completed",
          progressPercent: 100,
          statusMessage: "Guide updated",
          error: undefined,
        });

        hasCompleted = true;
        break;
      }

      if (event === "chat.error") {
        const messageText =
          typeof data.message === "string" && data.message.trim()
            ? data.message
            : "Guide update failed.";
        throw new Error(messageText);
      }
    }

    flushDelta();
    if (!hasCompleted) {
      throw new Error("Agent stream ended before completion during guide update.");
    }
  } catch (err) {
    flushDelta();
    if (pendingPersist) maybePersistAssistant(true);
    await persistChain;

    const errorMessage = toErrorMessage(err);

    const fallbackContent = assistantContent.trim()
      ? `${assistantContent}\n\n_Guide update could not be completed: ${errorMessage}_`
      : `_Guide update failed: ${errorMessage}_`;

    await updateChatMessageContent({
      messageId: assistantMessageId,
      content: fallbackContent,
      metadata: {
        streaming: false,
        failed: true,
        error: errorMessage,
        guide_version: versionNumber,
      },
    }).catch(() => undefined);

    emitChatMessageCompleted(sessionId, {
      messageId: assistantMessageId,
      content: fallbackContent,
    });

    patchRuntimeSession(sessionId, {
      status: "completed",
      stage: "completed",
      progressPercent: 100,
      statusMessage: "Guide update failed",
      error: errorMessage,
    });
  } finally {
    if (flushTimer) {
      clearInterval(flushTimer);
    }
  }
}

export function startGuideRegeneration(input: {
  sessionId: string;
  assistantMessageId: string;
  versionNumber: number;
  requestUrl: string;
}) {
  void runGuideRegeneration(input);
}
