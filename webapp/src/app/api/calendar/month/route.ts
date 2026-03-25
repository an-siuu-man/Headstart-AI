import { NextResponse } from "next/server";
import { applyAuthCookies, resolveRequestUser } from "@/lib/auth/session";
import {
  listAssignmentWorkBlocksForRange,
  listCalendarAssignmentsForUser,
} from "@/lib/calendar-repository";
import {
  GoogleCalendarApiError,
  listGoogleCalendarEvents,
  type GoogleCalendarListedEvent,
} from "@/lib/google-calendar";
import { ensureGoogleCalendarAccessToken } from "@/lib/google-calendar-session";
import { upsertNeedsAttentionGoogleCalendarIntegration } from "@/lib/google-calendar-repository";

export const runtime = "nodejs";

type CalendarEventSource = "assignment_due" | "google_event" | "proposed_block";

type CalendarEventPayload = {
  id: string;
  source: CalendarEventSource;
  title: string;
  start_iso: string;
  end_iso: string | null;
  all_day: boolean;
  assignment_id: string | null;
  google_event_id: string | null;
  status: string | null;
  url: string | null;
};

export async function GET(req: Request) {
  const resolvedUser = await resolveRequestUser(req);
  const userId = resolvedUser?.user.id ?? "";
  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const url = new URL(req.url);
  const startISO =
    toOptionalString(url.searchParams.get("start_iso")) ??
    toOptionalString(url.searchParams.get("start"));
  const endISO =
    toOptionalString(url.searchParams.get("end_iso")) ??
    toOptionalString(url.searchParams.get("end"));
  const timezone = toOptionalString(url.searchParams.get("timezone")) ?? "UTC";

  const startAt = parseIso(startISO);
  const endAt = parseIso(endISO);
  if (!startAt || !endAt || endAt.getTime() <= startAt.getTime()) {
    return NextResponse.json(
      { error: "start_iso and end_iso must be valid ISO values with start < end" },
      { status: 400 },
    );
  }

  if (!isValidTimezone(timezone)) {
    return NextResponse.json(
      { error: "timezone must be a valid IANA time zone" },
      { status: 400 },
    );
  }

  const normalizedStartISO = startAt.toISOString();
  const normalizedEndISO = endAt.toISOString();

  try {
    const [assignments, workBlocks] = await Promise.all([
      listCalendarAssignmentsForUser(userId),
      listAssignmentWorkBlocksForRange({
        userId,
        startISO: normalizedStartISO,
        endISO: normalizedEndISO,
        statuses: ["proposed", "accepted"],
      }),
    ]);

    const assignmentEvents: CalendarEventPayload[] = [];
    for (const assignment of assignments) {
      const dueAt = parseIso(assignment.dueAtISO);
      if (!dueAt || !isPointInRange(dueAt, startAt, endAt)) {
        continue;
      }

      assignmentEvents.push({
        id: `assignment-${assignment.assignmentId ?? assignment.key}`,
        source: "assignment_due",
        title: `Due: ${assignment.title}`,
        start_iso: dueAt.toISOString(),
        end_iso: null,
        all_day: false,
        assignment_id: assignment.assignmentId,
        google_event_id: null,
        status: assignment.isSubmitted ? "submitted" : "pending",
        url: assignment.latestSessionId
          ? `/dashboard/chat?session=${encodeURIComponent(assignment.latestSessionId)}`
          : null,
      });
    }

    const blockEvents: CalendarEventPayload[] = workBlocks.map((block) => ({
      id: `work-${block.id}`,
      source: "proposed_block",
      title: block.title,
      start_iso: block.startAtISO,
      end_iso: block.endAtISO,
      all_day: false,
      assignment_id: block.assignmentId,
      google_event_id: block.googleEventId,
      status: block.status,
      url: null,
    }));

    let googleStatus: "connected" | "disconnected" | "needs_attention" = "disconnected";
    let googleConnected = false;
    const googleEvents: CalendarEventPayload[] = [];

    const accessState = await ensureGoogleCalendarAccessToken({
      userId,
      requestUrl: req.url,
    });
    googleStatus = accessState.status;
    googleConnected = accessState.connected;

    if (accessState.connected && accessState.accessToken) {
      try {
        const listed = await listGoogleCalendarEvents({
          accessToken: accessState.accessToken,
          timeMinIso: normalizedStartISO,
          timeMaxIso: normalizedEndISO,
        });

        for (const event of listed) {
          const mapped = mapGoogleEvent(event, startAt, endAt);
          if (!mapped) continue;
          googleEvents.push(mapped);
        }
      } catch (error) {
        if (
          error instanceof GoogleCalendarApiError &&
          (error.status === 400 || error.status === 401 || error.status === 403)
        ) {
          await upsertNeedsAttentionGoogleCalendarIntegration({
            userId,
            lastError: "Google authorization rejected by provider.",
          }).catch(() => undefined);
          googleStatus = "needs_attention";
          googleConnected = false;
          googleEvents.length = 0;
        } else {
          throw error;
        }
      }
    }

    const events = [...assignmentEvents, ...blockEvents, ...googleEvents].sort((left, right) => {
      const leftTs = toSortableTimestamp(left.start_iso);
      const rightTs = toSortableTimestamp(right.start_iso);
      if (leftTs !== rightTs) return leftTs - rightTs;
      return left.title.localeCompare(right.title);
    });

    const response = NextResponse.json({
      ok: true,
      range: {
        start_iso: normalizedStartISO,
        end_iso: normalizedEndISO,
        timezone,
      },
      integration: {
        google: {
          status: googleStatus,
          connected: googleConnected,
        },
      },
      events,
    });

    if (resolvedUser?.refreshedSession) {
      applyAuthCookies(response, resolvedUser.refreshedSession);
    }

    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "Failed to load calendar data", detail: message },
      { status: 500 },
    );
  }
}

function mapGoogleEvent(
  event: GoogleCalendarListedEvent,
  rangeStart: Date,
  rangeEnd: Date,
): CalendarEventPayload | null {
  if (event.status === "cancelled") {
    return null;
  }

  const normalized = normalizeGoogleEventWindow(event);
  if (!normalized) {
    return null;
  }

  if (!overlapsRange(normalized.start, normalized.end, rangeStart, rangeEnd)) {
    return null;
  }

  return {
    id: `google-${event.id}`,
    source: "google_event",
    title: event.summary ?? "(Untitled event)",
    start_iso: normalized.startISO,
    end_iso: normalized.endISO,
    all_day: normalized.allDay,
    assignment_id: null,
    google_event_id: event.id,
    status: event.status,
    url: event.htmlLink,
  };
}

function normalizeGoogleEventWindow(event: GoogleCalendarListedEvent) {
  if (event.start.dateTime) {
    const start = parseIso(event.start.dateTime);
    if (!start) return null;

    const end = parseIso(event.end.dateTime) ?? start;
    return {
      start,
      end,
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      allDay: false,
    };
  }

  if (event.start.date) {
    const start = parseIso(event.start.date);
    if (!start) return null;

    const end = parseIso(event.end.date) ?? start;
    return {
      start,
      end,
      startISO: event.start.date,
      endISO: event.end.date ?? event.start.date,
      allDay: true,
    };
  }

  return null;
}

function isPointInRange(point: Date, rangeStart: Date, rangeEnd: Date) {
  return point.getTime() >= rangeStart.getTime() && point.getTime() < rangeEnd.getTime();
}

function overlapsRange(start: Date, end: Date, rangeStart: Date, rangeEnd: Date) {
  return start.getTime() < rangeEnd.getTime() && end.getTime() > rangeStart.getTime();
}

function toSortableTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? Number.MAX_SAFE_INTEGER : timestamp;
}

function parseIso(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
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


