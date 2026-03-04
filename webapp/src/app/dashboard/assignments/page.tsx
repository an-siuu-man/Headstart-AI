"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useState } from "react"
import { motion } from "framer-motion"
import { format, formatDistanceToNow } from "date-fns"
import {
  Search,
  Filter,
  MoreVertical,
  Calendar as CalendarIcon,
  CheckCircle2,
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
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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

const container = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.05,
    },
  },
}

const item = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0 },
}

function priorityTone(priority: AssignmentItem["priority"]) {
  if (priority === "High") return "border-red-200/80 bg-red-50 text-red-700"
  if (priority === "Medium") return "border-amber-200/80 bg-amber-50 text-amber-700"
  return "border-emerald-200/80 bg-emerald-50 text-emerald-700"
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

export default function AssignmentsPage() {
  const [searchQuery, setSearchQuery] = useState("")
  const [activeTab, setActiveTab] = useState("all")
  const [assignments, setAssignments] = useState<AssignmentItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [updatingAssignmentId, setUpdatingAssignmentId] = useState<string | null>(null)

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

  const filteredAssignments = useMemo(() => {
    return assignments.filter((assignment) => {
      const query = searchQuery.trim().toLowerCase()
      const matchesSearch =
        query.length === 0 ||
        assignment.title.toLowerCase().includes(query) ||
        (assignment.course_name ?? "").toLowerCase().includes(query)
      const matchesTab =
        activeTab === "all"
          ? true
          : activeTab === "pending"
          ? assignment.status !== "Completed"
          : activeTab === "completed"
          ? assignment.status === "Completed"
          : true
      return matchesSearch && matchesTab
    })
  }, [activeTab, assignments, searchQuery])

  const pendingCount = assignments.filter(
    (assignment) => assignment.status !== "Completed",
  ).length
  const completedCount = assignments.filter(
    (assignment) => assignment.status === "Completed",
  ).length

  return (
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

      <div className="flex items-center justify-between gap-4">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search assignments..."
            className="pl-8"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" aria-label="Assignment filters">
            <Filter className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {errorText ? (
        <p className="text-sm text-destructive">{errorText}</p>
      ) : null}

      <Tabs defaultValue="all" className="w-full" onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="all">All ({assignments.length})</TabsTrigger>
          <TabsTrigger value="pending">Pending ({pendingCount})</TabsTrigger>
          <TabsTrigger value="completed">Completed ({completedCount})</TabsTrigger>
        </TabsList>
        <TabsContent value="all" className="mt-4">
          <AssignmentList
            assignments={filteredAssignments}
            isLoading={isLoading}
            updatingAssignmentId={updatingAssignmentId}
            onToggleSubmitted={toggleSubmitted}
          />
        </TabsContent>
        <TabsContent value="pending" className="mt-4">
          <AssignmentList
            assignments={filteredAssignments}
            isLoading={isLoading}
            updatingAssignmentId={updatingAssignmentId}
            onToggleSubmitted={toggleSubmitted}
          />
        </TabsContent>
        <TabsContent value="completed" className="mt-4">
          <AssignmentList
            assignments={filteredAssignments}
            isLoading={isLoading}
            updatingAssignmentId={updatingAssignmentId}
            onToggleSubmitted={toggleSubmitted}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function AssignmentList({
  assignments,
  isLoading,
  updatingAssignmentId,
  onToggleSubmitted,
}: {
  assignments: AssignmentItem[]
  isLoading: boolean
  updatingAssignmentId: string | null
  onToggleSubmitted: (assignment: AssignmentItem) => Promise<void>
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
    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"
    >
      {assignments.map((assignment) => {
        const dueAt = parseIsoDate(assignment.due_at_iso)

        return (
          <motion.div key={assignment.id} variants={item}>
            <Card className="flex h-full flex-col hover:shadow-md transition-shadow">
              <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                <div className="space-y-1">
                  <Badge variant="outline" className="mb-2">
                    {assignment.course_name || "Unknown course"}
                  </Badge>
                  <CardTitle className="line-clamp-2 text-base" title={assignment.title}>
                    {assignment.title}
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Attachments: {assignment.attachment_count}
                  </CardDescription>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" className="h-8 w-8 p-0">
                      <span className="sr-only">Open assignment menu</span>
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem asChild>
                      <Link
                        href={`/dashboard/chat?session=${encodeURIComponent(
                          assignment.latest_session_id,
                        )}`}
                      >
                        Open chat
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!assignment.assignment_id || updatingAssignmentId === assignment.assignment_id}
                      onSelect={(event) => {
                        event.preventDefault()
                        void onToggleSubmitted(assignment)
                      }}
                    >
                      {assignment.is_submitted ? "Mark as not submitted" : "Mark as submitted"}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </CardHeader>
              <CardContent className="mt-auto space-y-3 pt-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className={cn(priorityTone(assignment.priority))}>
                    {assignment.priority}
                  </Badge>
                  <Badge variant="outline" className={cn(statusTone(assignment.status))}>
                    {assignment.status}
                  </Badge>
                </div>

                {assignment.is_submitted ? (
                  <div className="flex items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-sm font-semibold text-emerald-800">
                    <CheckCircle2 className="h-4 w-4" />
                    <span>Submitted</span>
                  </div>
                ) : (
                  <div
                    className={cn(
                      "flex items-center gap-1 text-sm",
                      assignment.is_overdue ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    <CalendarIcon className="h-4 w-4" />
                    {dueAt ? (
                      <span>
                        {format(dueAt, "MMM d, yyyy h:mm a")} ({formatDistanceToNow(dueAt, { addSuffix: true })})
                      </span>
                    ) : (
                      <span>No due date available</span>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>
        )
      })}
    </motion.div>
  )
}
