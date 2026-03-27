"use client"

import { memo, useMemo } from "react"
import { format, isSameDay } from "date-fns"
import { motion } from "framer-motion"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import rehypeKatex from "rehype-katex"

import { type ChatMessageDto } from "@/lib/chat-types"
import { MARKDOWN_COMPONENTS } from "./markdown-components"

const EASE_OUT = [0.22, 1, 0.36, 1] as const
const THINK_OPEN_TAG = "<think>"
const THINK_CLOSE_TAG = "</think>"
const REMARK_PLUGINS = [remarkGfm, remarkMath]
const REHYPE_PLUGINS = [rehypeKatex]

type ChatMessageBubbleProps = {
  message: ChatMessageDto
  isLatestStreamingAssistant: boolean
  reduceMotion: boolean | null
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

function formatMessageTimestamp(value: string | null | undefined) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  if (!isSameDay(date, new Date())) {
    return format(date, "MMM d, yyyy hh:mm a")
  }
  return format(date, "hh:mm a")
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

export const ChatMessageBubble = memo(function ChatMessageBubble({
  message,
  isLatestStreamingAssistant,
  reduceMotion,
}: ChatMessageBubbleProps) {
  const assistantThinkState = useMemo(() => {
    if (message.sender_role !== "assistant") {
      return null
    }
    return removeThinkBlocks(message.content_text || "")
  }, [message.content_text, message.sender_role])

  const messageTimestampText = useMemo(
    () => formatMessageTimestamp(message.created_at),
    [message.created_at],
  )

  const assistantVisibleText = assistantThinkState?.visibleMarkdown.trim() || ""
  const assistantThinkingCount = Math.max(
    assistantThinkState?.thinkBlockCount ?? 0,
    assistantThinkState?.isThinking ? 1 : 0,
  )
  const showAssistantThinking =
    isLatestStreamingAssistant &&
    !assistantVisibleText &&
    assistantThinkingCount > 0

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
      transition={reduceMotion ? undefined : { duration: 0.24, ease: EASE_OUT }}
      className={
        message.sender_role === "user"
          ? "ml-auto w-fit max-w-[85%] break-words rounded-2xl border border-zinc-500/70 bg-zinc-700/85 px-3 py-2 text-left text-[15px] text-zinc-50 shadow-sm sm:max-w-[75%] lg:max-w-[65%]"
          : "mx-auto w-full max-w-4xl px-1 py-1 text-left text-[15px]"
      }
    >
      {message.sender_role === "assistant" ? (
        <div className="space-y-2">
          {showAssistantThinking
            ? Array.from({ length: assistantThinkingCount }).map((_, index) => (
                <ThinkingMessage
                  key={`${message.id}-thinking-${index}`}
                  reduceMotion={reduceMotion}
                />
              ))
            : null}
          {assistantVisibleText ? (
            <div className="min-w-0 [font-family:var(--font-lexend)] [&_a]:font-medium [&_a]:text-blue-600 [&_a]:underline [&_code]:[font-family:var(--font-space-mono)] [&_code]:break-words [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_hr]:my-6 [&_li]:break-words [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_p]:break-words [&_p]:font-light [&_pre]:[font-family:var(--font-space-mono)] [&_pre]:my-3 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_table]:w-full [&_table]:min-w-[28rem] [&_table]:border-separate [&_table]:border-spacing-0 [&_table]:rounded-md [&_table]:border [&_table]:border-border/70 [&_thead]:bg-muted/45 [&_th]:border-b [&_th]:border-border/70 [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-[13px] [&_th]:font-semibold [&_td]:border-b [&_td]:border-border/50 [&_td]:px-2 [&_td]:py-1.5 [&_td]:text-[13px] [&_tbody_tr:last-child_td]:border-b-0 [&_tbody_tr:nth-child(even)]:bg-muted/25 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5">
              <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MARKDOWN_COMPONENTS}>
                {assistantVisibleText}
              </ReactMarkdown>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="min-w-0 [font-family:var(--font-lexend)] [&_a]:font-medium [&_a]:text-blue-400 [&_a]:underline [&_code]:[font-family:var(--font-space-mono)] [&_code]:break-words [&_code]:rounded [&_code]:bg-zinc-600 [&_code]:px-1 [&_hr]:my-6 [&_li]:break-words [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_p]:break-words [&_pre]:[font-family:var(--font-space-mono)] [&_pre]:my-3 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-zinc-800 [&_pre]:p-3 [&_table]:w-full [&_table]:min-w-[28rem] [&_table]:border-separate [&_table]:border-spacing-0 [&_table]:rounded-md [&_table]:border [&_table]:border-zinc-500/70 [&_thead]:bg-zinc-600/45 [&_th]:border-b [&_th]:border-zinc-500/70 [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-[13px] [&_th]:font-semibold [&_td]:border-b [&_td]:border-zinc-500/50 [&_td]:px-2 [&_td]:py-1.5 [&_td]:text-[13px] [&_tbody_tr:last-child_td]:border-b-0 [&_tbody_tr:nth-child(even)]:bg-zinc-600/25 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5">
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MARKDOWN_COMPONENTS}>
            {message.content_text || ""}
          </ReactMarkdown>
        </div>
      )}
      {messageTimestampText ? (
        <p
          className={
            message.sender_role === "user"
              ? "mt-1 text-right text-[11px] font-medium tracking-wide text-zinc-200/80"
              : "mt-1 text-left text-[11px] font-medium tracking-wide text-muted-foreground"
          }
        >
          {messageTimestampText}
        </p>
      ) : null}
    </motion.div>
  )
})

ChatMessageBubble.displayName = "ChatMessageBubble"
