import { NextResponse } from "next/server";
import {
  listAssignmentSubmissionStatesForUser,
  listPersistedChatSessionsForUser,
  type UserChatSessionListItem,
} from "@/lib/chat-repository";
import { applyAuthCookies, resolveRequestUser } from "@/lib/auth/session";

export const runtime = "nodejs";

type AssignmentListStatus = "Pending" | "In Progress" | "Completed";
type AssignmentPriority = "High" | "Medium" | "Low";

function toTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
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

function mapAssignmentStatus(
  status: UserChatSessionListItem["status"],
): AssignmentListStatus {
  if (status === "completed") return "Completed";
  if (status === "running" || status === "queued") return "In Progress";
  return "Pending";
}

function derivePriority(dueAtISO: string | null): AssignmentPriority {
  const dueAt = toTimestamp(dueAtISO);
  if (dueAt == null) return "Low";

  const hoursUntilDue = (dueAt - Date.now()) / (1000 * 60 * 60);
  if (hoursUntilDue <= 48) return "High";
  if (hoursUntilDue <= 24 * 7) return "Medium";
  return "Low";
}

export async function GET(req: Request) {
  const resolvedUser = await resolveRequestUser(req);
  const userId = resolvedUser?.user.id ?? "";
  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const sessions = await listPersistedChatSessionsForUser(userId, 200);
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

    const assignmentByKey = new Map<
      string,
      {
        id: string;
        assignment_id: string | null;
        title: string;
        course_name: string | null;
        due_at_iso: string | null;
        latest_session_id: string;
        latest_session_updated_at: number;
        status: AssignmentListStatus;
        priority: AssignmentPriority;
        attachment_count: number;
        is_overdue: boolean;
        is_submitted: boolean;
        submitted_at: string | null;
      }
    >();

    for (const session of sessions) {
      const key = normalizeAssignmentKey(session);
      if (assignmentByKey.has(key)) continue;

      const status = mapAssignmentStatus(session.status);
      const dueAt = toTimestamp(session.context.dueAtISO);
      const submissionState = session.context.assignmentRecordId
        ? submissionStates.get(session.context.assignmentRecordId)
        : undefined;
      const isSubmitted = submissionState?.isSubmitted ?? false;
      assignmentByKey.set(key, {
        id: key,
        assignment_id: session.context.assignmentRecordId,
        title: session.context.assignmentTitle,
        course_name: session.context.courseName,
        due_at_iso: session.context.dueAtISO,
        latest_session_id: session.sessionId,
        latest_session_updated_at: session.updatedAt,
        status,
        priority: isSubmitted ? "Low" : derivePriority(session.context.dueAtISO),
        attachment_count: session.context.attachmentCount,
        is_overdue:
          !isSubmitted && dueAt != null && dueAt < Date.now() && status !== "Completed",
        is_submitted: isSubmitted,
        submitted_at: submissionState?.submittedAt ?? null,
      });
    }

    const assignments = Array.from(assignmentByKey.values()).sort((left, right) => {
      if (left.is_submitted !== right.is_submitted) {
        return left.is_submitted ? 1 : -1;
      }
      const leftDue = toTimestamp(left.due_at_iso);
      const rightDue = toTimestamp(right.due_at_iso);
      if (leftDue == null && rightDue == null) {
        return right.latest_session_updated_at - left.latest_session_updated_at;
      }
      if (leftDue == null) return 1;
      if (rightDue == null) return -1;
      return leftDue - rightDue;
    });

    const response = NextResponse.json({
      ok: true,
      assignments,
    });
    if (resolvedUser?.refreshedSession) {
      applyAuthCookies(response, resolvedUser.refreshedSession);
    }
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "Failed to load assignments", detail: message },
      { status: 500 },
    );
  }
}
