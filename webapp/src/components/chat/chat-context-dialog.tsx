"use client"

import { format } from "date-fns"
import { AnimatePresence, motion } from "framer-motion"

import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { stageLabel } from "@/lib/chat-utils"
import { type AssignmentPayload, type ChatSessionDto } from "@/lib/chat-types"

const EASE_OUT = [0.22, 1, 0.36, 1] as const
const STAGE_BADGE_TONES = [
  "border-cyan-400/60 bg-cyan-500/15 text-cyan-800 dark:text-cyan-200",
  "border-amber-400/60 bg-amber-500/15 text-amber-800 dark:text-amber-200",
  "border-fuchsia-400/60 bg-fuchsia-500/15 text-fuchsia-800 dark:text-fuchsia-200",
  "border-lime-400/60 bg-lime-500/15 text-lime-800 dark:text-lime-200",
  "border-indigo-400/60 bg-indigo-500/15 text-indigo-800 dark:text-indigo-200",
] as const

type ChatContextDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  payload: AssignmentPayload | undefined
  attachmentCount: number
  attachmentNames: string[]
  userAttachedFileNames: string[]
  createdAtText: string | null
  effectiveSession: ChatSessionDto | null
  isSessionLoading: boolean
  isPolling: boolean
  stageToneIndex: number
  reduceMotion: boolean | null
}

export function ChatContextDialog({
  open,
  onOpenChange,
  payload,
  attachmentCount,
  attachmentNames,
  userAttachedFileNames,
  createdAtText,
  effectiveSession,
  isSessionLoading,
  isPolling,
  stageToneIndex,
  reduceMotion,
}: ChatContextDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] w-full max-w-2xl overflow-hidden p-0">
        <DialogHeader className="border-b border-border/70 px-5 py-4">
          <DialogTitle>Assignment Context</DialogTitle>
          <DialogDescription>Session from extension handoff</DialogDescription>
        </DialogHeader>

        <div className="max-h-[calc(85vh-88px)] overflow-y-auto px-5 py-4">
          <div className="space-y-3 text-sm">
            {isSessionLoading && !effectiveSession ? (
              <p className="text-muted-foreground">Loading session...</p>
            ) : null}

            {!isSessionLoading && !payload ? (
              <p className="text-destructive">No session payload available.</p>
            ) : null}

            {payload ? (
              <>
                <div>
                  <p className="text-muted-foreground">Title</p>
                  <p className="font-medium">{payload.title || "(untitled assignment)"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Course</p>
                  <p className="font-medium">
                    {payload.courseName || String(payload.courseId || "-")}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">Attachments: {attachmentCount}</Badge>
                  {payload.rubric?.criteria?.length ? (
                    <Badge variant="outline">Rubric: {payload.rubric.criteria.length}</Badge>
                  ) : null}
                </div>
                <div>
                  <p className="mb-1 text-muted-foreground">Assignment Documents</p>
                  {attachmentNames.length > 0 ? (
                    <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                      {attachmentNames.map((name, index) => (
                        <li key={`${name}-${index}`} className="break-all">
                          {name}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted-foreground/60">No assignment documents provided.</p>
                  )}
                </div>
                <div className="border-t border-border/50 pt-3">
                  <p className="mb-1 text-muted-foreground">User-Attached Files</p>
                  {userAttachedFileNames.length > 0 ? (
                    <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                      {userAttachedFileNames.map((name, index) => (
                        <li key={`${name}-${index}`} className="break-all">
                          {name}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted-foreground/60">No files attached to messages yet.</p>
                  )}
                </div>
                {payload.dueAtISO ? (
                  <div>
                    <p className="text-muted-foreground">Due</p>
                    <p className="font-medium">
                      {format(new Date(payload.dueAtISO), "MMM d, yyyy h:mm a")}
                    </p>
                  </div>
                ) : null}
                {createdAtText ? (
                  <div>
                    <p className="text-muted-foreground">Session Created</p>
                    <p className="font-medium">{createdAtText}</p>
                  </div>
                ) : null}
              </>
            ) : null}

            {effectiveSession ? (
              <>
                <div>
                  <p className="text-muted-foreground">Stage</p>
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.div
                      key={`stage-dialog-${effectiveSession.stage}-${stageToneIndex}`}
                      initial={reduceMotion ? false : { opacity: 0, y: 6, scale: 0.95 }}
                      animate={reduceMotion ? undefined : { opacity: 1, y: 0, scale: 1 }}
                      exit={reduceMotion ? undefined : { opacity: 0, y: -6, scale: 0.95 }}
                      transition={reduceMotion ? undefined : { duration: 0.24, ease: EASE_OUT }}
                      className="mt-1 inline-flex"
                    >
                      <Badge
                        variant="outline"
                        className={`px-2.5 py-1 text-xs font-semibold transition-colors duration-500 ${STAGE_BADGE_TONES[stageToneIndex]}`}
                      >
                        {stageLabel(effectiveSession.stage)}
                      </Badge>
                    </motion.div>
                  </AnimatePresence>
                </div>
                {isPolling ? (
                  <p className="text-xs text-muted-foreground">Reconnecting stream...</p>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
