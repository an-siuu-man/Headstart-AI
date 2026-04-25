"use client"

import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import { useCallback, useEffect, useState } from "react"
import { AnimatePresence, motion } from "framer-motion"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import rehypeKatex from "rehype-katex"
import {
  format,
  formatDistanceToNow,
  differenceInDays,
  differenceInHours,
} from "date-fns"
import {
  ExternalLink,
  CheckCircle2,
  RotateCcw,
  Trash2,
  LoaderCircle,
  MessageSquare,
  FileText,
  Clock,
  ChevronDown,
  ChevronUp,
  Calendar as CalendarIcon,
  BookOpen,
  AlignLeft,
  AlertTriangle,
  Plus,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { GuideExportButton } from "@/components/chat/guide-export-button"
import { MARKDOWN_COMPONENTS } from "@/components/chat/markdown-components"
import { removeThinkBlocks } from "@/lib/chat-utils"
import { cn } from "@/lib/utils"
import { type GuideVersionMeta } from "@/lib/chat-types"

const EASE_OUT = [0.22, 1, 0.36, 1] as const
const MAX_COURSE_NAME_LENGTH = 48
const GUIDE_REMARK_PLUGINS = [remarkGfm, remarkMath]
const GUIDE_REHYPE_PLUGINS = [rehypeKatex]
const GUIDE_MARKDOWN_CLASS =
  "font-body [&_a]:font-medium [&_a]:text-blue-600 [&_a]:underline [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:italic [&_code]:font-code [&_code]:break-words [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h1]:mt-6 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_h1:first-child]:mt-0 [&_h2]:mt-5 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2:first-child]:mt-0 [&_h3]:mt-4 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:tracking-tight [&_h3:first-child]:mt-0 [&_h4]:mt-4 [&_h4]:text-base [&_h4]:font-semibold [&_hr]:my-6 [&_li]:my-1 [&_li]:break-words [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-3 [&_p]:break-words [&_p]:font-light [&_pre]:font-code [&_pre]:my-3 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_strong]:font-semibold [&_table]:w-full [&_table]:min-w-[28rem] [&_table]:border-separate [&_table]:border-spacing-0 [&_table]:rounded-md [&_table]:border [&_table]:border-border/70 [&_thead]:bg-muted/45 [&_th]:border-b [&_th]:border-border/70 [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-[13px] [&_th]:font-semibold [&_td]:border-b [&_td]:border-border/50 [&_td]:px-2 [&_td]:py-1.5 [&_td]:text-[13px] [&_tbody_tr:last-child_td]:border-b-0 [&_tbody_tr:nth-child(even)]:bg-muted/25 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5"

type SessionItem = {
  session_id: string
  last_user_message: string | null
  status: string
  created_at: number
  updated_at: number
}

type PdfFile = {
  filename: string
  byte_size: number | null
  signed_url: string
}

type RubricCriterion = {
  description?: string
  longDescription?: string
  long_description?: string
  points?: number
  ratings?: Array<{ description?: string; points?: number }>
}

type GuideSessionItem = {
  session_id: string
  title: string
  version_count: number
  latest_guide_at: string
  created_at: number
}

type AssignmentDetail = {
  assignment_id: string
  title: string
  course_name: string | null
  due_at_iso: string | null
  points_possible: number | null
  submission_type: string | null
  description_text: string | null
  description_html: string | null
  canvas_url: string | null
  rubric: { criteria?: unknown[] } | null
  attachment_count: number
  is_submitted: boolean
  submitted_at: string | null
  is_overdue: boolean
  priority: "High" | "Medium" | "Low"
  sessions: SessionItem[]
  latest_session_id: string | null
  latest_guide_session_id: string | null
  guide_sessions: GuideSessionItem[]
  latest_guide_content: string | null
  guide_versions: GuideVersionMeta[]
  has_guide: boolean
  first_guide_at: string | null
  pdf_files: PdfFile[]
}

function priorityTone(priority: AssignmentDetail["priority"]) {
  if (priority === "High") return "border-red-200/80 bg-red-50 text-red-700"
  if (priority === "Medium") return "border-amber-200/80 bg-amber-50 text-amber-700"
  return "border-emerald-200/80 bg-emerald-50 text-emerald-700"
}

function sessionStatusTone(status: string) {
  if (status === "completed") return "border-emerald-200/80 bg-emerald-50 text-emerald-700"
  if (status === "running" || status === "queued") return "border-amber-200/80 bg-amber-50 text-amber-700"
  if (status === "failed") return "border-red-200/80 bg-red-50 text-red-700"
  return "border-slate-200/80 bg-slate-50 text-slate-700"
}

function formatBytes(bytes: number | null) {
  if (bytes == null) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function parseIsoDate(value: string | null | undefined) {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function truncateWithEllipsis(value: string, maxLength: number) {
  const normalizedValue = value.trim()
  if (normalizedValue.length <= maxLength) return normalizedValue
  return `${normalizedValue.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

function urgencyColor(dueAt: Date | null, isSubmitted: boolean, isOverdue: boolean) {
  if (isSubmitted) return "bg-emerald-500"
  if (!dueAt) return "bg-slate-300"
  if (isOverdue) return "bg-red-500"
  const hoursUntil = differenceInHours(dueAt, new Date())
  if (hoursUntil <= 24) return "bg-red-500"
  if (hoursUntil <= 48) return "bg-orange-500"
  if (hoursUntil <= 24 * 7) return "bg-amber-400"
  return "bg-emerald-500"
}

export default function AssignmentDetailPage() {
  const params = useParams()
  const router = useRouter()
  const slug = typeof params.slug === "string" ? params.slug : Array.isArray(params.slug) ? params.slug[0] : ""

  const [detail, setDetail] = useState<AssignmentDetail | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [isUpdatingSubmit, setIsUpdatingSubmit] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [descriptionExpanded, setDescriptionExpanded] = useState(false)
  const [rubricExpanded, setRubricExpanded] = useState(false)
  const [selectedGuideVersion, setSelectedGuideVersion] = useState<number | null>(null)
  const [guideContentByVersion, setGuideContentByVersion] = useState<Record<number, string>>({})
  const [loadingGuideVersionNumber, setLoadingGuideVersionNumber] = useState<number | null>(null)
  const [guideVersionError, setGuideVersionError] = useState<string | null>(null)
  const [selectedGuideSessionId, setSelectedGuideSessionId] = useState<string | null>(null)
  const [currentGuideVersions, setCurrentGuideVersions] = useState<GuideVersionMeta[]>([])
  const [isCreatingChat, setIsCreatingChat] = useState(false)

  async function handleNewChat() {
    if (isCreatingChat || !slug) return
    setIsCreatingChat(true)
    try {
      const res = await fetch(`/api/assignments/${encodeURIComponent(slug)}/new-chat`, {
        method: "POST",
      })
      if (!res.ok) throw new Error("Failed to create chat")
      const body = (await res.json()) as { session_id: string }
      router.push(`/dashboard/chat?session=${encodeURIComponent(body.session_id)}`)
    } catch {
      setIsCreatingChat(false)
    }
  }

  const loadDetail = useCallback(async () => {
    if (!slug) return
    try {
      setIsLoading(true)
      const res = await fetch(`/api/assignments/${encodeURIComponent(slug)}/detail`, {
        cache: "no-store",
      })
      if (!res.ok) {
        const body = await res.text()
        throw new Error(body || `Failed to load assignment (${res.status})`)
      }
      const body = (await res.json()) as AssignmentDetail
      setDetail(body)
      setErrorText(null)

      const latestVersionNumber =
        body.guide_versions[body.guide_versions.length - 1]?.version_number ?? null
      setSelectedGuideVersion(latestVersionNumber)
      setLoadingGuideVersionNumber(null)
      setGuideVersionError(null)
      setSelectedGuideSessionId(body.latest_guide_session_id)
      setCurrentGuideVersions(body.guide_versions)
      if (latestVersionNumber !== null && body.latest_guide_content !== null) {
        setGuideContentByVersion({
          [latestVersionNumber]: body.latest_guide_content,
        })
      } else {
        setGuideContentByVersion({})
      }
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }, [slug])

  const handleGuideVersionChange = useCallback(
    async (nextValue: string) => {
      const versionNumber = Number.parseInt(nextValue, 10)
      if (!Number.isFinite(versionNumber) || versionNumber < 1) return

      setSelectedGuideVersion(versionNumber)
      setGuideVersionError(null)

      if (!selectedGuideSessionId) return
      if (Object.prototype.hasOwnProperty.call(guideContentByVersion, versionNumber)) return

      setLoadingGuideVersionNumber(versionNumber)
      try {
        const response = await fetch(
          `/api/chat-session/${encodeURIComponent(selectedGuideSessionId)}/guide-versions/${versionNumber}`,
          { cache: "no-store" },
        )
        if (!response.ok) {
          const body = await response.text()
          throw new Error(body || `Failed to load guide version (${response.status})`)
        }

        const body = (await response.json()) as { content_text?: string }
        if (typeof body.content_text !== "string") {
          throw new Error("Guide version content missing")
        }
        const contentText = body.content_text

        setGuideContentByVersion((current) => ({
          ...current,
          [versionNumber]: contentText,
        }))
      } catch (error) {
        setGuideVersionError(error instanceof Error ? error.message : "Failed to load guide version.")
      } finally {
        setLoadingGuideVersionNumber((current) => (current === versionNumber ? null : current))
      }
    },
    [selectedGuideSessionId, guideContentByVersion],
  )

  const handleGuideSessionChange = useCallback(
    async (nextSessionId: string) => {
      if (!nextSessionId || nextSessionId === selectedGuideSessionId) return
      setSelectedGuideSessionId(nextSessionId)
      setSelectedGuideVersion(null)
      setGuideContentByVersion({})
      setGuideVersionError(null)
      setLoadingGuideVersionNumber(null)

      try {
        const versionsRes = await fetch(
          `/api/chat-session/${encodeURIComponent(nextSessionId)}/guide-versions`,
          { cache: "no-store" },
        )
        if (!versionsRes.ok) throw new Error("Failed to load guide versions")
        const versionsBody = (await versionsRes.json()) as { versions?: GuideVersionMeta[] }
        const versions = versionsBody.versions ?? []
        setCurrentGuideVersions(versions)

        const latest = versions[versions.length - 1]
        if (!latest) return
        setSelectedGuideVersion(latest.version_number)
        setLoadingGuideVersionNumber(latest.version_number)

        const contentRes = await fetch(
          `/api/chat-session/${encodeURIComponent(nextSessionId)}/guide-versions/${latest.version_number}`,
          { cache: "no-store" },
        )
        if (!contentRes.ok) throw new Error("Failed to load guide content")
        const contentBody = (await contentRes.json()) as { content_text?: string }
        if (typeof contentBody.content_text === "string") {
          setGuideContentByVersion({ [latest.version_number]: contentBody.content_text })
        }
      } catch (err) {
        setGuideVersionError(err instanceof Error ? err.message : "Failed to load guide.")
      } finally {
        setLoadingGuideVersionNumber(null)
      }
    },
    [selectedGuideSessionId],
  )

  useEffect(() => {
    void loadDetail()
  }, [loadDetail])

  const toggleSubmitted = useCallback(async () => {
    if (!detail?.assignment_id) return
    setIsUpdatingSubmit(true)
    try {
      const res = await fetch(
        `/api/assignments/${encodeURIComponent(detail.assignment_id)}/submission`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ is_submitted: !detail.is_submitted }),
        },
      )
      if (!res.ok) {
        const body = await res.text()
        throw new Error(body || `Failed to update submission (${res.status})`)
      }
      await loadDetail()
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err))
    } finally {
      setIsUpdatingSubmit(false)
    }
  }, [detail, loadDetail])

  const confirmDelete = useCallback(async () => {
    if (!detail?.assignment_id) return
    setIsDeleting(true)
    try {
      const res = await fetch(`/api/assignments/${encodeURIComponent(detail.assignment_id)}`, {
        method: "DELETE",
      })
      if (!res.ok) {
        const body = await res.text()
        throw new Error(body || `Failed to delete assignment (${res.status})`)
      }
      router.push("/dashboard/assignments")
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err))
      setIsDeleting(false)
      setShowDeleteDialog(false)
    }
  }, [detail, router])

  if (isLoading) {
    return (
      <div className="flex h-full flex-col space-y-6">
        <div className="h-4 w-48 animate-pulse rounded bg-muted/40" />
        <div className="h-8 w-80 animate-pulse rounded bg-muted/40" />
        <div className="h-20 animate-pulse rounded-lg bg-muted/30" />
        <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
          <div className="space-y-4">
            <div className="h-64 animate-pulse rounded-lg bg-muted/30" />
            <div className="h-32 animate-pulse rounded-lg bg-muted/30" />
          </div>
          <div className="space-y-4">
            <div className="h-40 animate-pulse rounded-lg bg-muted/30" />
            <div className="h-32 animate-pulse rounded-lg bg-muted/30" />
          </div>
        </div>
      </div>
    )
  }

  if (errorText || !detail) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <p className="text-sm text-destructive">{errorText ?? "Assignment not found."}</p>
        <Button asChild variant="outline" className="mt-4">
          <Link href="/dashboard/assignments">Back to Assignments</Link>
        </Button>
      </div>
    )
  }

  const dueAt = parseIsoDate(detail.due_at_iso)
  const submittedAt = parseIsoDate(detail.submitted_at)
  const firstGuideAt = parseIsoDate(detail.first_guide_at)
  const rubricCriteria = (detail.rubric?.criteria ?? []) as RubricCriterion[]
  const totalRubricPoints = rubricCriteria.reduce((sum, c) => sum + (c.points ?? 0), 0)
  const fullCourseName = detail.course_name?.trim() || "Unknown course"
  const courseName = truncateWithEllipsis(fullCourseName, MAX_COURSE_NAME_LENGTH)
  const latestGuideVersionNumber =
    currentGuideVersions[currentGuideVersions.length - 1]?.version_number ?? null
  const selectedGuideVersionNumber = selectedGuideVersion ?? latestGuideVersionNumber
  const latestGuideMarkdownRaw = detail.latest_guide_content ?? ""
  const activeGuideMarkdownRaw =
    selectedGuideVersionNumber != null &&
    Object.prototype.hasOwnProperty.call(guideContentByVersion, selectedGuideVersionNumber)
      ? guideContentByVersion[selectedGuideVersionNumber] ?? ""
      : selectedGuideVersionNumber === latestGuideVersionNumber
      ? latestGuideMarkdownRaw
      : ""
  const { visibleMarkdown: guideMarkdown } = removeThinkBlocks(activeGuideMarkdownRaw)
  const hasVisibleGuideContent = guideMarkdown.trim().length > 0

  const descriptionText = detail.description_text ?? ""
  const isDescriptionLong = descriptionText.length > 500
  const displayDescription =
    descriptionExpanded || !isDescriptionLong ? descriptionText : descriptionText.slice(0, 500) + "…"

  // Progress steps
  const progressSteps = [
    {
      label: "Imported",
      done: true,
      timestamp: null,
    },
    {
      label: "Guide Generated",
      done: detail.has_guide,
      timestamp: firstGuideAt ? format(firstGuideAt, "MMM d, yyyy") : null,
    },
    {
      label: "Submitted",
      done: detail.is_submitted,
      timestamp: submittedAt ? format(submittedAt, "MMM d, yyyy") : null,
    },
  ]

  // Key dates timeline
  type TimelineEvent = { label: string; date: Date; past: boolean; highlight?: boolean }
  const timelineEvents: TimelineEvent[] = []
  if (firstGuideAt) timelineEvents.push({ label: "Guide Created", date: firstGuideAt, past: true })
  if (dueAt)
    timelineEvents.push({
      label: "Due",
      date: dueAt,
      past: dueAt < new Date(),
      highlight: true,
    })
  if (submittedAt) timelineEvents.push({ label: "Submitted", date: submittedAt, past: true })
  timelineEvents.sort((a, b) => a.date.getTime() - b.date.getTime())

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col space-y-6">
        {/* Breadcrumb */}
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href="/dashboard/assignments">Assignments</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage className="max-w-[32ch] truncate">{detail.title}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: EASE_OUT }}
          className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
        >
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className="max-w-[32ch] shrink justify-start">
                    <span className="block max-w-full truncate">{courseName}</span>
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>{fullCourseName}</TooltipContent>
              </Tooltip>
              <Badge variant="outline" className={cn(priorityTone(detail.priority))}>
                {detail.priority} Priority
              </Badge>
              {detail.is_submitted && (
                <Badge variant="outline" className="border-emerald-200/80 bg-emerald-50 text-emerald-700">
                  Submitted
                </Badge>
              )}
              {detail.is_overdue && (
                <Badge variant="outline" className="border-red-200/80 bg-red-50 text-red-700">
                  Overdue
                </Badge>
              )}
            </div>
            <h1 className="text-2xl font-heading font-bold tracking-tight">{detail.title}</h1>
          </div>

          {/* Action buttons */}
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {detail.canvas_url && (
              <Button variant="outline" size="sm" asChild>
                <a href={detail.canvas_url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                  Open in Canvas
                </a>
              </Button>
            )}
            {detail.latest_session_id && (
              <Button variant="outline" size="sm" asChild>
                <Link href={`/dashboard/chat?session=${detail.latest_session_id}`}>
                  <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
                  Open Chat
                </Link>
              </Button>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void toggleSubmitted()}
                  disabled={isUpdatingSubmit}
                >
                  {isUpdatingSubmit ? (
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  ) : detail.is_submitted ? (
                    <>
                      <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                      Unsubmit
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
                      Mark Submitted
                    </>
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {detail.is_submitted ? "Mark as not submitted" : "Mark as submitted"}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setShowDeleteDialog(true)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Delete assignment</TooltipContent>
            </Tooltip>
          </div>
        </motion.div>

        {errorText && <p className="text-sm text-destructive">{errorText}</p>}

        {/* Due Date Banner */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, delay: 0.05, ease: EASE_OUT }}
          className={cn(
            "rounded-lg border px-4 py-3",
            detail.is_submitted
              ? "border-emerald-200 bg-emerald-50"
              : detail.is_overdue
              ? "border-red-200 bg-red-50"
              : "border-border bg-muted/20",
          )}
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              {detail.is_submitted ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
              ) : detail.is_overdue ? (
                <AlertTriangle className="h-5 w-5 text-red-600 shrink-0" />
              ) : (
                <CalendarIcon className="h-5 w-5 text-muted-foreground shrink-0" />
              )}
              <div>
                {detail.is_submitted ? (
                  <p className="font-semibold text-emerald-800">
                    Submitted
                    {submittedAt && (
                      <span className="ml-2 font-normal text-emerald-700">
                        on {format(submittedAt, "MMM d, yyyy")}
                      </span>
                    )}
                  </p>
                ) : dueAt ? (
                  <>
                    <p
                      className={cn(
                        "font-semibold",
                        detail.is_overdue ? "text-red-800" : "text-foreground",
                      )}
                    >
                      Due {format(dueAt, "MMMM d, yyyy 'at' h:mm a")}
                    </p>
                    <p
                      className={cn(
                        "text-sm",
                        detail.is_overdue ? "text-red-600" : "text-muted-foreground",
                      )}
                    >
                      {detail.is_overdue
                        ? `Overdue by ${formatDistanceToNow(dueAt)}`
                        : `Due ${formatDistanceToNow(dueAt, { addSuffix: true })}`}
                    </p>
                  </>
                ) : (
                  <p className="text-muted-foreground">No due date set</p>
                )}
              </div>
            </div>
            {/* Countdown pill */}
            {!detail.is_submitted && dueAt && !detail.is_overdue && (
              <div className="flex items-center gap-2">
                <div
                  className={cn(
                    "h-2 w-24 rounded-full bg-muted overflow-hidden",
                  )}
                >
                  <div
                    className={cn(
                      "h-full rounded-full transition-all",
                      urgencyColor(dueAt, detail.is_submitted, detail.is_overdue),
                    )}
                    style={{
                      width: (() => {
                        const days = differenceInDays(dueAt, new Date())
                        if (days > 14) return "100%"
                        if (days <= 0) return "0%"
                        return `${Math.round((days / 14) * 100)}%`
                      })(),
                    }}
                  />
                </div>
                <span className="text-sm font-medium text-muted-foreground">
                  {differenceInDays(dueAt, new Date())}d left
                </span>
              </div>
            )}
          </div>
        </motion.div>

        {/* Main two-column layout */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, delay: 0.1, ease: EASE_OUT }}
          className="grid gap-6 lg:grid-cols-[1fr_320px]"
        >
          {/* LEFT COLUMN */}
          <div className="space-y-6 min-w-0">
            {/* Study Guide Panel */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <BookOpen className="h-4 w-4" />
                    Study Guide
                    {currentGuideVersions.length > 0 && (
                      <Badge variant="outline" className="text-xs">
                        v{currentGuideVersions[currentGuideVersions.length - 1]?.version_number ?? 1}
                      </Badge>
                    )}
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    {hasVisibleGuideContent && (
                      <GuideExportButton
                        guideMarkdown={latestGuideMarkdownRaw}
                        assignmentTitle={detail.title}
                        courseName={detail.course_name ?? undefined}
                        versions={currentGuideVersions}
                        sessionId={selectedGuideSessionId ?? undefined}
                        stripThinkBlocks
                      />
                    )}
                    {selectedGuideSessionId && (
                      <Button variant="outline" size="sm" asChild>
                        <Link href={`/dashboard/chat?session=${selectedGuideSessionId}`}>
                          <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
                          Chat
                        </Link>
                      </Button>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {detail.guide_sessions.length > 1 && (
                  <div className="mb-3 flex items-center gap-2">
                    <span className="text-xs text-muted-foreground shrink-0">Guide from:</span>
                    <select
                      value={selectedGuideSessionId ?? ""}
                      onChange={(e) => { void handleGuideSessionChange(e.target.value) }}
                      className="h-7 rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                    >
                      {detail.guide_sessions.map((s) => (
                        <option key={s.session_id} value={s.session_id}>
                          {new Date(s.created_at).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                          {s.version_count > 1 ? ` (${s.version_count} versions)` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {currentGuideVersions.length > 1 && selectedGuideVersionNumber !== null && (
                  <motion.div
                    className="mb-3 overflow-x-auto pb-1"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.24, ease: EASE_OUT }}
                  >
                    <Tabs
                      value={String(selectedGuideVersionNumber)}
                      onValueChange={(value) => {
                        void handleGuideVersionChange(value)
                      }}
                      className="min-w-max gap-1"
                    >
                      <TabsList
                        variant="default"
                        className={cn(
                          "h-auto w-max justify-start rounded-full border border-border/70 bg-muted/65 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] backdrop-blur-sm",
                        )}
                      >
                        {currentGuideVersions.map((version) => (
                          <TabsTrigger
                            key={version.version_number}
                            value={String(version.version_number)}
                            className={cn(
                              "relative h-8 flex-none overflow-hidden rounded-full px-3 text-xs font-medium",
                              "text-muted-foreground transition-[color,box-shadow,background-color] duration-300 ease-out",
                              "hover:text-foreground/90",
                              "focus-visible:ring-2 focus-visible:ring-brand-blue/35 focus-visible:ring-offset-0 focus-visible:outline-none",
                              "data-[state=active]:text-brand-blue data-[state=active]:shadow-[0_0_0_1px_rgba(0,81,186,0.16),0_8px_18px_rgba(15,23,42,0.12)]",
                            )}
                          >
                            {selectedGuideVersionNumber === version.version_number && (
                              <motion.span
                                layoutId="guide-version-active-pill"
                                className="absolute inset-0 rounded-full bg-background ring-1 ring-brand-blue/20"
                                transition={{
                                  type: "spring",
                                  stiffness: 520,
                                  damping: 36,
                                  mass: 0.65,
                                }}
                              />
                            )}
                            <span className="relative z-10">v{version.version_number}</span>
                          </TabsTrigger>
                        ))}
                      </TabsList>
                    </Tabs>
                  </motion.div>
                )}

                {guideVersionError && (
                  <p className="mb-3 text-xs text-destructive">{guideVersionError}</p>
                )}

                <AnimatePresence mode="wait" initial={false}>
                  {loadingGuideVersionNumber === selectedGuideVersionNumber && !hasVisibleGuideContent ? (
                    <motion.div
                      key={`loading-${selectedGuideVersionNumber ?? "none"}`}
                      initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
                      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                      exit={{ opacity: 0, y: -8, filter: "blur(4px)" }}
                      transition={{ duration: 0.24, ease: EASE_OUT }}
                      className="flex items-center gap-2 py-8 text-sm text-muted-foreground"
                    >
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                      Loading guide version…
                    </motion.div>
                  ) : hasVisibleGuideContent ? (
                    <motion.div
                      key={`guide-${selectedGuideVersionNumber ?? "latest"}`}
                      initial={{ opacity: 0, y: 14, scale: 0.99, filter: "blur(6px)" }}
                      animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
                      exit={{ opacity: 0, y: -10, scale: 0.995, filter: "blur(4px)" }}
                      transition={{ duration: 0.3, ease: EASE_OUT }}
                      className={cn("min-w-0 text-[15px] leading-6", GUIDE_MARKDOWN_CLASS)}
                    >
                      <ReactMarkdown
                        remarkPlugins={GUIDE_REMARK_PLUGINS}
                        rehypePlugins={GUIDE_REHYPE_PLUGINS}
                        components={MARKDOWN_COMPONENTS}
                      >
                        {guideMarkdown}
                      </ReactMarkdown>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="empty-guide"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: 0.24, ease: EASE_OUT }}
                      className="flex flex-col items-center justify-center gap-3 py-10 text-center text-muted-foreground"
                    >
                      <BookOpen className="h-10 w-10 opacity-30" />
                      <p className="text-sm">No study guide generated yet.</p>
                      {detail.sessions.length > 0 ? (
                        <Button variant="outline" size="sm" asChild>
                          <Link href={`/dashboard/chat?session=${detail.sessions[0]?.session_id}`}>
                            <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
                            Open Chat to Generate
                          </Link>
                        </Button>
                      ) : (
                        <Button variant="outline" size="sm" onClick={handleNewChat} disabled={isCreatingChat}>
                          {isCreatingChat ? (
                            <LoaderCircle className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                          ) : (
                            <Plus className="h-3.5 w-3.5 mr-1.5" />
                          )}
                          Start a Chat
                        </Button>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </CardContent>
            </Card>

            {/* Assignment Description */}
            {descriptionText && (
              <Card>
                <CardHeader className="pb-3">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between text-left"
                    onClick={() => setDescriptionExpanded((v) => !v)}
                  >
                    <CardTitle className="flex items-center gap-2 text-base">
                      <AlignLeft className="h-4 w-4" />
                      Assignment Description
                    </CardTitle>
                    {isDescriptionLong && (
                      descriptionExpanded ? (
                        <ChevronUp className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      )
                    )}
                  </button>
                </CardHeader>
                <CardContent>
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground leading-relaxed">
                    {displayDescription}
                  </p>
                  {isDescriptionLong && (
                    <button
                      type="button"
                      className="mt-2 text-xs text-primary hover:underline"
                      onClick={() => setDescriptionExpanded((v) => !v)}
                    >
                      {descriptionExpanded ? "Show less" : "Show more"}
                    </button>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Rubric */}
            {rubricCriteria.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between text-left"
                    onClick={() => setRubricExpanded((v) => !v)}
                  >
                    <CardTitle className="flex items-center gap-2 text-base">
                      <FileText className="h-4 w-4" />
                      Rubric
                      <Badge variant="outline" className="text-xs">
                        {rubricCriteria.length} criteria
                      </Badge>
                    </CardTitle>
                    {rubricExpanded ? (
                      <ChevronUp className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    )}
                  </button>
                </CardHeader>
                {rubricExpanded && (
                  <CardContent className="pt-0">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border">
                            <th className="pb-2 pr-4 text-left font-medium text-muted-foreground">Criterion</th>
                            <th className="pb-2 pr-4 text-left font-medium text-muted-foreground">Description</th>
                            <th className="pb-2 text-right font-medium text-muted-foreground">Points</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/50">
                          {rubricCriteria.map((criterion, index) => (
                            <tr key={`criterion-${index}`} className="align-top">
                              <td className="py-2 pr-4 font-medium">{criterion.description ?? `Criterion ${index + 1}`}</td>
                              <td className="py-2 pr-4 text-muted-foreground">
                                {criterion.longDescription ?? criterion.long_description ?? "—"}
                              </td>
                              <td className="py-2 text-right font-medium">{criterion.points ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                        {totalRubricPoints > 0 && (
                          <tfoot>
                            <tr className="border-t border-border">
                              <td colSpan={2} className="pt-2 pr-4 font-semibold">Total</td>
                              <td className="pt-2 text-right font-semibold">{totalRubricPoints} pts</td>
                            </tr>
                          </tfoot>
                        )}
                      </table>
                    </div>
                  </CardContent>
                )}
              </Card>
            )}
          </div>

          {/* RIGHT COLUMN */}
          <div className="space-y-4">
            {/* Progress Tracker */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Progress
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="relative space-y-0">
                  {progressSteps.map((step, index) => (
                    <div key={step.label} className="flex items-start gap-3">
                      <div className="flex flex-col items-center">
                        <div
                          className={cn(
                            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold transition-colors",
                            step.done
                              ? "border-emerald-500 bg-emerald-500 text-white"
                              : "border-muted-foreground/30 bg-background text-muted-foreground",
                          )}
                        >
                          {step.done ? (
                            <CheckCircle2 className="h-4 w-4" />
                          ) : (
                            <span>{index + 1}</span>
                          )}
                        </div>
                        {index < progressSteps.length - 1 && (
                          <div
                            className={cn(
                              "w-0.5 flex-1 my-1",
                              step.done ? "bg-emerald-500/40" : "bg-muted-foreground/20",
                            )}
                            style={{ height: "20px" }}
                          />
                        )}
                      </div>
                      <div className="pb-4">
                        <p
                          className={cn(
                            "text-sm font-medium",
                            step.done ? "text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {step.label}
                        </p>
                        {step.timestamp && (
                          <p className="text-xs text-muted-foreground">{step.timestamp}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Quick Stats */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Details
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0 space-y-2 text-sm">
                {detail.points_possible != null && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Points</span>
                    <span className="font-medium">{detail.points_possible}</span>
                  </div>
                )}
                {detail.submission_type && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Submission</span>
                    <span className="font-medium text-right max-w-[60%] text-xs">{detail.submission_type}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Attachments</span>
                  <span className="font-medium">{detail.attachment_count}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Chat sessions</span>
                  <span className="font-medium">{detail.sessions.length}</span>
                </div>
                {currentGuideVersions.length > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Guide versions</span>
                    <span className="font-medium">{currentGuideVersions.length}</span>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* PDF Attachments */}
            {detail.pdf_files.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                    <FileText className="h-3.5 w-3.5" />
                    Attachments
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0 space-y-2">
                  {detail.pdf_files.map((file, index) => (
                    <div
                      key={`file-${index}`}
                      className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{file.filename}</p>
                        {file.byte_size != null && (
                          <p className="text-xs text-muted-foreground">{formatBytes(file.byte_size)}</p>
                        )}
                      </div>
                      <a
                        href={file.signed_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 text-xs text-primary hover:underline"
                      >
                        Download
                      </a>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Chat Sessions */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                    <MessageSquare className="h-3.5 w-3.5" />
                    Chat Sessions
                  </CardTitle>
                  <Button variant="outline" size="sm" onClick={handleNewChat} disabled={isCreatingChat}>
                    {isCreatingChat ? (
                      <LoaderCircle className="h-3.5 w-3.5 mr-1 animate-spin" />
                    ) : (
                      <Plus className="h-3.5 w-3.5 mr-1" />
                    )}
                    New
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                {detail.sessions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No chat sessions yet.</p>
                ) : (
                  <div className="space-y-2">
                    {detail.sessions.slice(0, 5).map((session) => (
                      <Link
                        key={session.session_id}
                        href={`/dashboard/chat?session=${session.session_id}`}
                        className="block rounded-md border border-border/60 px-3 py-2 text-sm transition-colors hover:bg-muted/40"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <Badge
                            variant="outline"
                            className={cn("text-xs", sessionStatusTone(session.status))}
                          >
                            {session.status}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {formatDistanceToNow(new Date(session.updated_at), { addSuffix: true })}
                          </span>
                        </div>
                        {session.last_user_message && (
                          <p className="mt-1 truncate text-xs text-muted-foreground">
                            {session.last_user_message}
                          </p>
                        )}
                      </Link>
                    ))}
                    {detail.sessions.length > 5 && (
                      <p className="text-center text-xs text-muted-foreground">
                        +{detail.sessions.length - 5} more
                      </p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Study Schedule */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  <CalendarIcon className="h-3.5 w-3.5" />
                  Study Schedule
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="mb-3 text-xs text-muted-foreground">
                  Plan study sessions around this assignment using the calendar.
                </p>
                <Button variant="outline" size="sm" className="w-full" asChild>
                  <Link href="/dashboard/calendar">
                    <CalendarIcon className="h-3.5 w-3.5 mr-1.5" />
                    Open Calendar
                  </Link>
                </Button>
              </CardContent>
            </Card>
          </div>
        </motion.div>

        {/* Key Dates Timeline */}
        {timelineEvents.length > 1 && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: 0.15, ease: EASE_OUT }}
          >
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  Key Dates
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="relative flex items-start justify-between gap-2 overflow-x-auto pb-2">
                  {/* Connecting line */}
                  <div className="absolute left-0 right-0 top-3 h-0.5 bg-border/60" />
                  {timelineEvents.map((event, index) => (
                    <div
                      key={`timeline-${index}`}
                      className="relative flex min-w-[80px] flex-col items-center gap-1.5"
                    >
                      <div
                        className={cn(
                          "relative z-10 h-6 w-6 rounded-full border-2 transition-colors",
                          event.past
                            ? event.highlight
                              ? detail.is_overdue && !detail.is_submitted
                                ? "border-red-500 bg-red-500"
                                : "border-primary bg-primary"
                              : "border-emerald-500 bg-emerald-500"
                            : "border-muted-foreground/40 bg-background",
                        )}
                      />
                      <p
                        className={cn(
                          "text-center text-xs font-medium",
                          event.highlight ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {event.label}
                      </p>
                      <p className="text-center text-[11px] text-muted-foreground">
                        {format(event.date, "MMM d")}
                      </p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </motion.div>
        )}
      </div>

      {/* Delete Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={(open) => { if (!open) setShowDeleteDialog(false) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Assignment?</DialogTitle>
            <DialogDescription>
              This permanently deletes all chats, messages, and stored attachments tied to this assignment.
            </DialogDescription>
          </DialogHeader>
          <p className="mt-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-sm">
            {detail.title}
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowDeleteDialog(false)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={isDeleting}
            >
              {isDeleting ? (
                <>
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete Assignment"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}
