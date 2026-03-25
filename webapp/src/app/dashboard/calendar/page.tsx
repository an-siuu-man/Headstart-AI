"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import FullCalendar from "@fullcalendar/react"
import dayGridPlugin from "@fullcalendar/daygrid"
import type { DatesSetArg, EventClickArg, EventInput } from "@fullcalendar/core"
import { CalendarDays, RefreshCcw } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

type CalendarEventSource = "assignment_due" | "google_event" | "proposed_block"
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

export default function DashboardCalendarPage() {
  const router = useRouter()
  const timezone = useMemo(() => {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  }, [])

  const [range, setRange] = useState<CalendarRange | null>(null)
  const [events, setEvents] = useState<CalendarApiEvent[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [googleStatus, setGoogleStatus] = useState<GoogleIntegrationStatus>("disconnected")

  const [showAssignmentDue, setShowAssignmentDue] = useState(true)
  const [showGoogleEvents, setShowGoogleEvents] = useState(true)
  const [showProposedBlocks, setShowProposedBlocks] = useState(true)

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
        if (event.source === "google_event") return showGoogleEvents
        return showProposedBlocks
      })
      .map((event) => toFullCalendarEvent(event))
  }, [events, showAssignmentDue, showGoogleEvents, showProposedBlocks])

  const sourceCounts = useMemo(() => {
    return {
      assignmentDue: events.filter((event) => event.source === "assignment_due").length,
      googleEvents: events.filter((event) => event.source === "google_event").length,
      proposedBlocks: events.filter((event) => event.source === "proposed_block").length,
    }
  }, [events])

  const onDatesSet = useCallback((arg: DatesSetArg) => {
    setRange({
      startISO: arg.start.toISOString(),
      endISO: arg.end.toISOString(),
    })
  }, [])

  const onEventClick = useCallback((arg: EventClickArg) => {
    const target = arg.event.url
    if (!target) return

    arg.jsEvent.preventDefault()
    if (target.startsWith("http")) {
      window.open(target, "_blank", "noopener,noreferrer")
      return
    }

    router.push(target)
  }, [router])

  const generateBlocks = useCallback(async (replaceExisting: boolean) => {
    if (!range) return

    setIsGenerating(true)
    setLoadError(null)

    try {
      const response = await fetch("/api/calendar/proposals/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          start_iso: range.startISO,
          end_iso: range.endISO,
          timezone,
          replace_existing: replaceExisting,
        }),
      })

      if (!response.ok) {
        const bodyText = await response.text()
        throw new Error(bodyText || `Failed to generate proposals (${response.status})`)
      }

      setReloadNonce((value) => value + 1)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setLoadError(message)
    } finally {
      setIsGenerating(false)
    }
  }, [range, timezone])

  return (
    <div className="flex h-full flex-col space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-3xl font-heading font-bold tracking-tight">Calendar Planner</h2>
          <p className="text-muted-foreground">
            Monthly view of assignment deadlines, Google events, and proposed work blocks.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className={cn(
              "px-2.5 py-1 text-xs font-medium",
              googleStatusTone(googleStatus),
            )}
          >
            Google: {googleStatusLabel(googleStatus)}
          </Badge>
          <Button
            variant="outline"
            disabled={!range || isGenerating}
            onClick={() => void generateBlocks(false)}
          >
            <CalendarDays className="mr-2 h-4 w-4" />
            Generate Proposals
          </Button>
          <Button
            disabled={!range || isGenerating}
            onClick={() => void generateBlocks(true)}
          >
            <RefreshCcw className="mr-2 h-4 w-4" />
            Regenerate
          </Button>
        </div>
      </div>

      {loadError ? (
        <p className="text-sm text-destructive">{loadError}</p>
      ) : null}

      <Card className="border-border/60 bg-card/90 shadow-[0_14px_36px_-24px_rgba(15,23,42,0.5)]">
        <CardHeader>
          <CardTitle>Monthly Calendar</CardTitle>
          <CardDescription>
            Toggle each source to focus on assignments, Google events, or your generated work plan.
          </CardDescription>
          <div className="flex flex-wrap items-center gap-2">
            <SourceToggle
              label={`Assignment Due (${sourceCounts.assignmentDue})`}
              active={showAssignmentDue}
              onToggle={() => setShowAssignmentDue((value) => !value)}
            />
            <SourceToggle
              label={`Google Events (${sourceCounts.googleEvents})`}
              active={showGoogleEvents}
              onToggle={() => setShowGoogleEvents((value) => !value)}
            />
            <SourceToggle
              label={`Proposed Blocks (${sourceCounts.proposedBlocks})`}
              active={showProposedBlocks}
              onToggle={() => setShowProposedBlocks((value) => !value)}
            />
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-xl border border-border/70 bg-background/70 p-3">
            <FullCalendar
              plugins={[dayGridPlugin]}
              initialView="dayGridMonth"
              height="auto"
              headerToolbar={{
                left: "prev,next today",
                center: "title",
                right: "",
              }}
              dayMaxEventRows={4}
              events={fullCalendarEvents}
              eventClick={onEventClick}
              datesSet={onDatesSet}
            />
          </div>
          {isLoading ? (
            <p className="mt-3 text-sm text-muted-foreground">Loading calendar...</p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}

function SourceToggle({
  label,
  active,
  onToggle,
}: {
  label: string
  active: boolean
  onToggle: () => void
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? "default" : "outline"}
      onClick={onToggle}
    >
      {label}
    </Button>
  )
}

function toFullCalendarEvent(event: CalendarApiEvent): EventInput {
  const tone = eventTone(event)
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

function eventTone(event: CalendarApiEvent) {
  if (event.source === "assignment_due") {
    if (event.status === "submitted") {
      return {
        background: "#dcfce7",
        border: "#16a34a",
        text: "#166534",
      }
    }
    return {
      background: "#fee2e2",
      border: "#dc2626",
      text: "#991b1b",
    }
  }

  if (event.source === "google_event") {
    return {
      background: "#ccfbf1",
      border: "#0f766e",
      text: "#134e4a",
    }
  }

  return {
    background: "#dbeafe",
    border: "#2563eb",
    text: "#1e3a8a",
  }
}

function googleStatusTone(status: GoogleIntegrationStatus) {
  if (status === "connected") {
    return "border-emerald-300/70 bg-emerald-50 text-emerald-700"
  }

  if (status === "needs_attention") {
    return "border-amber-300/70 bg-amber-50 text-amber-700"
  }

  return "border-slate-300/70 bg-slate-50 text-slate-700"
}

function googleStatusLabel(status: GoogleIntegrationStatus) {
  if (status === "connected") return "Connected"
  if (status === "needs_attention") return "Needs Attention"
  return "Not Connected"
}

