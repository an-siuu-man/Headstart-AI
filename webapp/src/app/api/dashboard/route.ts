import { NextResponse } from "next/server";
import {
  listAssignmentSubmissionStatesForUser,
  listPersistedChatSessionsForUser,
  type UserChatSessionListItem,
} from "@/lib/chat-repository";
import { applyAuthCookies, resolveRequestUser } from "@/lib/auth/session";

export const runtime = "nodejs";

type DashboardGuideStatus = "Ready" | "Processing" | "Failed" | "Archived";

function mapGuideStatus(
  status: UserChatSessionListItem["status"],
): DashboardGuideStatus {
  if (status === "completed") return "Ready";
  if (status === "failed") return "Failed";
  if (status === "archived") return "Archived";
  return "Processing";
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

function toTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

export async function GET(req: Request) {
  const resolvedUser = await resolveRequestUser(req);
  const userId = resolvedUser?.user.id ?? "";
  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const sessions = await listPersistedChatSessionsForUser(userId, 100);
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

    const guides = sessions.slice(0, 8).map((session) => ({
      id: session.sessionId,
      session_id: session.sessionId,
      title: session.title,
      assignment_title: session.context.assignmentTitle,
      course_name: session.context.courseName,
      due_at_iso: session.context.dueAtISO,
      updated_at: session.updatedAt,
      status: mapGuideStatus(session.status),
    }));

    const assignmentByKey = new Map<
      string,
      {
        id: string;
        assignment_id: string | null;
        title: string;
        course_name: string | null;
        due_at_iso: string | null;
        latest_session_id: string;
        updated_at: number;
        priority: "High" | "Medium" | "Low";
        is_submitted: boolean;
        submitted_at: string | null;
      }
    >();

    for (const session of sessions) {
      const key = normalizeAssignmentKey(session);
      if (assignmentByKey.has(key)) continue;

      const dueAt = toTimestamp(session.context.dueAtISO);
      const submissionState = session.context.assignmentRecordId
        ? submissionStates.get(session.context.assignmentRecordId)
        : undefined;
      const isSubmitted = submissionState?.isSubmitted ?? false;
      const now = Date.now();
      const hoursUntilDue = dueAt == null ? null : (dueAt - now) / (1000 * 60 * 60);
      let priority: "High" | "Medium" | "Low" = "Low";
      if (!isSubmitted && hoursUntilDue != null) {
        if (hoursUntilDue <= 48) priority = "High";
        else if (hoursUntilDue <= 24 * 7) priority = "Medium";
      }

      assignmentByKey.set(key, {
        id: key,
        assignment_id: session.context.assignmentRecordId,
        title: session.context.assignmentTitle,
        course_name: session.context.courseName,
        due_at_iso: session.context.dueAtISO,
        latest_session_id: session.sessionId,
        updated_at: session.updatedAt,
        priority,
        is_submitted: isSubmitted,
        submitted_at: submissionState?.submittedAt ?? null,
      });
    }

    const assignments = Array.from(assignmentByKey.values())
      .sort((left, right) => {
        if (left.is_submitted !== right.is_submitted) {
          return left.is_submitted ? 1 : -1;
        }
        const leftDue = toTimestamp(left.due_at_iso);
        const rightDue = toTimestamp(right.due_at_iso);
        if (leftDue == null && rightDue == null) {
          return right.updated_at - left.updated_at;
        }
        if (leftDue == null) return 1;
        if (rightDue == null) return -1;
        return leftDue - rightDue;
      })
      .slice(0, 8);

    const response = NextResponse.json({
      ok: true,
      assignments,
      guides,
    });
    if (resolvedUser?.refreshedSession) {
      applyAuthCookies(response, resolvedUser.refreshedSession);
    }
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "Failed to load dashboard data", detail: message },
      { status: 500 },
    );
  }
}
