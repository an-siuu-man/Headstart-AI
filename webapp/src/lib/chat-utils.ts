import { format } from "date-fns"

import { type ChatSessionStage } from "@/lib/chat-types"

const THINK_OPEN_TAG = "<think>"
const THINK_CLOSE_TAG = "</think>"

export function normalizeResult(result: unknown) {
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

export function extractGuideMarkdown(result: unknown) {
  if (result == null) {
    return ""
  }
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

export function removeThinkBlocks(markdown: string) {
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

export function stageLabel(stage: ChatSessionStage) {
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
    case "classifying_assignment":
      return "Classifying assignment"
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

export function formatDateTime(value: number | string | null | undefined) {
  if (value == null) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return format(date, "MMM d, yyyy h:mm a")
}

export function assignmentCategoryLabel(value: string | null | undefined) {
  switch ((value ?? "").trim().toLowerCase()) {
    case "coding":
      return "Coding"
    case "mathematics":
      return "Mathematics"
    case "science":
      return "Science"
    case "speech":
      return "Speech"
    case "essay":
      return "Essay"
    case "general":
      return "General"
    default:
      return null
  }
}

export function assignmentCategoryTone(value: string | null | undefined) {
  switch ((value ?? "").trim().toLowerCase()) {
    case "coding":
      return "border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-200"
    case "mathematics":
      return "border-violet-500/35 bg-violet-500/10 text-violet-700 dark:text-violet-200"
    case "science":
      return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
    case "speech":
      return "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-200"
    case "essay":
      return "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-200"
    case "general":
      return "border-slate-500/35 bg-slate-500/10 text-slate-700 dark:text-slate-200"
    default:
      return "border-border/60 bg-muted/40 text-muted-foreground"
  }
}
