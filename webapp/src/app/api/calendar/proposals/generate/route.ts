import { NextResponse } from "next/server";
import { applyAuthCookies, resolveRequestUser } from "@/lib/auth/session";
import { listCalendarAssignmentsForUser } from "@/lib/calendar-repository";
import {
  GoogleCalendarApiError,
  listGoogleCalendarEvents,
  type GoogleCalendarListedEvent,
} from "@/lib/google-calendar";
import { ensureGoogleCalendarAccessToken } from "@/lib/google-calendar-session";
import { upsertNeedsAttentionGoogleCalendarIntegration } from "@/lib/google-calendar-repository";
import {
  generateHeuristicWorkBlocks,
  type PlannerAssignmentInput,
  type PlannerBusyInterval,
} from "@/lib/calendar-planner";

export const runtime = "nodejs";

type ProposalSuggestion = {
  id: string;
  assignment_id: string;
  assignment_title: string;
  start_iso: string;
  end_iso: string;
  focus: string;
  priority: "high" | "medium" | "low";
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

  const startISO = toOptionalString(body?.start_iso);
  const endISO = toOptionalString(body?.end_iso);
  const timezone = toOptionalString(body?.timezone) ?? "UTC";
  const replaceExisting =
    typeof body?.replace_existing === "boolean" ? Boolean(body.replace_existing) : true;

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
    const assignments = await listCalendarAssignmentsForUser(userId);
    const assignmentTitleById = new Map<string, string>();

    const plannerAssignments: PlannerAssignmentInput[] = assignments
      .filter((assignment) => {
        if (assignment.isSubmitted) return false;
        if (!assignment.assignmentId || !assignment.dueAtISO) return false;

        const dueAt = parseIso(assignment.dueAtISO);
        if (!dueAt) return false;
        return isPointInRange(dueAt, startAt, endAt);
      })
      .map((assignment) => {
        assignmentTitleById.set(assignment.assignmentId as string, assignment.title);
        return {
          assignmentId: assignment.assignmentId as string,
          title: assignment.title,
          dueAtISO: assignment.dueAtISO as string,
          priority: assignment.priority,
        };
      });

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
          timeMinIso: normalizedStartISO,
          timeMaxIso: normalizedEndISO,
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

    const generatedDrafts = generateHeuristicWorkBlocks({
      assignments: plannerAssignments,
      busyIntervals: googleBusy,
      rangeStartISO: normalizedStartISO,
      rangeEndISO: normalizedEndISO,
    });

    const suggestions: ProposalSuggestion[] = generatedDrafts.map((draft) => {
      const assignmentTitle = assignmentTitleById.get(draft.assignmentId) ?? draft.title;
      const priority = toSessionPriority(draft.metadata.priority);
      return {
        id: `${draft.assignmentId}:${draft.startAtISO}`,
        assignment_id: draft.assignmentId,
        assignment_title: assignmentTitle,
        start_iso: draft.startAtISO,
        end_iso: draft.endAtISO,
        focus: `Planned study block for ${assignmentTitle}`,
        priority,
      };
    });

    const response = NextResponse.json({
      ok: true,
      generated_count: suggestions.length,
      // Kept for API compatibility; proposal suggestions are ephemeral only.
      requested_replace_existing: replaceExisting,
      replace_existing_ignored: true,
      integration: {
        google: {
          status: googleStatus,
          connected: googleStatus === "connected",
        },
      },
      suggestions,
    });

    if (resolvedUser?.refreshedSession) {
      applyAuthCookies(response, resolvedUser.refreshedSession);
    }

    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "Failed to generate work block suggestions", detail: message },
      { status: 500 },
    );
  }
}

function toSessionPriority(value: unknown): ProposalSuggestion["priority"] {
  if (value === "High") return "high";
  if (value === "Medium") return "medium";
  return "low";
}

function normalizeGoogleBusyWindow(event: GoogleCalendarListedEvent): PlannerBusyInterval | null {
  if (event.status === "cancelled") {
    return null;
  }

  if (event.start.dateTime) {
    const start = parseIso(event.start.dateTime);
    const end = parseIso(event.end.dateTime);
    if (!start || !end || end.getTime() <= start.getTime()) return null;

    return {
      startISO: start.toISOString(),
      endISO: end.toISOString(),
    };
  }

  if (event.start.date) {
    const start = parseIso(event.start.date);
    const end = parseIso(event.end.date);
    if (!start || !end || end.getTime() <= start.getTime()) return null;

    return {
      startISO: start.toISOString(),
      endISO: end.toISOString(),
    };
  }

  return null;
}

function isPointInRange(point: Date, rangeStart: Date, rangeEnd: Date) {
  return point.getTime() >= rangeStart.getTime() && point.getTime() < rangeEnd.getTime();
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
