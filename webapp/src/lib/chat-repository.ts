import {
  type AssignmentPayload,
  type ChatMessageDto,
  type ChatMessageFormat,
  type ChatMessageRole,
  type ChatSessionStatus,
  type PersistedSessionSnapshot,
} from "@/lib/chat-types";
import {
  canonicalizeJson,
  extractDomainFromUrl,
  sha256Hex,
  supabaseTableRequest,
} from "@/lib/supabase-rest";

type DbLmsIntegration = {
  id: string;
  user_id: string;
};

type DbCourse = {
  id: string;
  integration_id: string;
};

type DbAssignment = {
  id: string;
  course_id: string;
};

type DbAssignmentSnapshot = {
  id: string;
  title?: string | null;
  due_at?: string | null;
  raw_payload: unknown;
};

type DbAssignmentIngest = {
  assignment_uuid: string;
  assignment_snapshot_id: string;
};

type DbChatSession = {
  id: string;
  user_id: string;
  assignment_uuid: string;
  title?: string | null;
  status: ChatSessionStatus;
  created_at: string;
  updated_at: string;
};

type DbChatMessage = {
  id: string;
  session_id: string;
  message_index: number;
  sender_role: ChatMessageRole;
  content_text: string;
  content_format: ChatMessageFormat;
  metadata: unknown;
  created_at: string;
};

type DbHeadstartRun = {
  id: string;
  assignment_uuid: string;
  attempt_no: number;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
};

type DbHeadstartDocument = {
  id: string;
  run_id: string;
  description: string;
};

function nowIso() {
  return new Date().toISOString();
}

function toEpoch(value: string) {
  return new Date(value).getTime();
}

function eq(value: string | number | boolean) {
  return `eq.${value}`;
}

function inList(values: string[]) {
  const normalized = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => `"${value.replaceAll('"', "")}"`);
  return `in.(${normalized.join(",")})`;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function toMessageDto(row: DbChatMessage): ChatMessageDto {
  const metadata = asObject(row.metadata);
  return {
    id: row.id,
    message_index: row.message_index,
    sender_role: row.sender_role,
    content_text: row.content_text,
    content_format: row.content_format,
    metadata,
    created_at: row.created_at,
  };
}

function normalizeSource(value: unknown) {
  if (value === "extension_dom" || value === "sync") return value;
  return "extension_api";
}

function toOptionalString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toTitle(payload: AssignmentPayload) {
  const title = toOptionalString(payload.title);
  return title ?? "(untitled assignment)";
}

function toOptionalNumber(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

export type UserChatSessionListItem = {
  sessionId: string;
  assignmentUuid: string;
  title: string;
  status: ChatSessionStatus;
  createdAt: number;
  updatedAt: number;
  context: {
    assignmentTitle: string;
    courseName: string | null;
    dueAtISO: string | null;
    attachmentCount: number;
  };
};

function toExternalUserId(userId: string, payload: AssignmentPayload) {
  const payloadUserId =
    toOptionalString(payload["externalUserId"]) ??
    toOptionalString(payload["canvasUserId"]) ??
    toOptionalString(payload["userId"]);
  return payloadUserId ?? userId;
}

function normalizePayload(payload: AssignmentPayload): AssignmentPayload {
  return {
    ...payload,
    title: toTitle(payload),
    courseId: payload.courseId != null ? String(payload.courseId) : undefined,
    assignmentId: payload.assignmentId != null ? String(payload.assignmentId) : undefined,
    dueAtISO: toOptionalString(payload.dueAtISO) ?? undefined,
    userTimezone: toOptionalString(payload.userTimezone) ?? undefined,
    descriptionText: toOptionalString(payload.descriptionText) ?? undefined,
    descriptionHtml: toOptionalString(payload.descriptionHtml) ?? undefined,
    submissionType: toOptionalString(payload.submissionType) ?? undefined,
    pointsPossible: toOptionalNumber(payload.pointsPossible) ?? undefined,
    courseName: toOptionalString(payload.courseName) ?? undefined,
    source: normalizeSource(payload.source),
  };
}

async function upsertSingle<T>(input: {
  table: string;
  rows: Record<string, unknown>[];
  onConflict: string;
}) {
  const rows = await supabaseTableRequest<T[]>({
    table: input.table,
    method: "POST",
    query: {
      on_conflict: input.onConflict,
    },
    headers: {
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: input.rows,
  });

  const first = rows[0];
  if (!first) {
    throw new Error(`Supabase upsert on ${input.table} returned no rows.`);
  }
  return first;
}

async function insertSingle<T>(input: {
  table: string;
  row: Record<string, unknown>;
}) {
  const rows = await supabaseTableRequest<T[]>({
    table: input.table,
    method: "POST",
    headers: {
      Prefer: "return=representation",
    },
    body: [input.row],
  });

  const first = rows[0];
  if (!first) {
    throw new Error(`Supabase insert on ${input.table} returned no rows.`);
  }
  return first;
}

async function patchSingle<T>(input: {
  table: string;
  query: Record<string, string>;
  patch: Record<string, unknown>;
}) {
  const rows = await supabaseTableRequest<T[]>({
    table: input.table,
    method: "PATCH",
    query: input.query,
    headers: {
      Prefer: "return=representation",
    },
    body: input.patch,
  });
  const first = rows[0];
  if (!first) {
    throw new Error(`Supabase patch on ${input.table} returned no rows.`);
  }
  return first;
}

async function selectMany<T>(input: {
  table: string;
  query?: Record<string, string | number | boolean>;
}) {
  return supabaseTableRequest<T[]>({
    table: input.table,
    method: "GET",
    query: input.query,
  });
}

async function selectFirst<T>(input: {
  table: string;
  query?: Record<string, string | number | boolean>;
}) {
  const rows = await selectMany<T>(input);
  return rows[0] ?? null;
}

async function ensureLmsIntegration(userId: string, payload: AssignmentPayload) {
  const instanceDomain = extractDomainFromUrl(toOptionalString(payload.url) ?? undefined);
  const externalUserId = toExternalUserId(userId, payload);

  return upsertSingle<DbLmsIntegration>({
    table: "lms_integrations",
    onConflict: "user_id,provider,instance_domain,external_user_id",
    rows: [
      {
        user_id: userId,
        provider: "canvas",
        instance_domain: instanceDomain,
        external_user_id: externalUserId,
        status: "connected",
        updated_at: nowIso(),
      },
    ],
  });
}

async function ensureCourse(integrationId: string, payload: AssignmentPayload) {
  const providerCourseId =
    payload.courseId != null ? String(payload.courseId) : "unknown-course";

  return upsertSingle<DbCourse>({
    table: "courses",
    onConflict: "integration_id,provider_course_id",
    rows: [
      {
        integration_id: integrationId,
        provider_course_id: providerCourseId,
        name: toOptionalString(payload.courseName),
        is_active: true,
        updated_at: nowIso(),
      },
    ],
  });
}

async function ensureAssignment(courseId: string, payload: AssignmentPayload) {
  const providerAssignmentId =
    payload.assignmentId != null ? String(payload.assignmentId) : "unknown-assignment";

  return upsertSingle<DbAssignment>({
    table: "assignments",
    onConflict: "course_id,provider_assignment_id",
    rows: [
      {
        course_id: courseId,
        provider_assignment_id: providerAssignmentId,
        canvas_url: toOptionalString(payload.url),
        updated_at: nowIso(),
      },
    ],
  });
}

async function upsertAssignmentSnapshot(
  assignmentId: string,
  payload: AssignmentPayload,
) {
  const normalizedPayload = normalizePayload(payload);
  const contentHash = await sha256Hex(canonicalizeJson(normalizedPayload));

  return upsertSingle<DbAssignmentSnapshot>({
    table: "assignment_snapshots",
    onConflict: "assignment_id,content_hash",
    rows: [
      {
        assignment_id: assignmentId,
        source: normalizeSource(payload.source),
        title: toTitle(payload),
        description_text: toOptionalString(payload.descriptionText),
        description_html: toOptionalString(payload.descriptionHtml),
        due_at: toOptionalString(payload.dueAtISO),
        points_possible: toOptionalNumber(payload.pointsPossible),
        submission_type: toOptionalString(payload.submissionType),
        rubric_json: payload.rubric ?? null,
        user_timezone: toOptionalString(payload.userTimezone),
        raw_payload: normalizedPayload,
        content_hash: contentHash,
      },
    ],
  });
}

export async function createPersistedChatSession(input: {
  userId: string;
  payload: AssignmentPayload;
  requestId?: string;
}) {
  const payload = normalizePayload(input.payload);

  const integration = await ensureLmsIntegration(input.userId, payload);
  const course = await ensureCourse(integration.id, payload);
  const assignment = await ensureAssignment(course.id, payload);
  const snapshot = await upsertAssignmentSnapshot(assignment.id, payload);

  const assignmentUuid = crypto.randomUUID();

  await insertSingle<DbAssignmentIngest>({
    table: "assignment_ingests",
    row: {
      assignment_uuid: assignmentUuid,
      assignment_snapshot_id: snapshot.id,
      request_id: input.requestId ?? null,
    },
  });

  const session = await insertSingle<DbChatSession>({
    table: "chat_sessions",
    row: {
      user_id: input.userId,
      assignment_uuid: assignmentUuid,
      title: toTitle(payload),
      status: "queued",
      updated_at: nowIso(),
    },
  });

  return {
    sessionId: session.id,
    assignmentUuid,
    userId: session.user_id,
    createdAt: toEpoch(session.created_at),
    updatedAt: toEpoch(session.updated_at),
    payload,
  };
}

export async function getPersistedSessionSnapshot(
  sessionId: string,
): Promise<PersistedSessionSnapshot | null> {
  const session = await selectFirst<DbChatSession>({
    table: "chat_sessions",
    query: {
      id: eq(sessionId),
      select: "id,user_id,assignment_uuid,status,created_at,updated_at",
      limit: 1,
    },
  });

  if (!session) {
    return null;
  }

  const ingest = await selectFirst<DbAssignmentIngest>({
    table: "assignment_ingests",
    query: {
      assignment_uuid: eq(session.assignment_uuid),
      select: "assignment_uuid,assignment_snapshot_id",
      limit: 1,
    },
  });

  if (!ingest) {
    throw new Error(`assignment_ingests missing for assignment_uuid=${session.assignment_uuid}`);
  }

  const snapshot = await selectFirst<DbAssignmentSnapshot>({
    table: "assignment_snapshots",
    query: {
      id: eq(ingest.assignment_snapshot_id),
      select: "id,raw_payload",
      limit: 1,
    },
  });

  if (!snapshot) {
    throw new Error(`assignment_snapshots missing for id=${ingest.assignment_snapshot_id}`);
  }

  const messages = await selectMany<DbChatMessage>({
    table: "chat_messages",
    query: {
      session_id: eq(session.id),
      select:
        "id,session_id,message_index,sender_role,content_text,content_format,metadata,created_at",
      order: "message_index.asc",
    },
  });

  const latestRun = await selectFirst<DbHeadstartRun>({
    table: "headstart_runs",
    query: {
      assignment_uuid: eq(session.assignment_uuid),
      select: "id,assignment_uuid,attempt_no,status",
      order: "attempt_no.desc",
      limit: 1,
    },
  });

  let guideMarkdown = "";
  if (latestRun?.status === "succeeded") {
    const doc = await selectFirst<DbHeadstartDocument>({
      table: "headstart_documents",
      query: {
        run_id: eq(latestRun.id),
        select: "id,run_id,description",
        limit: 1,
      },
    });
    guideMarkdown = doc?.description ?? "";
  }

  const payload = asObject(snapshot.raw_payload) as AssignmentPayload;

  return {
    sessionId: session.id,
    assignmentUuid: session.assignment_uuid,
    userId: session.user_id,
    createdAt: toEpoch(session.created_at),
    updatedAt: toEpoch(session.updated_at),
    status: session.status,
    payload,
    messages: messages.map((row) => toMessageDto(row)),
    guideMarkdown,
  };
}

export async function getSessionRow(sessionId: string) {
  return selectFirst<DbChatSession>({
    table: "chat_sessions",
    query: {
      id: eq(sessionId),
      select: "id,user_id,assignment_uuid,status,created_at,updated_at",
      limit: 1,
    },
  });
}

export async function assertSessionOwnership(sessionId: string, userId: string) {
  const session = await getSessionRow(sessionId);
  if (!session) return null;
  if (session.user_id !== userId) return null;
  return session;
}

export async function listPersistedChatSessionsForUser(
  userId: string,
  limit = 40,
): Promise<UserChatSessionListItem[]> {
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const sessions = await selectMany<DbChatSession>({
    table: "chat_sessions",
    query: {
      user_id: eq(userId),
      select: "id,user_id,assignment_uuid,title,status,created_at,updated_at",
      order: "updated_at.desc",
      limit: boundedLimit,
    },
  });

  if (sessions.length === 0) {
    return [];
  }

  const assignmentUuids = Array.from(
    new Set(sessions.map((session) => session.assignment_uuid)),
  );
  const ingests =
    assignmentUuids.length > 0
      ? await selectMany<DbAssignmentIngest>({
          table: "assignment_ingests",
          query: {
            assignment_uuid: inList(assignmentUuids),
            select: "assignment_uuid,assignment_snapshot_id",
          },
        })
      : [];

  const ingestByAssignmentUuid = new Map(
    ingests.map((ingest) => [ingest.assignment_uuid, ingest]),
  );
  const snapshotIds = Array.from(
    new Set(ingests.map((ingest) => ingest.assignment_snapshot_id)),
  );
  const snapshots =
    snapshotIds.length > 0
      ? await selectMany<DbAssignmentSnapshot>({
          table: "assignment_snapshots",
          query: {
            id: inList(snapshotIds),
            select: "id,title,due_at,raw_payload",
          },
        })
      : [];
  const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));

  return sessions.map((session) => {
    const ingest = ingestByAssignmentUuid.get(session.assignment_uuid);
    const snapshot = ingest
      ? snapshotById.get(ingest.assignment_snapshot_id)
      : undefined;
    const payload = asObject(snapshot?.raw_payload);
    const attachmentCount = Array.isArray(payload.pdfAttachments)
      ? payload.pdfAttachments.length
      : 0;
    const assignmentTitle =
      toOptionalString(snapshot?.title) ??
      toOptionalString(payload.title) ??
      toOptionalString(session.title) ??
      "(untitled assignment)";

    return {
      sessionId: session.id,
      assignmentUuid: session.assignment_uuid,
      title: toOptionalString(session.title) ?? assignmentTitle,
      status: session.status,
      createdAt: toEpoch(session.created_at),
      updatedAt: toEpoch(session.updated_at),
      context: {
        assignmentTitle,
        courseName: toOptionalString(payload.courseName),
        dueAtISO:
          toOptionalString(payload.dueAtISO) ??
          toOptionalString(snapshot?.due_at),
        attachmentCount,
      },
    };
  });
}

export async function updateChatSessionStatus(
  sessionId: string,
  status: ChatSessionStatus,
) {
  return patchSingle<DbChatSession>({
    table: "chat_sessions",
    query: {
      id: eq(sessionId),
    },
    patch: {
      status,
      updated_at: nowIso(),
    },
  });
}

export async function createHeadstartRun(input: {
  assignmentUuid: string;
  triggerSource: "user_click" | "retry" | "api";
  modelName?: string;
  promptVersion?: string;
}) {
  const latest = await selectFirst<DbHeadstartRun>({
    table: "headstart_runs",
    query: {
      assignment_uuid: eq(input.assignmentUuid),
      select: "id,assignment_uuid,attempt_no,status",
      order: "attempt_no.desc",
      limit: 1,
    },
  });
  const attemptNo = (latest?.attempt_no ?? 0) + 1;

  return insertSingle<DbHeadstartRun>({
    table: "headstart_runs",
    row: {
      assignment_uuid: input.assignmentUuid,
      attempt_no: attemptNo,
      trigger_source: input.triggerSource,
      status: "running",
      model_name: input.modelName ?? null,
      prompt_version: input.promptVersion ?? null,
      started_at: nowIso(),
    },
  });
}

export async function markHeadstartRunSucceeded(runId: string) {
  return patchSingle<DbHeadstartRun>({
    table: "headstart_runs",
    query: {
      id: eq(runId),
    },
    patch: {
      status: "succeeded",
      finished_at: nowIso(),
    },
  });
}

export async function markHeadstartRunFailed(
  runId: string,
  errorMessage: string,
  errorCode?: string,
) {
  return patchSingle<DbHeadstartRun>({
    table: "headstart_runs",
    query: {
      id: eq(runId),
    },
    patch: {
      status: "failed",
      error_message: errorMessage,
      error_code: errorCode ?? "RUN_FAILED",
      finished_at: nowIso(),
    },
  });
}

export async function upsertHeadstartDocument(runId: string, guideMarkdown: string) {
  return upsertSingle<DbHeadstartDocument>({
    table: "headstart_documents",
    onConflict: "run_id",
    rows: [
      {
        run_id: runId,
        description: guideMarkdown,
        updated_at: nowIso(),
      },
    ],
  });
}

export async function saveRunPdfFiles(
  runId: string,
  attachments: AssignmentPayload["pdfAttachments"] | undefined,
) {
  if (!attachments || attachments.length === 0) {
    return;
  }

  const rows = await Promise.all(
    attachments
      .filter((item) => typeof item?.base64Data === "string" && item.base64Data.length > 0)
      .map(async (item, index) => {
        const base64Data = item?.base64Data as string;
        const sha = await sha256Hex(base64Data);
        return {
          run_id: runId,
          filename: toOptionalString(item?.filename) ?? `attachment-${index + 1}.pdf`,
          file_sha256: sha,
          extraction_mode: "none",
          page_count: null,
        };
      }),
  );

  if (rows.length === 0) {
    return;
  }

  await supabaseTableRequest<unknown[]>({
    table: "run_pdf_files",
    method: "POST",
    query: {
      on_conflict: "run_id,filename,file_sha256",
    },
    headers: {
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: rows,
  });
}

async function getNextMessageIndex(sessionId: string) {
  const latest = await selectFirst<DbChatMessage>({
    table: "chat_messages",
    query: {
      session_id: eq(sessionId),
      select: "id,session_id,message_index,sender_role,content_text,content_format,metadata,created_at",
      order: "message_index.desc",
      limit: 1,
    },
  });
  return (latest?.message_index ?? 0) + 1;
}

export async function createChatMessage(input: {
  sessionId: string;
  role: ChatMessageRole;
  content: string;
  format?: ChatMessageFormat;
  metadata?: Record<string, unknown>;
}) {
  const nextMessageIndex = await getNextMessageIndex(input.sessionId);

  const row = await insertSingle<DbChatMessage>({
    table: "chat_messages",
    row: {
      session_id: input.sessionId,
      message_index: nextMessageIndex,
      sender_role: input.role,
      content_text: input.content,
      content_format: input.format ?? "markdown",
      metadata: input.metadata ?? {},
    },
  });

  return toMessageDto(row);
}

export async function updateChatMessageContent(input: {
  messageId: string;
  content: string;
  metadata?: Record<string, unknown>;
}) {
  const patch: Record<string, unknown> = {
    content_text: input.content,
  };
  if (input.metadata) {
    patch.metadata = input.metadata;
  }

  const row = await patchSingle<DbChatMessage>({
    table: "chat_messages",
    query: {
      id: eq(input.messageId),
    },
    patch,
  });

  return toMessageDto(row);
}

export async function getSessionGuideAndHistory(sessionId: string) {
  const snapshot = await getPersistedSessionSnapshot(sessionId);
  if (!snapshot) {
    return null;
  }

  return {
    payload: snapshot.payload,
    guideMarkdown: snapshot.guideMarkdown,
    messages: snapshot.messages,
    userId: snapshot.userId,
    assignmentUuid: snapshot.assignmentUuid,
  };
}
