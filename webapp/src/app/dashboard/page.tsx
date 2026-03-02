"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { motion } from "framer-motion"
import { format, formatDistanceToNow } from "date-fns"
import { ArrowUpRight, BookOpen, CalendarDays, Clock } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { fetchDashboardData, getCourse } from "@/lib/data"
import { Assignment, GeneratedGuide, User } from "@/lib/types"
import { useAuthUser } from "@/hooks/use-auth-user"
import { cn } from "@/lib/utils"

type DashboardData = {
  user: User
  upcomingAssignments: Assignment[]
  generatedGuides: GeneratedGuide[]
}

const container = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.08 },
  },
}

const item = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0 },
}

function greeting() {
  const hour = new Date().getHours()
  if (hour < 12) return "Good morning"
  if (hour < 18) return "Good afternoon"
  return "Good evening"
}

function priorityTone(priority: Assignment["priority"]) {
  if (priority === "High") return "border-red-200/80 bg-red-50 text-red-700"
  if (priority === "Medium") return "border-amber-200/80 bg-amber-50 text-amber-700"
  return "border-emerald-200/80 bg-emerald-50 text-emerald-700"
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const { user: authUser } = useAuthUser()

  useEffect(() => {
    fetchDashboardData().then((response) => {
      setData({
        user: response.user,
        upcomingAssignments: response.upcomingAssignments,
        generatedGuides: response.generatedGuides,
      })
    })
  }, [])

  if (!data) {
    return (
      <div className="space-y-4">
        <Card className="h-32 animate-pulse bg-muted/30" />
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <Card className="h-[420px] animate-pulse bg-muted/30" />
          <Card className="h-[420px] animate-pulse bg-muted/30" />
        </div>
      </div>
    )
  }

  const readyGuides = data.generatedGuides.filter((guide) => guide.status === "Ready").length
  const firstName = (authUser?.displayName || data.user.name).split(" ")[0]

  return (
    <motion.div variants={container} initial="hidden" animate="show" className="space-y-5">
      <motion.div variants={item}>
        <Card className="border-border/60 bg-card/85 shadow-[0_12px_34px_-22px_rgba(15,23,42,0.45)]">
          <CardContent className="flex flex-col gap-4 p-5 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-blue">
                Dashboard
              </p>
              <h2 className="text-3xl font-heading font-bold tracking-tight">
                {greeting()}, {firstName}
              </h2>
              <p className="mt-1 text-muted-foreground">
                Focus on what is due next and which guides are ready.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="border-border/70 bg-background/80 px-3 py-1.5">
                Assignments: {data.upcomingAssignments.length}
              </Badge>
              <Badge variant="outline" className="border-border/70 bg-background/80 px-3 py-1.5">
                Guides ready: {readyGuides}
              </Badge>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      <motion.div
        variants={item}
        className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]"
      >
        <Card className="border-border/60 bg-card/90 shadow-[0_14px_36px_-24px_rgba(15,23,42,0.5)]">
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-xl">Assignments</CardTitle>
                <CardDescription>Prioritized by due date and urgency.</CardDescription>
              </div>
              <Button asChild variant="ghost" size="sm" className="gap-1.5">
                <Link href="/dashboard/assignments">
                  View all
                  <ArrowUpRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.upcomingAssignments.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/80 p-6 text-center text-sm text-muted-foreground">
                No upcoming assignments.
              </div>
            ) : (
              data.upcomingAssignments.map((assignment) => {
                const course = getCourse(assignment.courseId)
                const dueAt = new Date(assignment.dueDate)

                return (
                  <Link
                    key={assignment.id}
                    href="/dashboard/assignments"
                    className="group block rounded-xl border border-border/70 bg-background/70 p-4 shadow-[0_10px_26px_-20px_rgba(15,23,42,0.48)] transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-[0_18px_32px_-22px_rgba(15,23,42,0.55)]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="line-clamp-1 font-medium text-foreground group-hover:text-brand-blue">
                          {assignment.title}
                        </p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {course?.code} • {course?.name}
                        </p>
                      </div>
                      <Badge
                        variant="outline"
                        className={cn("shrink-0", priorityTone(assignment.priority))}
                      >
                        {assignment.priority}
                      </Badge>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
                      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                        <CalendarDays className="h-4 w-4" />
                        {format(dueAt, "EEE, MMM d • h:mm a")}
                      </span>
                      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                        <Clock className="h-4 w-4" />
                        {formatDistanceToNow(dueAt, { addSuffix: true })}
                      </span>
                    </div>
                  </Link>
                )
              })
            )}
          </CardContent>
        </Card>

        <Card className="border-border/60 bg-card/90 shadow-[0_14px_36px_-24px_rgba(15,23,42,0.5)]">
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-xl">Generated Guides</CardTitle>
                <CardDescription>Latest generated outputs ready to open.</CardDescription>
              </div>
              <Button asChild variant="ghost" size="sm" className="gap-1.5">
                <Link href="/dashboard/chat">
                  Open chat
                  <ArrowUpRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.generatedGuides.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/80 p-6 text-center text-sm text-muted-foreground">
                No guides generated yet.
              </div>
            ) : (
              data.generatedGuides.map((guide) => {
                const course = getCourse(guide.courseId)
                return (
                  <Link
                    key={guide.id}
                    href="/dashboard/chat"
                    className="group block rounded-xl border border-border/70 bg-background/70 p-4 shadow-[0_10px_26px_-20px_rgba(15,23,42,0.48)] transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-[0_18px_32px_-22px_rgba(15,23,42,0.55)]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="line-clamp-1 font-medium text-foreground group-hover:text-brand-blue">
                          {guide.title}
                        </p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {course?.code} • {course?.name}
                        </p>
                      </div>
                      <Badge
                        variant="outline"
                        className={cn(
                          "shrink-0",
                          guide.status === "Ready"
                            ? "border-emerald-200/80 bg-emerald-50 text-emerald-700"
                            : "border-amber-200/80 bg-amber-50 text-amber-700"
                        )}
                      >
                        {guide.status}
                      </Badge>
                    </div>

                    <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                      <BookOpen className="h-4 w-4" />
                      Generated {formatDistanceToNow(new Date(guide.generatedAt), { addSuffix: true })}
                    </div>
                  </Link>
                )
              })
            )}
          </CardContent>
        </Card>
      </motion.div>
    </motion.div>
  )
}
