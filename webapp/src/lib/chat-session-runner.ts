import {
  appendRuntimeGuideDelta,
  emitChatError,
  emitChatMessageCompleted,
  emitChatMessageDelta,
  markRuntimeCompleted,
  markRuntimeFailed,
  patchRuntimeSession,
  setRuntimeProgress,
} from "@/lib/chat-runtime-store";
import {
  createHeadstartRun,
  getSessionGuideAndHistory,
  markHeadstartRunFailed,
  markHeadstartRunSucceeded,
  saveRunPdfFiles,
  updateChatMessageContent,
  updateChatSessionStatus,
  upsertHeadstartDocument,
} from "@/lib/chat-repository";
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
  let runId = "";
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

    const run = await createHeadstartRun({
      assignmentUuid,
      triggerSource: "user_click",
      modelName: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
      promptVersion: "guide-v1",
    });
    runId = run.id;

    await saveRunPdfFiles(run.id, payload.pdfAttachments);

    const { pdfAttachments = [], ...payloadWithoutPdfs } = payload;
    const pdfFiles = pdfAttachments
      .filter((item) => typeof item?.base64Data === "string" && item.base64Data.length > 0)
      .map((item) => ({
        filename: item.filename ?? "attachment.pdf",
        base64_data: item.base64Data as string,
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

        await upsertHeadstartDocument(run.id, guideMarkdown);
        await markHeadstartRunSucceeded(run.id);
        await updateChatSessionStatus(sessionId, "completed");

        markRuntimeCompleted(sessionId, guideMarkdown);
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
    if (runId) {
      await markHeadstartRunFailed(runId, message).catch(() => undefined);
    }
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
}) {
  const { sessionId, assistantMessageId, userMessageContent } = input;

  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let bufferedDelta = "";
  let assistantContent = "";
  let persistChain: Promise<void> = Promise.resolve();

  const persistAssistant = (content: string) => {
    persistChain = persistChain
      .then(async () => {
        await updateChatMessageContent({
          messageId: assistantMessageId,
          content,
          metadata: {
            streaming: true,
          },
        });
      })
      .catch(() => undefined);
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
    persistAssistant(assistantContent);
  };

  try {
    patchRuntimeSession(sessionId, {
      status: "running",
      stage: "chat_streaming",
      statusMessage: "Generating follow-up response",
      progressPercent: 97,
      error: undefined,
    });

    const sessionContext = await getSessionGuideAndHistory(sessionId);
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
      .slice(-6);
    const assignmentPayload = sanitizeAssignmentPayloadForFollowup(sessionContext.payload);

    const streamResponse = await openAgentChatStream(
      agentUrl,
      JSON.stringify({
        assignment_payload: assignmentPayload,
        guide_markdown: sessionContext.guideMarkdown,
        chat_history: chatHistory,
        retrieval_context: retrievalContext,
        user_message: userMessageContent,
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

        if (typeof data.assistant_message === "string") {
          const completedText = data.assistant_message;
          if (completedText.trim().length > 0) {
            assistantContent = completedText;
          }
        }

        persistAssistant(assistantContent);
        await persistChain;

        await updateChatMessageContent({
          messageId: assistantMessageId,
          content: assistantContent,
          metadata: {
            streaming: false,
            completed: true,
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
}) {
  void runFollowupChat(input);
}
