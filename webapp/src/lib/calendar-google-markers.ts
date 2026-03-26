import type { GoogleCalendarListedEvent } from "@/lib/google-calendar";

export const HEADSTART_EVENT_TYPE_KEY = "headstart_event_type";
export const HEADSTART_EVENT_TYPE_STUDY = "study_time_block";
export const HEADSTART_ASSIGNMENT_ID_KEY = "headstart_assignment_id";
export const LEGACY_STUDY_TITLE_PREFIX = "study:";

export function isStudyTimeBlockGoogleEvent(event: Pick<
  GoogleCalendarListedEvent,
  "summary" | "extendedProperties"
>) {
  const marker = event.extendedProperties.private[HEADSTART_EVENT_TYPE_KEY];
  if (marker === HEADSTART_EVENT_TYPE_STUDY) {
    return true;
  }

  const normalizedSummary = (event.summary ?? "").trim().toLowerCase();
  return normalizedSummary.startsWith(LEGACY_STUDY_TITLE_PREFIX);
}
