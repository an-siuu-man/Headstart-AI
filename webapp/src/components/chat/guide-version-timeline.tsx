"use client"

import { type GuideVersionMeta } from "@/lib/chat-types"

type GuideVersionTimelineProps = {
  versions: GuideVersionMeta[]
  onScrollToVersion: (versionNumber: number) => void
}

export function GuideVersionTimeline({
  versions,
  onScrollToVersion,
}: GuideVersionTimelineProps) {
  if (versions.length === 0) return null

  return (
    <div className="ml-2 flex self-start sticky top-0 flex-col items-center pt-3">
      {versions.map((version, index) => (
        <div key={version.version_number} className="flex flex-col items-center">
          {index > 0 ? (
            <div className="h-6 w-px bg-gradient-to-b from-border/80 to-border/40" />
          ) : null}

          <button
            type="button"
            onClick={() => onScrollToVersion(version.version_number)}
            className={[
              "relative h-9 w-9 rounded-full border text-[11px] font-semibold transition-all duration-200",
              "bg-background shadow-sm",
              "border-border/70 text-muted-foreground",
              "hover:border-brand-blue/50 hover:text-brand-blue",
              "hover:shadow-[0_0_0_3px_rgba(0,81,186,0.12),0_2px_10px_rgba(0,81,186,0.20)]",
              "hover:bg-brand-blue/10",
            ].join(" ")}
            title={`v${version.version_number} — ${version.source === "initial_run" ? "Initial guide" : "Regenerated"}`}
          >
            v{version.version_number}
          </button>

          {index < versions.length - 1 ? (
            <div className="h-6 w-px bg-gradient-to-b from-border/40 to-border/80" />
          ) : null}
        </div>
      ))}
    </div>
  )
}
