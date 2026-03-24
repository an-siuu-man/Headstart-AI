"use client"

import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, Suspense, useEffect, useMemo, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { format } from "date-fns"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { Brain, LoaderCircle, SendHorizontal, Trash2 } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { ChatMessageBubble } from "@/components/chat/chat-message-bubble"
import { GuideExportButton } from "@/components/chat/guide-export-button"
import { MARKDOWN_COMPONENTS } from "@/components/chat/markdown-components"
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

type ChatSessionStatus = "queued" | "running" | "completed" | "failed" | "archived"
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

const EASE_OUT = [0.22, 1, 0.36, 1] as const
const THINK_OPEN_TAG = "<think>"
const THINK_CLOSE_TAG = "</think>"
const CHAT_LIST_CONTAINER_VARIANTS = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.06,
      delayChildren: 0.04,
    },
  },
}
const CHAT_LIST_ITEM_VARIANTS = {
  hidden: { opacity: 0, y: 8, scale: 0.99 },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      duration: 0.24,
      ease: EASE_OUT,
    },
  },
}
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
    return { visibleMarkdown: "", isThinking: false, thinkBlockCount: 0 }
  }

  let cursor = 0
  let visible = ""
  let thinkBlockCount = 0

  while (cursor < markdown.length) {
    const openIndex = markdown.indexOf(THINK_OPEN_TAG, cursor)
    if (openIndex === -1) {
      visible += markdown.slice(cursor)
      break
    }

    visible += markdown.slice(cursor, openIndex)
    thinkBlockCount += 1
    const thinkStart = openIndex + THINK_OPEN_TAG.length
    const closeIndex = markdown.indexOf(THINK_CLOSE_TAG, thinkStart)

    if (closeIndex === -1) {
      return {
        visibleMarkdown: visible.replaceAll(THINK_CLOSE_TAG, ""),
        isThinking: true,
        thinkBlockCount,
      }
    }

    cursor = closeIndex + THINK_CLOSE_TAG.length
  }

  return {
    visibleMarkdown: visible.replaceAll(THINK_CLOSE_TAG, ""),
    isThinking: false,
    thinkBlockCount,
  }
}

function ThinkingMessage({ reduceMotion }: { reduceMotion: boolean | null }) {
  return (
    <div className="inline-flex items-center text-[15px] font-medium text-muted-foreground">
      {reduceMotion ? (
        <span>Thinking</span>
      ) : (
        <span className="inline-grid">
          <span className="[grid-area:1/1]">Thinking</span>
          <span
            aria-hidden="true"
            className="thinking-shine-overlay pointer-events-none [grid-area:1/1]"
          >
            Thinking
          </span>
        </span>
      )}
    </div>
  )
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

function formatDateTime(value: number | string | null | undefined) {
  if (value == null) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return format(date, "MMM d, yyyy h:mm a")
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
  const router = useRouter()
  const searchParams = useSearchParams()
  const sessionId = (searchParams.get("session") || "").trim()

  const [sessionList, setSessionList] = useState<ChatSessionListItemResponse[]>([])
  const [isSessionListLoading, setIsSessionListLoading] = useState(false)
  const [sessionListError, setSessionListError] = useState<string | null>(null)
  const [deletingSessionIds, setDeletingSessionIds] = useState<Set<string>>(new Set())
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null)
  const [session, setSession] = useState<ChatSessionResponse | null>(null)
  const [isPolling, setIsPolling] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [isSending, setIsSending] = useState(false)
  const [isThinkingModeEnabled, setIsThinkingModeEnabled] = useState(false)
  const [showProgressPanel, setShowProgressPanel] = useState(false)
  const [displayProgress, setDisplayProgress] = useState(0)
  const [stageToneIndex, setStageToneIndex] = useState(0)
  const [isContextDialogOpen, setIsContextDialogOpen] = useState(false)
  const threadContainerRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const latestSessionRef = useRef<ChatSessionResponse | null>(null)
  const latestAssistantMessageIdRef = useRef<string | null>(null)
  const previousGuideLengthRef = useRef(0)
  const lastScrollTimeRef = useRef(0)
  const progressHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reduceMotion = useReducedMotion()

  function getThreadViewport() {
    return threadContainerRef.current?.querySelector<HTMLDivElement>(
      "[data-slot='scroll-area-viewport']"
    )
  }

  function scrollThreadToBottom(behavior: ScrollBehavior = "smooth") {
    const viewport = getThreadViewport()
    if (!viewport) return
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior,
    })
  }

  function isNearBottom(threshold = 150) {
    const viewport = getThreadViewport()
    if (!viewport) return true
    return (
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < threshold
    )
  }

  function throttledScrollToBottom() {
    const now = Date.now()
    if (now - lastScrollTimeRef.current < 150) return
    lastScrollTimeRef.current = now
    requestAnimationFrame(() => {
      scrollThreadToBottom("smooth")
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

  function findLatestAssistantMessageId(messages: ChatMessageResponse[]) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message.sender_role === "assistant") {
        return message.id
      }
    }
    return null
  }

  useEffect(() => {
    if (sessionId) {
      return
    }

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

    loadSessions()
    return () => {
      isDisposed = true
    }
  }, [sessionId])

  useEffect(() => {
    if (!sessionId) {
      latestAssistantMessageIdRef.current = null
      return
    }

    const streamUrl = `/api/chat-session/${encodeURIComponent(sessionId)}/events`
    const eventSource = new EventSource(streamUrl)
    let isDisposed = false

    const applySession = (nextSession: ChatSessionResponse) => {
      if (isDisposed) return
      const previousSession = latestSessionRef.current

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

    const parseSessionSnapshot = (event: MessageEvent<string>) => {
      try {
        const data = JSON.parse(event.data) as ChatSessionResponse
        latestAssistantMessageIdRef.current = findLatestAssistantMessageId(data.messages)
        applySession(data)
      } catch {
        setErrorText("Unable to parse session stream event.")
      }
    }

    const parseSessionUpdate = (event: MessageEvent<string>) => {
      try {
        const patch = JSON.parse(event.data) as Partial<ChatSessionResponse>
        const previous = latestSessionRef.current
        if (!previous || previous.session_id !== sessionId) return
        applySession({
          ...previous,
          ...patch,
        })
      } catch {
        setErrorText("Unable to parse session stream event.")
      }
    }

    const parseChatMessageCreated = (event: MessageEvent<string>) => {
      try {
        const message = JSON.parse(event.data) as ChatMessageResponse
        if (message.sender_role === "assistant") {
          latestAssistantMessageIdRef.current = message.id
        }
        setSession((previous) => {
          if (!previous || previous.session_id !== sessionId) return previous
          const next = upsertSessionMessage(previous, message)
          latestSessionRef.current = next
          return next
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
        const shouldAutoScroll = isNearBottom()

        setSession((previous) => {
          if (!previous || previous.session_id !== sessionId) return previous
          const next = patchSessionMessageContent(previous, messageId, (previousText) => {
            if (typeof payload.content === "string") {
              return payload.content
            }
            return `${previousText}${payload.delta ?? ""}`
          })
          latestSessionRef.current = next
          return next
        })
        if (shouldAutoScroll) {
          throttledScrollToBottom()
        }
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
        latestAssistantMessageIdRef.current = messageId

        setSession((previous) => {
          if (!previous || previous.session_id !== sessionId) return previous
          const next = patchSessionMessageContent(previous, messageId, () => content)
          latestSessionRef.current = next
          return next
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

    eventSource.addEventListener("session.snapshot", parseSessionSnapshot as EventListener)
    eventSource.addEventListener("session.update", parseSessionUpdate as EventListener)
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
  const createdAtText = formatDateTime(effectiveSession?.created_at)
  const groupedSessionList = useMemo(() => {
    const grouped = new Map<string, ChatSessionAssignmentGroup>()

    for (const item of sessionList) {
      const rawAssignmentTitle = (item.context.assignment_title || item.title || "").trim()
      const assignmentTitle = rawAssignmentTitle || "(untitled assignment)"
      const normalizedAssignmentTitle = assignmentTitle
        .toLocaleLowerCase()
        .replace(/\s+/g, " ")
        .trim()
      const incomingCourseName = item.context.course_name?.trim() || null
      const groupKey =
        normalizedAssignmentTitle && normalizedAssignmentTitle !== "(untitled assignment)"
          ? normalizedAssignmentTitle
          : `untitled::${item.assignment_uuid || item.session_id}`
      const existingGroup = grouped.get(groupKey)

      if (existingGroup) {
        existingGroup.sessions.push(item)
        existingGroup.latestUpdatedAt = Math.max(existingGroup.latestUpdatedAt, item.updated_at)
        if (!existingGroup.courseName && incomingCourseName) {
          existingGroup.courseName = incomingCourseName
        } else if (
          existingGroup.courseName &&
          incomingCourseName &&
          existingGroup.courseName !== "Multiple courses" &&
          existingGroup.courseName.toLocaleLowerCase() !== incomingCourseName.toLocaleLowerCase()
        ) {
          existingGroup.courseName = "Multiple courses"
        }
        if (!existingGroup.dueAtISO && item.context.due_at_iso) {
          existingGroup.dueAtISO = item.context.due_at_iso
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
        sessions: group.sessions.slice().sort((left, right) => right.updated_at - left.updated_at),
      }))
      .sort((left, right) => right.latestUpdatedAt - left.latestUpdatedAt)
  }, [sessionList])

  const rawGuideMarkdown = useMemo(() => {
    if (!effectiveSession) return ""
    if (effectiveSession.streamed_guide_markdown?.trim()) {
      return effectiveSession.streamed_guide_markdown
    }
    if (effectiveSession.status !== "completed") return ""
    return extractGuideMarkdown(effectiveSession.result)
  }, [
    effectiveSession?.streamed_guide_markdown,
    effectiveSession?.status,
    effectiveSession?.result,
  ])

  const {
    visibleMarkdown: guideMarkdown,
    isThinking,
    thinkBlockCount: guideThinkBlockCount,
  } = useMemo(
    () => removeThinkBlocks(rawGuideMarkdown),
    [rawGuideMarkdown],
  )

  const hasGuideContent = guideMarkdown.trim().length > 0
  const isGuideStreaming =
    effectiveSession?.status === "running" || effectiveSession?.status === "queued"
  const showThinkingIndicator = Boolean(
    !hasGuideContent && isGuideStreaming && (guideThinkBlockCount > 0 || isThinking),
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

  const progressLabel =
    effectiveSession?.status === "completed"
      ? "Guide ready"
      : effectiveSession?.status_message || "Generating guide..."
  const progressPanelTone =
    effectiveSession?.status === "completed"
      ? "rounded-lg border border-emerald-300/60 bg-emerald-50/80 p-3 text-[15px]"
      : "rounded-lg border border-brand-gold/40 bg-brand-gold/10 p-3 text-[15px]"
  const resolvedErrorText = errorText
  const isSessionLoading = Boolean(
    sessionId && !effectiveSession && !resolvedErrorText && !isPolling,
  )
  const canSendMessage = Boolean(
    effectiveSession &&
      (effectiveSession.status === "completed" ||
        effectiveSession.stage === "chat_streaming") &&
      !isSending,
  )
  const latestAssistantMessageId = latestAssistantMessageIdRef.current

  const pendingDeleteSession = pendingDeleteSessionId
    ? sessionList.find((item) => item.session_id === pendingDeleteSessionId) ?? null
    : null

  function handleOpenSession(nextSessionId: string) {
    router.push(`/dashboard/chat?session=${encodeURIComponent(nextSessionId)}`)
  }

  function handleRequestDeleteSession(targetSessionId: string) {
    setPendingDeleteSessionId(targetSessionId)
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

      if (sessionId === targetSessionId) {
        router.push("/dashboard/chat")
      }
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

  if (!sessionId) {
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
              <CardContent className="space-y-3 p-4 sm:p-5">
                {sessionListError ? (
                  <p className="text-sm text-destructive">{sessionListError}</p>
                ) : null}

                {!isSessionListLoading && !sessionListError && sessionList.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No chats found yet. Generate a guide from the extension to create your first chat.
                  </p>
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
                          animate={
                            reduceMotion
                              ? undefined
                              : {
                                  opacity: [0.38, 0.86, 0.38],
                                }
                          }
                          transition={
                            reduceMotion
                              ? undefined
                              : {
                                  duration: 1.3,
                                  ease: "easeInOut",
                                  repeat: Number.POSITIVE_INFINITY,
                                  delay: index * 0.08,
                                }
                          }
                          className="rounded-xl border border-border/60 bg-background/40 p-3"
                        >
                          <div className="h-3 w-2/3 rounded bg-muted/80" />
                          <div className="mt-2 h-2.5 w-1/3 rounded bg-muted/70" />
                          <div className="mt-3 h-2.5 w-1/2 rounded bg-muted/70" />
                        </motion.div>
                      ))}
                    </motion.div>
                  ) : null}

                  {!isSessionListLoading && sessionList.length > 0 ? (
                    <motion.div
                      key="chat-list-loaded"
                      variants={CHAT_LIST_CONTAINER_VARIANTS}
                      initial={reduceMotion ? false : "hidden"}
                      animate={reduceMotion ? undefined : "show"}
                      className="space-y-3"
                    >
                      {groupedSessionList.map((group) => {
                        return (
                          <motion.section
                            key={group.groupKey}
                            variants={CHAT_LIST_ITEM_VARIANTS}
                            className="space-y-2"
                          >
                            <p className="truncate text-sm font-semibold text-foreground">
                              {group.assignmentTitle}
                            </p>

                            <div className="space-y-2">
                              {group.sessions.map((item) => {
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
                                    variants={CHAT_LIST_ITEM_VARIANTS}
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
                            </div>
                          </motion.section>
                        )
                      })}
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
            thinking_mode: isThinkingModeEnabled ? "thinking" : "normal",
          }),
        },
      )

      if (!response.ok) {
        const errorBody = await response.text()
        throw new Error(
          errorBody || `Chat request failed (${response.status})`,
        )
      }

      setSessionList((previous) =>
        previous.map((item) =>
          item.session_id === effectiveSession.session_id
            ? {
                ...item,
                last_user_message: text,
                updated_at: Date.now(),
              }
            : item,
        ),
      )
      setDraft("")
      if (textareaRef.current) textareaRef.current.style.height = "auto"
      requestAnimationFrame(() => {
        scrollThreadToBottom("smooth")
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrorText(message)
      setIsSending(false)
    }
  }

  function handleDraftKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Tab") {
      event.preventDefault()
      const el = event.currentTarget
      const start = el.selectionStart
      const end = el.selectionEnd
      el.setRangeText("\t", start, end, "end")
      setDraft(el.value)
      return
    }
    if (event.key !== "Enter") return
    if (event.shiftKey) return
    if (event.nativeEvent.isComposing) return
    if (!draft.trim()) return
    if (!canSendMessage || isSending) return

    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
      transition={reduceMotion ? undefined : { duration: 0.45, ease: EASE_OUT }}
      className="flex h-[calc(100dvh-7.75rem)] min-h-[480px] w-full flex-col gap-2 md:min-h-[560px]"
    >
      <motion.div
        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
        animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
        transition={reduceMotion ? undefined : { duration: 0.35, ease: EASE_OUT, delay: 0.05 }}
        className="flex items-center justify-between gap-2 pb-1"
      >
        <div className="min-w-0 flex items-center gap-2">
            <h1 className="text-lg font-heading font-medium tracking-tight">Session Chat</h1>
            {effectiveSession ? (
              <Badge
                variant="outline"
                className="w-fit border-brand-blue/30 bg-brand-blue/10 px-2 py-0.5 text-[10px] text-brand-blue"
              >
                {stageLabel(effectiveSession.stage)}
              </Badge>
            ) : null}
        </div>
        <div className="flex items-center gap-1 sm:justify-end">
          <Button
            type="button"
            variant="primary"
            size="default"
            className="rounded-full px-4"
            onClick={() => router.push("/dashboard/chat")}
          >
            All Chats
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="default"
            className="rounded-full px-4"
            onClick={() => setIsContextDialogOpen(true)}
            disabled={!payload}
          >
            Chat Context
          </Button>
        </div>
      </motion.div>

      <motion.div
        initial={reduceMotion ? false : { opacity: 0, y: 10 }}
        animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
        transition={reduceMotion ? undefined : { duration: 0.4, ease: EASE_OUT, delay: 0.1 }}
        className="min-h-0 flex flex-1"
      >
        <motion.div
          initial={reduceMotion ? false : { opacity: 0, x: 8 }}
          animate={reduceMotion ? undefined : { opacity: 1, x: 0 }}
          transition={reduceMotion ? undefined : { duration: 0.35, ease: EASE_OUT, delay: 0.18 }}
          className="min-h-0 min-w-0 flex flex-1"
        >
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <div ref={threadContainerRef} className="min-h-0 flex-1">
              <ScrollArea className="h-full">
                <div className="mx-auto min-w-0 w-full max-w-5xl space-y-3 px-3 pb-28 pt-2 sm:px-6 sm:pb-32 sm:pt-3 lg:px-8">
                <AnimatePresence initial={false}>
                  {showProgressPanel && effectiveSession ? (
                    <motion.div
                      key={`progress-${effectiveSession.status}`}
                      initial={reduceMotion ? false : { opacity: 0, y: -6, scale: 0.98 }}
                      animate={reduceMotion ? undefined : { opacity: 1, y: 0, scale: 1 }}
                      exit={reduceMotion ? undefined : { opacity: 0, y: -8, scale: 0.98 }}
                      transition={reduceMotion ? undefined : { duration: 0.28, ease: EASE_OUT }}
                      className={`${progressPanelTone} mx-auto min-w-0 w-full max-w-4xl`}
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
                      className="mx-auto w-full max-w-4xl space-y-1 px-1 py-1"
                    >
                      {Array.from({
                        length: Math.max(
                          guideThinkBlockCount,
                          isThinking ? 1 : 0,
                        ),
                      }).map((_, index) => (
                        <ThinkingMessage
                          key={`guide-thinking-${index}`}
                          reduceMotion={reduceMotion}
                        />
                      ))}
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
                      className="mx-auto w-full max-w-4xl min-w-0 p-1 text-left text-[15px] leading-6"
                    >
                    <div className="[font-family:var(--font-lexend)] [&_a]:font-medium [&_a]:text-blue-600 [&_a]:underline [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:italic [&_code]:[font-family:var(--font-space-mono)] [&_code]:break-words [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h1]:mt-6 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_h1:first-child]:mt-0 [&_h2]:mt-5 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2:first-child]:mt-0 [&_h3]:mt-4 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:tracking-tight [&_h3:first-child]:mt-0 [&_h4]:mt-4 [&_h4]:text-base [&_h4]:font-semibold [&_hr]:my-6 [&_li]:my-1 [&_li]:break-words [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-3 [&_p]:break-words [&_p]:font-light [&_pre]:[font-family:var(--font-space-mono)] [&_pre]:my-3 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_strong]:font-semibold [&_table]:w-full [&_table]:min-w-[28rem] [&_table]:border-separate [&_table]:border-spacing-0 [&_table]:rounded-md [&_table]:border [&_table]:border-border/70 [&_thead]:bg-muted/45 [&_th]:border-b [&_th]:border-border/70 [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-[13px] [&_th]:font-semibold [&_td]:border-b [&_td]:border-border/50 [&_td]:px-2 [&_td]:py-1.5 [&_td]:text-[13px] [&_tbody_tr:last-child_td]:border-b-0 [&_tbody_tr:nth-child(even)]:bg-muted/25 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                        {guideMarkdown}
                      </ReactMarkdown>
                    </div>
                  </motion.div>
                  ) : null}
                </AnimatePresence>

                {effectiveSession?.status === "failed" ? (
                  <div className="rounded-md border border-red-200 bg-red-50 p-3 text-[15px] text-red-800">
                    Error generating guide: {effectiveSession.error || "Unknown error"}
                  </div>
                ) : null}

                {(effectiveSession?.messages ?? []).map((message) => (
                  <ChatMessageBubble
                    key={message.id}
                    message={message}
                    isLatestStreamingAssistant={
                      message.sender_role === "assistant" &&
                      message.id === latestAssistantMessageId &&
                      isSending
                    }
                    reduceMotion={reduceMotion}
                  />
                ))}
                </div>
              </ScrollArea>
            </div>

            {hasGuideContent && !isGuideStreaming && (
              <div className="absolute bottom-16 right-6 z-30">
                <GuideExportButton
                  guideMarkdown={guideMarkdown}
                  assignmentTitle={payload?.title}
                  courseName={payload?.courseName}
                />
              </div>
            )}

            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-28 bg-gradient-to-t from-background via-background/95 to-transparent"
            />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 pb-2">
              <div className="mx-auto w-full max-w-5xl px-3 sm:px-6 lg:px-8">
                <div className="pointer-events-auto w-full">
                  {resolvedErrorText ? (
                    <p className="mb-2 px-3 text-[13px] text-destructive">{resolvedErrorText}</p>
                  ) : null}
                  <form
                    onSubmit={handleSend}
                    className="flex w-full items-end gap-2 rounded-2xl bg-background/92 px-2 py-2 shadow-[0_14px_32px_-20px_rgba(15,23,42,0.55)] backdrop-blur supports-[backdrop-filter]:bg-background/80 dark:border dark:border-zinc-700/70"
                  >
                    <Button
                      type="button"
                      variant={isThinkingModeEnabled ? "secondary" : "ghost"}
                      aria-pressed={isThinkingModeEnabled}
                      disabled={isSending}
                      onClick={() => setIsThinkingModeEnabled((previous) => !previous)}
                      className="h-9 shrink-0 rounded-full px-3 text-xs font-medium"
                    >
                      <Brain className="mr-1.5 h-3.5 w-3.5" />
                      {isThinkingModeEnabled ? "Thinking On" : "Thinking Off"}
                    </Button>
                    <textarea
                      ref={textareaRef}
                      rows={1}
                      value={draft}
                      onChange={(event) => {
                        setDraft(event.target.value)
                        const el = event.target
                        el.style.height = "auto"
                        el.style.height = `${el.scrollHeight}px`
                      }}
                      onKeyDown={handleDraftKeyDown}
                      placeholder="Ask a follow-up question..."
                      className="min-h-10 max-h-40 w-full resize-none overflow-y-auto border-0 bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground"
                    />
                    <Button
                      type="submit"
                      variant="ghost"
                      disabled={draft.trim().length === 0 || !canSendMessage}
                      className="h-9 w-9 rounded-full p-0 text-black transition-colors duration-200 hover:bg-foreground/10 hover:text-black disabled:text-black/40 dark:text-white dark:hover:text-white dark:disabled:text-white/40"
                    >
                      {isSending ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <SendHorizontal className="h-4 w-4" />
                      )}
                    </Button>
                  </form>
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      </motion.div>

      <Dialog open={isContextDialogOpen} onOpenChange={setIsContextDialogOpen}>
          <DialogContent className="max-h-[85vh] w-full max-w-2xl overflow-hidden p-0">
          <DialogHeader className="border-b border-border/70 px-5 py-4">
            <DialogTitle>Assignment Context</DialogTitle>
            <DialogDescription>Session from extension handoff</DialogDescription>
          </DialogHeader>

          <div className="max-h-[calc(85vh-88px)] overflow-y-auto px-5 py-4">
            <div className="space-y-3 text-sm">
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
                    <p className="font-medium">
                      {payload.courseName || String(payload.courseId || "-")}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">Attachments: {attachmentCount}</Badge>
                    {payload.rubric?.criteria?.length ? (
                      <Badge variant="outline">Rubric: {payload.rubric.criteria.length}</Badge>
                    ) : null}
                  </div>
                  {attachmentNames.length > 0 ? (
                    <div>
                      <p className="text-muted-foreground">Attachment Files</p>
                      <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                        {attachmentNames.map((name, index) => (
                          <li key={`${name}-${index}`} className="break-all">
                            {name}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="text-muted-foreground">No attachments provided.</p>
                  )}
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
                </>
              ) : null}

              {effectiveSession ? (
                <>
                  <div>
                    <p className="text-muted-foreground">Stage</p>
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.div
                        key={`stage-dialog-${effectiveSession.stage}-${stageToneIndex}`}
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
            </div>
          </div>
        </DialogContent>
      </Dialog>
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
