"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useState } from "react"
import { motion } from "framer-motion"
import { format, formatDistanceToNow } from "date-fns"
import {
  Search,
  Filter,
  ArrowUpDown,
  Calendar as CalendarIcon,
  CheckCircle2,
  LoaderCircle,
  Paperclip,
  RotateCcw,
  Trash2,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

type AssignmentItem = {
  id: string
  assignment_id: string | null
  title: string
  course_name: string | null
  due_at_iso: string | null
  latest_session_id: string
  latest_session_updated_at: number
  status: "Pending" | "In Progress" | "Completed"
  priority: "High" | "Medium" | "Low"
  attachment_count: number
  is_overdue: boolean
  is_submitted: boolean
  submitted_at: string | null
}

type DueFilter = "all" | "overdue" | "today" | "week" | "no-date"
type PriorityFilter = "all" | AssignmentItem["priority"]
type SortMode = "due" | "updated" | "priority" | "course" | "title"

const EASE_OUT = [0.22, 1, 0.36, 1] as const
const MAX_COURSE_NAME_LENGTH = 48

function priorityTone(priority: AssignmentItem["priority"]) {
  if (priority === "High") return "border-red-200/80 bg-red-50 text-red-700"
  if (priority === "Medium") return "border-amber-200/80 bg-amber-50 text-amber-700"
  return "border-emerald-200/80 bg-emerald-50 text-emerald-700"
}

function priorityRailTone(priority: AssignmentItem["priority"]) {
  if (priority === "High") return "border-l-red-500"
  if (priority === "Medium") return "border-l-amber-400"
  return "border-l-emerald-500"
}

function statusTone(status: AssignmentItem["status"]) {
  if (status === "Completed") return "border-emerald-200/80 bg-emerald-50 text-emerald-700"
  if (status === "In Progress") return "border-amber-200/80 bg-amber-50 text-amber-700"
  return "border-slate-200/80 bg-slate-50 text-slate-700"
}

function parseIsoDate(value: string | null | undefined) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date
}

function truncateWithEllipsis(value: string, maxLength: number) {
  const normalizedValue = value.trim()
  if (normalizedValue.length <= maxLength) return normalizedValue
  return `${normalizedValue.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

function courseNameForFilter(assignment: AssignmentItem) {
  return assignment.course_name?.trim() || "Unknown course"
}

function priorityWeight(priority: AssignmentItem["priority"]) {
  if (priority === "High") return 0
  if (priority === "Medium") return 1
  return 2
}

function isSameLocalDay(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

function matchesDueFilter(assignment: AssignmentItem, dueFilter: DueFilter) {
  if (dueFilter === "all") return true

  const dueAt = parseIsoDate(assignment.due_at_iso)
  if (dueFilter === "no-date") return !dueAt
  if (!dueAt || assignment.is_submitted) return false

  const now = new Date()
  if (dueFilter === "overdue") return assignment.is_overdue
  if (dueFilter === "today") return isSameLocalDay(dueAt, now)
  if (dueFilter === "week") {
    const sevenDaysFromNow = now.getTime() + 7 * 24 * 60 * 60 * 1000
    return dueAt.getTime() >= now.getTime() && dueAt.getTime() <= sevenDaysFromNow
  }

  return true
}

function compareDueThenUpdated(left: AssignmentItem, right: AssignmentItem) {
  if (left.is_submitted !== right.is_submitted) return left.is_submitted ? 1 : -1

  const leftDue = parseIsoDate(left.due_at_iso)?.getTime() ?? null
  const rightDue = parseIsoDate(right.due_at_iso)?.getTime() ?? null
  if (leftDue == null && rightDue == null) {
    return right.latest_session_updated_at - left.latest_session_updated_at
  }
  if (leftDue == null) return 1
  if (rightDue == null) return -1
  return leftDue - rightDue
}

function dueSummary(assignment: AssignmentItem, dueAt: Date | null) {
  if (assignment.is_submitted) {
    const submittedAt = parseIsoDate(assignment.submitted_at)
    return submittedAt ? `Submitted ${format(submittedAt, "MMM d, yyyy")}` : "Submitted"
  }

  if (!dueAt) return "No due date"
  if (assignment.is_overdue) return `Overdue ${formatDistanceToNow(dueAt, { addSuffix: true })}`
  return `Due ${formatDistanceToNow(dueAt, { addSuffix: true })}`
}

export default function AssignmentsPage() {
  const [searchQuery, setSearchQuery] = useState("")
  const [activeTab, setActiveTab] = useState("all")
  const [selectedCourse, setSelectedCourse] = useState("all")
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all")
  const [dueFilter, setDueFilter] = useState<DueFilter>("all")
  const [hasAttachmentsOnly, setHasAttachmentsOnly] = useState(false)
  const [sortMode, setSortMode] = useState<SortMode>("due")
  const [assignments, setAssignments] = useState<AssignmentItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [updatingAssignmentId, setUpdatingAssignmentId] = useState<string | null>(null)
  const [deletingAssignmentId, setDeletingAssignmentId] = useState<string | null>(null)
  const [pendingDeleteAssignmentId, setPendingDeleteAssignmentId] = useState<string | null>(null)

  const loadAssignments = useCallback(async () => {
    try {
      setIsLoading(true)
      const response = await fetch("/api/assignments", {
        method: "GET",
        cache: "no-store",
      })
      if (!response.ok) {
        const bodyText = await response.text()
        throw new Error(bodyText || `Failed to load assignments (${response.status})`)
      }
      const body = (await response.json()) as { assignments?: AssignmentItem[] }
      setAssignments(Array.isArray(body.assignments) ? body.assignments : [])
      setErrorText(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setAssignments([])
      setErrorText(message)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadAssignments()
  }, [loadAssignments])

  const toggleSubmitted = useCallback(
    async (assignment: AssignmentItem) => {
      if (!assignment.assignment_id) {
        setErrorText("Cannot update submission state for this assignment.")
        return
      }

      const nextValue = !assignment.is_submitted
      setUpdatingAssignmentId(assignment.assignment_id)
      try {
        const response = await fetch(
          `/api/assignments/${encodeURIComponent(assignment.assignment_id)}/submission`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              is_submitted: nextValue,
            }),
          },
        )

        if (!response.ok) {
          const bodyText = await response.text()
          throw new Error(bodyText || `Failed to update assignment (${response.status})`)
        }

        await loadAssignments()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setErrorText(message)
      } finally {
        setUpdatingAssignmentId(null)
      }
    },
    [loadAssignments],
  )

  const courseOptions = useMemo(() => {
    return Array.from(new Set(assignments.map(courseNameForFilter))).sort((left, right) =>
      left.localeCompare(right),
    )
  }, [assignments])

  const filteredAssignments = useMemo(() => {
    const filtered = assignments.filter((assignment) => {
      const query = searchQuery.trim().toLowerCase()
      const matchesSearch =
        query.length === 0 ||
        assignment.title.toLowerCase().includes(query) ||
        (assignment.course_name ?? "").toLowerCase().includes(query)
      const matchesTab =
        activeTab === "all"
          ? true
          : activeTab === "pending"
          ? !assignment.is_submitted
          : activeTab === "completed"
          ? assignment.is_submitted
          : true
      const matchesCourse =
        selectedCourse === "all" || courseNameForFilter(assignment) === selectedCourse
      const matchesPriority =
        priorityFilter === "all" || assignment.priority === priorityFilter
      const matchesAttachments = !hasAttachmentsOnly || assignment.attachment_count > 0
      return (
        matchesSearch &&
        matchesTab &&
        matchesCourse &&
        matchesPriority &&
        matchesDueFilter(assignment, dueFilter) &&
        matchesAttachments
      )
    })

    const sorted = filtered.slice()
    sorted.sort((left, right) => {
      if (sortMode === "updated") {
        return right.latest_session_updated_at - left.latest_session_updated_at
      }
      if (sortMode === "priority") {
        const priorityDifference =
          priorityWeight(left.priority) - priorityWeight(right.priority)
        return priorityDifference || compareDueThenUpdated(left, right)
      }
      if (sortMode === "course") {
        const courseDifference = courseNameForFilter(left).localeCompare(
          courseNameForFilter(right),
        )
        return courseDifference || compareDueThenUpdated(left, right)
      }
      if (sortMode === "title") {
        return left.title.localeCompare(right.title)
      }
      return compareDueThenUpdated(left, right)
    })

    return sorted
  }, [
    activeTab,
    assignments,
    dueFilter,
    hasAttachmentsOnly,
    priorityFilter,
    searchQuery,
    selectedCourse,
    sortMode,
  ])

  const pendingCount = assignments.filter(
    (assignment) => !assignment.is_submitted,
  ).length
  const completedCount = assignments.filter(
    (assignment) => assignment.is_submitted,
  ).length
  const pendingDeleteAssignment = pendingDeleteAssignmentId
    ? assignments.find((assignment) => assignment.id === pendingDeleteAssignmentId) ?? null
    : null
  const activeFilterCount =
    (selectedCourse !== "all" ? 1 : 0) +
    (priorityFilter !== "all" ? 1 : 0) +
    (dueFilter !== "all" ? 1 : 0) +
    (hasAttachmentsOnly ? 1 : 0)

  const resetFilters = useCallback(() => {
    setSelectedCourse("all")
    setPriorityFilter("all")
    setDueFilter("all")
    setHasAttachmentsOnly(false)
  }, [])

  const requestDeleteAssignment = useCallback((assignment: AssignmentItem) => {
    setPendingDeleteAssignmentId(assignment.id)
  }, [])

  const confirmDeleteAssignment = useCallback(async () => {
    if (!pendingDeleteAssignment) {
      setPendingDeleteAssignmentId(null)
      return
    }

    if (!pendingDeleteAssignment.assignment_id) {
      setPendingDeleteAssignmentId(null)
      setErrorText("Cannot delete this assignment because its record id is missing.")
      return
    }

    const assignmentId = pendingDeleteAssignment.assignment_id
    setDeletingAssignmentId(assignmentId)
    setErrorText(null)

    try {
      const response = await fetch(`/api/assignments/${encodeURIComponent(assignmentId)}`, {
        method: "DELETE",
      })
      if (!response.ok) {
        const bodyText = await response.text()
        throw new Error(bodyText || `Failed to delete assignment (${response.status})`)
      }

      setPendingDeleteAssignmentId(null)
      await loadAssignments()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErrorText(message)
    } finally {
      setDeletingAssignmentId(null)
    }
  }, [loadAssignments, pendingDeleteAssignment])

  return (
    <>
      <div className="flex h-full flex-col space-y-8">
        <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-3xl font-heading font-bold tracking-tight">Assignments</h2>
            <p className="text-muted-foreground">
              Assignment context synced from your persisted chat sessions.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href="/dashboard/chat">
                <CalendarIcon className="mr-2 h-4 w-4" />
                Open Chats
              </Link>
            </Button>
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
          <div className="relative min-w-0">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search assignments..."
              className="pl-8"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </div>

          <Select value={selectedCourse} onValueChange={setSelectedCourse}>
            <SelectTrigger className="w-full lg:w-[190px]" aria-label="Filter by course">
              <SelectValue placeholder="All courses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All courses</SelectItem>
              {courseOptions.map((course) => (
                <SelectItem key={course} value={course}>
                  {course}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={sortMode} onValueChange={(value) => setSortMode(value as SortMode)}>
            <SelectTrigger className="w-full lg:w-[180px]" aria-label="Sort assignments">
              <ArrowUpDown className="h-4 w-4" />
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="due">Due soon</SelectItem>
              <SelectItem value="updated">Recently updated</SelectItem>
              <SelectItem value="priority">Priority</SelectItem>
              <SelectItem value="course">Course</SelectItem>
              <SelectItem value="title">Title A-Z</SelectItem>
            </SelectContent>
          </Select>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="justify-center" aria-label="Assignment filters">
                <Filter className="h-4 w-4" />
                <span>Filters</span>
                {activeFilterCount > 0 ? (
                  <Badge variant="secondary" className="ml-1 px-1.5">
                    {activeFilterCount}
                  </Badge>
                ) : null}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>Priority</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={priorityFilter}
                onValueChange={(value) => setPriorityFilter(value as PriorityFilter)}
              >
                <DropdownMenuRadioItem value="all">Any priority</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="High">High</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="Medium">Medium</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="Low">Low</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Due date</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={dueFilter}
                onValueChange={(value) => setDueFilter(value as DueFilter)}
              >
                <DropdownMenuRadioItem value="all">Any due date</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="overdue">Overdue</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="today">Due today</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="week">Due this week</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="no-date">No due date</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={hasAttachmentsOnly}
                onCheckedChange={(checked) => setHasAttachmentsOnly(checked === true)}
                onSelect={(event) => event.preventDefault()}
              >
                Has attachments
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                disabled={activeFilterCount === 0}
                onClick={resetFilters}
              >
                Clear filters
              </Button>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {errorText ? (
          <p className="text-sm text-destructive">{errorText}</p>
        ) : null}

        <Tabs value={activeTab} className="w-full" onValueChange={setActiveTab}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <TabsList>
              <TabsTrigger value="all">All ({assignments.length})</TabsTrigger>
              <TabsTrigger value="pending">Pending ({pendingCount})</TabsTrigger>
              <TabsTrigger value="completed">Completed ({completedCount})</TabsTrigger>
            </TabsList>
            <p className="text-sm text-muted-foreground">
              Showing {filteredAssignments.length} of {assignments.length}
            </p>
          </div>
          <TabsContent value="all" className="mt-4">
            <AssignmentList
              assignments={filteredAssignments}
              isLoading={isLoading}
              updatingAssignmentId={updatingAssignmentId}
              deletingAssignmentId={deletingAssignmentId}
              onToggleSubmitted={toggleSubmitted}
              onRequestDeleteAssignment={requestDeleteAssignment}
            />
          </TabsContent>
          <TabsContent value="pending" className="mt-4">
            <AssignmentList
              assignments={filteredAssignments}
              isLoading={isLoading}
              updatingAssignmentId={updatingAssignmentId}
              deletingAssignmentId={deletingAssignmentId}
              onToggleSubmitted={toggleSubmitted}
              onRequestDeleteAssignment={requestDeleteAssignment}
            />
          </TabsContent>
          <TabsContent value="completed" className="mt-4">
            <AssignmentList
              assignments={filteredAssignments}
              isLoading={isLoading}
              updatingAssignmentId={updatingAssignmentId}
              deletingAssignmentId={deletingAssignmentId}
              onToggleSubmitted={toggleSubmitted}
              onRequestDeleteAssignment={requestDeleteAssignment}
            />
          </TabsContent>
        </Tabs>
      </div>

      <Dialog
        open={Boolean(pendingDeleteAssignment)}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDeleteAssignmentId(null)
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Assignment?</DialogTitle>
            <DialogDescription>
              This permanently deletes all chats, messages, and stored attachments tied to this assignment.
            </DialogDescription>
          </DialogHeader>
          {pendingDeleteAssignment ? (
            <p className="mt-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-sm">
              {pendingDeleteAssignment.title}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPendingDeleteAssignmentId(null)}
              disabled={Boolean(
                pendingDeleteAssignment &&
                  pendingDeleteAssignment.assignment_id &&
                  deletingAssignmentId === pendingDeleteAssignment.assignment_id,
              )}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void confirmDeleteAssignment()}
              disabled={Boolean(
                pendingDeleteAssignment &&
                  pendingDeleteAssignment.assignment_id &&
                  deletingAssignmentId === pendingDeleteAssignment.assignment_id,
              )}
            >
              {pendingDeleteAssignment &&
              pendingDeleteAssignment.assignment_id &&
              deletingAssignmentId === pendingDeleteAssignment.assignment_id ? (
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
    </>
  )
}

function AssignmentList({
  assignments,
  isLoading,
  updatingAssignmentId,
  deletingAssignmentId,
  onToggleSubmitted,
  onRequestDeleteAssignment,
}: {
  assignments: AssignmentItem[]
  isLoading: boolean
  updatingAssignmentId: string | null
  deletingAssignmentId: string | null
  onToggleSubmitted: (assignment: AssignmentItem) => Promise<void>
  onRequestDeleteAssignment: (assignment: AssignmentItem) => void
}) {
  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <Card key={`assignment-skeleton-${index}`} className="h-40 animate-pulse bg-muted/30" />
        ))}
      </div>
    )
  }

  if (assignments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
        <p>No assignments found.</p>
      </div>
    )
  }

  return (
    <TooltipProvider>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {assignments.map((assignment) => {
          const dueAt = parseIsoDate(assignment.due_at_iso)
          const isUpdating = updatingAssignmentId === assignment.assignment_id
          const isDeleting = deletingAssignmentId === assignment.assignment_id
          const submitTooltip = assignment.is_submitted
            ? "Mark as not submitted"
            : "Mark as submitted"
          const fullCourseName = assignment.course_name?.trim() || "Unknown course"
          const courseName = truncateWithEllipsis(fullCourseName, MAX_COURSE_NAME_LENGTH)

          return (
            <motion.div
              key={assignment.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: EASE_OUT }}
            >
              <Card
                className={cn(
                  "flex h-full overflow-hidden border-l-4 transition-shadow hover:shadow-md",
                  priorityRailTone(assignment.priority),
                )}
              >
                <CardHeader className="space-y-3 pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="outline" className="max-w-[32ch] shrink justify-start">
                          <span className="block max-w-full truncate">{courseName}</span>
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent>{fullCourseName}</TooltipContent>
                    </Tooltip>
                    <Badge
                      variant="outline"
                      className={cn(
                        "shrink-0",
                        assignment.is_submitted
                          ? "border-emerald-200/80 bg-emerald-50 text-emerald-700"
                          : assignment.is_overdue
                          ? "border-red-200/80 bg-red-50 text-red-700"
                          : "border-slate-200/80 bg-slate-50 text-slate-700",
                      )}
                    >
                      {assignment.is_submitted
                        ? "Submitted"
                        : assignment.is_overdue
                        ? "Overdue"
                        : "Open"}
                    </Badge>
                  </div>

                  <div className="min-w-0 space-y-2">
                    {assignment.assignment_id ? (
                      <Link href={`/dashboard/assignments/${encodeURIComponent(assignment.assignment_id)}`}>
                        <CardTitle className="line-clamp-2 break-words text-base leading-snug hover:text-primary hover:underline" title={assignment.title}>
                          {assignment.title}
                        </CardTitle>
                      </Link>
                    ) : (
                      <CardTitle className="line-clamp-2 break-words text-base leading-snug" title={assignment.title}>
                        {assignment.title}
                      </CardTitle>
                    )}
                    <CardDescription className="flex items-center gap-1 text-xs">
                      <Paperclip className="h-3.5 w-3.5" />
                      <span>{assignment.attachment_count} attachments</span>
                    </CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="mt-auto space-y-4 pt-0">
                  <div
                    className={cn(
                      "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
                      assignment.is_submitted
                        ? "border-emerald-200/80 bg-emerald-50 text-emerald-800"
                        : assignment.is_overdue
                        ? "border-red-200/80 bg-red-50 text-red-700"
                        : "border-border/70 bg-muted/20 text-muted-foreground",
                    )}
                  >
                    {assignment.is_submitted ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                    ) : (
                      <CalendarIcon className="mt-0.5 h-4 w-4 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <p className="font-medium">{dueSummary(assignment, dueAt)}</p>
                      {!assignment.is_submitted && dueAt ? (
                        <p className="text-xs opacity-80">
                          {format(dueAt, "MMM d, yyyy h:mm a")}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className={cn(priorityTone(assignment.priority))}>
                      {assignment.priority}
                    </Badge>
                    <Badge variant="outline" className={cn(statusTone(assignment.status))}>
                      {assignment.status}
                    </Badge>
                  </div>

                  <div className="flex items-center justify-between gap-2 border-t border-border/70 pt-3">
                    {assignment.assignment_id ? (
                      <Button asChild variant="outline" size="sm">
                        <Link href={`/dashboard/assignments/${encodeURIComponent(assignment.assignment_id)}`}>
                          Open
                        </Link>
                      </Button>
                    ) : (
                      <Button variant="outline" size="sm" disabled>
                        Open
                      </Button>
                    )}

                    <div className="flex items-center gap-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={submitTooltip}
                            disabled={!assignment.assignment_id || isUpdating || isDeleting}
                            onClick={() => void onToggleSubmitted(assignment)}
                          >
                            {isUpdating ? (
                              <LoaderCircle className="h-4 w-4 animate-spin" />
                            ) : assignment.is_submitted ? (
                              <RotateCcw className="h-4 w-4" />
                            ) : (
                              <CheckCircle2 className="h-4 w-4" />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{submitTooltip}</TooltipContent>
                      </Tooltip>

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="text-destructive hover:text-destructive"
                            aria-label="Delete assignment"
                            disabled={!assignment.assignment_id || isDeleting}
                            onClick={() => onRequestDeleteAssignment(assignment)}
                          >
                            {isDeleting ? (
                              <LoaderCircle className="h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="h-4 w-4" />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Delete assignment</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          )
        })}
      </div>
    </TooltipProvider>
  )
}
