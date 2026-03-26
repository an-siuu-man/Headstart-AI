import { NextResponse } from "next/server";
import { applyAuthCookies, resolveRequestUser } from "@/lib/auth/session";
import { listCalendarAssignmentsForUser } from "@/lib/calendar-repository";
import {
  createGoogleCalendarEvent,
  GoogleCalendarApiError,
} from "@/lib/google-calendar";
import { ensureGoogleCalendarAccessToken } from "@/lib/google-calendar-session";
import { upsertNeedsAttentionGoogleCalendarIntegration } from "@/lib/google-calendar-repository";
import {
  HEADSTART_ASSIGNMENT_ID_KEY,
  HEADSTART_EVENT_TYPE_KEY,
  HEADSTART_EVENT_TYPE_STUDY,
} from "@/lib/calendar-google-markers";

export const runtime = "nodejs";

const MAX_SESSIONS = 10;

type SessionInput = {
  start_iso: string;
  end_iso: string;
  focus?: string;
  priority?: string;
};

export async function POST(req: Request) {
  const resolvedUser = await resolveRequestUser(req);
  const userId = resolvedUser?.user.id ?? "";
  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  let body: Record<string, unknown> | null = null;
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const assignmentId = toOptionalString(body?.assignment_id);
  const sessionIdFromBody = toOptionalString(body?.session_id);

  if (!assignmentId && !sessionIdFromBody) {
    return NextResponse.json(
      { error: "assignment_id is required" },
      { status: 400 },
    );
  }

  const timezone = toOptionalString(body?.timezone) ?? "UTC";
  if (!isValidTimezone(timezone)) {
    return NextResponse.json(
      { error: "timezone must be a valid IANA time zone" },
      { status: 400 },
    );
  }

  if (!Array.isArray(body?.sessions) || (body.sessions as unknown[]).length === 0) {
    return NextResponse.json(
      { error: "sessions must be a non-empty array" },
      { status: 400 },
    );
  }

  const rawSessions = (body.sessions as unknown[]).slice(0, MAX_SESSIONS);
  const sessions: SessionInput[] = rawSessions
    .filter(
      (s): s is SessionInput =>
        typeof s === "object" &&
        s !== null &&
        typeof (s as Record<string, unknown>).start_iso === "string" &&
        typeof (s as Record<string, unknown>).end_iso === "string",
    )
    .map((s) => ({
      start_iso: (s as SessionInput).start_iso,
      end_iso: (s as SessionInput).end_iso,
      focus: toOptionalString((s as SessionInput).focus) ?? undefined,
      priority: toOptionalString((s as SessionInput).priority) ?? undefined,
    }));

  if (sessions.length === 0) {
    return NextResponse.json(
      { error: "sessions must contain at least one valid item with start_iso and end_iso" },
      { status: 400 },
    );
  }

  try {
    // Resolve assignment — try by assignmentId first, fall back to sessionId
    const allAssignments = await listCalendarAssignmentsForUser(userId);
    const assignment =
      (assignmentId ? allAssignments.find((a) => a.assignmentId === assignmentId) : undefined) ??
      (sessionIdFromBody
        ? allAssignments.find((a) => a.latestSessionId === sessionIdFromBody)
        : undefined);

    if (!assignment) {
      return NextResponse.json(
        { error: "Assignment not found for this user" },
        { status: 404 },
      );
    }

    if (assignment.isSubmitted) {
      return NextResponse.json(
        { error: "Assignment is already submitted" },
        { status: 404 },
      );
    }

    // Scheduling requires a connected Google Calendar
    const accessState = await ensureGoogleCalendarAccessToken({
      userId,
      requestUrl: req.url,
    });

    if (!accessState.connected || !accessState.accessToken) {
      return NextResponse.json(
        { error: "Google Calendar is not connected" },
        { status: 400 },
      );
    }

    const { accessToken } = accessState;
    let googleStatus = accessState.status;

    // Build event metadata from assignment
    const dueDateLabel = formatDueDate(assignment.dueAtISO);
    const coursePrefix = assignment.courseName ? `Course: ${assignment.courseName}\n` : "";

    // Create events in parallel with per-event failure isolation
    let authErrorRecorded = false;

    const results = await Promise.allSettled(
      sessions.map((session) => {
        const focusLabel = session.focus ?? "Study session";
        const description =
          `${coursePrefix}Deadline: ${dueDateLabel}\nFocus: ${focusLabel}`.trim();

        return createGoogleCalendarEvent({
          accessToken,
          event: {
            summary: `Study: ${assignment.title}`,
            description,
            startIso: session.start_iso,
            endIso: session.end_iso,
            timezone,
            extendedPropertiesPrivate: {
              [HEADSTART_EVENT_TYPE_KEY]: HEADSTART_EVENT_TYPE_STUDY,
              ...(assignment.assignmentId
                ? { [HEADSTART_ASSIGNMENT_ID_KEY]: assignment.assignmentId }
                : {}),
            },
          },
        });
      }),
    );

    // Process results
    type ScheduledEventEntry = {
      start_iso: string;
      end_iso: string;
      google_event_id: string | null;
      html_link: string | null;
      status: "created" | "failed";
      error?: string;
    };

    const scheduledEvents: ScheduledEventEntry[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const session = sessions[i]!;

      if (result.status === "fulfilled") {
        scheduledEvents.push({
          start_iso: session.start_iso,
          end_iso: session.end_iso,
          google_event_id: result.value.id,
          html_link: result.value.htmlLink,
          status: "created",
        });
      } else {
        const err = result.reason;
        const errorMessage =
          err instanceof Error ? err.message : String(err);

        // Mark integration as needs_attention on auth failures (once)
        if (
          !authErrorRecorded &&
          err instanceof GoogleCalendarApiError &&
          (err.status === 401 || err.status === 403)
        ) {
          authErrorRecorded = true;
          googleStatus = "needs_attention";
          await upsertNeedsAttentionGoogleCalendarIntegration({
            userId,
            lastError: "Google authorization rejected by provider.",
          }).catch(() => undefined);
        }

        scheduledEvents.push({
          start_iso: session.start_iso,
          end_iso: session.end_iso,
          google_event_id: null,
          html_link: null,
          status: "failed",
          error: errorMessage,
        });
      }
    }

    const createdCount = scheduledEvents.filter((e) => e.status === "created").length;
    const failedCount = scheduledEvents.filter((e) => e.status === "failed").length;

    const response = NextResponse.json({
      assignment_id: assignmentId,
      created_count: createdCount,
      failed_count: failedCount,
      scheduled_events: scheduledEvents,
      integration: {
        google: {
          status: googleStatus,
          connected: googleStatus === "connected",
        },
      },
    });

    if (resolvedUser?.refreshedSession) {
      applyAuthCookies(response, resolvedUser.refreshedSession);
    }

    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "Failed to schedule study sessions", detail: message },
      { status: 500 },
    );
  }
}

function formatDueDate(dueAtISO: string | null): string {
  if (!dueAtISO) return "No deadline set";
  const date = new Date(dueAtISO);
  if (Number.isNaN(date.getTime())) return dueAtISO;
  return date.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function toOptionalString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isValidTimezone(value: string) {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
