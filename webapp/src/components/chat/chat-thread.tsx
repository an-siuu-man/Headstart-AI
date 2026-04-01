"use client"

import { type RefObject, useDeferredValue } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { LoaderCircle } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { CalendarProposalCard } from "@/components/chat/calendar-proposal-card"
import { ChatMessageBubble } from "@/components/chat/chat-message-bubble"
import { GuideExportButton } from "@/components/chat/guide-export-button"
import { MARKDOWN_COMPONENTS } from "@/components/chat/markdown-components"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { type ChatSessionDto, type GuideVersionMeta } from "@/lib/chat-types"

const EASE_OUT = [0.22, 1, 0.36, 1] as const

export type ChatCalendarProposal = {
  assignmentId: string
  sessions: Array<{
    start_iso: string
    end_iso: string
    focus: string
    priority: "high" | "medium" | "low"
  }>
}

type ChatThreadProps = {
  session: ChatSessionDto | null
  sessionId: string
  guideMarkdown: string
  hasGuideContent: boolean
  isGuideStreaming: boolean
  showProgressPanel: boolean
  displayProgress: number
  progressLabel: string
  showThinkingIndicator: boolean
  isThinking: boolean
  guideThinkBlockCount: number
  isSending: boolean
  calendarProposals: Map<string, ChatCalendarProposal>
  latestAssistantMessageId: string | null
  guideVersions: GuideVersionMeta[]
  reduceMotion: boolean | null
  onCalendarScheduled: (messageId: string) => void
  onCalendarDismissed: (messageId: string) => void
  threadContainerRef: RefObject<HTMLDivElement | null>
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

export function ChatThread({
  session,
  sessionId,
  guideMarkdown,
  hasGuideContent,
  isGuideStreaming,
  showProgressPanel,
  displayProgress,
  progressLabel,
  showThinkingIndicator,
  isThinking,
  guideThinkBlockCount,
  isSending,
  calendarProposals,
  latestAssistantMessageId,
  guideVersions,
  reduceMotion,
  onCalendarScheduled,
  onCalendarDismissed,
  threadContainerRef,
}: ChatThreadProps) {
  const deferredGuideMarkdown = useDeferredValue(guideMarkdown)
  const guideTailText = guideMarkdown.slice(deferredGuideMarkdown.length)

  const progressPanelTone =
    session?.status === "completed"
      ? "rounded-lg border border-emerald-300/60 bg-emerald-50/80 p-3 text-[15px]"
      : "rounded-lg border border-brand-gold/40 bg-brand-gold/10 p-3 text-[15px]"
  const shouldShowWelcomeMessage = Boolean(
    session &&
      session.status === "completed" &&
      !hasGuideContent &&
      session.messages.length === 0,
  )
  const rawAssignmentTitle =
    typeof session?.payload?.title === "string" ? session.payload.title.trim() : ""
  const assignmentTitle = rawAssignmentTitle || "this assignment"
  const welcomeMessageText = `Hi! How may I help you with ${assignmentTitle}?`
  const welcomeCreatedAt = session
    ? new Date(session.created_at).toISOString()
    : new Date().toISOString()

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div ref={threadContainerRef} className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="mx-auto min-w-0 w-full max-w-5xl space-y-3 px-3 pb-28 pt-2 sm:px-6 sm:pb-32 sm:pt-3 lg:px-8">
            <AnimatePresence initial={false}>
              {showProgressPanel && session ? (
                <motion.div
                  key={`progress-${session.status}`}
                  initial={reduceMotion ? false : { opacity: 0, y: -6, scale: 0.98 }}
                  animate={reduceMotion ? undefined : { opacity: 1, y: 0, scale: 1 }}
                  exit={reduceMotion ? undefined : { opacity: 0, y: -8, scale: 0.98 }}
                  transition={reduceMotion ? undefined : { duration: 0.28, ease: EASE_OUT }}
                  className={`${progressPanelTone} mx-auto min-w-0 w-full max-w-4xl`}
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2 font-medium text-foreground">
                      {session.status !== "completed" ? (
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
                    length: Math.max(1, guideThinkBlockCount, isThinking ? 1 : 0),
                  }).map((_, index) => (
                    <ThinkingMessage key={`guide-thinking-${index}`} reduceMotion={reduceMotion} />
                  ))}
                </motion.div>
              ) : null}
            </AnimatePresence>

            <AnimatePresence initial={false}>
              {hasGuideContent ? (
                <motion.div
                  key="guide-body"
                  data-guide-version={1}
                  initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                  animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
                  transition={reduceMotion ? undefined : { duration: 0.35, ease: EASE_OUT }}
                  className="mx-auto min-w-0 w-full max-w-4xl p-1 text-left text-[15px] leading-6"
                >
                  <div className="font-body [&_a]:font-medium [&_a]:text-blue-600 [&_a]:underline [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:italic [&_code]:font-code [&_code]:text-[14px] [&_code]:break-words [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h1]:mt-6 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_h1:first-child]:mt-0 [&_h2]:mt-5 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2:first-child]:mt-0 [&_h3]:mt-4 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:tracking-tight [&_h3:first-child]:mt-0 [&_h4]:mt-4 [&_h4]:text-base [&_h4]:font-semibold [&_hr]:my-6 [&_li]:my-1 [&_li]:break-words [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-3 [&_p]:break-words [&_p]:font-light [&_pre]:font-code [&_pre]:text-[14px] [&_pre]:my-3 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_strong]:font-semibold [&_table]:w-full [&_table]:min-w-[28rem] [&_table]:border-separate [&_table]:border-spacing-0 [&_table]:rounded-md [&_table]:border [&_table]:border-border/70 [&_thead]:bg-muted/45 [&_th]:border-b [&_th]:border-border/70 [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-[13px] [&_th]:font-semibold [&_td]:border-b [&_td]:border-border/50 [&_td]:px-2 [&_td]:py-1.5 [&_td]:text-[13px] [&_tbody_tr:last-child_td]:border-b-0 [&_tbody_tr:nth-child(even)]:bg-muted/25 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                      {deferredGuideMarkdown}
                    </ReactMarkdown>
                    {guideTailText ? (
                      <span key={deferredGuideMarkdown.length} className="whitespace-pre-wrap font-light stream-chunk-in">
                        {guideTailText}
                      </span>
                    ) : null}
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>

            {session?.status === "failed" ? (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-[15px] text-red-800">
                Error generating guide: {session.error || "Unknown error"}
              </div>
            ) : null}

            {shouldShowWelcomeMessage ? (
              <ChatMessageBubble
                message={{
                  id: `welcome-${sessionId}`,
                  message_index: 1,
                  sender_role: "assistant",
                  content_text: welcomeMessageText,
                  content_format: "markdown",
                  metadata: { synthetic: true },
                  created_at: welcomeCreatedAt,
                }}
                isLatestStreamingAssistant={false}
                reduceMotion={reduceMotion}
              />
            ) : null}

            {(session?.messages ?? []).map((message) => {
              const proposal =
                message.sender_role === "assistant"
                  ? calendarProposals.get(message.id)
                  : undefined
              const guideVersionNum =
                typeof message.metadata?.guide_version === "number"
                  ? message.metadata.guide_version
                  : null

              return (
                <div
                  key={message.id}
                  {...(guideVersionNum !== null ? { "data-guide-version": guideVersionNum } : {})}
                >
                  <ChatMessageBubble
                    message={message}
                    isLatestStreamingAssistant={
                      message.sender_role === "assistant" &&
                      message.id === latestAssistantMessageId &&
                      isSending
                    }
                    reduceMotion={reduceMotion}
                  />

                  {proposal ? (
                    <div className="mx-auto w-full max-w-4xl px-1">
                      <CalendarProposalCard
                        assignmentId={proposal.assignmentId}
                        sessionId={sessionId}
                        sessions={proposal.sessions}
                        timezone={String(session?.payload?.userTimezone ?? "UTC")}
                        onScheduled={() => onCalendarScheduled(message.id)}
                        onDismissed={() => onCalendarDismissed(message.id)}
                      />
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </ScrollArea>
      </div>

      {hasGuideContent && !isGuideStreaming ? (
        <div className="absolute bottom-16 right-6 z-30">
          <GuideExportButton
            guideMarkdown={guideMarkdown}
            assignmentTitle={session?.payload?.title}
            courseName={session?.payload?.courseName}
            versions={guideVersions}
            sessionId={sessionId}
          />
        </div>
      ) : null}
    </div>
  )
}
