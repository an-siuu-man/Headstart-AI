"use client"

import { useRef, useState } from "react"
import { format } from "date-fns"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { AlertCircle, CalendarDays, CheckCircle2, Loader2, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { cn } from "@/lib/utils"

const EASE_OUT = [0.22, 1, 0.36, 1] as const

type ProposalSession = {
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

type ScheduleResult = {
  created_count: number
  failed_count: number
  scheduled_events: ScheduledEvent[]
}

type Props = {
  assignmentId: string
  sessionId?: string
  sessions: ProposalSession[]
  timezone: string
  onScheduled: (result: ScheduleResult) => void
  onDismissed: () => void
}

type ViewState = "idle" | "scheduling" | "done"

function formatSessionTime(startIso: string, endIso: string): string {
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

export function CalendarProposalCard({
  assignmentId,
  sessionId,
  sessions,
  timezone,
  onScheduled,
  onDismissed,
}: Props) {
  const reduceMotion = useReducedMotion()
  const isSubmitting = useRef(false)
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(sessions.map((_, i) => i)),
  )
  const [view, setView] = useState<ViewState>("idle")
  const [result, setResult] = useState<ScheduleResult | null>(null)
  const [errorText, setErrorText] = useState<string | null>(null)

  const toggleSession = (index: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }

  const handleSchedule = async () => {
    if (isSubmitting.current) return
    isSubmitting.current = true

    const selectedSessions = sessions.filter((_, i) => selected.has(i))
    if (selectedSessions.length === 0) {
      isSubmitting.current = false
      return
    }

    setView("scheduling")
    setErrorText(null)

    try {
      const response = await fetch("/api/calendar/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assignment_id: assignmentId || undefined,
          session_id: sessionId || undefined,
          timezone,
          sessions: selectedSessions,
        }),
      })

      const data = (await response.json()) as ScheduleResult & { error?: string }

      if (!response.ok) {
        throw new Error(data.error ?? `Schedule failed (${response.status})`)
      }

      setResult(data)
      setView("done")
      onScheduled(data)
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err))
      setView("idle")
      isSubmitting.current = false
    }
  }

  const entrance = reduceMotion
    ? {}
    : {
        initial: { opacity: 0, y: 8 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.22, ease: EASE_OUT },
      }

  return (
    <motion.div {...entrance} className="mt-2">
      <Card className="border border-border/60 bg-card/80 shadow-sm backdrop-blur-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3 pt-4">
          <CalendarDays className="h-4 w-4 shrink-0 text-primary" />
          <span className="text-sm font-semibold">Schedule Study Sessions</span>
        </CardHeader>

        <CardContent className="pb-4">
          <AnimatePresence mode="wait">
            {view === "idle" && (
              <motion.div
                key="idle"
                initial={reduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                <p className="mb-3 text-xs text-muted-foreground">
                  Select the sessions you would like to add to Google Calendar:
                </p>

                <div className="space-y-2">
                  {sessions.map((session, i) => (
                    <label
                      key={i}
                      className={cn(
                        "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors",
                        selected.has(i)
                          ? "border-primary/40 bg-primary/5"
                          : "border-border/40 bg-muted/30 opacity-60",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(i)}
                        onChange={() => toggleSession(i)}
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium leading-snug text-foreground">
                          {formatSessionTime(session.start_iso, session.end_iso)}
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

                {errorText && (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    {errorText}
                  </p>
                )}

                <div className="mt-4 flex items-center gap-2">
                  <Button
                    size="sm"
                    disabled={selected.size === 0 || view !== "idle"}
                    onClick={handleSchedule}
                    className="h-8 text-xs"
                  >
                    Schedule Selected ({selected.size})
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={onDismissed}
                    className="h-8 text-xs text-muted-foreground"
                  >
                    Dismiss
                  </Button>
                </div>
              </motion.div>
            )}

            {view === "scheduling" && (
              <motion.div
                key="scheduling"
                initial={reduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="flex items-center gap-2 py-2 text-sm text-muted-foreground"
              >
                <Loader2 className="h-4 w-4 animate-spin" />
                Scheduling…
              </motion.div>
            )}

            {view === "done" && result && (
              <motion.div
                key="done"
                initial={reduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                <div className="mb-3 flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
                  <span className="text-sm font-medium">
                    {result.created_count === 1
                      ? "1 session added to Google Calendar"
                      : `${result.created_count} sessions added to Google Calendar`}
                    {result.failed_count > 0 && (
                      <span className="ml-1 text-muted-foreground">
                        ({result.failed_count} failed)
                      </span>
                    )}
                  </span>
                </div>

                <div className="space-y-1.5">
                  {result.scheduled_events.map((event, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                      {event.status === "created" ? (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-500" />
                      ) : (
                        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                      )}
                      <span className="truncate">
                        {formatSessionTime(event.start_iso, event.end_iso)}
                        {event.status === "failed" && event.error && ` — ${event.error}`}
                      </span>
                    </div>
                  ))}
                </div>

                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onDismissed}
                  className="mt-3 h-8 text-xs text-muted-foreground"
                >
                  <X className="mr-1 h-3.5 w-3.5" />
                  Close
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </CardContent>
      </Card>
    </motion.div>
  )
}
