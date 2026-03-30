"use client"

import { useState } from "react"
import { FileText, FileDown } from "lucide-react"
import { format } from "date-fns"
import { Button } from "@/components/ui/button"

type GuideVersionMeta = {
  version_number: number
  source: string
  content_length: number
  created_at: string
}

type GuideExportButtonProps = {
  guideMarkdown: string
  assignmentTitle?: string
  courseName?: string
  versions?: GuideVersionMeta[]
  sessionId?: string
}

function slugify(text: string): string {
  return text
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "_")
    .replace(/-+/g, "_")
    .slice(0, 80)
}

function buildFilename(
  assignmentTitle: string | undefined,
  courseName: string | undefined,
  ext: "md" | "pdf",
  versionSuffix?: string,
): string {
  const parts: string[] = []
  if (courseName) parts.push(slugify(courseName))
  parts.push(assignmentTitle ? slugify(assignmentTitle) : "Guide")
  parts.push("Headstart_Guide")
  if (versionSuffix) parts.push(versionSuffix)
  return `${parts.join("_")}.${ext}`
}

function formatVersionDate(isoString: string) {
  try {
    return format(new Date(isoString), "MMM d, yyyy")
  } catch {
    return isoString
  }
}

async function printMarkdownAsPdf(markdown: string, filename: string) {
  const { marked } = await import("marked")
  const html = await marked.parse(markdown)

  const iframe = document.createElement("iframe")
  iframe.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:0;height:0;border:none"
  document.body.appendChild(iframe)

  const iframeDoc = iframe.contentDocument!
  iframeDoc.open()
  iframeDoc.write(`<!DOCTYPE html><html><head>
    <title>${filename}</title>
    <style>
      body{font-family:system-ui,sans-serif;font-size:14px;line-height:1.6;color:#111;padding:24px;margin:0}
      h1{font-size:22px;font-weight:600;margin:20px 0 8px}
      h2{font-size:18px;font-weight:600;margin:18px 0 6px}
      h3{font-size:16px;font-weight:600;margin:14px 0 6px}
      p{margin:8px 0}
      ul,ol{padding-left:20px;margin:8px 0}
      li{margin:4px 0}
      table{border-collapse:collapse;width:100%;margin:12px 0}
      th,td{border:1px solid #ccc;padding:6px 10px;text-align:left;font-size:13px}
      th{background:#f3f3f3;font-weight:600}
      tr:nth-child(even){background:#fafafa}
      code{background:#f0f0f0;border-radius:3px;padding:1px 4px;font-size:13px}
      pre{background:#f0f0f0;border-radius:4px;padding:12px;overflow:auto;font-size:13px}
      blockquote{border-left:3px solid #ccc;margin:8px 0;padding-left:12px;color:#555}
      a{color:#2563eb}
      hr{border:none;border-top:1px solid #e0e0e0;margin:16px 0}
      @media print{body{padding:0}}
    </style>
  </head><body>${html}</body></html>`)
  iframeDoc.close()

  setTimeout(() => {
    iframe.contentWindow!.print()
    setTimeout(() => document.body.removeChild(iframe), 1000)
  }, 250)
}

function downloadMarkdown(markdown: string, filename: string) {
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function GuideExportButton({
  guideMarkdown,
  assignmentTitle,
  courseName,
  versions = [],
  sessionId,
}: GuideExportButtonProps) {
  const [open, setOpen] = useState(false)
  const [loadingVersion, setLoadingVersion] = useState<number | null>(null)

  const hasMultipleVersions = versions.length > 1
  const latestVersion = versions.length > 0 ? versions[versions.length - 1] : null
  const olderVersions = versions.length > 1 ? versions.slice(0, -1).reverse() : []

  function exportCurrentMarkdown() {
    const suffix = latestVersion ? `v${latestVersion.version_number}` : undefined
    downloadMarkdown(guideMarkdown, buildFilename(assignmentTitle, courseName, "md", suffix))
    setOpen(false)
  }

  async function exportCurrentPdf() {
    setOpen(false)
    const suffix = latestVersion ? `v${latestVersion.version_number}` : undefined
    await printMarkdownAsPdf(guideMarkdown, buildFilename(assignmentTitle, courseName, "pdf", suffix))
  }

  async function exportOlderVersion(versionNumber: number, ext: "md" | "pdf") {
    if (!sessionId) return
    setLoadingVersion(versionNumber)
    try {
      const res = await fetch(
        `/api/chat-session/${encodeURIComponent(sessionId)}/guide-versions/${versionNumber}`,
        { cache: "no-store" },
      )
      if (!res.ok) return
      const body = await res.json() as { content_text?: string }
      if (!body.content_text) return
      const suffix = `v${versionNumber}`
      if (ext === "md") {
        downloadMarkdown(body.content_text, buildFilename(assignmentTitle, courseName, "md", suffix))
      } else {
        await printMarkdownAsPdf(body.content_text, buildFilename(assignmentTitle, courseName, "pdf", suffix))
      }
    } finally {
      setLoadingVersion(null)
      setOpen(false)
    }
  }

  const latestLabel = latestVersion
    ? `Export Latest (v${latestVersion.version_number})`
    : "Export Guide"

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5 text-xs"
        onClick={() => setOpen((v) => !v)}
      >
        <FileDown className="h-3.5 w-3.5" />
        Export Guide
      </Button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 z-20 mt-1 min-w-[180px] rounded-md border border-border bg-background shadow-md">
            {/* Current / latest version */}
            <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {latestLabel}
            </div>
            <button
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
              onClick={exportCurrentMarkdown}
            >
              <FileText className="h-4 w-4 text-muted-foreground" />
              Export as .md
            </button>
            <button
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
              onClick={exportCurrentPdf}
            >
              <FileDown className="h-4 w-4 text-muted-foreground" />
              Export as .pdf
            </button>

            {/* Older versions */}
            {hasMultipleVersions && olderVersions.length > 0 && (
              <>
                <div className="my-1 border-t border-border/60" />
                <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Older Versions
                </div>
                {olderVersions.map((v) => (
                  <div key={v.version_number} className="px-2 pb-1">
                    <div className="rounded-md border border-border/50 bg-muted/30 px-2 py-1.5">
                      <p className="mb-1 text-[11px] text-muted-foreground">
                        v{v.version_number} — {formatVersionDate(v.created_at)}
                        {v.source === "regenerated" ? " (regenerated)" : ""}
                      </p>
                      <div className="flex gap-2">
                        <button
                          disabled={loadingVersion === v.version_number}
                          onClick={() => exportOlderVersion(v.version_number, "md")}
                          className="text-[12px] text-blue-500 hover:underline disabled:opacity-50"
                        >
                          .md
                        </button>
                        <span className="text-muted-foreground/50">|</span>
                        <button
                          disabled={loadingVersion === v.version_number}
                          onClick={() => exportOlderVersion(v.version_number, "pdf")}
                          className="text-[12px] text-blue-500 hover:underline disabled:opacity-50"
                        >
                          .pdf
                        </button>
                        {loadingVersion === v.version_number && (
                          <span className="text-[11px] text-muted-foreground">loading…</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
