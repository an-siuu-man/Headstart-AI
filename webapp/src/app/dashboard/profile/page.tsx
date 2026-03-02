"use client"

import Link from "next/link"
import { motion } from "framer-motion"
import {
  CalendarDays,
  CalendarRange,
  type LucideIcon,
  School,
  ShieldCheck,
} from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useAuthUser } from "@/hooks/use-auth-user"
import { cn } from "@/lib/utils"

type IntegrationStatus = "Connected" | "Not Connected" | "Needs Attention"

type Integration = {
  name: string
  description: string
  status?: IntegrationStatus
  actionLabel?: string
  note?: string
  icon: LucideIcon
}

const integrations: Integration[] = [
  {
    name: "Google Calendar",
    description: "Sync assignment deadlines and study blocks to your Google calendar.",
    status: "Connected",
    actionLabel: "Manage",
    icon: CalendarDays,
  },
  {
    name: "Outlook Calendar",
    description: "Push due dates and reminders to Outlook for cross-device planning.",
    status: "Not Connected",
    actionLabel: "Connect",
    icon: CalendarRange,
  },
  {
    name: "Canvas LMS",
    description: "Import assignment metadata and submission windows from Canvas.",
    note: "To get the latest assignments info, you need to log into your Canvas account.",
    icon: School,
  },
]

const container = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.08 },
  },
}

const item = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0 },
}

function statusTone(status: IntegrationStatus) {
  if (status === "Connected") {
    return "border-emerald-300/70 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300"
  }

  if (status === "Needs Attention") {
    return "border-amber-300/70 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
  }

  return "border-slate-300/70 bg-slate-50 text-slate-700 dark:border-slate-500/40 dark:bg-slate-500/10 dark:text-slate-300"
}

export default function ProfilePage() {
  const { user } = useAuthUser()
  const displayName = user?.displayName || "Student"
  const email = user?.email || ""

  const initials = displayName
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()

  return (
    <motion.div variants={container} initial="hidden" animate="show" className="space-y-6">
      <motion.div variants={item}>
        <h1 className="text-3xl font-heading font-bold tracking-tight">Profile</h1>
        <p className="text-muted-foreground">
          Review your account details and connected academic integrations.
        </p>
      </motion.div>

      <motion.div variants={item}>
        <Card className="border-border/60 bg-card/85 shadow-[0_12px_34px_-22px_rgba(15,23,42,0.45)]">
          <CardContent className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <Avatar className="h-20 w-20 ring-2 ring-border/70">
                <AvatarFallback className="text-lg font-semibold">{initials}</AvatarFallback>
              </Avatar>

              <div>
                <p className="text-2xl font-heading font-bold tracking-tight">{displayName}</p>
                <p className="text-sm text-muted-foreground">{email || "No email"}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="border-border/70 bg-background/70 px-3 py-1">
                    Student Account
                  </Badge>
                  <Badge variant="outline" className="border-border/70 bg-background/70 px-3 py-1">
                    University SSO
                  </Badge>
                </div>
              </div>
            </div>

            <div className="flex gap-2">
              <Button asChild variant="outline">
                <Link href="/dashboard/settings">Account settings</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      <motion.div variants={item}>
        <Card className="border-border/60 bg-card/90 shadow-[0_14px_36px_-24px_rgba(15,23,42,0.5)]">
          <CardHeader>
            <CardTitle className="text-xl">Integrations</CardTitle>
            <CardDescription>
              Connect external tools to sync deadlines, reminders, and course context.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {integrations.map((integration) => (
              <div
                key={integration.name}
                className="flex flex-col gap-4 rounded-xl border border-border/70 bg-background/70 p-4 shadow-[0_10px_26px_-20px_rgba(15,23,42,0.48)] sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-start gap-3">
                  <div className="rounded-lg bg-brand-blue/10 p-2 text-brand-blue">
                    <integration.icon className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="font-medium">{integration.name}</p>
                    <p className="text-sm text-muted-foreground">{integration.description}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {integration.note ? (
                    <p className="text-sm text-muted-foreground sm:max-w-[22rem] sm:text-right">
                      {integration.note}
                    </p>
                  ) : (
                    <>
                      <Badge
                        variant="outline"
                        className={cn(
                          "px-2.5 py-1 text-xs font-medium",
                          statusTone(integration.status ?? "Not Connected")
                        )}
                      >
                        {integration.status}
                      </Badge>
                      <Button
                        size="sm"
                        variant={integration.status === "Connected" ? "outline" : "default"}
                      >
                        {integration.actionLabel}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}

            <div className="mt-4 rounded-lg border border-dashed border-border/80 p-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-brand-blue" />
                <span>All integrations use your existing university account permissions.</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </motion.div>
  )
}
