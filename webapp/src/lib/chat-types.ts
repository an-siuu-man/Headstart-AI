export type PdfAttachment = {
  filename?: string;
  base64Data?: string;
  fileSha256?: string;
  byteSize?: number;
  storagePath?: string;
};

export type PdfTextStyle = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
};

export type PdfTextBlock = {
  block_id: string;
  text: string;
  role?: string;
  page_number?: number;
  source?: "docling" | "native" | "reconciled";
  reading_order?: number;
  confidence?: number;
  bbox?: number[] | null;
  formatting?: PdfTextStyle | null;
};

export type PdfVisualSignal = {
  file: string;
  page: number;
  text: string;
  signal_types: string[];
  score: number;
  significance: "high" | "medium" | "low";
  source: string;
};

export type PdfPageExtraction = {
  page_number: number;
  text: string;
  method: string;
  blocks: PdfTextBlock[];
  confidence: number;
};

export type PdfExtractionQuality = {
  strategy: string;
  docling_available: boolean;
  native_chars: number;
  docling_chars: number;
  reconciled_chars: number;
  notes: string[];
};

export type PdfExtraction = {
  filename: string;
  source: "assignment" | "user_upload";
  file_sha256?: string | null;
  full_text: string;
  pages: PdfPageExtraction[];
  visual_signals: PdfVisualSignal[];
  quality?: PdfExtractionQuality | null;
};

export type AssignmentPayload = Record<string, unknown> & {
  title?: string;
  courseName?: string;
  courseId?: string | number;
  assignmentId?: string | number;
  dueAtISO?: string;
  pointsPossible?: number;
  submissionType?: string;
  descriptionText?: string;
  descriptionHtml?: string;
  userTimezone?: string;
  rubric?: {
    criteria?: unknown[];
  };
  pdfAttachments?: PdfAttachment[];
  url?: string;
  source?: string;
};

export type ChatSessionStatus = "queued" | "running" | "completed" | "failed" | "archived";
export type ChatSessionStage =
  | "queued"
  | "preparing_payload"
  | "extracting_pdf"
  | "calling_agent"
  | "streaming_output"
  | "validating_output"
  | "parsing_response"
  | "chat_streaming"
  | "completed"
  | "failed";

export type ChatMessageRole = "user" | "assistant" | "system";
export type ChatMessageFormat = "plain_text" | "markdown" | "json";

export type ChatMessageDto = {
  id: string;
  message_index: number;
  sender_role: ChatMessageRole;
  content_text: string;
  content_format: ChatMessageFormat;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type ChatSessionDto = {
  ok: true;
  session_id: string;
  assignment_uuid: string;
  user_id: string;
  created_at: number;
  updated_at: number;
  status: ChatSessionStatus;
  stage: ChatSessionStage;
  progress_percent: number;
  status_message: string;
  streamed_guide_markdown: string;
  result: unknown | null;
  error: string | null;
  payload: AssignmentPayload;
  messages: ChatMessageDto[];
};

export type GuideVersionMeta = {
  version_number: number;
  source: string;
  content_length: number;
  created_at: string;
};

export type PersistedSessionSnapshot = {
  sessionId: string;
  userId: string;
  assignmentUuid: string;
  assignmentRecordId?: string | null;
  createdAt: number;
  updatedAt: number;
  status: ChatSessionStatus;
  payload: AssignmentPayload;
  messages: ChatMessageDto[];
  guideMarkdown: string;
};

export type RuntimeSessionState = {
  sessionId: string;
  status: ChatSessionStatus;
  stage: ChatSessionStage;
  progressPercent: number;
  statusMessage: string;
  streamedGuideMarkdown: string;
  result?: unknown;
  error?: string;
  updatedAt: number;
};

export function buildSessionDto(
  snapshot: PersistedSessionSnapshot,
  runtime: RuntimeSessionState | null,
): ChatSessionDto {
  const status = runtime?.status ?? snapshot.status;
  const stage = runtime?.stage ?? (status === "completed" ? "completed" : "queued");
  const streamedGuideMarkdown =
    runtime?.streamedGuideMarkdown || snapshot.guideMarkdown || "";

  let progress = runtime?.progressPercent;
  if (progress == null) {
    if (status === "completed" || status === "failed") progress = 100;
    else if (status === "running") progress = 40;
    else progress = 5;
  }

  const statusMessage =
    runtime?.statusMessage ??
    (status === "completed"
      ? "Guide ready"
      : status === "failed"
      ? "Guide generation failed"
      : status === "running"
      ? "Processing"
      : "Queued");

  const updatedAt = Math.max(snapshot.updatedAt, runtime?.updatedAt ?? 0);
  const result = runtime?.result ?? (streamedGuideMarkdown ? { guideMarkdown: streamedGuideMarkdown } : null);
  const error = runtime?.error ?? null;

  return {
    ok: true,
    session_id: snapshot.sessionId,
    assignment_uuid: snapshot.assignmentUuid,
    user_id: snapshot.userId,
    created_at: snapshot.createdAt,
    updated_at: updatedAt,
    status,
    stage,
    progress_percent: Math.max(0, Math.min(100, Math.round(progress))),
    status_message: statusMessage,
    streamed_guide_markdown: streamedGuideMarkdown,
    result,
    error,
    payload: snapshot.payload,
    messages: snapshot.messages,
  };
}
