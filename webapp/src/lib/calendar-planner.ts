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
