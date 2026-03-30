import "server-only"

import { detectFreeSlots, recommendStudySessions, type FreeSlot, type PlannerBusyInterval, type RecommendedSession } from "@/lib/calendar-planner"
import { resolveAssignmentRecordIdForUser } from "@/lib/chat-repository"
import { GoogleCalendarApiError, listGoogleCalendarEvents, type GoogleCalendarListedEvent } from "@/lib/google-calendar"
import { ensureGoogleCalendarAccessToken } from "@/lib/google-calendar-session"
import { toOptionalString } from "@/lib/utils"
import {
  getAssignmentCalendarMetadataForUser,
  getGoogleCalendarIntegration,
  type GoogleCalendarIntegrationStatus,
  upsertNeedsAttentionGoogleCalendarIntegration,
} from "@/lib/google-calendar-repository"

export type CalendarContextAvailabilityReason =
  | "available"
  | "available_review_window"
  | "no_slots_before_deadline"
  | "no_slots_in_review_window"
  | "calendar_disconnected"
  | "calendar_needs_attention"
  | "calendar_fetch_failed"
  | "assignment_missing_due_date"
  | "assignment_past_due"
  | "assignment_unresolved"

export type AssignmentCalendarContext = {
  assignment_id: string | null
  timezone: string
  availability_reason: CalendarContextAvailabilityReason
  integration: {
    google: {
      status: GoogleCalendarIntegrationStatus
      connected: boolean
    }
  }
  no_slots_found: boolean
  free_slots: FreeSlot[]
  recommended_sessions: RecommendedSession[]
}

type AssignmentWindowMode = "deadline" | "review_window"
type CalendarContextCacheEntry = {
  value: AssignmentCalendarContext
  expiresAt: number
}

const CALENDAR_CONTEXT_CACHE_TTL_MS = 90_000
const REVIEW_WINDOW_DAYS = 7
const REVIEW_WINDOW_MS = REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000

declare global {
  var __headstartCalendarContextByKey:
    | Map<string, CalendarContextCacheEntry>
    | undefined
}

const sharedCalendarContextByKey =
  globalThis.__headstartCalendarContextByKey ??
  new Map<string, CalendarContextCacheEntry>()

if (!globalThis.__headstartCalendarContextByKey) {
  globalThis.__headstartCalendarContextByKey = sharedCalendarContextByKey
}

export async function getSharedAssignmentCalendarContextForChat(input: {
  userId: string
  assignmentRecordId: string | null | undefined
  requestUrl: string
  timezone?: string | null
  estimatedEffortMinutes?: number
  courseId?: string | null
  providerAssignmentId?: string | null
  assignmentUrl?: string | null
  bypassCache?: boolean
}): Promise<AssignmentCalendarContext> {
  const resolvedAssignmentRecordId = await resolveAssignmentRecordId(input)
  const normalizedTimezone = resolveTimezone(input.timezone, null)
  const normalizedEffort = clampEstimatedEffortMinutes(input.estimatedEffortMinutes)
  const assignmentCacheKey =
    resolvedAssignmentRecordId ??
    [
      "legacy",
      toOptionalString(input.courseId) ?? "-",
      toOptionalString(input.providerAssignmentId) ?? "-",
      toOptionalString(extractDomain(input.assignmentUrl)) ?? "-",
    ].join(":")
  const cacheKey = [
    `user=${input.userId}`,
    `assignment=${assignmentCacheKey}`,
    `tz=${normalizedTimezone}`,
    `effort=${normalizedEffort ?? "none"}`,
  ].join("|")

  if (!input.bypassCache) {
    const cached = readCachedContext(cacheKey)
    if (cached) {
      return cached
    }
  }

  const context = await buildAssignmentCalendarContextForUser({
    userId: input.userId,
    assignmentRecordId: resolvedAssignmentRecordId,
    requestUrl: input.requestUrl,
    timezone: input.timezone,
    estimatedEffortMinutes: normalizedEffort,
  })

  if (!input.bypassCache) {
    sharedCalendarContextByKey.set(cacheKey, {
      value: context,
      expiresAt: Date.now() + CALENDAR_CONTEXT_CACHE_TTL_MS,
    })
  }

  return context
}

export function invalidateAssignmentCalendarContextCache(input?: {
  userId?: string | null
  assignmentId?: string | null
}) {
  const normalizedUserId = toOptionalString(input?.userId)
  const normalizedAssignmentId = toOptionalString(input?.assignmentId)

  if (!normalizedUserId && !normalizedAssignmentId) {
    sharedCalendarContextByKey.clear()
    return
  }

  for (const [key] of sharedCalendarContextByKey) {
    if (normalizedUserId && !key.startsWith(`user=${normalizedUserId}|`)) {
      continue
    }
    if (
      normalizedAssignmentId &&
      !key.includes(`|assignment=${normalizedAssignmentId}|`)
    ) {
      continue
    }
    sharedCalendarContextByKey.delete(key)
  }
}

export async function buildAssignmentCalendarContextForUser(input: {
  userId: string
  assignmentRecordId: string | null | undefined
  requestUrl: string
  timezone?: string | null
  estimatedEffortMinutes?: number
}): Promise<AssignmentCalendarContext> {
  const normalizedAssignmentId = toOptionalString(input.assignmentRecordId)
  const metadata = normalizedAssignmentId
    ? await getAssignmentCalendarMetadataForUser({
        userId: input.userId,
        assignmentId: normalizedAssignmentId,
      })
    : null

  const integration = await getGoogleCalendarIntegration(input.userId)
  const integrationStatus = integration?.status ?? "disconnected"
  const timezone = resolveTimezone(input.timezone, metadata?.timezone)
  const baseContext = buildBaseContext({
    assignmentId: normalizedAssignmentId,
    timezone,
    googleStatus: integrationStatus,
  })

  if (!metadata) {
    return {
      ...baseContext,
      availability_reason: "assignment_unresolved",
    }
  }

  const dueAt = parseIso(metadata.dueAtISO)
  if (!dueAt) {
    return {
      ...buildBaseContext({
        assignmentId: metadata.assignmentId,
        timezone,
        googleStatus: integrationStatus,
      }),
      availability_reason: "assignment_missing_due_date",
    }
  }

  const now = new Date()
  const assignmentWindow = resolveAssignmentWindow({
    dueAt,
    now,
  })

  if (!assignmentWindow) {
    return {
      ...buildBaseContext({
        assignmentId: metadata.assignmentId,
        timezone,
        googleStatus: integrationStatus,
      }),
      availability_reason: "assignment_past_due",
    }
  }

  if (integrationStatus !== "connected") {
    invalidateAssignmentCalendarContextCache({ userId: input.userId })
    return {
      ...buildBaseContext({
        assignmentId: metadata.assignmentId,
        timezone,
        googleStatus: integrationStatus,
      }),
      availability_reason:
        integrationStatus === "needs_attention"
          ? "calendar_needs_attention"
          : "calendar_disconnected",
    }
  }

  const accessState = await ensureGoogleCalendarAccessToken({
    userId: input.userId,
    requestUrl: input.requestUrl,
  })

  if (!accessState.connected || !accessState.accessToken) {
    invalidateAssignmentCalendarContextCache({ userId: input.userId })
    return {
      ...buildBaseContext({
        assignmentId: metadata.assignmentId,
        timezone,
        googleStatus: accessState.status,
      }),
      availability_reason:
        accessState.status === "needs_attention"
          ? "calendar_needs_attention"
          : "calendar_disconnected",
    }
  }

  let busyIntervals: PlannerBusyInterval[]
  try {
    const listedEvents = await listGoogleCalendarEvents({
      accessToken: accessState.accessToken,
      timeMinIso: now.toISOString(),
      timeMaxIso: assignmentWindow.endsAt.toISOString(),
    })

    busyIntervals = listedEvents
      .map((event) => normalizeGoogleBusyWindow(event))
      .filter((event): event is PlannerBusyInterval => Boolean(event))
  } catch (error) {
    if (
      error instanceof GoogleCalendarApiError &&
      (error.status === 400 || error.status === 401 || error.status === 403)
    ) {
      await upsertNeedsAttentionGoogleCalendarIntegration({
        userId: input.userId,
        lastError: "Google authorization rejected by provider.",
      }).catch(() => undefined)
      invalidateAssignmentCalendarContextCache({ userId: input.userId })

      return {
        ...buildBaseContext({
          assignmentId: metadata.assignmentId,
          timezone,
          googleStatus: "needs_attention",
        }),
        availability_reason: "calendar_needs_attention",
      }
    }

    return {
      ...buildBaseContext({
        assignmentId: metadata.assignmentId,
        timezone,
        googleStatus: "connected",
      }),
      availability_reason: "calendar_fetch_failed",
    }
  }

  const plannerAssignment = {
    assignmentId: metadata.assignmentId,
    title: metadata.title,
    dueAtISO: assignmentWindow.endsAt.toISOString(),
    priority: derivePriority(assignmentWindow.endsAt.toISOString(), now.getTime()),
  }
  const freeSlots = detectFreeSlots({
    assignment: plannerAssignment,
    busyIntervals,
    nowISO: now.toISOString(),
  })
  const recommendedSessions = recommendStudySessions({
    assignment: plannerAssignment,
    freeSlots,
    estimatedEffortMinutes: clampEstimatedEffortMinutes(input.estimatedEffortMinutes),
  })

  return {
    assignment_id: metadata.assignmentId,
    timezone,
    availability_reason: deriveAvailabilityReason({
      mode: assignmentWindow.mode,
      hasSlots: freeSlots.length > 0,
    }),
    integration: {
      google: {
        status: "connected",
        connected: true,
      },
    },
    no_slots_found: freeSlots.length === 0,
    free_slots: freeSlots,
    recommended_sessions: recommendedSessions,
  }
}

export function normalizeGoogleBusyWindow(
  event: GoogleCalendarListedEvent,
): PlannerBusyInterval | null {
  if (event.status === "cancelled") return null

  if (event.start.dateTime) {
    const start = parseIso(event.start.dateTime)
    const end = parseIso(event.end.dateTime)
    if (!start || !end || end.getTime() <= start.getTime()) return null
    return { startISO: start.toISOString(), endISO: end.toISOString() }
  }

  if (event.start.date) {
    const start = parseIso(event.start.date)
    const end = parseIso(event.end.date)
    if (!start || !end || end.getTime() <= start.getTime()) return null
    return { startISO: start.toISOString(), endISO: end.toISOString() }
  }

  return null
}

function buildBaseContext(input: {
  assignmentId: string | null
  timezone: string
  googleStatus: GoogleCalendarIntegrationStatus
}): AssignmentCalendarContext {
  return {
    assignment_id: input.assignmentId,
    timezone: input.timezone,
    availability_reason: "assignment_unresolved",
    integration: {
      google: {
        status: input.googleStatus,
        connected: input.googleStatus === "connected",
      },
    },
    no_slots_found: false,
    free_slots: [],
    recommended_sessions: [],
  }
}

function resolveAssignmentWindow(input: {
  dueAt: Date
  now: Date
}): { mode: AssignmentWindowMode; endsAt: Date } | null {
  if (input.dueAt.getTime() > input.now.getTime()) {
    return {
      mode: "deadline",
      endsAt: input.dueAt,
    }
  }

  const reviewEndsAt = new Date(input.now.getTime() + REVIEW_WINDOW_MS)
  if (reviewEndsAt.getTime() <= input.now.getTime()) {
    return null
  }

  return {
    mode: "review_window",
    endsAt: reviewEndsAt,
  }
}

function deriveAvailabilityReason(input: {
  mode: AssignmentWindowMode
  hasSlots: boolean
}): CalendarContextAvailabilityReason {
  if (input.mode === "review_window") {
    return input.hasSlots ? "available_review_window" : "no_slots_in_review_window"
  }
  return input.hasSlots ? "available" : "no_slots_before_deadline"
}

async function resolveAssignmentRecordId(input: {
  userId: string
  assignmentRecordId: string | null | undefined
  courseId?: string | null
  providerAssignmentId?: string | null
  assignmentUrl?: string | null
}) {
  const normalizedAssignmentRecordId = toOptionalString(input.assignmentRecordId)
  if (normalizedAssignmentRecordId) {
    return normalizedAssignmentRecordId
  }
  return resolveAssignmentRecordIdForUser({
    userId: input.userId,
    courseId: input.courseId,
    assignmentId: input.providerAssignmentId,
    assignmentUrl: input.assignmentUrl,
  })
}

function readCachedContext(key: string) {
  const cached = sharedCalendarContextByKey.get(key)
  if (!cached) return null
  if (cached.expiresAt <= Date.now()) {
    sharedCalendarContextByKey.delete(key)
    return null
  }
  return cached.value
}

function clampEstimatedEffortMinutes(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined
  }
  return Math.max(30, Math.min(480, Math.round(value)))
}

function derivePriority(
  dueAtISO: string,
  nowTimestamp: number,
): "High" | "Medium" | "Low" {
  const dueAt = parseIso(dueAtISO)
  if (!dueAt) return "Low"

  const hoursUntilDue = (dueAt.getTime() - nowTimestamp) / (1000 * 60 * 60)
  if (hoursUntilDue <= 48) return "High"
  if (hoursUntilDue <= 24 * 7) return "Medium"
  return "Low"
}

function resolveTimezone(primary?: string | null, fallback?: string | null) {
  const candidates = [primary, fallback, "UTC"]
  for (const candidate of candidates) {
    const value = toOptionalString(candidate)
    if (!value) continue
    if (isValidTimezone(value)) return value
  }
  return "UTC"
}

function parseIso(value: string | null | undefined) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function extractDomain(value: string | null | undefined) {
  if (!value) return null
  try {
    return new URL(value).host.toLowerCase()
  } catch {
    return null
  }
}

function isValidTimezone(value: string) {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value })
    return true
  } catch {
    return false
  }
}
