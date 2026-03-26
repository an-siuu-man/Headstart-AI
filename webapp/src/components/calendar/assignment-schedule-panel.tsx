"use client"

import { useRef, useState } from "react"
import { format } from "date-fns"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  X,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const EASE_OUT = [0.22, 1, 0.36, 1] as const

type FreeSlot = {
  start_iso: string
  end_iso: string
  duration_minutes: number
  score: number
  reason: string
}

type RecommendedSession = {
  start_iso: string
  end_iso: string
  focus: string
  priority: "high" | "medium" | "low"
}

type ScheduledEvent = {
  start_iso: string
  end_iso: string
  google_event_id: string | null
  html_link: string | null
  status: "created" | "failed"
  error?: string
}

type SlotsResponse = {
  no_slots_found: boolean
  free_slots: FreeSlot[]
  recommended_sessions: RecommendedSession[]
}

type PanelState = "idle" | "loading" | "loaded" | "scheduling"

type Props = {
  assignmentId: string
  title: string
  dueAtISO: string | null
  chatUrl: string | null
  timezone: string
  isDark: boolean
  onClose: () => void
  onScheduled: () => void
}

function formatSlotTime(startIso: string, endIso: string): string {
  try {
    const start = new Date(startIso)
    const end = new Date(endIso)
    const durationMs = end.getTime() - start.getTime()
    const durationMin = Math.round(durationMs / 60000)
    return `${format(start, "EEE, MMM d · h:mm a")} – ${format(end, "h:mm a")} (${durationMin} min)`
  } catch {
    return `${startIso} – ${endIso}`
  }
}

function priorityBadgeTone(priority: "high" | "medium" | "low") {
  if (priority === "high")
    return "border-red-400/60 bg-red-500/10 text-red-700 dark:text-red-300"
  if (priority === "medium")
    return "border-amber-400/60 bg-amber-500/10 text-amber-700 dark:text-amber-300"
  return "border-blue-400/60 bg-blue-500/10 text-blue-700 dark:text-blue-300"
}

export function AssignmentSchedulePanel({
  assignmentId,
  title,
  dueAtISO,
  chatUrl,
  timezone,
  onClose,
  onScheduled,
}: Props) {
  const reduceMotion = useReducedMotion()
  const isSubmitting = useRef(false)
  const [panelState, setPanelState] = useState<PanelState>("idle")
  const [slotsData, setSlotsData] = useState<SlotsResponse | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [showRawSlots, setShowRawSlots] = useState(false)
  const [scheduledEvents, setScheduledEvents] = useState<ScheduledEvent[]>([])
  const [errorText, setErrorText] = useState<string | null>(null)

  const dueLabel = dueAtISO
    ? (() => {
        try {
          return format(new Date(dueAtISO), "MMM d, yyyy h:mm a")
        } catch {
          return dueAtISO
        }
      })()
    : null

  const fetchSlots = async () => {
    setPanelState("loading")
    setErrorText(null)

    try {
      const response = await fetch("/api/calendar/slots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignment_id: assignmentId, timezone }),
      })

      const data = (await response.json()) as SlotsResponse & { error?: string }

      if (!response.ok) {
        throw new Error(data.error ?? `Failed to fetch slots (${response.status})`)
      }

      setSlotsData(data)
      setSelected(new Set(data.recommended_sessions.map((_, i) => i)))
      setPanelState("loaded")
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err))
      setPanelState("idle")
    }
  }

  const handleSchedule = async () => {
    if (!slotsData || isSubmitting.current) return
    isSubmitting.current = true

    const selectedSessions = slotsData.recommended_sessions.filter((_, i) => selected.has(i))
    if (selectedSessions.length === 0) {
      isSubmitting.current = false
      return
    }

    setPanelState("scheduling")
    setErrorText(null)

    try {
      const response = await fetch("/api/calendar/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignment_id: assignmentId, timezone, sessions: selectedSessions }),
      })

      const data = (await response.json()) as {
        scheduled_events?: ScheduledEvent[]
        error?: string
      }

      if (!response.ok) {
        throw new Error(data.error ?? `Schedule failed (${response.status})`)
      }

      setScheduledEvents(data.scheduled_events ?? [])
      setSelected(new Set())
      onScheduled()
      setPanelState("loaded")
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err))
      setPanelState("loaded")
      isSubmitting.current = false
    }
  }

  const toggleSession = (index: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const createdCount = scheduledEvents.filter((e) => e.status === "created").length

  return (
    <motion.div
      initial={reduceMotion ? false : { x: "100%", opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={reduceMotion ? undefined : { x: "100%", opacity: 0 }}
      transition={{ duration: 0.28, ease: EASE_OUT }}
      className="absolute inset-y-0 right-0 z-30 flex w-full flex-col overflow-hidden rounded-xl border border-border/70 bg-card/95 shadow-2xl backdrop-blur-sm sm:w-[380px]"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold leading-snug">{title}</p>
          {dueLabel && (
            <p className="mt-0.5 text-xs text-muted-foreground">Due {dueLabel}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {chatUrl && (
            <a
              href={chatUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
              title="Open chat session"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
            aria-label="Close panel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <AnimatePresence mode="wait">
          {/* Idle state */}
          {panelState === "idle" && (
            <motion.div
              key="idle"
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="space-y-3"
            >
              <p className="text-sm text-muted-foreground">
                Find free time slots on your calendar before this assignment&apos;s deadline and schedule
                study sessions.
              </p>
              {errorText && (
                <p className="flex items-center gap-1.5 text-xs text-destructive">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  {errorText}
                </p>
              )}
              <Button size="sm" onClick={() => void fetchSlots()} className="w-full">
                Find Free Time
              </Button>
            </motion.div>
          )}

          {/* Loading skeleton */}
          {panelState === "loading" && (
            <motion.div
              key="loading"
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="space-y-2.5"
            >
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-14 animate-pulse rounded-md bg-muted"
                  style={{ opacity: 1 - i * 0.2 }}
                />
              ))}
            </motion.div>
          )}

          {/* Loaded state */}
          {(panelState === "loaded" || panelState === "scheduling") && slotsData && (
            <motion.div
              key="loaded"
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="space-y-4"
            >
              {/* Post-schedule result */}
              {scheduledEvents.length > 0 && (
                <div className="rounded-md border border-border/50 bg-muted/30 p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
                    <span className="text-xs font-medium">
                      {createdCount === 1
                        ? "1 session added"
                        : `${createdCount} sessions added`}{" "}
                      to Google Calendar
                    </span>
                  </div>
                  <div className="space-y-1">
                    {scheduledEvents.map((event, i) => (
                      <div key={i} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        {event.status === "created" ? (
                          <CheckCircle2 className="h-3 w-3 shrink-0 text-green-500" />
                        ) : (
                          <AlertCircle className="h-3 w-3 shrink-0 text-destructive" />
                        )}
                        <span className="truncate">
                          {formatSlotTime(event.start_iso, event.end_iso)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {slotsData.no_slots_found ? (
                <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-4 text-center">
                  <p className="text-sm text-muted-foreground">
                    Your calendar looks fully booked before this deadline.
                  </p>
                </div>
              ) : (
                <>
                  <div>
                    <p className="mb-2 text-xs font-medium text-muted-foreground">
                      Recommended sessions
                    </p>
                    <div className="space-y-2">
                      {slotsData.recommended_sessions.map((session, i) => (
                        <label
                          key={i}
                          className={cn(
                            "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors",
                            selected.has(i)
                              ? "border-primary/40 bg-primary/5"
                              : "border-border/40 bg-muted/20 opacity-60",
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={selected.has(i)}
                            onChange={() => toggleSession(i)}
                            disabled={panelState === "scheduling"}
                            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium leading-snug">
                              {formatSlotTime(session.start_iso, session.end_iso)}
                            </p>
                            <p className="mt-0.5 text-xs text-muted-foreground">{session.focus}</p>
                          </div>
                          <Badge
                            variant="outline"
                            className={cn("shrink-0 text-[10px]", priorityBadgeTone(session.priority))}
                          >
                            {session.priority}
                          </Badge>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Raw free slots toggle */}
                  <div>
                    <button
                      type="button"
                      onClick={() => setShowRawSlots((v) => !v)}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      {showRawSlots ? (
                        <ChevronUp className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5" />
                      )}
                      {showRawSlots ? "Hide" : "Show"} all free slots ({slotsData.free_slots.length})
                    </button>

                    <AnimatePresence>
                      {showRawSlots && (
                        <motion.div
                          initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={reduceMotion ? undefined : { height: 0, opacity: 0 }}
                          transition={{ duration: 0.2 }}
                          className="mt-2 overflow-hidden"
                        >
                          <div className="space-y-1.5">
                            {slotsData.free_slots.map((slot, i) => (
                              <div
                                key={i}
                                className="rounded-md border border-border/30 bg-muted/10 px-2.5 py-2 text-xs"
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className="truncate text-foreground/80">
                                    {formatSlotTime(slot.start_iso, slot.end_iso)}
                                  </span>
                                  <span className="shrink-0 tabular-nums text-muted-foreground">
                                    score {slot.score}
                                  </span>
                                </div>
                                <p className="mt-0.5 text-muted-foreground">{slot.reason}</p>
                              </div>
                            ))}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </>
              )}

              {errorText && (
                <p className="flex items-center gap-1.5 text-xs text-destructive">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  {errorText}
                </p>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Footer actions */}
      {(panelState === "loaded" || panelState === "scheduling") &&
        slotsData &&
        !slotsData.no_slots_found && (
          <div className="flex items-center gap-2 border-t border-border/60 px-4 py-3">
            <Button
              size="sm"
              disabled={selected.size === 0 || panelState === "scheduling"}
              onClick={() => void handleSchedule()}
              className="flex-1 text-xs"
            >
              {panelState === "scheduling" ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  Scheduling…
                </>
              ) : (
                `Schedule Selected (${selected.size})`
              )}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onClose}
              className="text-xs text-muted-foreground"
            >
              Close
            </Button>
          </div>
        )}

      {panelState === "idle" ||
      (panelState === "loaded" && slotsData?.no_slots_found) ? (
        <div className="border-t border-border/60 px-4 py-3">
          <Button
            size="sm"
            variant="ghost"
            onClick={onClose}
            className="w-full text-xs text-muted-foreground"
          >
            Close
          </Button>
        </div>
      ) : null}
    </motion.div>
  )
}
