import { Buffer } from "node:buffer";

import {
  type AssignmentPayload,
  type ChatMessageDto,
  type ChatMessageFormat,
  type ChatMessageRole,
  type ChatSessionStatus,
  type PdfAttachment,
  type PersistedSessionSnapshot,
} from "@/lib/chat-types";
import {
  canonicalizeJson,
  extractDomainFromUrl,
  supabaseStorageCreateSignedUrl,
  supabaseStorageDeleteObject,
  supabaseStorageUploadObject,
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
  assignment_id?: string | null;
  title?: string | null;
  due_at?: string | null;
  raw_payload: unknown;
};

type DbAssignmentIngest = {
  assignment_uuid: string;
  assignment_snapshot_id: string;
};

type DbAssignmentSnapshotFile = {
  assignment_snapshot_id: string;
  filename: string;
  file_sha256: string;
  storage_path: string;
  byte_size?: number | null;
};

type DbStoredPdfBlob = {
  file_sha256: string;
  storage_path?: string;
  byte_size?: number | null;
  uploaded_at?: string | null;
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

type DbChatMessageListPreview = {
  session_id: string;
  message_index: number;
  content_text: string;
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

type DbAssignmentUserState = {
  assignment_id: string;
  user_id: string;
  is_submitted: boolean;
  submitted_at?: string | null;
  updated_at?: string;
};

type SnapshotAttachmentPayload = {
  filename: string;
  fileSha256?: string;
  storagePath?: string;
  byteSize?: number;
};

type PreparedSnapshotFile = {
  filename: string;
  fileSha256: string;
  storagePath: string;
  byteSize: number;
  bytes?: Uint8Array;
};

export type SignedSnapshotPdfFile = {
  filename: string;
  fileSha256: string;
  storagePath: string;
  byteSize: number | null;
  signedUrl: string;
};

export type RunPdfFileInput = {
  filename: string;
  fileSha256: string;
  storageUri?: string | null;
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

function isNull() {
  return "is.null";
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

function toOptionalPositiveInteger(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.floor(value);
  return rounded >= 0 ? rounded : null;
}

function toUint8ArrayBase64(base64Data: string) {
  const trimmed = base64Data.trim();
  const payload =
    trimmed.startsWith("data:") && trimmed.includes(",")
      ? trimmed.split(",", 2)[1]
      : trimmed;
  return new Uint8Array(Buffer.from(payload, "base64"));
}

function bufferToHex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256HexFromBytes(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return bufferToHex(digest);
}

async function sha256HexFromString(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bufferToHex(digest);
}

const SNAPSHOT_PDF_BUCKET =
  toOptionalString(process.env.SUPABASE_ASSIGNMENT_PDF_BUCKET) ?? "assignment-pdfs";
const SNAPSHOT_PDF_SIGNED_URL_TTL_SECONDS = (() => {
  const raw = Number(process.env.SUPABASE_ASSIGNMENT_PDF_SIGNED_URL_TTL_SECONDS ?? "600");
  if (!Number.isFinite(raw)) return 600;
  return Math.max(60, Math.floor(raw));
})();

function buildSnapshotStoragePath(fileSha256: string) {
  const prefix = fileSha256.slice(0, 2);
  return `snapshots/${prefix}/${fileSha256}.pdf`;
}

function toSnapshotAttachmentPayload(
  entry: Record<string, unknown>,
  fallbackFilename: string,
): SnapshotAttachmentPayload {
  const filename = toOptionalString(entry.filename) ?? fallbackFilename;
  const fileSha256 =
    toOptionalString(entry.fileSha256) ?? toOptionalString(entry.file_sha256) ?? undefined;
  const storagePath =
    toOptionalString(entry.storagePath) ?? toOptionalString(entry.storage_path) ?? undefined;
  const byteSize = toOptionalPositiveInteger(entry.byteSize ?? entry.byte_size) ?? undefined;

  return {
    filename,
    fileSha256,
    storagePath,
    byteSize,
  };
}

async function prepareSnapshotAttachments(
  attachments: PdfAttachment[] | undefined,
): Promise<{
  payloadAttachments: SnapshotAttachmentPayload[];
  snapshotFiles: PreparedSnapshotFile[];
}> {
  const list = Array.isArray(attachments) ? attachments : [];
  const payloadAttachments: SnapshotAttachmentPayload[] = [];
  const snapshotFiles: PreparedSnapshotFile[] = [];

  for (let index = 0; index < list.length; index += 1) {
    const item = list[index] as Record<string, unknown>;
    const fallbackFilename = `attachment-${index + 1}.pdf`;
    const filename = toOptionalString(item.filename) ?? fallbackFilename;
    const base64Data = toOptionalString(item.base64Data);

    if (!base64Data) {
      const metadataOnly = toSnapshotAttachmentPayload(item, fallbackFilename);
      payloadAttachments.push(metadataOnly);
      if (metadataOnly.fileSha256 && metadataOnly.storagePath) {
        snapshotFiles.push({
          filename: metadataOnly.filename,
          fileSha256: metadataOnly.fileSha256,
          storagePath: metadataOnly.storagePath,
          byteSize: metadataOnly.byteSize ?? 0,
        });
      }
      continue;
    }

    let bytes: Uint8Array;
    try {
      bytes = toUint8ArrayBase64(base64Data);
    } catch {
      payloadAttachments.push({
        filename,
      });
      continue;
    }
    const fileSha256 = await sha256HexFromBytes(bytes);
    const storagePath = buildSnapshotStoragePath(fileSha256);
    const byteSize = bytes.byteLength;

    payloadAttachments.push({
      filename,
      fileSha256,
      storagePath,
      byteSize,
    });
    snapshotFiles.push({
      filename,
      fileSha256,
      storagePath,
      byteSize,
      bytes,
    });
  }

  return {
    payloadAttachments,
    snapshotFiles,
  };
}

function withAttachmentMetadataPayload(
  payload: AssignmentPayload,
  attachments: SnapshotAttachmentPayload[],
): AssignmentPayload {
  return {
    ...payload,
    pdfAttachments: attachments.map((item) => ({
      filename: item.filename,
      fileSha256: item.fileSha256,
      storagePath: item.storagePath,
      byteSize: item.byteSize,
    })),
  };
}

function sanitizePayloadForResponse(payload: AssignmentPayload): AssignmentPayload {
  const rawAttachments = Array.isArray(payload.pdfAttachments)
    ? payload.pdfAttachments
    : [];

  const sanitized = rawAttachments.map((item, index) =>
    toSnapshotAttachmentPayload(item as Record<string, unknown>, `attachment-${index + 1}.pdf`),
  );

  return withAttachmentMetadataPayload(payload, sanitized);
}

export type UserChatSessionListItem = {
  sessionId: string;
  assignmentUuid: string;
  title: string;
  lastUserMessage: string | null;
  status: ChatSessionStatus;
  createdAt: number;
  updatedAt: number;
  context: {
    assignmentRecordId: string | null;
    assignmentTitle: string;
    courseName: string | null;
    courseId: string | null;
    assignmentId: string | null;
    assignmentUrl: string | null;
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

async function deleteMany(input: {
  table: string;
  query: Record<string, string | number | boolean>;
}) {
  await supabaseTableRequest<null>({
    table: input.table,
    method: "DELETE",
    query: input.query,
    headers: {
      Prefer: "return=minimal",
    },
  });
}

async function getAssignmentIngestByAssignmentUuid(assignmentUuid: string) {
  return selectFirst<DbAssignmentIngest>({
    table: "assignment_ingests",
    query: {
      assignment_uuid: eq(assignmentUuid),
      select: "assignment_uuid,assignment_snapshot_id",
      limit: 1,
    },
  });
}

async function persistSnapshotFiles(
  assignmentSnapshotId: string,
  snapshotFiles: PreparedSnapshotFile[],
) {
  const normalized = snapshotFiles.filter(
    (item) =>
      item.fileSha256.trim().length > 0 &&
      item.storagePath.trim().length > 0 &&
      item.filename.trim().length > 0,
  );

  if (normalized.length === 0) {
    return;
  }

  const uniqueByHash = new Map<string, PreparedSnapshotFile>();
  for (const file of normalized) {
    if (!uniqueByHash.has(file.fileSha256)) {
      uniqueByHash.set(file.fileSha256, file);
    }
  }
  const uniqueFiles = Array.from(uniqueByHash.values());
  const hashes = uniqueFiles.map((file) => file.fileSha256);

  const existingBlobs =
    hashes.length > 0
      ? await selectMany<DbStoredPdfBlob>({
          table: "stored_pdf_blobs",
          query: {
            file_sha256: inList(hashes),
            select: "file_sha256,storage_path,byte_size,uploaded_at",
          },
        })
      : [];
  const existingByHash = new Map(
    existingBlobs.map((blob) => [blob.file_sha256, blob]),
  );

  const rowsToInsert = uniqueFiles
    .filter((file) => !existingByHash.has(file.fileSha256))
    .map((file) => ({
      file_sha256: file.fileSha256,
      storage_path: file.storagePath,
      byte_size: file.byteSize,
      uploaded_at: null,
    }));

  if (rowsToInsert.length > 0) {
    await supabaseTableRequest<unknown[]>({
      table: "stored_pdf_blobs",
      method: "POST",
      query: {
        on_conflict: "file_sha256",
      },
      headers: {
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: rowsToInsert,
    });
  }

  const refreshedBlobs =
    hashes.length > 0
      ? await selectMany<DbStoredPdfBlob>({
          table: "stored_pdf_blobs",
          query: {
            file_sha256: inList(hashes),
            select: "file_sha256,uploaded_at",
          },
        })
      : [];
  const uploadedHashes = new Set(
    refreshedBlobs
      .filter((blob) => typeof blob.uploaded_at === "string" && blob.uploaded_at.trim().length > 0)
      .map((blob) => blob.file_sha256),
  );

  const filesToUpload = uniqueFiles.filter(
    (file) => !uploadedHashes.has(file.fileSha256),
  );
  const missingBytes = filesToUpload.filter((file) => !file.bytes);
  if (missingBytes.length > 0) {
    throw new Error(
      `Missing binary payload for ${missingBytes.length} file hash(es) that are not uploaded yet.`,
    );
  }

  await Promise.all(
    filesToUpload.map((file) =>
      supabaseStorageUploadObject({
        bucket: SNAPSHOT_PDF_BUCKET,
        path: file.storagePath,
        data: file.bytes as Uint8Array,
        contentType: "application/pdf",
        upsert: true,
      }),
    ),
  );

  if (filesToUpload.length > 0) {
    const uploadedAt = nowIso();
    await Promise.all(
      filesToUpload.map((file) =>
        supabaseTableRequest<unknown[]>({
          table: "stored_pdf_blobs",
          method: "PATCH",
          query: {
            file_sha256: eq(file.fileSha256),
            uploaded_at: isNull(),
          },
          headers: {
            Prefer: "return=minimal",
          },
          body: {
            uploaded_at: uploadedAt,
          },
        }),
      ),
    );
  }

  const rows = normalized.map((file) => ({
    assignment_snapshot_id: assignmentSnapshotId,
    filename: file.filename,
    file_sha256: file.fileSha256,
    storage_path: file.storagePath,
    byte_size: file.byteSize,
  }));

  await supabaseTableRequest<unknown[]>({
    table: "assignment_snapshot_files",
    method: "POST",
    query: {
      on_conflict: "assignment_snapshot_id,file_sha256,filename",
    },
    headers: {
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: rows,
  });
}

async function getSnapshotPdfFilesByAssignmentUuid(
  assignmentUuid: string,
): Promise<DbAssignmentSnapshotFile[]> {
  const ingest = await getAssignmentIngestByAssignmentUuid(assignmentUuid);
  if (!ingest) return [];

  return selectMany<DbAssignmentSnapshotFile>({
    table: "assignment_snapshot_files",
    query: {
      assignment_snapshot_id: eq(ingest.assignment_snapshot_id),
      select: "assignment_snapshot_id,filename,file_sha256,storage_path,byte_size",
      order: "created_at.asc",
    },
  });
}

export async function listSignedSnapshotPdfFiles(
  assignmentUuid: string,
): Promise<SignedSnapshotPdfFile[]> {
  const snapshotFiles = await getSnapshotPdfFilesByAssignmentUuid(assignmentUuid);
  if (snapshotFiles.length === 0) {
    return [];
  }

  return Promise.all(
    snapshotFiles.map(async (file) => ({
      filename: file.filename,
      fileSha256: file.file_sha256,
      storagePath: file.storage_path,
      byteSize: file.byte_size ?? null,
      signedUrl: await supabaseStorageCreateSignedUrl({
        bucket: SNAPSHOT_PDF_BUCKET,
        path: file.storage_path,
        expiresInSeconds: SNAPSHOT_PDF_SIGNED_URL_TTL_SECONDS,
      }),
    })),
  );
}

async function deleteStoredBlobIfUnreferenced(input: {
  fileSha256: string;
  storagePathHint?: string;
}) {
  const stillReferencedInSnapshots = await selectFirst<{ file_sha256: string }>({
    table: "assignment_snapshot_files",
    query: {
      file_sha256: eq(input.fileSha256),
      select: "file_sha256",
      limit: 1,
    },
  });
  if (stillReferencedInSnapshots) {
    return false;
  }

  const stillReferencedInRuns = await selectFirst<{ file_sha256: string }>({
    table: "run_pdf_files",
    query: {
      file_sha256: eq(input.fileSha256),
      select: "file_sha256",
      limit: 1,
    },
  });
  if (stillReferencedInRuns) {
    return false;
  }

  const blob = await selectFirst<DbStoredPdfBlob>({
    table: "stored_pdf_blobs",
    query: {
      file_sha256: eq(input.fileSha256),
      select: "file_sha256,storage_path,byte_size,uploaded_at",
      limit: 1,
    },
  });

  const storagePath =
    toOptionalString(input.storagePathHint) ??
    toOptionalString(blob?.storage_path) ??
    null;

  if (storagePath) {
    await supabaseStorageDeleteObject({
      bucket: SNAPSHOT_PDF_BUCKET,
      path: storagePath,
    });
  }

  await deleteMany({
    table: "stored_pdf_blobs",
    query: {
      file_sha256: eq(input.fileSha256),
    },
  });

  return true;
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
  snapshotPayload: AssignmentPayload,
) {
  const contentHash = await sha256HexFromString(canonicalizeJson(snapshotPayload));

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
        raw_payload: snapshotPayload,
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
  const normalizedPayload = normalizePayload(input.payload);
  const preparedAttachments = await prepareSnapshotAttachments(normalizedPayload.pdfAttachments);
  const snapshotPayload = withAttachmentMetadataPayload(
    normalizedPayload,
    preparedAttachments.payloadAttachments,
  );

  const integration = await ensureLmsIntegration(input.userId, normalizedPayload);
  const course = await ensureCourse(integration.id, normalizedPayload);
  const assignment = await ensureAssignment(course.id, normalizedPayload);
  const snapshot = await upsertAssignmentSnapshot(
    assignment.id,
    normalizedPayload,
    snapshotPayload,
  );
  await persistSnapshotFiles(snapshot.id, preparedAttachments.snapshotFiles);

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
      title: toTitle(normalizedPayload),
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
    payload: snapshotPayload,
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

  const ingest = await getAssignmentIngestByAssignmentUuid(session.assignment_uuid);

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

  const payload = sanitizePayloadForResponse(
    asObject(snapshot.raw_payload) as AssignmentPayload,
  );

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

export async function deletePersistedChatSessionForUser(input: {
  sessionId: string;
  userId: string;
}) {
  const session = await assertSessionOwnership(input.sessionId, input.userId);
  if (!session) {
    return null;
  }

  const ingest = await getAssignmentIngestByAssignmentUuid(session.assignment_uuid);
  const snapshotId = ingest?.assignment_snapshot_id ?? null;

  const snapshotFiles =
    snapshotId != null
      ? await selectMany<DbAssignmentSnapshotFile>({
          table: "assignment_snapshot_files",
          query: {
            assignment_snapshot_id: eq(snapshotId),
            select: "assignment_snapshot_id,filename,file_sha256,storage_path,byte_size",
          },
        })
      : [];

  await deleteMany({
    table: "chat_sessions",
    query: {
      id: eq(session.id),
    },
  });

  let ingestDeleted = false;
  let snapshotDeleted = false;
  let attachmentRecordsDeleted = 0;
  let blobsDeleted = 0;

  const remainingSessionsForAssignmentUuid = await selectFirst<{ id: string }>({
    table: "chat_sessions",
    query: {
      assignment_uuid: eq(session.assignment_uuid),
      select: "id",
      limit: 1,
    },
  });

  if (!remainingSessionsForAssignmentUuid && ingest) {
    await deleteMany({
      table: "assignment_ingests",
      query: {
        assignment_uuid: eq(session.assignment_uuid),
      },
    });
    ingestDeleted = true;
  }

  if (snapshotId) {
    const remainingIngestsForSnapshot = await selectFirst<{ assignment_uuid: string }>({
      table: "assignment_ingests",
      query: {
        assignment_snapshot_id: eq(snapshotId),
        select: "assignment_uuid",
        limit: 1,
      },
    });

    if (!remainingIngestsForSnapshot) {
      if (snapshotFiles.length > 0) {
        await deleteMany({
          table: "assignment_snapshot_files",
          query: {
            assignment_snapshot_id: eq(snapshotId),
          },
        });
        attachmentRecordsDeleted = snapshotFiles.length;
      }

      await deleteMany({
        table: "assignment_snapshots",
        query: {
          id: eq(snapshotId),
        },
      });
      snapshotDeleted = true;

      const uniqueFileRefsByHash = new Map<string, string | undefined>();
      for (const file of snapshotFiles) {
        const fileSha256 = toOptionalString(file.file_sha256);
        if (!fileSha256 || uniqueFileRefsByHash.has(fileSha256)) {
          continue;
        }
        uniqueFileRefsByHash.set(
          fileSha256,
          toOptionalString(file.storage_path) ?? undefined,
        );
      }

      for (const [fileSha256, storagePathHint] of uniqueFileRefsByHash.entries()) {
        const deleted = await deleteStoredBlobIfUnreferenced({
          fileSha256,
          storagePathHint,
        });
        if (deleted) {
          blobsDeleted += 1;
        }
      }
    }
  }

  return {
    sessionId: session.id,
    assignmentUuid: session.assignment_uuid,
    ingestDeleted,
    snapshotDeleted,
    attachmentRecordsDeleted,
    blobsDeleted,
  };
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

  const sessionIds = sessions.map((session) => session.id);
  const userMessages =
    sessionIds.length > 0
      ? await selectMany<DbChatMessageListPreview>({
          table: "chat_messages",
          query: {
            session_id: inList(sessionIds),
            sender_role: eq("user"),
            select: "session_id,message_index,content_text",
            order: "session_id.asc,message_index.desc",
          },
        })
      : [];
  const lastUserMessageBySessionId = new Map<string, string | null>();
  for (const message of userMessages) {
    if (lastUserMessageBySessionId.has(message.session_id)) {
      continue;
    }
    lastUserMessageBySessionId.set(
      message.session_id,
      toOptionalString(message.content_text),
    );
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
            select: "id,assignment_id,title,due_at,raw_payload",
          },
        })
      : [];
  const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));

  return sessions.map((session) => {
    const ingest = ingestByAssignmentUuid.get(session.assignment_uuid);
    const snapshot = ingest
      ? snapshotById.get(ingest.assignment_snapshot_id)
      : undefined;
    const payload = sanitizePayloadForResponse(
      asObject(snapshot?.raw_payload) as AssignmentPayload,
    );
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
      lastUserMessage: lastUserMessageBySessionId.get(session.id) ?? null,
      status: session.status,
      createdAt: toEpoch(session.created_at),
      updatedAt: toEpoch(session.updated_at),
      context: {
        assignmentRecordId: toOptionalString(snapshot?.assignment_id),
        assignmentTitle,
        courseName: toOptionalString(payload.courseName),
        courseId: toOptionalString(payload.courseId),
        assignmentId: toOptionalString(payload.assignmentId),
        assignmentUrl: toOptionalString(payload.url),
        dueAtISO:
          toOptionalString(payload.dueAtISO) ??
          toOptionalString(snapshot?.due_at),
        attachmentCount,
      },
    };
  });
}

export async function findLatestExistingGuideForAssignment(input: {
  userId: string;
  courseId: string;
  assignmentId: string;
  instanceDomain?: string | null;
}) {
  const normalizedCourseId = toOptionalString(input.courseId);
  const normalizedAssignmentId = toOptionalString(input.assignmentId);
  const normalizedDomain = toOptionalString(input.instanceDomain)?.toLowerCase() ?? null;

  if (!normalizedCourseId || !normalizedAssignmentId) {
    return {
      exists: false,
      latestSessionId: null as string | null,
      latestSessionUpdatedAt: null as number | null,
      status: null as ChatSessionStatus | null,
    };
  }

  const integrationRows = await selectMany<DbLmsIntegration>({
    table: "lms_integrations",
    query: {
      user_id: eq(input.userId),
      provider: eq("canvas"),
      ...(normalizedDomain ? { instance_domain: eq(normalizedDomain) } : {}),
      select: "id,user_id",
      limit: 200,
    },
  });
  if (integrationRows.length === 0) {
    return {
      exists: false,
      latestSessionId: null as string | null,
      latestSessionUpdatedAt: null as number | null,
      status: null as ChatSessionStatus | null,
    };
  }

  const integrationIds = Array.from(new Set(integrationRows.map((row) => row.id)));
  const courseRows = await selectMany<DbCourse>({
    table: "courses",
    query: {
      integration_id: inList(integrationIds),
      provider_course_id: eq(normalizedCourseId),
      select: "id,integration_id",
      limit: 200,
    },
  });
  if (courseRows.length === 0) {
    return {
      exists: false,
      latestSessionId: null as string | null,
      latestSessionUpdatedAt: null as number | null,
      status: null as ChatSessionStatus | null,
    };
  }

  const courseIds = Array.from(new Set(courseRows.map((row) => row.id)));
  const assignmentRows = await selectMany<DbAssignment>({
    table: "assignments",
    query: {
      course_id: inList(courseIds),
      provider_assignment_id: eq(normalizedAssignmentId),
      select: "id,course_id",
      limit: 200,
    },
  });
  if (assignmentRows.length === 0) {
    return {
      exists: false,
      latestSessionId: null as string | null,
      latestSessionUpdatedAt: null as number | null,
      status: null as ChatSessionStatus | null,
    };
  }

  const assignmentIds = Array.from(new Set(assignmentRows.map((row) => row.id)));
  const snapshotRows = await selectMany<DbAssignmentSnapshot>({
    table: "assignment_snapshots",
    query: {
      assignment_id: inList(assignmentIds),
      select: "id",
      limit: 400,
    },
  });
  if (snapshotRows.length === 0) {
    return {
      exists: false,
      latestSessionId: null as string | null,
      latestSessionUpdatedAt: null as number | null,
      status: null as ChatSessionStatus | null,
    };
  }

  const snapshotIds = Array.from(new Set(snapshotRows.map((row) => row.id)));
  const ingestRows = await selectMany<DbAssignmentIngest>({
    table: "assignment_ingests",
    query: {
      assignment_snapshot_id: inList(snapshotIds),
      select: "assignment_uuid,assignment_snapshot_id",
      limit: 400,
    },
  });
  if (ingestRows.length === 0) {
    return {
      exists: false,
      latestSessionId: null as string | null,
      latestSessionUpdatedAt: null as number | null,
      status: null as ChatSessionStatus | null,
    };
  }

  const assignmentUuids = Array.from(new Set(ingestRows.map((row) => row.assignment_uuid)));
  const latest = await selectFirst<DbChatSession>({
    table: "chat_sessions",
    query: {
      user_id: eq(input.userId),
      assignment_uuid: inList(assignmentUuids),
      status: inList(["completed", "archived"]),
      select: "id,user_id,assignment_uuid,status,created_at,updated_at",
      order: "updated_at.desc",
      limit: 1,
    },
  });

  if (latest) {
    return {
      exists: true,
      latestSessionId: latest.id,
      latestSessionUpdatedAt: toEpoch(latest.updated_at),
      status: latest.status,
    };
  }

  // Fallback for legacy records where relational course/assignment ids may be missing:
  // inspect recent persisted sessions and match by assignment URL-derived ids.
  const fallbackSessions = await listPersistedChatSessionsForUser(input.userId, 200);
  const fallbackMatch = fallbackSessions
    .filter((session) => session.status === "completed" || session.status === "archived")
    .filter((session) => {
      const courseMatch = session.context.courseId === normalizedCourseId;
      const assignmentMatch = session.context.assignmentId === normalizedAssignmentId;
      if (courseMatch && assignmentMatch) {
        if (!normalizedDomain) return true;
        const sessionDomain = extractDomainFromUrl(
          session.context.assignmentUrl ?? undefined,
        ).toLowerCase();
        return sessionDomain === normalizedDomain;
      }

      const sessionUrl = toOptionalString(session.context.assignmentUrl);
      if (!sessionUrl) return false;
      const idsFromUrl = sessionUrl.match(/\/courses\/(\d+)\/assignments\/(\d+)/);
      if (!idsFromUrl) return false;
      if (idsFromUrl[1] !== normalizedCourseId || idsFromUrl[2] !== normalizedAssignmentId) {
        return false;
      }
      if (!normalizedDomain) return true;
      const sessionDomain = extractDomainFromUrl(sessionUrl).toLowerCase();
      return sessionDomain === normalizedDomain;
    })
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];

  return {
    exists: Boolean(fallbackMatch),
    latestSessionId: fallbackMatch?.sessionId ?? null,
    latestSessionUpdatedAt: fallbackMatch?.updatedAt ?? null,
    status: fallbackMatch?.status ?? null,
  };
}

export async function listAssignmentSubmissionStatesForUser(
  userId: string,
  assignmentIds: string[],
) {
  const normalizedIds = Array.from(
    new Set(
      assignmentIds
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );

  if (normalizedIds.length === 0) {
    return new Map<string, { isSubmitted: boolean; submittedAt: string | null }>();
  }

  const rows = await selectMany<DbAssignmentUserState>({
    table: "assignment_user_states",
    query: {
      user_id: eq(userId),
      assignment_id: inList(normalizedIds),
      select: "assignment_id,user_id,is_submitted,submitted_at,updated_at",
      limit: normalizedIds.length,
    },
  });

  return new Map(
    rows.map((row) => [
      row.assignment_id,
      {
        isSubmitted: Boolean(row.is_submitted),
        submittedAt: toOptionalString(row.submitted_at) ?? null,
      },
    ]),
  );
}

async function userOwnsAssignment(userId: string, assignmentId: string) {
  const assignment = await selectFirst<DbAssignment>({
    table: "assignments",
    query: {
      id: eq(assignmentId),
      select: "id,course_id",
      limit: 1,
    },
  });
  if (!assignment) return false;

  const course = await selectFirst<DbCourse>({
    table: "courses",
    query: {
      id: eq(assignment.course_id),
      select: "id,integration_id",
      limit: 1,
    },
  });
  if (!course) return false;

  const integration = await selectFirst<DbLmsIntegration>({
    table: "lms_integrations",
    query: {
      id: eq(course.integration_id),
      user_id: eq(userId),
      select: "id,user_id",
      limit: 1,
    },
  });

  return Boolean(integration);
}

export async function setAssignmentSubmittedStateForUser(input: {
  userId: string;
  assignmentId: string;
  isSubmitted: boolean;
}) {
  const owned = await userOwnsAssignment(input.userId, input.assignmentId);
  if (!owned) {
    return null;
  }

  const submittedAt = input.isSubmitted ? nowIso() : null;
  const row = await upsertSingle<DbAssignmentUserState>({
    table: "assignment_user_states",
    onConflict: "assignment_id,user_id",
    rows: [
      {
        assignment_id: input.assignmentId,
        user_id: input.userId,
        is_submitted: input.isSubmitted,
        submitted_at: submittedAt,
        updated_at: nowIso(),
      },
    ],
  });

  return {
    assignmentId: row.assignment_id,
    isSubmitted: Boolean(row.is_submitted),
    submittedAt: toOptionalString(row.submitted_at) ?? null,
  };
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
  files: RunPdfFileInput[] | undefined,
) {
  if (!files || files.length === 0) {
    return;
  }

  const rows = files
    .filter((file) => file.fileSha256.trim().length > 0)
    .map((file, index) => ({
      run_id: runId,
      filename: toOptionalString(file.filename) ?? `attachment-${index + 1}.pdf`,
      file_sha256: file.fileSha256,
      storage_uri: toOptionalString(file.storageUri) ?? null,
      extraction_mode: "none",
      page_count: null,
    }));

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
