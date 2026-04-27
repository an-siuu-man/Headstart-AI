"use client"

import {
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { LoaderCircle, Paperclip, RefreshCw, SendHorizontal, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

type ChatInputBarProps = {
  canSendMessage: boolean
  isSending: boolean
  hasGuideContent: boolean
  isGuideStreaming: boolean
  isRegenerating: boolean
  errorText: string | null
  onSend: (text: string, files: File[]) => Promise<void>
  onRegenerateGuide: () => Promise<void> | void
}

export function ChatInputBar({
  canSendMessage,
  isSending,
  hasGuideContent,
  isGuideStreaming,
  isRegenerating,
  errorText,
  onSend,
  onRegenerateGuide,
}: ChatInputBarProps) {
  const [draft, setDraft] = useState("")
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [fileError, setFileError] = useState<string | null>(null)
  const pasteCounterRef = useRef(0)

  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Object URLs for image previews — revoked when files are removed or component unmounts
  const previewUrls = useMemo(
    () => pendingFiles.map((f) => (f.type.startsWith("image/") ? URL.createObjectURL(f) : null)),
    [pendingFiles],
  )
  useEffect(() => {
    return () => { previewUrls.forEach((url) => url && URL.revokeObjectURL(url)) }
  }, [previewUrls])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = draft.trim()
    if (!text && pendingFiles.length === 0) return
    if (!canSendMessage || isSending) return

    setFileError(null)

    try {
      await onSend(text, pendingFiles)
      setDraft("")
      setPendingFiles([])
      if (textareaRef.current) textareaRef.current.style.height = "auto"
    } catch {
      // Parent state owns error surface and sending state resets.
    }
  }

  const ALLOWED_TYPES = new Set(["application/pdf", "image/png", "image/jpeg"])
  const ALLOWED_EXTS = [".pdf", ".png", ".jpg", ".jpeg"]

  function addFiles(incoming: File[]): boolean {
    if (incoming.length === 0) return true
    const combined = [...pendingFiles, ...incoming]
    if (combined.length > 3) {
      setFileError("Maximum 3 files per message.")
      return false
    }
    for (const file of incoming) {
      if (file.size > 10 * 1024 * 1024) {
        setFileError(`${file.name} exceeds the 10 MB limit.`)
        return false
      }
      const lowerName = file.name.toLowerCase()
      const hasAllowedExt = ALLOWED_EXTS.some((ext) => lowerName.endsWith(ext))
      if (!ALLOWED_TYPES.has(file.type) && !hasAllowedExt) {
        setFileError(`${file.name} is not a supported file type. Use PDF, PNG, or JPEG.`)
        return false
      }
    }
    setPendingFiles(combined)
    return true
  }

  function handleFileSelect(event: ChangeEvent<HTMLInputElement>) {
    setFileError(null)
    const selected = Array.from(event.target.files ?? [])
    addFiles(selected)
    event.target.value = ""
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(event.clipboardData.items)
    const imageItems = items.filter((item) => item.kind === "file" && (item.type === "image/png" || item.type === "image/jpeg"))
    if (imageItems.length === 0) return

    event.preventDefault()
    setFileError(null)

    const files = imageItems.map((item) => {
      const blob = item.getAsFile()
      if (!blob) return null
      const ext = item.type === "image/jpeg" ? "jpg" : "png"
      pasteCounterRef.current += 1
      return new File([blob], `pasted-image-${pasteCounterRef.current}.${ext}`, { type: item.type })
    }).filter((f): f is File => f !== null)

    addFiles(files)
  }

  function removeFile(index: number) {
    setPendingFiles((previous) => previous.filter((_, i) => i !== index))
  }

  function handleDraftKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Tab") {
      event.preventDefault()
      const el = event.currentTarget
      const start = el.selectionStart
      const end = el.selectionEnd
      el.setRangeText("\t", start, end, "end")
      setDraft(el.value)
      return
    }
    if (event.key !== "Enter") return
    if (event.shiftKey) return
    if (event.nativeEvent.isComposing) return
    if (!draft.trim() && pendingFiles.length === 0) return
    if (!canSendMessage || isSending) return

    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }

  return (
    <>
      {errorText ? (
        <p className="mb-2 px-3 text-[13px] text-destructive">{errorText}</p>
      ) : null}
      <form
        onSubmit={handleSubmit}
        className="w-full rounded-2xl bg-background/92 shadow-[0_14px_32px_-20px_rgba(15,23,42,0.55)] backdrop-blur supports-[backdrop-filter]:bg-background/80 dark:border dark:border-zinc-700/70"
      >
        {pendingFiles.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2">
            {pendingFiles.map((file, index) => {
              const previewUrl = previewUrls[index]
              return previewUrl ? (
                <div
                  key={`${file.name}-${index}`}
                  className="relative inline-flex rounded-md overflow-hidden border border-zinc-200 dark:border-zinc-700"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={previewUrl}
                    alt={file.name}
                    className="h-16 w-16 object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeFile(index)}
                    className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white hover:bg-black/80"
                    aria-label={`Remove ${file.name}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ) : (
                <Badge
                  key={`${file.name}-${index}`}
                  variant="secondary"
                  className="flex items-center gap-1 pr-1 text-xs"
                >
                  <span className="max-w-[140px] truncate">{file.name}</span>
                  <span className="text-muted-foreground">({(file.size / 1024).toFixed(0)} KB)</span>
                  <button
                    type="button"
                    onClick={() => removeFile(index)}
                    className="ml-0.5 rounded-full p-0.5 hover:bg-foreground/10"
                    aria-label={`Remove ${file.name}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              )
            })}
          </div>
        )}

        {fileError ? (
          <p className="px-3 pt-1 text-[12px] text-destructive">{fileError}</p>
        ) : null}

        <div className="flex items-center gap-2 px-2 py-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,application/pdf,.png,image/png,.jpg,.jpeg,image/jpeg"
            multiple
            className="hidden"
            onChange={handleFileSelect}
            disabled={isSending}
          />

          <Button
            type="button"
            variant="ghost"
            disabled={isSending || pendingFiles.length >= 3}
            onClick={() => fileInputRef.current?.click()}
            className="h-9 w-9 shrink-0 rounded-full p-0 text-muted-foreground transition-colors duration-200 hover:bg-foreground/10 hover:text-foreground disabled:opacity-40"
            aria-label="Attach file"
            title="Attach PDF, PNG, or JPEG (max 3 files, 10 MB each)"
          >
            <Paperclip className="h-4 w-4" />
          </Button>

          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
              const el = event.target
              el.style.height = "auto"
              el.style.height = `${el.scrollHeight}px`
            }}
            onKeyDown={handleDraftKeyDown}
            onPaste={handlePaste}
            placeholder="Ask a follow-up question..."
            className="min-h-10 max-h-40 w-full resize-none overflow-y-auto border-0 bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground"
          />

          {hasGuideContent && !isGuideStreaming ? (
            <Button
              type="button"
              variant="ghost"
              disabled={isSending || isRegenerating}
              onClick={() => void onRegenerateGuide()}
              className="h-9 shrink-0 rounded-full px-3 text-xs font-medium text-muted-foreground hover:text-foreground"
              title="Update guide based on current chat context"
            >
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isRegenerating ? "animate-spin" : ""}`} />
              {isRegenerating ? "Updating…" : "Update Guide"}
            </Button>
          ) : null}

          <Button
            type="submit"
            variant="ghost"
            disabled={(draft.trim().length === 0 && pendingFiles.length === 0) || !canSendMessage || isSending}
            className="h-9 w-9 rounded-full p-0 text-black transition-colors duration-200 hover:bg-foreground/10 hover:text-black disabled:text-black/40 dark:text-white dark:hover:text-white dark:disabled:text-white/40"
          >
            {isSending ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <SendHorizontal className="h-4 w-4" />
            )}
          </Button>
        </div>
      </form>
    </>
  )
}
