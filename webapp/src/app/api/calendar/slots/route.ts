import { NextResponse } from "next/server";
import { applyAuthCookies, resolveRequestUser } from "@/lib/auth/session";
import { listAssignmentWorkBlocksForRange, listCalendarAssignmentsForUser } from "@/lib/calendar-repository";
import {
  detectFreeSlots,
  recommendStudySessions,
  type PlannerAssignmentInput,
  type PlannerBusyInterval,
} from "@/lib/calendar-planner";
import {
  GoogleCalendarApiError,
  listGoogleCalendarEvents,
  type GoogleCalendarListedEvent,
} from "@/lib/google-calendar";
import { ensureGoogleCalendarAccessToken } from "@/lib/google-calendar-session";
import { upsertNeedsAttentionGoogleCalendarIntegration } from "@/lib/google-calendar-repository";

export const runtime = "nodejs";

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
  if (!assignmentId) {
    return NextResponse.json({ error: "assignment_id is required" }, { status: 400 });
  }

  const timezone = toOptionalString(body?.timezone) ?? "UTC";
  if (!isValidTimezone(timezone)) {
    return NextResponse.json(
      { error: "timezone must be a valid IANA time zone" },
      { status: 400 },
    );
  }

  const rawEffort =
    typeof body?.estimated_effort_minutes === "number"
      ? body.estimated_effort_minutes
      : null;
  const estimatedEffortMinutes =
    rawEffort !== null ? Math.max(30, Math.min(480, Math.round(rawEffort))) : undefined;

  try {
    // Resolve the target assignment
    const allAssignments = await listCalendarAssignmentsForUser(userId);
    const assignment = allAssignments.find((a) => a.assignmentId === assignmentId);

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

    const now = new Date();
    const dueAt = parseIso(assignment.dueAtISO);

    // Due date in the past or missing → no slots possible
    if (!dueAt || dueAt.getTime() <= now.getTime()) {
      const response = NextResponse.json({
        assignment_id: assignmentId,
        timezone,
        no_slots_found: true,
        free_slots: [],
        recommended_sessions: [],
        integration: {
          google: { status: "disconnected", connected: false },
        },
      });
      if (resolvedUser?.refreshedSession) {
        applyAuthCookies(response, resolvedUser.refreshedSession);
      }
      return response;
    }

    const nowISO = now.toISOString();
    const dueAtISO = dueAt.toISOString();

    // Fetch existing work-block busy time
    const existingBlocks = await listAssignmentWorkBlocksForRange({
      userId,
      startISO: nowISO,
      endISO: dueAtISO,
      statuses: ["proposed", "accepted"],
    });

    const workBlockBusy: PlannerBusyInterval[] = existingBlocks.map((block) => ({
      startISO: block.startAtISO,
      endISO: block.endAtISO,
    }));

    // Fetch Google Calendar busy intervals
    let googleBusy: PlannerBusyInterval[] = [];
    let googleStatus: "connected" | "disconnected" | "needs_attention" = "disconnected";

    const accessState = await ensureGoogleCalendarAccessToken({
      userId,
      requestUrl: req.url,
    });
    googleStatus = accessState.status;

    if (accessState.connected && accessState.accessToken) {
      try {
        const listedEvents = await listGoogleCalendarEvents({
          accessToken: accessState.accessToken,
          timeMinIso: nowISO,
          timeMaxIso: dueAtISO,
        });

        googleBusy = listedEvents
          .map((event) => normalizeGoogleBusyWindow(event))
          .filter((event): event is PlannerBusyInterval => Boolean(event));
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
          googleBusy = [];
        } else {
          throw error;
        }
      }
    }

    const plannerAssignment: PlannerAssignmentInput = {
      assignmentId: assignment.assignmentId as string,
      title: assignment.title,
      dueAtISO: dueAtISO,
      priority: assignment.priority,
    };

    const busyIntervals: PlannerBusyInterval[] = [...googleBusy, ...workBlockBusy];

    const freeSlots = detectFreeSlots({
      assignment: plannerAssignment,
      busyIntervals,
      nowISO,
    });

    const recommendedSessions = recommendStudySessions({
      assignment: plannerAssignment,
      freeSlots,
      estimatedEffortMinutes,
    });

    const response = NextResponse.json({
      assignment_id: assignmentId,
      timezone,
      no_slots_found: freeSlots.length === 0,
      free_slots: freeSlots,
      recommended_sessions: recommendedSessions,
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
      { error: "Failed to detect free slots", detail: message },
      { status: 500 },
    );
  }
}

function normalizeGoogleBusyWindow(event: GoogleCalendarListedEvent): PlannerBusyInterval | null {
  if (event.status === "cancelled") return null;

  if (event.start.dateTime) {
    const start = parseIso(event.start.dateTime);
    const end = parseIso(event.end.dateTime);
    if (!start || !end || end.getTime() <= start.getTime()) return null;
    return { startISO: start.toISOString(), endISO: end.toISOString() };
  }

  if (event.start.date) {
    const start = parseIso(event.start.date);
    const end = parseIso(event.end.date);
    if (!start || !end || end.getTime() <= start.getTime()) return null;
    return { startISO: start.toISOString(), endISO: end.toISOString() };
  }

  return null;
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
