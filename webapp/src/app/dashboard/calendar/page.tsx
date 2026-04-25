"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import type { ElementType } from "react"
import { useRouter } from "next/navigation"
import FullCalendar from "@fullcalendar/react"
import dayGridPlugin from "@fullcalendar/daygrid"
import type { DatesSetArg, EventClickArg, EventInput } from "@fullcalendar/core"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { useTheme } from "next-themes"
import {
  AlertCircle,
  CalendarCheck,
  CalendarDays,
  CalendarX,
  Loader2,
  Wifi,
  WifiOff,
} from "lucide-react"

import { AssignmentSchedulePanel } from "@/components/calendar/assignment-schedule-panel"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

type CalendarEventSource = "assignment_due" | "google_event" | "study_time_block"
type GoogleIntegrationStatus = "connected" | "disconnected" | "needs_attention"

type CalendarApiEvent = {
  id: string
  source: CalendarEventSource
  title: string
  start_iso: string
  end_iso: string | null
  all_day: boolean
  assignment_id: string | null
  google_event_id: string | null
  status: string | null
  url: string | null
}

type CalendarApiResponse = {
  integration?: {
    google?: {
      status?: GoogleIntegrationStatus
      connected?: boolean
    }
  }
  events?: CalendarApiEvent[]
}

type CalendarRange = {
  startISO: string
  endISO: string
}

const EASE_OUT = [0.22, 1, 0.36, 1] as const

const pageContainer = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.09, delayChildren: 0.04 },
  },
}

const pageSection = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.32, ease: EASE_OUT } },
}

export default function DashboardCalendarPage() {
  const router = useRouter()
  const { resolvedTheme } = useTheme()
  const reduceMotion = useReducedMotion()
  const isDark = resolvedTheme === "dark"

  const timezone = useMemo(() => {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  }, [])

  const [range, setRange] = useState<CalendarRange | null>(null)
  const [events, setEvents] = useState<CalendarApiEvent[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [googleStatus, setGoogleStatus] = useState<GoogleIntegrationStatus>("disconnected")

  const [showAssignmentDue, setShowAssignmentDue] = useState(true)
  const [showGoogleEvents, setShowGoogleEvents] = useState(true)
  const [showStudyBlocks, setShowStudyBlocks] = useState(true)
  const [visibleMonthLabel, setVisibleMonthLabel] = useState("")
  const [panelAssignment, setPanelAssignment] = useState<{
    assignmentId: string
    title: string
    dueAtISO: string | null
    url: string | null
  } | null>(null)

  useEffect(() => {
    if (!range) return

    const abortController = new AbortController()

    const loadCalendarData = async () => {
      setIsLoading(true)
      try {
        const query = new URLSearchParams({
          start_iso: range.startISO,
          end_iso: range.endISO,
          timezone,
        })

        const response = await fetch(`/api/calendar/month?${query.toString()}`, {
          method: "GET",
          cache: "no-store",
          signal: abortController.signal,
        })

        if (!response.ok) {
          const bodyText = await response.text()
          throw new Error(bodyText || `Failed to load calendar (${response.status})`)
        }

        const body = (await response.json()) as CalendarApiResponse
        if (abortController.signal.aborted) return

        setEvents(Array.isArray(body.events) ? body.events : [])
        setGoogleStatus(body.integration?.google?.status ?? "disconnected")
        setLoadError(null)
      } catch (error) {
        if (abortController.signal.aborted) return
        const message = error instanceof Error ? error.message : String(error)
        setEvents([])
        setLoadError(message)
      } finally {
        if (!abortController.signal.aborted) {
          setIsLoading(false)
        }
      }
    }

    void loadCalendarData()

    return () => {
      abortController.abort()
    }
  }, [range, timezone, reloadNonce])

  const fullCalendarEvents = useMemo(() => {
    return events
      .filter((event) => {
        if (event.source === "assignment_due") return showAssignmentDue
        if (event.source === "study_time_block") return showStudyBlocks
        return showGoogleEvents
      })
      .map((event) => toFullCalendarEvent(event, isDark))
  }, [events, isDark, showAssignmentDue, showGoogleEvents, showStudyBlocks])

  const sourceCounts = useMemo(
    () => ({
      assignmentDue: events.filter((e) => e.source === "assignment_due").length,
      studyBlocks: events.filter((e) => e.source === "study_time_block").length,
      googleEvents: events.filter((e) => e.source === "google_event").length,
    }),
    [events],
  )

  const enabledSourceCount = useMemo(() => {
    return [showAssignmentDue, showStudyBlocks, showGoogleEvents].filter(Boolean).length
  }, [showAssignmentDue, showGoogleEvents, showStudyBlocks])

  const onDatesSet = useCallback((arg: DatesSetArg) => {
    setRange({
      startISO: arg.start.toISOString(),
      endISO: arg.end.toISOString(),
    })
    setVisibleMonthLabel(arg.view.title)
  }, [])

  const onEventClick = useCallback(
    (arg: EventClickArg) => {
      arg.jsEvent.preventDefault()

      const rawEvent = events.find((e) => e.id === arg.event.id)
      if (rawEvent?.source === "assignment_due" && rawEvent.assignment_id) {
        setPanelAssignment({
          assignmentId: rawEvent.assignment_id,
          title: rawEvent.title,
          dueAtISO: rawEvent.start_iso,
          url: rawEvent.url,
        })
        return
      }

      const target = arg.event.url
      if (!target) return

      if (target.startsWith("http")) {
        window.open(target, "_blank", "noopener,noreferrer")
        return
      }

      router.push(target)
    },
    [events, router],
  )

  return (
    <motion.div
      className="flex h-full flex-col space-y-6"
      variants={reduceMotion ? undefined : pageContainer}
      initial={reduceMotion ? false : "hidden"}
      animate={reduceMotion ? undefined : "show"}
    >
      <motion.div
        variants={reduceMotion ? undefined : pageSection}
        className="rounded-2xl border border-border/60 bg-gradient-to-br from-card/95 via-card/85 to-muted/40 p-4 shadow-[0_22px_44px_-32px_rgba(15,23,42,0.7)] backdrop-blur-sm sm:p-5"
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground/85">
              Study Schedule
            </p>
            <h2 className="text-3xl font-heading font-bold tracking-tight">Calendar Planner</h2>
            <p className="text-muted-foreground">
              Read deadlines at a glance, focus by source, and open assignments straight from the
              calendar.
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className="border-border/60 bg-background/70 px-2.5 py-1 text-xs font-medium"
              >
                {visibleMonthLabel || "Current Month"}
              </Badge>
              <Badge
                variant="outline"
                className="border-border/60 bg-background/70 px-2.5 py-1 text-xs font-medium"
              >
                {fullCalendarEvents.length} visible of {events.length} events
              </Badge>
              <Badge
                variant="outline"
                className="border-border/60 bg-background/70 px-2.5 py-1 text-xs font-medium"
              >
                {timezone}
              </Badge>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 lg:justify-end">
            <GoogleStatusBadge status={googleStatus} />
            <Badge
              variant="outline"
              className="border-border/60 bg-background/70 px-2.5 py-1 text-xs font-medium"
            >
              {enabledSourceCount} filter{enabledSourceCount === 1 ? "" : "s"} active
            </Badge>
          </div>
        </div>
      </motion.div>

      <AnimatePresence>
        {loadError && (
          <motion.div
            key="error"
            initial={reduceMotion ? false : { opacity: 0, y: -8, height: 0 }}
            animate={reduceMotion ? undefined : { opacity: 1, y: 0, height: "auto" }}
            exit={reduceMotion ? undefined : { opacity: 0, y: -8, height: 0 }}
            transition={{ duration: 0.22, ease: EASE_OUT }}
          >
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{loadError}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div variants={reduceMotion ? undefined : pageSection} className="relative flex-1">
        <AnimatePresence>
          {panelAssignment && (
            <AssignmentSchedulePanel
              assignmentId={panelAssignment.assignmentId}
              title={panelAssignment.title}
              dueAtISO={panelAssignment.dueAtISO}
              chatUrl={panelAssignment.url}
              timezone={timezone}
              isDark={isDark}
              onClose={() => setPanelAssignment(null)}
              onScheduled={() => setReloadNonce((n) => n + 1)}
            />
          )}
        </AnimatePresence>
        <Card className="headstart-calendar-shell overflow-hidden border-border/60 bg-card/90 shadow-[0_20px_42px_-28px_rgba(15,23,42,0.62)]">
          <CardHeader>
            <CardTitle>{visibleMonthLabel || "Monthly Calendar"}</CardTitle>
            <CardDescription>
              Filter event sources to declutter the month view and focus on what needs attention.
            </CardDescription>
            <div className="rounded-xl border border-border/65 bg-background/65 p-2">
              <div className="flex flex-wrap items-center gap-2">
                <SourceToggle
                  label="Assignment Due"
                  count={sourceCounts.assignmentDue}
                  active={showAssignmentDue}
                  onToggle={() => setShowAssignmentDue((v) => !v)}
                  dotClass="bg-red-500"
                  icon={CalendarX}
                />
                <SourceToggle
                  label="Study Time Blocks"
                  count={sourceCounts.studyBlocks}
                  active={showStudyBlocks}
                  onToggle={() => setShowStudyBlocks((v) => !v)}
                  dotClass="bg-blue-500"
                  icon={CalendarDays}
                />
                <SourceToggle
                  label="Google Events"
                  count={sourceCounts.googleEvents}
                  active={showGoogleEvents}
                  onToggle={() => setShowGoogleEvents((v) => !v)}
                  dotClass="bg-teal-500"
                  icon={CalendarCheck}
                />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="headstart-calendar-shell__frame relative rounded-2xl border border-border/70 bg-background/80 p-2.5 sm:p-3">
              <FullCalendar
                plugins={[dayGridPlugin]}
                initialView="dayGridMonth"
                height="auto"
                headerToolbar={{
                  left: "prev,next today",
                  center: "title",
                  right: "",
                }}
                fixedWeekCount={false}
                dayMaxEventRows={3}
                events={fullCalendarEvents}
                eventClick={onEventClick}
                datesSet={onDatesSet}
              />

              <AnimatePresence>
                {isLoading && (
                  <motion.div
                    key="loading-overlay"
                    initial={reduceMotion ? false : { opacity: 0 }}
                    animate={reduceMotion ? undefined : { opacity: 1 }}
                    exit={reduceMotion ? undefined : { opacity: 0 }}
                    transition={{ duration: 0.18 }}
                    className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
                  >
                    <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/90 px-3 py-1.5 text-sm text-muted-foreground shadow-[0_18px_30px_-24px_rgba(15,23,42,0.8)] backdrop-blur-sm">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Loading calendar...
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </motion.div>
  )
}

function SourceToggle({
  label,
  count,
  active,
  onToggle,
  dotClass,
  icon: Icon,
}: {
  label: string
  count: number
  active: boolean
  onToggle: () => void
  dotClass: string
  icon: ElementType
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className={cn(
        "inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "border-border/80 bg-card text-card-foreground shadow-[0_10px_20px_-16px_rgba(15,23,42,0.75)] hover:bg-muted/55"
          : "border-border/45 bg-background/40 text-muted-foreground/70 hover:border-border/70 hover:bg-background/70 hover:text-foreground/85",
      )}
    >
      <span
        className={cn("h-2 w-2 shrink-0 rounded-full", dotClass, !active && "opacity-30")}
      />
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span>{label}</span>
      <span
        className={cn(
          "ml-0.5 rounded-full border px-1.5 py-0.5 text-xs tabular-nums leading-none",
          active
            ? "border-border/70 bg-muted/70 text-muted-foreground"
            : "border-transparent bg-transparent text-muted-foreground/55",
        )}
      >
        {count}
      </span>
    </button>
  )
}

function GoogleStatusBadge({ status }: { status: GoogleIntegrationStatus }) {
  const Icon = status === "connected" ? Wifi : status === "needs_attention" ? AlertCircle : WifiOff

  return (
    <Badge
      variant="outline"
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium",
        googleStatusTone(status),
      )}
    >
      <Icon className="h-3 w-3 shrink-0" />
      Google: {googleStatusLabel(status)}
    </Badge>
  )
}

function toFullCalendarEvent(event: CalendarApiEvent, isDark: boolean): EventInput {
  const tone = eventTone(event, isDark)
  return {
    id: event.id,
    title: event.title,
    start: event.start_iso,
    end: event.end_iso ?? undefined,
    allDay: event.all_day,
    url: event.url ?? undefined,
    backgroundColor: tone.background,
    borderColor: tone.border,
    textColor: tone.text,
    classNames: ["headstart-calendar-event"],
  }
}

function eventTone(event: CalendarApiEvent, isDark: boolean) {
  if (event.source === "assignment_due") {
    if (event.status === "submitted") {
      return isDark
        ? { background: "rgba(22, 101, 52, 0.28)", border: "#4ade80", text: "#86efac" }
        : { background: "#dcfce7", border: "#16a34a", text: "#166534" }
    }
    return isDark
      ? { background: "rgba(153, 27, 27, 0.28)", border: "#f87171", text: "#fca5a5" }
      : { background: "#fee2e2", border: "#dc2626", text: "#991b1b" }
  }

  if (event.source === "study_time_block") {
    return isDark
      ? { background: "rgba(30, 58, 138, 0.32)", border: "#60a5fa", text: "#bfdbfe" }
      : { background: "#dbeafe", border: "#2563eb", text: "#1e3a8a" }
  }

  return isDark
    ? { background: "rgba(19, 78, 74, 0.32)", border: "#2dd4bf", text: "#99f6e4" }
    : { background: "#ccfbf1", border: "#0f766e", text: "#134e4a" }
}

function googleStatusTone(status: GoogleIntegrationStatus) {
  if (status === "connected") {
    return "border-emerald-300/70 bg-emerald-50 text-emerald-700 dark:border-emerald-500/35 dark:bg-emerald-500/12 dark:text-emerald-300"
  }
  if (status === "needs_attention") {
    return "border-amber-300/70 bg-amber-50 text-amber-700 dark:border-amber-500/35 dark:bg-amber-500/12 dark:text-amber-300"
  }
  return "border-slate-300/70 bg-slate-50 text-slate-600 dark:border-slate-500/35 dark:bg-slate-500/12 dark:text-slate-300"
}

function googleStatusLabel(status: GoogleIntegrationStatus) {
  if (status === "connected") return "Connected"
  if (status === "needs_attention") return "Needs Attention"
  return "Not Connected"
}
