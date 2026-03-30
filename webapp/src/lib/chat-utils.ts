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
