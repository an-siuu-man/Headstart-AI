"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { LoaderCircle, Search, Trash2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { formatDateTime } from "@/lib/chat-utils"
import { type ChatSessionStatus } from "@/lib/chat-types"

const EASE_OUT = [0.22, 1, 0.36, 1] as const

type ChatSessionListItemResponse = {
  session_id: string
  assignment_uuid: string
  title: string
  last_user_message?: string | null
  status: ChatSessionStatus
  created_at: number
  updated_at: number
  context: {
    assignment_title: string
    course_name: string | null
    due_at_iso: string | null
    attachment_count: number
  }
}

type ChatSessionAssignmentGroup = {
  groupKey: string
  assignmentTitle: string
  courseName: string | null
  dueAtISO: string | null
  latestUpdatedAt: number
  sessions: ChatSessionListItemResponse[]
}

type SessionStatusFilter = "all" | "active" | "completed" | "failed"

function isActiveSessionStatus(status: ChatSessionStatus) {
  return status === "running" || status === "queued"
}

function matchesStatusFilter(status: ChatSessionStatus, filter: SessionStatusFilter) {
  if (filter === "all") return true
  if (filter === "active") return isActiveSessionStatus(status)
  if (filter === "completed") return status === "completed"
  if (filter === "failed") return status === "failed"
  return true
}

function normalizeSessionSearchQuery(value: string) {
  return value.replace(/[\u200B-\u200D\uFEFF]/g, "").trim().toLowerCase()
}

export function ChatSessionList() {
  const router = useRouter()
  const reduceMotion = useReducedMotion()

  const [sessionList, setSessionList] = useState<ChatSessionListItemResponse[]>([])
  const [isSessionListLoading, setIsSessionListLoading] = useState(false)
  const [sessionListError, setSessionListError] = useState<string | null>(null)
  const [deletingSessionIds, setDeletingSessionIds] = useState<Set<string>>(new Set())
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<SessionStatusFilter>("all")

  useEffect(() => {
    let isDisposed = false
    setIsSessionListLoading(true)
    setSessionListError(null)

    const loadSessions = async () => {
      try {
        const response = await fetch("/api/chat-session", {
          method: "GET",
          cache: "no-store",
        })
        if (!response.ok) {
          const bodyText = await response.text()
          throw new Error(bodyText || `Failed to load chats (${response.status})`)
        }

        const body = (await response.json()) as {
          sessions?: ChatSessionListItemResponse[]
        }
        if (isDisposed) return
        setSessionList(Array.isArray(body.sessions) ? body.sessions : [])
      } catch (error) {
        if (isDisposed) return
        const message = error instanceof Error ? error.message : String(error)
        setSessionListError(message)
      } finally {
        if (!isDisposed) {
          setIsSessionListLoading(false)
        }
      }
    }

    void loadSessions()

    return () => {
      isDisposed = true
    }
  }, [])

  const statusCounts = useMemo(() => {
    let active = 0
    let completed = 0
    let failed = 0

    for (const item of sessionList) {
      if (isActiveSessionStatus(item.status)) active += 1
      if (item.status === "completed") completed += 1
      if (item.status === "failed") failed += 1
    }

    return {
      all: sessionList.length,
      active,
      completed,
      failed,
    }
  }, [sessionList])

  const filteredSessions = useMemo(() => {
    const q = normalizeSessionSearchQuery(searchQuery)
    return sessionList.filter((item) => {
      if (!matchesStatusFilter(item.status, statusFilter)) return false
      if (!q) return true
      const title = (item.context.assignment_title || item.title || "").toLowerCase()
      const preview = (item.last_user_message || "").toLowerCase()
      return title.includes(q) || preview.includes(q)
    })
  }, [sessionList, searchQuery, statusFilter])

  const sessionGroups = useMemo(() => {
    const grouped = new Map<string, ChatSessionAssignmentGroup>()

    for (const item of filteredSessions) {
      const rawTitle = (item.context.assignment_title || item.title || "").trim()
      const assignmentTitle = rawTitle || "(untitled assignment)"
      const incomingCourseName = item.context.course_name?.trim() || null
      const groupKey =
        assignmentTitle !== "(untitled assignment)"
          ? assignmentTitle.toLocaleLowerCase().replace(/\s+/g, " ").trim()
          : `untitled::${item.assignment_uuid || item.session_id}`

      const existing = grouped.get(groupKey)
      if (existing) {
        existing.sessions.push(item)
        existing.latestUpdatedAt = Math.max(existing.latestUpdatedAt, item.updated_at)
        if (!existing.courseName && incomingCourseName) {
          existing.courseName = incomingCourseName
        } else if (
          existing.courseName &&
          incomingCourseName &&
          existing.courseName !== "Multiple courses" &&
          existing.courseName.toLocaleLowerCase() !== incomingCourseName.toLocaleLowerCase()
        ) {
          existing.courseName = "Multiple courses"
        }
        if (!existing.dueAtISO && item.context.due_at_iso) {
          existing.dueAtISO = item.context.due_at_iso
        }
      } else {
        grouped.set(groupKey, {
          groupKey,
          assignmentTitle,
          courseName: incomingCourseName,
          dueAtISO: item.context.due_at_iso,
          latestUpdatedAt: item.updated_at,
          sessions: [item],
        })
      }
    }

    return Array.from(grouped.values())
      .map((group) => ({
        ...group,
        sessions: group.sessions.slice().sort((a, b) => b.updated_at - a.updated_at),
      }))
      .sort((a, b) => b.latestUpdatedAt - a.latestUpdatedAt)
  }, [filteredSessions])

  const pendingDeleteSession = pendingDeleteSessionId
    ? sessionList.find((item) => item.session_id === pendingDeleteSessionId) ?? null
    : null

  function handleOpenSession(nextSessionId: string) {
    router.push(`/dashboard/chat?session=${encodeURIComponent(nextSessionId)}`)
  }

  function handleRequestDeleteSession(targetSessionId: string) {
    setPendingDeleteSessionId(targetSessionId)
  }

  function handleSearchQueryChange(value: string) {
    setSearchQuery(value)
    if (!normalizeSessionSearchQuery(value)) {
      setStatusFilter("all")
    }
  }

  async function handleConfirmDeleteSession() {
    if (!pendingDeleteSession) {
      setPendingDeleteSessionId(null)
      return
    }

    const targetSessionId = pendingDeleteSession.session_id
    setDeletingSessionIds((previous) => {
      const next = new Set(previous)
      next.add(targetSessionId)
      return next
    })
    setSessionListError(null)

    try {
      const response = await fetch(
        `/api/chat-session/${encodeURIComponent(targetSessionId)}`,
        {
          method: "DELETE",
        },
      )

      if (!response.ok) {
        const bodyText = await response.text()
        throw new Error(bodyText || `Failed to delete chat (${response.status})`)
      }

      setPendingDeleteSessionId(null)
      setSessionList((previous) =>
        previous.filter((item) => item.session_id !== targetSessionId),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setSessionListError(message)
    } finally {
      setDeletingSessionIds((previous) => {
        const next = new Set(previous)
        next.delete(targetSessionId)
        return next
      })
    }
  }

  return (
    <>
      <motion.div
        initial={reduceMotion ? false : { opacity: 0, y: 12 }}
        animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
        transition={reduceMotion ? undefined : { duration: 0.45, ease: EASE_OUT }}
        className="w-full space-y-6"
      >
        <motion.div
          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
          animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
          transition={reduceMotion ? undefined : { duration: 0.35, ease: EASE_OUT, delay: 0.05 }}
          className="relative rounded-2xl border border-border/50 bg-card/60 p-4 backdrop-blur"
        >
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-brand-blue">
            Dashboard Chat
          </p>
          <h1 className="text-3xl font-heading font-bold tracking-tight">Choose a Chat</h1>
          <p className="text-muted-foreground">
            Open a previous session to continue with saved messages and assignment context.
          </p>
        </motion.div>

        <motion.div
          initial={reduceMotion ? false : { opacity: 0, y: 10 }}
          animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
          transition={reduceMotion ? undefined : { duration: 0.4, ease: EASE_OUT, delay: 0.1 }}
          className="relative"
        >
          <Card className="border-border/50 bg-card/90 backdrop-blur">
            <CardContent className="space-y-4 p-4 sm:p-5">
              <div className="space-y-3">
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="text"
                    inputMode="search"
                    enterKeyHint="search"
                    placeholder="Search chats by assignment or message preview..."
                    className="pl-8"
                    value={searchQuery}
                    onChange={(event) => handleSearchQueryChange(event.target.value)}
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {(
                    [
                      { key: "all", label: "All", count: statusCounts.all },
                      { key: "active", label: "Active", count: statusCounts.active },
                      { key: "completed", label: "Completed", count: statusCounts.completed },
                      { key: "failed", label: "Failed", count: statusCounts.failed },
                    ] satisfies Array<{ key: SessionStatusFilter; label: string; count: number }>
                  ).map((filter) => {
                    const selected = statusFilter === filter.key
                    return (
                      <button
                        key={filter.key}
                        type="button"
                        onClick={() => setStatusFilter(filter.key)}
                        className={[
                          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                          selected
                            ? "border-brand-blue/40 bg-brand-blue/10 text-brand-blue"
                            : "border-border/60 bg-background text-muted-foreground hover:border-brand-blue/30 hover:text-foreground",
                        ].join(" ")}
                      >
                        <span>{filter.label}</span>
                        <span
                          className={[
                            "rounded-full px-1.5 py-0.5 text-[11px] leading-none",
                            selected
                              ? "bg-brand-blue/15 text-brand-blue"
                              : "bg-muted text-muted-foreground",
                          ].join(" ")}
                        >
                          {filter.count}
                        </span>
                      </button>
                    )
                  })}

                  {(searchQuery.trim().length > 0 || statusFilter !== "all") ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 rounded-full px-3 text-xs"
                      onClick={() => {
                        setSearchQuery("")
                        setStatusFilter("all")
                      }}
                    >
                      Clear filters
                    </Button>
                  ) : null}
                </div>
              </div>

              {sessionListError ? (
                <p className="text-sm text-destructive">{sessionListError}</p>
              ) : null}

              {!isSessionListLoading && !sessionListError && sessionList.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No chats found yet. Generate a guide from the extension to create your first chat.
                </p>
              ) : null}

              {!isSessionListLoading && !sessionListError && sessionList.length > 0 && filteredSessions.length === 0 ? (
                <div className="rounded-xl border border-border/60 bg-background/40 px-4 py-3 text-sm text-muted-foreground">
                  <p>No sessions match your search.</p>
                </div>
              ) : null}

              <AnimatePresence mode="wait" initial={false}>
                {isSessionListLoading ? (
                  <motion.div
                    key="chat-list-loading"
                    initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                    animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
                    exit={reduceMotion ? undefined : { opacity: 0, y: -4 }}
                    transition={reduceMotion ? undefined : { duration: 0.2, ease: EASE_OUT }}
                    className="space-y-2"
                  >
                    <p className="text-sm text-muted-foreground">Loading chat sessions...</p>
                    {Array.from({ length: 4 }).map((_, index) => (
                      <motion.div
                        key={`chat-loading-skeleton-${index}`}
                        animate={reduceMotion ? undefined : { opacity: [0.38, 0.86, 0.38] }}
                        transition={
                          reduceMotion
                            ? undefined
                            : { duration: 1.3, ease: "easeInOut", repeat: Number.POSITIVE_INFINITY, delay: index * 0.08 }
                        }
                        className="rounded-xl border border-border/60 bg-background/40 p-3"
                      >
                        <div className="h-3 w-2/3 rounded bg-muted/80" />
                        <div className="mt-2 h-2.5 w-1/3 rounded bg-muted/70" />
                        <div className="mt-3 h-2.5 w-1/2 rounded bg-muted/70" />
                      </motion.div>
                    ))}
                  </motion.div>
                ) : sessionGroups.length > 0 ? (
                  <motion.div
                    key="chat-list-loaded"
                    initial={reduceMotion ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15, ease: EASE_OUT }}
                    className="space-y-3"
                    layout
                  >
                    <AnimatePresence initial={false}>
                      {sessionGroups.map((group, groupIndex) => (
                        <motion.section
                          key={group.groupKey}
                          layout
                          initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -4 }}
                          transition={{
                            duration: 0.2,
                            ease: EASE_OUT,
                            delay: reduceMotion ? 0 : Math.min(groupIndex * 0.02, 0.08),
                          }}
                          className="space-y-2"
                        >
                          <p className="truncate text-sm font-semibold text-foreground">
                            {group.assignmentTitle}
                          </p>

                          <div className="space-y-2">
                            <AnimatePresence initial={false}>
                              {group.sessions.map((item, sessionIndex) => {
                              const updatedAtText = formatDateTime(item.updated_at) || "-"
                              const sessionLabel =
                                typeof item.last_user_message === "string" &&
                                item.last_user_message.trim().length > 0
                                  ? item.last_user_message.trim()
                                  : "Chat Session"
                              const isDeleting = deletingSessionIds.has(item.session_id)

                              return (
                                <motion.div
                                  key={item.session_id}
                                  layout
                                  initial={reduceMotion ? false : { opacity: 0, y: 6, scale: 0.995 }}
                                  animate={reduceMotion ? undefined : { opacity: 1, y: 0, scale: 1 }}
                                  exit={reduceMotion ? undefined : { opacity: 0, y: -6, scale: 0.99 }}
                                  transition={
                                    reduceMotion
                                      ? undefined
                                      : {
                                          duration: 0.2,
                                          ease: EASE_OUT,
                                          delay: Math.min(
                                            groupIndex * 0.02 + sessionIndex * 0.015,
                                            0.12,
                                          ),
                                        }
                                  }
                                  className="w-full rounded-lg border border-border/60 bg-background/60 p-3 text-left transition-colors hover:border-brand-blue/40 hover:bg-brand-blue/5"
                                >
                                  <div className="flex items-start gap-2">
                                    <button
                                      type="button"
                                      onClick={() => handleOpenSession(item.session_id)}
                                      className="min-w-0 flex-1 text-left"
                                      disabled={isDeleting}
                                    >
                                      <div className="flex flex-wrap items-start justify-between gap-2">
                                        <p className="truncate text-sm font-medium text-foreground">
                                          {sessionLabel}
                                        </p>
                                        <Badge variant="outline" className="capitalize">
                                          {item.status}
                                        </Badge>
                                      </div>
                                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                        <span>Updated {updatedAtText}</span>
                                        <span>Attachments: {item.context.attachment_count}</span>
                                      </div>
                                    </button>

                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      className="h-8 w-8 shrink-0 rounded-full text-muted-foreground hover:text-destructive"
                                      onClick={() => handleRequestDeleteSession(item.session_id)}
                                      disabled={isDeleting}
                                      aria-label={`Delete chat: ${sessionLabel}`}
                                      title="Delete chat"
                                    >
                                      {isDeleting ? (
                                        <LoaderCircle className="h-4 w-4 animate-spin" />
                                      ) : (
                                        <Trash2 className="h-4 w-4" />
                                      )}
                                    </Button>
                                  </div>
                                </motion.div>
                              )
                              })}
                            </AnimatePresence>
                          </div>
                        </motion.section>
                      ))}
                    </AnimatePresence>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </CardContent>
          </Card>
        </motion.div>
      </motion.div>

      <Dialog
        open={Boolean(pendingDeleteSession)}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDeleteSessionId(null)
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Chat Session?</DialogTitle>
            <DialogDescription>
              This will permanently delete the chat, all messages, and associated attachments.
            </DialogDescription>
          </DialogHeader>
          {pendingDeleteSession ? (
            <p className="mt-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-sm">
              {(pendingDeleteSession.title ||
                pendingDeleteSession.context.assignment_title ||
                "Untitled chat").trim()}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPendingDeleteSessionId(null)}
              disabled={Boolean(
                pendingDeleteSession &&
                  deletingSessionIds.has(pendingDeleteSession.session_id),
              )}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleConfirmDeleteSession()}
              disabled={Boolean(
                pendingDeleteSession &&
                  deletingSessionIds.has(pendingDeleteSession.session_id),
              )}
            >
              {pendingDeleteSession &&
              deletingSessionIds.has(pendingDeleteSession.session_id) ? (
                <>
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete Chat"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
