"use client"

import { useState } from "react"
import { FileText, FileDown } from "lucide-react"
import { Button } from "@/components/ui/button"

type GuideExportButtonProps = {
  guideMarkdown: string
  assignmentTitle?: string
  courseName?: string
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
): string {
  const parts: string[] = []
  if (courseName) parts.push(slugify(courseName))
  parts.push(assignmentTitle ? slugify(assignmentTitle) : "Guide")
  parts.push("Headstart_Guide")
  return `${parts.join("_")}.${ext}`
}

export function GuideExportButton({ guideMarkdown, assignmentTitle, courseName }: GuideExportButtonProps) {
  const [open, setOpen] = useState(false)

  function exportMarkdown() {
    const blob = new Blob([guideMarkdown], { type: "text/markdown;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = buildFilename(assignmentTitle, courseName, "md")
    a.click()
    URL.revokeObjectURL(url)
    setOpen(false)
  }

  async function exportPdf() {
    setOpen(false)
    const { marked } = await import("marked")
    const html = await marked.parse(guideMarkdown)
    const filename = buildFilename(assignmentTitle, courseName, "pdf")

    // Use the browser's native print-to-PDF. This avoids html2canvas entirely,
    // which cannot parse oklch()/lab() colors used by the app's CSS theme.
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

    // Small delay to let the iframe render before printing
    setTimeout(() => {
      iframe.contentWindow!.print()
      setTimeout(() => document.body.removeChild(iframe), 1000)
    }, 250)
  }

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
          <div className="absolute right-0 z-20 mt-1 w-40 rounded-md border border-border bg-background shadow-md">
            <button
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
              onClick={exportMarkdown}
            >
              <FileText className="h-4 w-4 text-muted-foreground" />
              Export as .md
            </button>
            <button
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
              onClick={exportPdf}
            >
              <FileDown className="h-4 w-4 text-muted-foreground" />
              Export as .pdf
            </button>
          </div>
        </>
      )}
    </div>
  )
}
