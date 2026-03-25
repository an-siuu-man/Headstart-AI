import {
  listAssignmentSubmissionStatesForUser,
  listPersistedChatSessionsForUser,
  type UserChatSessionListItem,
} from "@/lib/chat-repository";
import { supabaseTableRequest } from "@/lib/supabase-rest";

const WORK_BLOCK_TABLE = "assignment_work_blocks";
const WORK_BLOCK_SELECT =
  "id,user_id,assignment_id,source,status,title,start_at,end_at,google_event_id,metadata,created_at,updated_at";

export type AssignmentPriority = "High" | "Medium" | "Low";
export type AssignmentWorkBlockSource = "heuristic" | "agent";
export type AssignmentWorkBlockStatus = "proposed" | "accepted" | "dismissed";

export type CalendarAssignment = {
  key: string;
  assignmentId: string | null;
  title: string;
  courseName: string | null;
  dueAtISO: string | null;
  latestSessionId: string;
  isSubmitted: boolean;
  priority: AssignmentPriority;
};

type DbAssignmentWorkBlock = {
  id: string;
  user_id: string;
  assignment_id: string;
  source: AssignmentWorkBlockSource;
  status: AssignmentWorkBlockStatus;
  title: string;
  start_at: string;
  end_at: string;
  google_event_id?: string | null;
  metadata?: unknown;
  created_at?: string;
  updated_at?: string;
};

export type AssignmentWorkBlock = {
  id: string;
  userId: string;
  assignmentId: string;
  source: AssignmentWorkBlockSource;
  status: AssignmentWorkBlockStatus;
  title: string;
  startAtISO: string;
  endAtISO: string;
  googleEventId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
};

export type AssignmentWorkBlockInsertRow = {
  userId: string;
  assignmentId: string;
  source: AssignmentWorkBlockSource;
  status?: AssignmentWorkBlockStatus;
  title: string;
  startAtISO: string;
  endAtISO: string;
  googleEventId?: string | null;
  metadata?: Record<string, unknown>;
};

export async function listCalendarAssignmentsForUser(userId: string, limit = 400) {
  const sessions = await listPersistedChatSessionsForUser(userId, Math.max(1, limit));
  const assignmentRecordIds = Array.from(
    new Set(
      sessions
        .map((session) => session.context.assignmentRecordId)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  );

  const submissionStates = await listAssignmentSubmissionStatesForUser(
    userId,
    assignmentRecordIds,
  );

  const assignmentByKey = new Map<string, CalendarAssignment>();
  const now = Date.now();

  for (const session of sessions) {
    const key = normalizeAssignmentKey(session);
    if (assignmentByKey.has(key)) continue;

    const assignmentId = session.context.assignmentRecordId;
    const submissionState = assignmentId ? submissionStates.get(assignmentId) : undefined;
    const isSubmitted = submissionState?.isSubmitted ?? false;

    assignmentByKey.set(key, {
      key,
      assignmentId,
      title: session.context.assignmentTitle,
      courseName: session.context.courseName,
      dueAtISO: session.context.dueAtISO,
      latestSessionId: session.sessionId,
      isSubmitted,
      priority: derivePriority(session.context.dueAtISO, isSubmitted, now),
    });
  }

  return Array.from(assignmentByKey.values()).sort((left, right) => {
    if (left.isSubmitted !== right.isSubmitted) {
      return left.isSubmitted ? 1 : -1;
    }

    const leftDue = toTimestamp(left.dueAtISO);
    const rightDue = toTimestamp(right.dueAtISO);

    if (leftDue == null && rightDue == null) return 0;
    if (leftDue == null) return 1;
    if (rightDue == null) return -1;
    return leftDue - rightDue;
  });
}

export async function listAssignmentWorkBlocksForRange(input: {
  userId: string;
  startISO: string;
  endISO: string;
  statuses?: AssignmentWorkBlockStatus[];
}) {
  const rows = await supabaseTableRequest<DbAssignmentWorkBlock[]>({
    table: WORK_BLOCK_TABLE,
    method: "GET",
    query: {
      user_id: eq(input.userId),
      start_at: lt(input.endISO),
      end_at: gt(input.startISO),
      ...(Array.isArray(input.statuses) && input.statuses.length > 0
        ? { status: inList(input.statuses) }
        : {}),
      select: WORK_BLOCK_SELECT,
      order: "start_at.asc",
      limit: 1000,
    },
  });

  return rows.map((row) => toAssignmentWorkBlock(row));
}

export async function insertAssignmentWorkBlocks(rows: AssignmentWorkBlockInsertRow[]) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return [] as AssignmentWorkBlock[];
  }

  const inserted = await supabaseTableRequest<DbAssignmentWorkBlock[]>({
    table: WORK_BLOCK_TABLE,
    method: "POST",
    query: {
      select: WORK_BLOCK_SELECT,
    },
    headers: {
      Prefer: "return=representation",
    },
    body: rows.map((row) => ({
      user_id: row.userId,
      assignment_id: row.assignmentId,
      source: row.source,
      status: row.status ?? "proposed",
      title: row.title,
      start_at: row.startAtISO,
      end_at: row.endAtISO,
      google_event_id: row.googleEventId ?? null,
      metadata: row.metadata ?? {},
      updated_at: nowIso(),
    })),
  });

  return inserted.map((row) => toAssignmentWorkBlock(row));
}

export async function deleteHeuristicProposedBlocksForRange(input: {
  userId: string;
  startISO: string;
  endISO: string;
}) {
  const deleted = await supabaseTableRequest<Array<{ id: string }>>({
    table: WORK_BLOCK_TABLE,
    method: "DELETE",
    query: {
      user_id: eq(input.userId),
      source: eq("heuristic"),
      status: eq("proposed"),
      start_at: lt(input.endISO),
      end_at: gt(input.startISO),
      select: "id",
    },
    headers: {
      Prefer: "return=representation",
    },
  });

  return deleted.length;
}

function normalizeAssignmentKey(item: UserChatSessionListItem) {
  if (item.context.assignmentRecordId) {
    return item.context.assignmentRecordId;
  }
  const title = item.context.assignmentTitle.trim().toLowerCase();
  const course = (item.context.courseName ?? "").trim().toLowerCase();
  const due = item.context.dueAtISO ?? "";
  return `${title}::${course}::${due}`;
}

function derivePriority(
  dueAtISO: string | null,
  isSubmitted: boolean,
  nowTimestamp: number,
): AssignmentPriority {
  if (isSubmitted) return "Low";
  const dueAt = toTimestamp(dueAtISO);
  if (dueAt == null) return "Low";

  const hoursUntilDue = (dueAt - nowTimestamp) / (1000 * 60 * 60);
  if (hoursUntilDue <= 48) return "High";
  if (hoursUntilDue <= 24 * 7) return "Medium";
  return "Low";
}

function toTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function toAssignmentWorkBlock(row: DbAssignmentWorkBlock): AssignmentWorkBlock {
  return {
    id: row.id,
    userId: row.user_id,
    assignmentId: row.assignment_id,
    source: row.source,
    status: row.status,
    title: row.title,
    startAtISO: row.start_at,
    endAtISO: row.end_at,
    googleEventId: toOptionalString(row.google_event_id),
    metadata: asObject(row.metadata),
    createdAt: toOptionalString(row.created_at),
    updatedAt: toOptionalString(row.updated_at),
  };
}

function eq(value: string | number | boolean) {
  return `eq.${value}`;
}

function lt(value: string) {
  return `lt.${value}`;
}

function gt(value: string) {
  return `gt.${value}`;
}

function inList(values: string[]) {
  const normalized = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => `"${value.replaceAll('"', "")}"`);
  return `in.(${normalized.join(",")})`;
}

function nowIso() {
  return new Date().toISOString();
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function toOptionalString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
