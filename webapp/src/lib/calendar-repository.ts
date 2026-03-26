import {
  listAssignmentSubmissionStatesForUser,
  listPersistedChatSessionsForUser,
  type UserChatSessionListItem,
} from "@/lib/chat-repository";

export type AssignmentPriority = "High" | "Medium" | "Low";

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
