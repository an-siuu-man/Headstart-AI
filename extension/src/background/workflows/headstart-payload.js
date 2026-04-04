/**
 * Helpers for building normalized Headstart payloads from stored assignment records.
 */

import {
  formatDateInTimezone,
  parseCanvasDueDate,
} from "../../shared/utils/date-time.js";

/**
 * Extract course and assignment IDs from a Canvas assignment URL.
 */
export function getCanvasIdsFromUrl(url) {
  const m = url?.match(/\/courses\/(\d+)\/assignments\/(\d+)/);
  if (!m) return null;
  return { courseId: m[1], assignmentId: m[2] };
}

/**
 * Build normalized payload for ingestion + agent execution.
 */
export function buildHeadstartPayload(stored) {
  const source = stored?.data ? stored.data : stored;
  const dueDateRaw = source?.dueDate || stored?.dueDate || null;

  const due = parseCanvasDueDate(dueDateRaw);
  const now = new Date();

  const daysToDue = due
    ? Math.ceil((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    : null;

  const userTimezone = source?.userTimezone || stored?.userTimezone || null;
  const dueAtISO = due ? due.toISOString() : null;
  const dueDateFormatted = formatDateInTimezone(dueAtISO, userTimezone);

  return {
    courseId: stored?.courseId ?? source?.courseId ?? null,
    courseName: stored?.courseName ?? source?.courseName ?? null,
    assignmentId: stored?.assignmentId ?? source?.assignmentId ?? null,

    title: source?.title ?? stored?.title ?? "",
    url: source?.url ?? stored?.url ?? "",

    detectedAt: stored?.detectedAt ?? null,
    status: stored?.status ?? null,

    dueDateRaw,
    dueAtISO,
    dueDateFormatted,
    userTimezone,
    userId: source?.userId ?? stored?.userId ?? null,

    flags: {
      daysToDue,
      isOverdue: typeof daysToDue === "number" ? daysToDue < 0 : false,
      isDueSoon:
        typeof daysToDue === "number"
          ? daysToDue >= 0 && daysToDue <= 3
          : false,
    },

    descriptionText: source?.descriptionText ?? null,
    rubric: source?.rubric ?? null,
    pdfs: source?.pdfs ?? [],
    pdfAttachments: source?.pdfAttachments ?? stored?.pdfAttachments ?? [],
    moduleResources: source?.moduleResources ?? stored?.moduleResources ?? [],
    moduleResourcesMeta: source?.moduleResourcesMeta ?? stored?.moduleResourcesMeta ?? null,
  };
}
