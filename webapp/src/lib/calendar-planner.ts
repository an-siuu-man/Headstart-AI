import type { AssignmentPriority } from "@/lib/calendar-repository";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const SLOT_SHIFT_MS = 30 * MINUTE_MS;
const LOOKBACK_DAYS_LIMIT = 21;
const LOOKBACK_STEPS_LIMIT = 96;

export type PlannerAssignmentInput = {
  assignmentId: string;
  title: string;
  dueAtISO: string;
  priority: AssignmentPriority;
};

export type PlannerBusyInterval = {
  startISO: string;
  endISO: string;
};

export type PlannerDraftWorkBlock = {
  assignmentId: string;
  title: string;
  startAtISO: string;
  endAtISO: string;
  metadata: Record<string, unknown>;
};

export function generateHeuristicWorkBlocks(input: {
  assignments: PlannerAssignmentInput[];
  busyIntervals: PlannerBusyInterval[];
  rangeStartISO: string;
  rangeEndISO: string;
  nowISO?: string;
}) {
  const rangeStart = parseIso(input.rangeStartISO);
  const rangeEnd = parseIso(input.rangeEndISO);
  if (!rangeStart || !rangeEnd || rangeEnd.getTime() <= rangeStart.getTime()) {
    return [] as PlannerDraftWorkBlock[];
  }

  const now = parseIso(input.nowISO) ?? new Date();
  const busy = input.busyIntervals
    .map((interval) => ({
      start: parseIso(interval.startISO),
      end: parseIso(interval.endISO),
    }))
    .filter((interval): interval is { start: Date; end: Date } => {
      return Boolean(
        interval.start &&
          interval.end &&
          interval.end.getTime() > interval.start.getTime(),
      );
    });

  const assignments = input.assignments
    .map((assignment) => ({
      ...assignment,
      dueAt: parseIso(assignment.dueAtISO),
    }))
    .filter((assignment): assignment is PlannerAssignmentInput & { dueAt: Date } => {
      return Boolean(assignment.dueAt && assignment.dueAt.getTime() > now.getTime());
    })
    .sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime());

  const output: PlannerDraftWorkBlock[] = [];

  for (const assignment of assignments) {
    const config = getPriorityConfig(assignment.priority);

    for (const offsetHours of config.offsetHours) {
      const durationMs = config.durationMinutes * MINUTE_MS;
      const targetEnd = new Date(assignment.dueAt.getTime() - offsetHours * HOUR_MS);
      let candidateStart = new Date(targetEnd.getTime() - durationMs);
      let candidateEnd = new Date(targetEnd.getTime());

      const earliestStart = new Date(
        assignment.dueAt.getTime() - LOOKBACK_DAYS_LIMIT * DAY_MS,
      );

      let found: { start: Date; end: Date } | null = null;

      for (let step = 0; step < LOOKBACK_STEPS_LIMIT; step += 1) {
        if (candidateEnd.getTime() > assignment.dueAt.getTime()) {
          candidateStart = new Date(candidateStart.getTime() - SLOT_SHIFT_MS);
          candidateEnd = new Date(candidateEnd.getTime() - SLOT_SHIFT_MS);
          continue;
        }
        if (candidateStart.getTime() < now.getTime()) {
          break;
        }
        if (candidateStart.getTime() < earliestStart.getTime()) {
          break;
        }
        if (!overlapsAny(candidateStart, candidateEnd, busy)) {
          found = {
            start: candidateStart,
            end: candidateEnd,
          };
          break;
        }

        candidateStart = new Date(candidateStart.getTime() - SLOT_SHIFT_MS);
        candidateEnd = new Date(candidateEnd.getTime() - SLOT_SHIFT_MS);
      }

      if (!found) {
        continue;
      }

      busy.push({ start: found.start, end: found.end });

      if (!overlapsRange(found.start, found.end, rangeStart, rangeEnd)) {
        continue;
      }

      output.push({
        assignmentId: assignment.assignmentId,
        title: `Work block: ${assignment.title}`,
        startAtISO: found.start.toISOString(),
        endAtISO: found.end.toISOString(),
        metadata: {
          heuristic_version: "v1",
          priority: assignment.priority,
          duration_minutes: config.durationMinutes,
          offset_hours: offsetHours,
        },
      });
    }
  }

  return output.sort((left, right) => {
    return Date.parse(left.startAtISO) - Date.parse(right.startAtISO);
  });
}

function getPriorityConfig(priority: AssignmentPriority) {
  if (priority === "High") {
    return {
      durationMinutes: 90,
      offsetHours: [168, 72, 24],
    };
  }

  if (priority === "Medium") {
    return {
      durationMinutes: 90,
      offsetHours: [96, 24],
    };
  }

  return {
    durationMinutes: 60,
    offsetHours: [24],
  };
}

function overlapsAny(start: Date, end: Date, busy: Array<{ start: Date; end: Date }>) {
  return busy.some((interval) => start.getTime() < interval.end.getTime() && end.getTime() > interval.start.getTime());
}

function overlapsRange(start: Date, end: Date, rangeStart: Date, rangeEnd: Date) {
  return start.getTime() < rangeEnd.getTime() && end.getTime() > rangeStart.getTime();
}

function parseIso(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ─── Free-slot detection ──────────────────────────────────────────────────────

export type FreeSlot = {
  start_iso: string;
  end_iso: string;
  duration_minutes: number;
  score: number; // 0–100
  reason: string;
};

export type RecommendedSession = {
  start_iso: string;
  end_iso: string;
  focus: string;
  priority: "high" | "medium" | "low";
};

/**
 * Detect free windows between `now` and `assignment.dueAt`, scored by
 * duration, time-of-day, and proximity to the deadline.
 */
export function detectFreeSlots(input: {
  assignment: PlannerAssignmentInput;
  busyIntervals: PlannerBusyInterval[];
  nowISO?: string;
  minSlotMinutes?: number;
  maxSlots?: number;
}): FreeSlot[] {
  const now = parseIso(input.nowISO) ?? new Date();
  const dueAt = parseIso(input.assignment.dueAtISO);
  if (!dueAt || dueAt.getTime() <= now.getTime()) {
    return [];
  }

  const minMs = (input.minSlotMinutes ?? 30) * MINUTE_MS;
  const maxSlots = input.maxSlots ?? 20;

  // Build merged busy intervals clamped to [now, dueAt]
  const merged = mergeBusyIntervals(
    input.busyIntervals
      .map((b) => ({ start: parseIso(b.startISO), end: parseIso(b.endISO) }))
      .filter((b): b is { start: Date; end: Date } => Boolean(b.start && b.end))
      .filter((b) => b.end.getTime() > now.getTime() && b.start.getTime() < dueAt.getTime())
      .map((b) => ({
        start: b.start.getTime() < now.getTime() ? now : b.start,
        end: b.end.getTime() > dueAt.getTime() ? dueAt : b.end,
      })),
  );

  // Walk the gaps
  const gaps: Array<{ start: Date; end: Date }> = [];
  let cursor = now;

  for (const busy of merged) {
    if (busy.start.getTime() > cursor.getTime()) {
      gaps.push({ start: cursor, end: busy.start });
    }
    if (busy.end.getTime() > cursor.getTime()) {
      cursor = busy.end;
    }
  }

  // Gap after last busy interval
  if (cursor.getTime() < dueAt.getTime()) {
    gaps.push({ start: cursor, end: dueAt });
  }

  const slots: FreeSlot[] = gaps
    .filter((gap) => gap.end.getTime() - gap.start.getTime() >= minMs)
    .map((gap) => buildFreeSlot(gap.start, gap.end, dueAt));

  slots.sort((a, b) => b.score - a.score);
  return slots.slice(0, maxSlots);
}

/**
 * Convert the top-scored free slots into concrete study session recommendations.
 */
export function recommendStudySessions(input: {
  assignment: PlannerAssignmentInput;
  freeSlots: FreeSlot[];
  estimatedEffortMinutes?: number;
}): RecommendedSession[] {
  const dueAt = parseIso(input.assignment.dueAtISO);
  if (!dueAt || input.freeSlots.length === 0) return [];

  const rawEffort = input.estimatedEffortMinutes ?? 90;
  const clampedEffort = Math.max(30, Math.min(480, rawEffort));
  // Floor to nearest 30-min increment
  const sessionDurationMs = Math.floor(clampedEffort / 30) * 30 * MINUTE_MS;

  const sessions: RecommendedSession[] = [];
  // Track scheduled windows to avoid overlap
  const scheduled: Array<{ start: Date; end: Date }> = [];

  for (const slot of input.freeSlots) {
    if (sessions.length >= 5) break;

    const slotStart = parseIso(slot.start_iso);
    const slotEnd = parseIso(slot.end_iso);
    if (!slotStart || !slotEnd) continue;

    // Find a non-overlapping start within this slot
    let sessionStart = slotStart;
    // Push past any already-scheduled sessions that overlap
    for (const s of scheduled) {
      if (
        sessionStart.getTime() < s.end.getTime() &&
        new Date(sessionStart.getTime() + sessionDurationMs).getTime() > s.start.getTime()
      ) {
        sessionStart = s.end;
      }
    }

    const sessionEnd = new Date(
      Math.min(sessionStart.getTime() + sessionDurationMs, slotEnd.getTime()),
    );
    const actualDuration = sessionEnd.getTime() - sessionStart.getTime();

    if (actualDuration < 30 * MINUTE_MS) continue;
    if (sessionStart.getTime() >= slotEnd.getTime()) continue;

    scheduled.push({ start: sessionStart, end: sessionEnd });

    const hoursUntilDue = (dueAt.getTime() - sessionStart.getTime()) / HOUR_MS;
    sessions.push({
      start_iso: sessionStart.toISOString(),
      end_iso: sessionEnd.toISOString(),
      focus: deriveFocusLabel(hoursUntilDue),
      priority: derivePriorityFromAssignment(input.assignment.priority),
    });
  }

  sessions.sort((a, b) => Date.parse(a.start_iso) - Date.parse(b.start_iso));
  return sessions;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mergeBusyIntervals(
  intervals: Array<{ start: Date; end: Date }>,
): Array<{ start: Date; end: Date }> {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: Array<{ start: Date; end: Date }> = [sorted[0]!];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (current.start.getTime() <= last.end.getTime()) {
      if (current.end.getTime() > last.end.getTime()) {
        last.end = current.end;
      }
    } else {
      merged.push(current);
    }
  }

  return merged;
}

function buildFreeSlot(start: Date, end: Date, dueAt: Date): FreeSlot {
  const durationMs = end.getTime() - start.getTime();
  const durationMinutes = Math.floor(durationMs / MINUTE_MS);

  const durationScore = Math.min(durationMinutes / 180, 1) * 40;

  const midpointHour = new Date(start.getTime() + durationMs / 2).getUTCHours();
  const timeOfDayScore = scoreTimeOfDay(midpointHour);

  const hoursUntilDue = (dueAt.getTime() - start.getTime()) / HOUR_MS;
  const proximityScore = scoreProximity(hoursUntilDue);

  const score = Math.round(durationScore + timeOfDayScore + proximityScore);

  return {
    start_iso: start.toISOString(),
    end_iso: end.toISOString(),
    duration_minutes: durationMinutes,
    score,
    reason: buildReason(hoursUntilDue, midpointHour),
  };
}

function scoreTimeOfDay(utcHour: number): number {
  if (utcHour >= 9 && utcHour < 12) return 30;
  if (utcHour >= 12 && utcHour < 18) return 25;
  if (utcHour >= 7 && utcHour < 9) return 15;
  if (utcHour >= 18 && utcHour < 21) return 10;
  return 0;
}

function scoreProximity(hoursUntilDue: number): number {
  if (hoursUntilDue >= 24 && hoursUntilDue < 72) return 30;
  if (hoursUntilDue >= 72 && hoursUntilDue < 168) return 20;
  if (hoursUntilDue >= 12 && hoursUntilDue < 24) return 10;
  if (hoursUntilDue >= 168) return 5;
  return 0;
}

function buildReason(hoursUntilDue: number, utcHour: number): string {
  const timeLabel = utcHour >= 9 && utcHour < 12
    ? "morning block"
    : utcHour >= 12 && utcHour < 18
      ? "afternoon block"
      : utcHour >= 18 && utcHour < 21
        ? "evening block"
        : "off-hours block";

  if (hoursUntilDue < 12) {
    return `${Math.round(hoursUntilDue)} hours before deadline — tight window`;
  }
  if (hoursUntilDue < 24) {
    return `Less than a day before deadline, ${timeLabel}`;
  }
  const days = Math.round(hoursUntilDue / 24);
  return `${days} day${days === 1 ? "" : "s"} before deadline, ${timeLabel}`;
}

function deriveFocusLabel(hoursUntilDue: number): string {
  if (hoursUntilDue > 168) return "Get ahead — plenty of time before deadline";
  if (hoursUntilDue > 72) return "Early progress — ideal time to start";
  if (hoursUntilDue > 24) return "Deep work — deadline approaching";
  return "Final push — deadline is very close";
}

function derivePriorityFromAssignment(
  priority: AssignmentPriority,
): RecommendedSession["priority"] {
  if (priority === "High") return "high";
  if (priority === "Medium") return "medium";
  return "low";
}
