"use client"

import Link from "next/link"
import { Suspense, useEffect, useMemo, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { motion, useReducedMotion } from "framer-motion"

import { ChatContextDialog } from "@/components/chat/chat-context-dialog"
import { ChatInputBar } from "@/components/chat/chat-input-bar"
import {
  ChatThread,
  type ChatCalendarProposal,
} from "@/components/chat/chat-thread"
import { ChatSessionList } from "@/components/chat/chat-session-list"
import { GuideVersionTimeline } from "@/components/chat/guide-version-timeline"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import {
  assignmentCategoryLabel,
  assignmentCategoryTone,
  extractGuideMarkdown,
  formatDateTime,
  removeThinkBlocks,
  stageLabel,
} from "@/lib/chat-utils"
import {
  type ChatMessageDto,
  type ChatSessionDto,
  type GuideVersionMeta,
} from "@/lib/chat-types"

const EASE_OUT = [0.22, 1, 0.36, 1] as const
const STAGE_BADGE_TONES = [
  "border-cyan-400/60 bg-cyan-500/15 text-cyan-800 dark:text-cyan-200",
  "border-amber-400/60 bg-amber-500/15 text-amber-800 dark:text-amber-200",
  "border-fuchsia-400/60 bg-fuchsia-500/15 text-fuchsia-800 dark:text-fuchsia-200",
  "border-lime-400/60 bg-lime-500/15 text-lime-800 dark:text-lime-200",
  "border-indigo-400/60 bg-indigo-500/15 text-indigo-800 dark:text-indigo-200",
] as const
const GUIDE_PROGRESS_STAGES = new Set([
  "queued",
  "preparing_payload",
  "extracting_pdf",
  "calling_agent",
  "streaming_output",
  "validating_output",
  "classifying_assignment",
  "parsing_response",
])

function isGuideGenerationInProgress(session: ChatSessionDto) {
  if (session.status !== "queued" && session.status !== "running") {
    return false
  }
  return GUIDE_PROGRESS_STAGES.has(session.stage)
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

  const [session, setSession] = useState<ChatSessionDto | null>(null)
  const [isPolling, setIsPolling] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [showProgressPanel, setShowProgressPanel] = useState(false)
  const [calendarProposals, setCalendarProposals] = useState<
    Map<string, ChatCalendarProposal>
  >(new Map())
  const [displayProgress, setDisplayProgress] = useState(0)
  const [stageToneIndex, setStageToneIndex] = useState(0)
  const [isContextDialogOpen, setIsContextDialogOpen] = useState(false)
  const [guideVersions, setGuideVersions] = useState<GuideVersionMeta[]>([])
  const [isRegenerating, setIsRegenerating] = useState(false)

  const threadContainerRef = useRef<HTMLDivElement | null>(null)
  const latestSessionRef = useRef<ChatSessionDto | null>(null)
  const latestAssistantMessageIdRef = useRef<string | null>(null)
  const previousGuideLengthRef = useRef(0)
  const lastScrollTimeRef = useRef(0)
  const initialScrollDoneRef = useRef<string | null>(null)
  const reduceMotion = useReducedMotion()

  function getThreadViewport() {
    return threadContainerRef.current?.querySelector<HTMLDivElement>(
      "[data-slot='scroll-area-viewport']",
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

  function scrollToGuideVersion(versionNumber: number) {
    const viewport = getThreadViewport()
    if (!viewport) return
    const target = viewport.querySelector<HTMLElement>(
      `[data-guide-version="${versionNumber}"]`,
    )
    if (!target) return
    target.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  function isNearBottom(threshold = 150) {
    const viewport = getThreadViewport()
    if (!viewport) return true
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < threshold
  }

  function throttledScrollToBottom() {
    const now = Date.now()
    if (now - lastScrollTimeRef.current < 150) return
    lastScrollTimeRef.current = now
    requestAnimationFrame(() => {
      scrollThreadToBottom("smooth")
    })
  }

  function upsertSessionMessage(current: ChatSessionDto, nextMessage: ChatMessageDto) {
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
    current: ChatSessionDto,
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

  function findLatestAssistantMessageId(messages: ChatMessageDto[]) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message.sender_role === "assistant") {
        return message.id
      }
    }
    return null
  }

  useEffect(() => {
    if (!sessionId) {
      latestAssistantMessageIdRef.current = null
      return
    }
    initialScrollDoneRef.current = null

    const streamUrl = `/api/chat-session/${encodeURIComponent(sessionId)}/events`
    const eventSource = new EventSource(streamUrl)
    let isDisposed = false

    const applySession = (nextSession: ChatSessionDto) => {
      if (isDisposed) return
      const previousSession = latestSessionRef.current

      if (previousSession?.stage && previousSession.stage !== nextSession.stage) {
        setStageToneIndex((prev) => (prev + 1) % STAGE_BADGE_TONES.length)
      }

      latestSessionRef.current = nextSession
      setSession(nextSession)
      setIsPolling(false)
      setErrorText(null)

      if (isGuideGenerationInProgress(nextSession)) {
        setShowProgressPanel(true)
        setDisplayProgress(
          Math.max(0, Math.min(100, Math.round(nextSession.progress_percent))),
        )
      } else if (nextSession.status === "failed") {
        setShowProgressPanel(false)
        setDisplayProgress(100)
      } else {
        setShowProgressPanel(false)
      }
    }

    const parseSessionSnapshot = (event: MessageEvent<string>) => {
      try {
        const data = JSON.parse(event.data) as ChatSessionDto
        latestAssistantMessageIdRef.current = findLatestAssistantMessageId(data.messages)
        applySession(data)
      } catch {
        setErrorText("Unable to parse session stream event.")
      }
    }

    const parseSessionUpdate = (event: MessageEvent<string>) => {
      try {
        const patch = JSON.parse(event.data) as Partial<ChatSessionDto>
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
        const message = JSON.parse(event.data) as ChatMessageDto
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

        const shouldScroll = isNearBottom()
        setSession((previous) => {
          if (!previous || previous.session_id !== sessionId) return previous
          const next = patchSessionMessageContent(previous, payload.message_id!, (previousText) => {
            if (typeof payload.content === "string") return payload.content
            return `${previousText}${payload.delta ?? ""}`
          })
          latestSessionRef.current = next
          return next
        })
        if (shouldScroll) throttledScrollToBottom()
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
        requestAnimationFrame(() => scrollThreadToBottom("smooth"))
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

    const parseCalendarProposal = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as {
          assistant_message_id?: string
          assignment_id?: string
          sessions?: Array<{
            start_iso: string
            end_iso: string
            focus: string
            priority: "high" | "medium" | "low"
          }>
        }
        if (!payload.assistant_message_id || !Array.isArray(payload.sessions)) return
        const messageId = payload.assistant_message_id
        const assignmentId = payload.assignment_id ?? ""
        const sessions = payload.sessions
        setCalendarProposals((prev) => new Map(prev).set(messageId, { assignmentId, sessions }))
      } catch {
        // Ignore malformed proposal events
      }
    }

    eventSource.addEventListener("session.snapshot", parseSessionSnapshot as EventListener)
    eventSource.addEventListener("session.update", parseSessionUpdate as EventListener)
    eventSource.addEventListener("chat.message.created", parseChatMessageCreated as EventListener)
    eventSource.addEventListener("chat.message.delta", parseChatMessageDelta as EventListener)
    eventSource.addEventListener("chat.message.completed", parseChatMessageCompleted as EventListener)
    eventSource.addEventListener("chat.error", parseChatError as EventListener)
    eventSource.addEventListener("calendar.proposal", parseCalendarProposal as EventListener)

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
      eventSource.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(() => {
    if (!sessionId || !session || session.session_id !== sessionId) return
    if (session.status !== "completed") return

    let isDisposed = false
    fetch(`/api/chat-session/${encodeURIComponent(sessionId)}/guide-versions`, {
      cache: "no-store",
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`${res.status}`))))
      .then((body: { versions?: GuideVersionMeta[] }) => {
        if (!isDisposed && Array.isArray(body.versions)) {
          setGuideVersions(body.versions)
          setIsRegenerating(false)
        }
      })
      .catch(() => {
        // Non-critical — export button just won't show version picker
      })

    return () => {
      isDisposed = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, session?.status])

  // Scroll to the bottom once when a session first loads so the latest message is visible.
  useEffect(() => {
    if (!session || session.session_id !== sessionId) return
    if (initialScrollDoneRef.current === sessionId) return
    initialScrollDoneRef.current = sessionId
    requestAnimationFrame(() => {
      requestAnimationFrame(() => scrollThreadToBottom("instant"))
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, sessionId])

  useEffect(() => {
    if (!session || session.session_id !== sessionId) return
    const map = new Map<string, ChatCalendarProposal>()
    for (const message of session.messages) {
      if (message.sender_role !== "assistant") continue
      const proposal = message.metadata?.calendar_proposal as
        | {
            assignmentId: string
            sessions: Array<{
              start_iso: string
              end_iso: string
              focus: string
              priority: "high" | "medium" | "low"
            }>
          }
        | undefined
      if (!proposal || message.metadata?.calendar_proposal_scheduled === true) continue
      map.set(message.id, {
        assignmentId: proposal.assignmentId,
        sessions: proposal.sessions,
      })
    }
    setCalendarProposals(map)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.session_id])

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
  const userAttachedFileNames = useMemo(() => {
    const seen = new Set<string>()
    const names: string[] = []
    for (const message of effectiveSession?.messages ?? []) {
      if (message.sender_role !== "user") continue
      const raw = message.metadata?.attachments
      if (!Array.isArray(raw)) continue
      for (const attachment of raw) {
        if (
          typeof attachment === "object" &&
          attachment !== null &&
          typeof (attachment as Record<string, unknown>).filename === "string"
        ) {
          const name = (attachment as { filename: string }).filename
          if (!seen.has(name)) {
            seen.add(name)
            names.push(name)
          }
        }
      }
    }
    return names
  }, [effectiveSession])
  const createdAtText = formatDateTime(effectiveSession?.created_at)

  const rawGuideMarkdown = useMemo(() => {
    if (!effectiveSession) return ""
    if (effectiveSession.streamed_guide_markdown?.trim()) {
      return effectiveSession.streamed_guide_markdown
    }
    if (effectiveSession.status !== "completed") return ""
    return extractGuideMarkdown(effectiveSession.result)
  }, [effectiveSession])

  const {
    visibleMarkdown: guideMarkdown,
    isThinking,
    thinkBlockCount: guideThinkBlockCount,
  } = useMemo(() => removeThinkBlocks(rawGuideMarkdown), [rawGuideMarkdown])

  const hasGuideContent = guideMarkdown.trim().length > 0
  const isGuideStreaming = Boolean(
    effectiveSession && isGuideGenerationInProgress(effectiveSession),
  )
  const showThinkingIndicator = Boolean(!hasGuideContent && isGuideStreaming)

  useEffect(() => {
    const currentLength = guideMarkdown.length
    if (currentLength > previousGuideLengthRef.current) {
      requestAnimationFrame(() => {
        scrollThreadToBottom("smooth")
      })
    }
    previousGuideLengthRef.current = currentLength
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guideMarkdown])

  const progressLabel =
    effectiveSession?.status === "completed"
      ? "Guide ready"
      : effectiveSession?.status_message || "Generating guide..."
  const resolvedErrorText = errorText
  const isSessionLoading = Boolean(sessionId && !effectiveSession && !resolvedErrorText && !isPolling)
  const canSendMessage = Boolean(
    effectiveSession &&
      (effectiveSession.status === "completed" ||
        effectiveSession.stage === "chat_streaming") &&
      !isSending,
  )
  const latestAssistantMessageId = latestAssistantMessageIdRef.current
  const chatName = useMemo(() => {
    if (!effectiveSession) return "New Chat"
    for (let index = effectiveSession.messages.length - 1; index >= 0; index -= 1) {
      const message = effectiveSession.messages[index]
      if (message.sender_role !== "user") continue
      const normalized = message.content_text.replace(/\s+/g, " ").trim()
      if (normalized) return normalized
    }
    return "New Chat"
  }, [effectiveSession])
  const categoryLabel = assignmentCategoryLabel(effectiveSession?.assignment_category)
  const categoryTone = assignmentCategoryTone(effectiveSession?.assignment_category)

  async function handleRegenerateGuide() {
    if (!sessionId || !effectiveSession || isRegenerating) return
    setIsRegenerating(true)
    try {
      const response = await fetch(
        `/api/chat-session/${encodeURIComponent(sessionId)}/regenerate-guide`,
        { method: "POST" },
      )
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        setErrorText(body.error ?? `Regeneration failed (${response.status})`)
        setIsRegenerating(false)
      }
    } catch {
      setErrorText("Failed to start guide regeneration.")
      setIsRegenerating(false)
    }
  }

  async function handleSend(text: string, files: File[]) {
    const trimmedText = text.trim()
    if (!trimmedText && files.length === 0) return
    if (!effectiveSession) {
      throw new Error("No active chat session")
    }
    if (effectiveSession.status !== "completed" && effectiveSession.stage !== "chat_streaming") {
      const message = "Guide generation is still in progress."
      setErrorText(message)
      throw new Error(message)
    }

    setIsSending(true)
    setErrorText(null)

    try {
      type UploadedAttachment = {
        filename: string
        file_sha256: string
        storage_path: string
      }

      const uploadedAttachments: UploadedAttachment[] = []
      for (const file of files) {
        const formData = new FormData()
        formData.append("file", file)
        const uploadResponse = await fetch(
          `/api/chat-session/${encodeURIComponent(effectiveSession.session_id)}/attachments`,
          { method: "POST", body: formData },
        )
        if (!uploadResponse.ok) {
          const err = await uploadResponse.text()
          throw new Error(`Failed to upload ${file.name}: ${err}`)
        }
        const uploaded = (await uploadResponse.json()) as UploadedAttachment
        uploadedAttachments.push(uploaded)
      }

      const response = await fetch(
        `/api/chat-session/${encodeURIComponent(effectiveSession.session_id)}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            content: trimmedText,
            ...(uploadedAttachments.length > 0
              ? { attachments: uploadedAttachments }
              : {}),
          }),
        },
      )

      if (!response.ok) {
        const errorBody = await response.text()
        throw new Error(errorBody || `Chat request failed (${response.status})`)
      }

      requestAnimationFrame(() => {
        scrollThreadToBottom("smooth")
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrorText(message)
      setIsSending(false)
      throw error
    }
  }

  function markCalendarProposalHandled(messageId: string) {
    setCalendarProposals((prev) => {
      const next = new Map(prev)
      next.delete(messageId)
      return next
    })

    if (!sessionId) return

    void fetch(`/api/chat-session/${sessionId}/messages/${messageId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ calendar_proposal_scheduled: true }),
    }).catch(() => {})
  }

  if (!sessionId) {
    return <ChatSessionList />
  }

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
      transition={reduceMotion ? undefined : { duration: 0.45, ease: EASE_OUT }}
      className="flex h-[calc(100dvh-7.75rem)] min-h-[480px] w-full flex-col gap-2 md:min-h-[560px]"
    >
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/dashboard/chat">Chats</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage className="max-w-[32ch] truncate">{chatName}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <motion.div
        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
        animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
        transition={reduceMotion ? undefined : { duration: 0.35, ease: EASE_OUT, delay: 0.05 }}
        className="flex items-center justify-between gap-2 pb-1"
      >
        <div className="min-w-0 flex items-center gap-2">
          <h1 className="text-lg font-heading font-medium tracking-tight">Session Chat</h1>
          {categoryLabel ? (
            <Badge
              variant="outline"
              className={`w-fit px-2 py-0.5 text-[10px] ${categoryTone}`}
            >
              {categoryLabel}
            </Badge>
          ) : null}
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
            <ChatThread
              session={effectiveSession}
              sessionId={sessionId}
              guideMarkdown={guideMarkdown}
              hasGuideContent={hasGuideContent}
              isGuideStreaming={isGuideStreaming}
              showProgressPanel={showProgressPanel}
              displayProgress={displayProgress}
              progressLabel={progressLabel}
              showThinkingIndicator={showThinkingIndicator}
              isThinking={isThinking}
              guideThinkBlockCount={guideThinkBlockCount}
              isSending={isSending}
              calendarProposals={calendarProposals}
              latestAssistantMessageId={latestAssistantMessageId}
              guideVersions={guideVersions}
              reduceMotion={reduceMotion}
              onCalendarScheduled={markCalendarProposalHandled}
              onCalendarDismissed={markCalendarProposalHandled}
              threadContainerRef={threadContainerRef}
            />

            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-28 bg-gradient-to-t from-background via-background/95 to-transparent"
            />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 pb-2">
              <div className="mx-auto w-full max-w-5xl px-3 sm:px-6 lg:px-8">
                <div className="pointer-events-auto w-full">
                  <ChatInputBar
                    canSendMessage={canSendMessage}
                    isSending={isSending}
                    hasGuideContent={hasGuideContent}
                    isGuideStreaming={isGuideStreaming}
                    isRegenerating={isRegenerating}
                    errorText={resolvedErrorText}
                    onSend={handleSend}
                    onRegenerateGuide={handleRegenerateGuide}
                  />
                </div>
              </div>
            </div>
          </div>
        </motion.div>

        <GuideVersionTimeline
          versions={guideVersions}
          onScrollToVersion={scrollToGuideVersion}
        />
      </motion.div>

      <ChatContextDialog
        open={isContextDialogOpen}
        onOpenChange={setIsContextDialogOpen}
        payload={payload}
        attachmentCount={attachmentCount}
        attachmentNames={attachmentNames}
        userAttachedFileNames={userAttachedFileNames}
        createdAtText={createdAtText}
        effectiveSession={effectiveSession}
        isSessionLoading={isSessionLoading}
        isPolling={isPolling}
        stageToneIndex={stageToneIndex}
        reduceMotion={reduceMotion}
      />
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
