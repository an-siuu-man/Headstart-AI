"use client"

import { type FormEvent, Suspense, useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "next/navigation"
import { format } from "date-fns"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { Bot, FileText, LoaderCircle, Send } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"

type PdfAttachment = {
  filename?: string
  base64Data?: string
}

type AssignmentPayload = {
  title?: string
  courseName?: string
  courseId?: string | number
  assignmentId?: string | number
  dueAtISO?: string
  pointsPossible?: number
  rubric?: {
    criteria?: unknown[]
  }
  pdfAttachments?: PdfAttachment[]
}

type ChatSessionStatus = "queued" | "running" | "completed" | "failed"
type ChatSessionStage =
  | "queued"
  | "preparing_payload"
  | "extracting_pdf"
  | "calling_agent"
  | "streaming_output"
  | "validating_output"
  | "parsing_response"
  | "chat_streaming"
  | "completed"
  | "failed"

type ChatMessageResponse = {
  id: string
  message_index: number
  sender_role: "user" | "assistant" | "system"
  content_text: string
  content_format: "plain_text" | "markdown" | "json"
  metadata: Record<string, unknown>
  created_at: string
}

type ChatSessionResponse = {
  ok: boolean
  session_id: string
  assignment_uuid: string
  user_id: string
  created_at: number
  updated_at: number
  status: ChatSessionStatus
  stage: ChatSessionStage
  progress_percent: number
  status_message: string
  streamed_guide_markdown: string
  result: unknown | null
  error: string | null
  payload: AssignmentPayload
  messages: ChatMessageResponse[]
}

const EASE_OUT = [0.22, 1, 0.36, 1] as const
const THINK_OPEN_TAG = "<think>"
const THINK_CLOSE_TAG = "</think>"
const STATUS_BADGE_TONES = [
  "border-emerald-400/60 bg-emerald-500/15 text-emerald-800 dark:text-emerald-200",
  "border-sky-400/60 bg-sky-500/15 text-sky-800 dark:text-sky-200",
  "border-violet-400/60 bg-violet-500/15 text-violet-800 dark:text-violet-200",
  "border-rose-400/60 bg-rose-500/15 text-rose-800 dark:text-rose-200",
] as const
const STAGE_BADGE_TONES = [
  "border-cyan-400/60 bg-cyan-500/15 text-cyan-800 dark:text-cyan-200",
  "border-amber-400/60 bg-amber-500/15 text-amber-800 dark:text-amber-200",
  "border-fuchsia-400/60 bg-fuchsia-500/15 text-fuchsia-800 dark:text-fuchsia-200",
  "border-lime-400/60 bg-lime-500/15 text-lime-800 dark:text-lime-200",
  "border-indigo-400/60 bg-indigo-500/15 text-indigo-800 dark:text-indigo-200",
] as const

function normalizeResult(result: unknown) {
  if (result == null) return result
  if (typeof result === "object") return result
  if (typeof result === "string") {
    try {
      return JSON.parse(result)
    } catch {
      return { tldr: result }
    }
  }
  return result
}

function extractGuideMarkdown(result: unknown) {
  const data = normalizeResult(result) as Record<string, unknown> | null
  if (typeof data?.guideMarkdown === "string" && data.guideMarkdown.trim()) {
    return data.guideMarkdown
  }
  if (typeof data?.description === "string" && data.description.trim()) {
    return data.description
  }
  if (typeof data?.tldr === "string" && data.tldr.trim()) {
    return data.tldr
  }
  if (typeof result === "string") {
    return result
  }
  return JSON.stringify(result, null, 2)
}

function removeThinkBlocks(markdown: string) {
  if (!markdown) {
    return { visibleMarkdown: "", isThinking: false }
  }

  let cursor = 0
  let visible = ""

  while (cursor < markdown.length) {
    const openIndex = markdown.indexOf(THINK_OPEN_TAG, cursor)
    if (openIndex === -1) {
      visible += markdown.slice(cursor)
      break
    }

    visible += markdown.slice(cursor, openIndex)
    const thinkStart = openIndex + THINK_OPEN_TAG.length
    const closeIndex = markdown.indexOf(THINK_CLOSE_TAG, thinkStart)

    if (closeIndex === -1) {
      return {
        visibleMarkdown: visible.replaceAll(THINK_CLOSE_TAG, ""),
        isThinking: true,
      }
    }

    cursor = closeIndex + THINK_CLOSE_TAG.length
  }

  return {
    visibleMarkdown: visible.replaceAll(THINK_CLOSE_TAG, ""),
    isThinking: false,
  }
}

function stageLabel(stage: ChatSessionStage) {
  switch (stage) {
    case "queued":
      return "Queued"
    case "preparing_payload":
      return "Preparing"
    case "calling_agent":
      return "Calling Agent"
    case "extracting_pdf":
      return "Extracting PDF"
    case "streaming_output":
      return "Streaming Output"
    case "validating_output":
      return "Validating Output"
    case "parsing_response":
      return "Parsing Response"
    case "chat_streaming":
      return "Chat Streaming"
    case "completed":
      return "Completed"
    case "failed":
      return "Failed"
    default:
      return stage
  }
}

function ChatPageFallback() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-heading font-bold tracking-tight">Chat</h1>
        <p className="text-muted-foreground">Loading chat session...</p>
      </div>
      <Card>
        <CardContent className="py-8">
          <p className="text-sm text-muted-foreground">Preparing dashboard chat...</p>
        </CardContent>
      </Card>
    </div>
  )
}

function DashboardChatPageContent() {
  const searchParams = useSearchParams()
  const sessionId = (searchParams.get("session") || "").trim()

  const [session, setSession] = useState<ChatSessionResponse | null>(null)
  const [isPolling, setIsPolling] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [isSending, setIsSending] = useState(false)
  const [showProgressPanel, setShowProgressPanel] = useState(false)
  const [displayProgress, setDisplayProgress] = useState(0)
  const [statusToneIndex, setStatusToneIndex] = useState(0)
  const [stageToneIndex, setStageToneIndex] = useState(0)
  const threadContainerRef = useRef<HTMLDivElement | null>(null)
  const latestSessionRef = useRef<ChatSessionResponse | null>(null)
  const previousGuideLengthRef = useRef(0)
  const progressHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reduceMotion = useReducedMotion()

  function scrollThreadToBottom(behavior: ScrollBehavior = "smooth") {
    const viewport = threadContainerRef.current?.querySelector<HTMLDivElement>(
      "[data-slot='scroll-area-viewport']"
    )
    if (!viewport) return
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior,
    })
  }

  function upsertSessionMessage(
    current: ChatSessionResponse,
    nextMessage: ChatMessageResponse,
  ) {
    const index = current.messages.findIndex((entry) => entry.id === nextMessage.id)
    const messages =
      index === -1
        ? [...current.messages, nextMessage]
        : current.messages.map((entry, messageIndex) =>
            messageIndex === index ? nextMessage : entry,
          )
    messages.sort((a, b) => a.message_index - b.message_index)
    return {
      ...current,
      messages,
      updated_at: Date.now(),
    }
  }

  function patchSessionMessageContent(
    current: ChatSessionResponse,
    messageId: string,
    updater: (previous: string) => string,
  ) {
    const index = current.messages.findIndex((entry) => entry.id === messageId)
    if (index === -1) return current
    const messages = current.messages.map((entry, messageIndex) =>
      messageIndex === index
        ? {
            ...entry,
            content_text: updater(entry.content_text),
          }
        : entry,
    )
    return {
      ...current,
      messages,
      updated_at: Date.now(),
    }
  }

  useEffect(() => {
    if (!sessionId) {
      return
    }

    const streamUrl = `/api/chat-session/${encodeURIComponent(sessionId)}/events`
    const eventSource = new EventSource(streamUrl)
    let isDisposed = false

    const applySession = (nextSession: ChatSessionResponse) => {
      if (isDisposed) return
      const previousSession = latestSessionRef.current

      if (previousSession?.status && previousSession.status !== nextSession.status) {
        setStatusToneIndex((prev) => (prev + 1) % STATUS_BADGE_TONES.length)
      }
      if (previousSession?.stage && previousSession.stage !== nextSession.stage) {
        setStageToneIndex((prev) => (prev + 1) % STAGE_BADGE_TONES.length)
      }

      latestSessionRef.current = nextSession
      setSession(nextSession)
      setIsPolling(false)
      setErrorText(null)

      if (progressHideTimerRef.current) {
        clearTimeout(progressHideTimerRef.current)
        progressHideTimerRef.current = null
      }
      if (nextSession.status === "queued" || nextSession.status === "running") {
        setShowProgressPanel(true)
        setDisplayProgress(
          Math.max(0, Math.min(100, Math.round(nextSession.progress_percent))),
        )
      } else if (nextSession.status === "completed") {
        setShowProgressPanel(true)
        setDisplayProgress(100)
        progressHideTimerRef.current = setTimeout(() => {
          setShowProgressPanel(false)
          progressHideTimerRef.current = null
        }, 900)
      } else if (nextSession.status === "failed") {
        setShowProgressPanel(false)
        setDisplayProgress(100)
      }
    }

    const parseSessionMessage = (event: MessageEvent<string>) => {
      try {
        const data = JSON.parse(event.data) as ChatSessionResponse
        applySession(data)
      } catch {
        setErrorText("Unable to parse session stream event.")
      }
    }

    const parseChatMessageCreated = (event: MessageEvent<string>) => {
      try {
        const message = JSON.parse(event.data) as ChatMessageResponse
        setSession((previous) => {
          if (!previous || previous.session_id !== sessionId) return previous
          return upsertSessionMessage(previous, message)
        })
        requestAnimationFrame(() => {
          scrollThreadToBottom("smooth")
        })
      } catch {
        setErrorText("Unable to parse chat message event.")
      }
    }

    const parseChatMessageDelta = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as {
          message_id?: string
          delta?: string
          content?: string
        }
        if (!payload.message_id) return
        const messageId = payload.message_id

        setSession((previous) => {
          if (!previous || previous.session_id !== sessionId) return previous
          return patchSessionMessageContent(previous, messageId, (previousText) => {
            if (typeof payload.content === "string") {
              return payload.content
            }
            return `${previousText}${payload.delta ?? ""}`
          })
        })
        requestAnimationFrame(() => {
          scrollThreadToBottom("smooth")
        })
      } catch {
        setErrorText("Unable to parse chat delta event.")
      }
    }

    const parseChatMessageCompleted = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as {
          message_id?: string
          content?: string
        }
        if (!payload.message_id || typeof payload.content !== "string") return
        const messageId = payload.message_id
        const content = payload.content

        setSession((previous) => {
          if (!previous || previous.session_id !== sessionId) return previous
          return patchSessionMessageContent(previous, messageId, () => content)
        })
        setIsSending(false)
      } catch {
        setErrorText("Unable to parse chat completion event.")
      }
    }

    const parseChatError = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as {
          message?: string
        }
        if (payload.message) {
          setErrorText(payload.message)
        }
      } catch {
        setErrorText("Unable to parse chat error event.")
      } finally {
        setIsSending(false)
      }
    }

    eventSource.addEventListener("session.snapshot", parseSessionMessage as EventListener)
    eventSource.addEventListener("session.update", parseSessionMessage as EventListener)
    eventSource.addEventListener("chat.message.created", parseChatMessageCreated as EventListener)
    eventSource.addEventListener("chat.message.delta", parseChatMessageDelta as EventListener)
    eventSource.addEventListener("chat.message.completed", parseChatMessageCompleted as EventListener)
    eventSource.addEventListener("chat.error", parseChatError as EventListener)

    eventSource.onerror = () => {
      if (isDisposed) return
      setIsPolling(true)
      if (!latestSessionRef.current) {
        setErrorText("Unable to connect to session stream.")
      }
    }

    eventSource.onopen = () => {
      if (isDisposed) return
      setIsPolling(false)
      setErrorText(null)
    }

    return () => {
      isDisposed = true
      if (progressHideTimerRef.current) {
        clearTimeout(progressHideTimerRef.current)
        progressHideTimerRef.current = null
      }
      eventSource.close()
    }
  }, [sessionId])

  const effectiveSession =
    sessionId && session?.session_id === sessionId ? session : null
  const payload = effectiveSession?.payload
  const attachmentCount = payload?.pdfAttachments?.length ?? 0
  const attachmentNames = (payload?.pdfAttachments ?? [])
    .map((item, index) => {
      const name = typeof item?.filename === "string" ? item.filename.trim() : ""
      return name || `attachment-${index + 1}.pdf`
    })
    .filter((name) => name.length > 0)
  const createdAtText = effectiveSession?.created_at
    ? format(new Date(effectiveSession.created_at), "MMM d, yyyy h:mm a")
    : null

  const rawGuideMarkdown = useMemo(() => {
    if (!effectiveSession) return ""
    if (effectiveSession.streamed_guide_markdown?.trim()) {
      return effectiveSession.streamed_guide_markdown
    }
    if (effectiveSession.status !== "completed") return ""
    return extractGuideMarkdown(effectiveSession.result)
  }, [effectiveSession])

  const { visibleMarkdown: guideMarkdown, isThinking } = useMemo(
    () => removeThinkBlocks(rawGuideMarkdown),
    [rawGuideMarkdown],
  )

  const hasGuideContent = guideMarkdown.trim().length > 0
  const showThinkingIndicator = Boolean(
    effectiveSession &&
      (effectiveSession.status === "running" || effectiveSession.status === "queued") &&
      isThinking &&
      !hasGuideContent,
  )

  useEffect(() => {
    const currentLength = guideMarkdown.length
    if (currentLength > previousGuideLengthRef.current) {
      requestAnimationFrame(() => {
        scrollThreadToBottom("smooth")
      })
    }
    previousGuideLengthRef.current = currentLength
  }, [guideMarkdown])

  useEffect(() => {
    if (!effectiveSession) return
    requestAnimationFrame(() => {
      scrollThreadToBottom("smooth")
    })
  }, [effectiveSession])

  const progressLabel =
    effectiveSession?.status === "completed"
      ? "Guide ready"
      : effectiveSession?.status_message || "Generating guide..."
  const progressPanelTone =
    effectiveSession?.status === "completed"
      ? "rounded-lg border border-emerald-300/60 bg-emerald-50/80 p-3 text-sm"
      : "rounded-lg border border-brand-gold/40 bg-brand-gold/10 p-3 text-sm"
  const resolvedErrorText = sessionId
    ? errorText
    : "Missing session id in URL. Open this page from the extension."
  const isSessionLoading = Boolean(
    sessionId && !effectiveSession && !resolvedErrorText && !isPolling,
  )
  const canSendMessage = Boolean(
    effectiveSession &&
      (effectiveSession.status === "completed" ||
        effectiveSession.stage === "chat_streaming") &&
      !isSending,
  )

  async function handleSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = draft.trim()
    if (!text) return
    if (!effectiveSession) return
    if (effectiveSession.status !== "completed" && effectiveSession.stage !== "chat_streaming") {
      setErrorText("Guide generation is still in progress.")
      return
    }

    setIsSending(true)
    setErrorText(null)

    try {
      const response = await fetch(
        `/api/chat-session/${encodeURIComponent(effectiveSession.session_id)}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            content: text,
          }),
        },
      )

      if (!response.ok) {
        const errorBody = await response.text()
        throw new Error(
          errorBody || `Chat request failed (${response.status})`,
        )
      }

      setDraft("")
      requestAnimationFrame(() => {
        scrollThreadToBottom("smooth")
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrorText(message)
      setIsSending(false)
    }
  }

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
      transition={reduceMotion ? undefined : { duration: 0.45, ease: EASE_OUT }}
      className="relative w-full space-y-6 overflow-hidden rounded-3xl border border-border/60 bg-gradient-to-b from-background via-background to-muted/20 p-4 shadow-[0_30px_90px_-45px_rgba(2,6,23,0.6)] md:p-6"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_70%_at_50%_-5%,rgba(148,163,184,0.12),transparent_62%),radial-gradient(120%_70%_at_50%_110%,rgba(100,116,139,0.08),transparent_68%)]" />

      <motion.div
        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
        animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
        transition={reduceMotion ? undefined : { duration: 0.35, ease: EASE_OUT, delay: 0.05 }}
        className="relative flex flex-col gap-3 rounded-2xl border border-border/50 bg-card/60 p-4 backdrop-blur sm:flex-row sm:items-end sm:justify-between"
      >
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-brand-blue">
            Dashboard Chat
          </p>
          <h1 className="text-3xl font-heading font-bold tracking-tight">Guide Workspace</h1>
          <p className="text-muted-foreground">
            The guide starts automatically after you click Generate Guide in the extension.
          </p>
        </div>
        {effectiveSession ? (
          <Badge variant="outline" className="w-fit border-brand-blue/40 bg-brand-blue/10 px-3 py-1.5 text-brand-blue">
            {stageLabel(effectiveSession.stage)}
          </Badge>
        ) : null}
      </motion.div>

      <motion.div
        initial={reduceMotion ? false : { opacity: 0, y: 10 }}
        animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
        transition={reduceMotion ? undefined : { duration: 0.4, ease: EASE_OUT, delay: 0.1 }}
        className="grid items-start gap-4 lg:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]"
      >
        <motion.div
          initial={reduceMotion ? false : { opacity: 0, x: -8 }}
          animate={reduceMotion ? undefined : { opacity: 1, x: 0 }}
          transition={reduceMotion ? undefined : { duration: 0.35, ease: EASE_OUT, delay: 0.15 }}
          className="min-w-0"
        >
          <Card className="h-full border-border/50 bg-card/85 shadow-sm backdrop-blur">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Assignment Context
            </CardTitle>
            <CardDescription>Session from extension handoff</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {isSessionLoading && !effectiveSession ? (
              <p className="text-muted-foreground">Loading session...</p>
            ) : null}

            {!isSessionLoading && !payload ? (
              <p className="text-destructive">No session payload available.</p>
            ) : null}

            {payload ? (
              <>
                <div>
                  <p className="text-muted-foreground">Title</p>
                  <p className="font-medium">{payload.title || "(untitled assignment)"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Course</p>
                  <p className="font-medium">{payload.courseName || String(payload.courseId || "-")}</p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="group/attachments relative inline-flex">
                    <Badge variant="outline">Attachments: {attachmentCount}</Badge>
                    <div className="pointer-events-none absolute left-0 top-[calc(100%+0.5rem)] z-30 w-max min-w-56 max-w-72 translate-y-1 rounded-lg border border-border/70 bg-popover/95 p-2 text-xs text-popover-foreground opacity-0 shadow-lg backdrop-blur transition-all duration-150 ease-out group-hover/attachments:translate-y-0 group-hover/attachments:opacity-100">
                      {attachmentNames.length > 0 ? (
                        <ul className="space-y-1">
                          {attachmentNames.map((name, index) => (
                            <li key={`${name}-${index}`} className="truncate text-muted-foreground">
                              {name}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-muted-foreground">No attachments provided.</p>
                      )}
                    </div>
                  </div>
                  {payload.rubric?.criteria?.length ? (
                    <Badge variant="outline">Rubric: {payload.rubric.criteria.length}</Badge>
                  ) : null}
                </div>
                {payload.dueAtISO ? (
                  <div>
                    <p className="text-muted-foreground">Due</p>
                    <p className="font-medium">
                      {format(new Date(payload.dueAtISO), "MMM d, yyyy h:mm a")}
                    </p>
                  </div>
                ) : null}
                {createdAtText ? (
                  <div>
                    <p className="text-muted-foreground">Session Created</p>
                    <p className="font-medium">{createdAtText}</p>
                  </div>
                ) : null}
                {effectiveSession ? (
                  <>
                    <div>
                      <p className="text-muted-foreground">Status</p>
                      <AnimatePresence mode="wait" initial={false}>
                        <motion.div
                          key={`status-${effectiveSession.status}-${statusToneIndex}`}
                          initial={reduceMotion ? false : { opacity: 0, y: 6, scale: 0.95 }}
                          animate={reduceMotion ? undefined : { opacity: 1, y: 0, scale: 1 }}
                          exit={reduceMotion ? undefined : { opacity: 0, y: -6, scale: 0.95 }}
                          transition={reduceMotion ? undefined : { duration: 0.24, ease: EASE_OUT }}
                          className="mt-1 inline-flex"
                        >
                          <Badge
                            variant="outline"
                            className={`px-2.5 py-1 text-xs font-semibold capitalize transition-colors duration-500 ${STATUS_BADGE_TONES[statusToneIndex]}`}
                          >
                            {effectiveSession.status}
                          </Badge>
                        </motion.div>
                      </AnimatePresence>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Stage</p>
                      <AnimatePresence mode="wait" initial={false}>
                        <motion.div
                          key={`stage-${effectiveSession.stage}-${stageToneIndex}`}
                          initial={reduceMotion ? false : { opacity: 0, y: 6, scale: 0.95 }}
                          animate={reduceMotion ? undefined : { opacity: 1, y: 0, scale: 1 }}
                          exit={reduceMotion ? undefined : { opacity: 0, y: -6, scale: 0.95 }}
                          transition={reduceMotion ? undefined : { duration: 0.24, ease: EASE_OUT }}
                          className="mt-1 inline-flex"
                        >
                          <Badge
                            variant="outline"
                            className={`px-2.5 py-1 text-xs font-semibold transition-colors duration-500 ${STAGE_BADGE_TONES[stageToneIndex]}`}
                          >
                            {stageLabel(effectiveSession.stage)}
                          </Badge>
                        </motion.div>
                      </AnimatePresence>
                    </div>
                    {isPolling ? (
                      <p className="text-xs text-muted-foreground">Reconnecting stream...</p>
                    ) : null}
                  </>
                ) : null}
              </>
            ) : null}
          </CardContent>
        </Card>
        </motion.div>

        <motion.div
          initial={reduceMotion ? false : { opacity: 0, x: 8 }}
          animate={reduceMotion ? undefined : { opacity: 1, x: 0 }}
          transition={reduceMotion ? undefined : { duration: 0.35, ease: EASE_OUT, delay: 0.18 }}
          className="min-w-0"
        >
          <Card className="flex h-[min(70vh,780px)] min-h-[480px] min-w-0 flex-col border-border/50 bg-card/90 shadow-[0_18px_45px_-28px_rgba(15,23,42,0.55)] backdrop-blur">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="h-4 w-4" />
              Assistant Output
            </CardTitle>
            <CardDescription>Guide generation progress and chat thread.</CardDescription>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
            <div ref={threadContainerRef} className="min-h-0 flex-1">
              <ScrollArea className="h-full rounded-xl border border-border/60 bg-gradient-to-b from-muted/15 via-card to-card">
                <div className="space-y-3 p-4 pr-5">
                <div className="rounded-lg border border-dashed border-brand-blue/35 bg-brand-blue/5 p-3 text-sm">
                  Assignment context received from extension.
                </div>

                <AnimatePresence initial={false}>
                  {showProgressPanel && effectiveSession ? (
                    <motion.div
                      key={`progress-${effectiveSession.status}`}
                      initial={reduceMotion ? false : { opacity: 0, y: -6, scale: 0.98 }}
                      animate={reduceMotion ? undefined : { opacity: 1, y: 0, scale: 1 }}
                      exit={reduceMotion ? undefined : { opacity: 0, y: -8, scale: 0.98 }}
                      transition={reduceMotion ? undefined : { duration: 0.28, ease: EASE_OUT }}
                      className={progressPanelTone}
                    >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-2 font-medium text-foreground">
                        {effectiveSession.status !== "completed" ? (
                          <LoaderCircle className="h-4 w-4 animate-spin" />
                        ) : null}
                        {progressLabel}
                      </span>
                      <span className="text-xs font-semibold text-foreground/70">{displayProgress}%</span>
                    </div>
                    <Progress value={displayProgress} />
                  </motion.div>
                  ) : null}
                </AnimatePresence>

                <AnimatePresence initial={false}>
                  {showThinkingIndicator ? (
                    <motion.div
                      key="thinking-indicator"
                      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                      animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
                      exit={reduceMotion ? undefined : { opacity: 0, y: -6 }}
                      transition={reduceMotion ? undefined : { duration: 0.28, ease: EASE_OUT }}
                      className="rounded-xl border border-border/60 bg-card/90 px-4 py-3 text-sm shadow-[0_10px_30px_-22px_rgba(15,23,42,0.55)]"
                    >
                      {reduceMotion ? (
                        <span className="font-medium text-muted-foreground">Thinking</span>
                      ) : (
                        <span className="inline-grid font-medium text-muted-foreground">
                          <span className="[grid-area:1/1]">Thinking</span>
                          <span
                            aria-hidden="true"
                            className="thinking-shine-overlay pointer-events-none [grid-area:1/1]"
                          >
                            Thinking
                          </span>
                        </span>
                      )}
                    </motion.div>
                  ) : null}
                </AnimatePresence>

                <AnimatePresence initial={false}>
                  {hasGuideContent ? (
                    <motion.div
                      key="guide-body"
                      initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                      animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
                      transition={reduceMotion ? undefined : { duration: 0.35, ease: EASE_OUT }}
                      className="rounded-xl border border-border/60 bg-card p-4 text-sm leading-6 shadow-[0_16px_40px_-28px_rgba(15,23,42,0.55)]"
                    >
                    <div className="[&_a]:font-medium [&_a]:text-blue-600 [&_a]:underline [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:italic [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h1]:mt-6 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_h1:first-child]:mt-0 [&_h2]:mt-5 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2:first-child]:mt-0 [&_h3]:mt-4 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:tracking-tight [&_h3:first-child]:mt-0 [&_h4]:mt-4 [&_h4]:text-base [&_h4]:font-semibold [&_li]:my-1 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-3 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_strong]:font-semibold [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {guideMarkdown}
                      </ReactMarkdown>
                    </div>
                  </motion.div>
                  ) : null}
                </AnimatePresence>

                {effectiveSession?.status === "failed" ? (
                  <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                    Error generating guide: {effectiveSession.error || "Unknown error"}
                  </div>
                ) : null}

                {(effectiveSession?.messages ?? []).map((message) => (
                  <motion.div
                    key={message.id}
                    initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                    animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
                    transition={reduceMotion ? undefined : { duration: 0.24, ease: EASE_OUT }}
                    className={
                      message.sender_role === "user"
                        ? "ml-auto w-fit max-w-[85%] rounded-2xl border border-brand-blue/35 bg-brand-blue/10 px-3 py-2 text-sm text-blue-900 shadow-sm"
                        : "max-w-[85%] rounded-2xl border border-border/70 bg-card px-3 py-2 text-sm shadow-sm"
                    }
                  >
                    {message.sender_role === "assistant" ? (
                      <div className="[&_a]:font-medium [&_a]:text-blue-600 [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {message.content_text || "..."}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <p className="whitespace-pre-wrap">{message.content_text}</p>
                    )}
                  </motion.div>
                ))}
                </div>
              </ScrollArea>
            </div>

            <form onSubmit={handleSend} className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/20 p-2">
              <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Ask a follow-up question..."
                className="border-transparent bg-transparent focus-visible:ring-0"
              />
              <Button type="submit" disabled={draft.trim().length === 0 || !canSendMessage} className="rounded-lg bg-brand-blue text-primary-foreground hover:bg-brand-blue/90">
                {isSending ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </form>

            {resolvedErrorText ? <p className="text-sm text-destructive">{resolvedErrorText}</p> : null}
          </CardContent>
        </Card>
        </motion.div>
      </motion.div>
    </motion.div>
  )
}

export default function DashboardChatPage() {
  return (
    <Suspense fallback={<ChatPageFallback />}>
      <DashboardChatPageContent />
    </Suspense>
  )
}
