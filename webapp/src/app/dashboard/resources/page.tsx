"use client"

import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import { formatDistanceToNow } from "date-fns"
import {
  AlertCircle,
  BookOpen,
  Download,
  ExternalLink,
  FileText,
  LoaderCircle,
  MessageSquare,
  Search,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type ResourceType = "guide" | "pdf" | "link"
type ResourceFilterType = "all" | ResourceType
type SortMode = "newest" | "oldest" | "az"

type ResourceItem = {
  id: string
  type: ResourceType
  title: string
  assignment_id: string | null
  assignment_title: string
  course_name: string | null
  due_at_iso: string | null
  session_id: string | null
  created_at: number
  updated_at: number
  byte_size: number | null
  url: string | null
  guide_version_count: number | null
}

type ResourcesResponse = {
  ok: true
  generated_at: number
  recent: ResourceItem[]
  items: ResourceItem[]
  facets: {
    type_counts: {
      all: number
      guide: number
      pdf: number
      link: number
    }
    courses: string[]
  }
}

function resourceTypeLabel(type: ResourceType) {
  if (type === "guide") return "Guide"
  if (type === "pdf") return "PDF"
  return "Link"
}

function formatBytes(bytes: number | null) {
  if (bytes == null) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatUpdatedAt(epoch: number) {
  if (!Number.isFinite(epoch)) return "Unknown"
  const date = new Date(epoch)
  if (Number.isNaN(date.getTime())) return "Unknown"
  return formatDistanceToNow(date, { addSuffix: true })
}

function formatDueDateLabel(value: string | null) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString()
}

export default function ResourcesPage() {
  const [data, setData] = useState<ResourcesResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [recentActiveType, setRecentActiveType] = useState<ResourceFilterType>("all")
  const [activeType, setActiveType] = useState<ResourceFilterType>("all")
  const [selectedCourse, setSelectedCourse] = useState("all")
  const [sortMode, setSortMode] = useState<SortMode>("newest")

  useEffect(() => {
    let isDisposed = false

    const loadResources = async () => {
      setIsLoading(true)
      try {
        const response = await fetch("/api/resources?limit=300", {
          method: "GET",
          cache: "no-store",
        })
        if (!response.ok) {
          const bodyText = await response.text()
          throw new Error(bodyText || `Failed to load resources (${response.status})`)
        }
        const body = (await response.json()) as ResourcesResponse
        if (isDisposed) return
        setData(body)
        setErrorText(null)
      } catch (error) {
        if (isDisposed) return
        const message = error instanceof Error ? error.message : String(error)
        setData(null)
        setErrorText(message)
      } finally {
        if (!isDisposed) {
          setIsLoading(false)
        }
      }
    }

    void loadResources()
    return () => {
      isDisposed = true
    }
  }, [])

  const filteredLibraryItems = useMemo(() => {
    const resources = data?.items ?? []
    const q = searchQuery.trim().toLowerCase()
    const filtered = resources.filter((item) => {
      if (activeType !== "all" && item.type !== activeType) return false
      if (selectedCourse !== "all" && (item.course_name ?? "Unknown course") !== selectedCourse) {
        return false
      }
      if (!q) return true
      const searchable = `${item.title} ${item.assignment_title} ${item.course_name ?? ""}`.toLowerCase()
      return searchable.includes(q)
    })

    const sorted = filtered.slice()
    sorted.sort((left, right) => {
      if (sortMode === "newest") {
        return right.updated_at - left.updated_at
      }
      if (sortMode === "oldest") {
        return left.updated_at - right.updated_at
      }
      return left.title.localeCompare(right.title)
    })

    return sorted
  }, [activeType, data?.items, searchQuery, selectedCourse, sortMode])

  const filteredRecentItems = useMemo(() => {
    const resources = data?.recent ?? []
    if (recentActiveType === "all") return resources
    return resources.filter((item) => item.type === recentActiveType)
  }, [data?.recent, recentActiveType])

  const recentTypeCounts = useMemo(() => {
    const recent = data?.recent ?? []
    let guide = 0
    let pdf = 0
    let link = 0
    for (const item of recent) {
      if (item.type === "guide") guide += 1
      if (item.type === "pdf") pdf += 1
      if (item.type === "link") link += 1
    }
    return {
      all: recent.length,
      guide,
      pdf,
      link,
    }
  }, [data?.recent])

  const courseOptions = useMemo(() => {
    return data?.facets.courses ?? []
  }, [data?.facets.courses])

  function renderPrimaryAction(item: ResourceItem) {
    if (item.type === "guide" && item.session_id) {
      return (
        <Button asChild size="sm" variant="outline">
          <Link href={`/dashboard/chat?session=${encodeURIComponent(item.session_id)}`}>
            <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
            Open Chat
          </Link>
        </Button>
      )
    }
    if (item.type === "pdf" && item.url) {
      return (
        <Button asChild size="sm" variant="outline">
          <a href={item.url} target="_blank" rel="noopener noreferrer">
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Download
          </a>
        </Button>
      )
    }
    if (item.type === "link" && item.url) {
      return (
        <Button asChild size="sm" variant="outline">
          <a href={item.url} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
            Open Link
          </a>
        </Button>
      )
    }
    return (
      <Button size="sm" variant="outline" disabled>
        Unavailable
      </Button>
    )
  }

  function renderTypeIcon(type: ResourceType) {
    if (type === "guide") return <BookOpen className="h-3.5 w-3.5" />
    if (type === "pdf") return <FileText className="h-3.5 w-3.5" />
    return <ExternalLink className="h-3.5 w-3.5" />
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-heading font-bold tracking-tight">Resources</h1>
        <p className="text-muted-foreground">
          Cross-assignment library for guides, source PDFs, and assignment links.
        </p>
      </div>

      {errorText ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{errorText}</span>
        </div>
      ) : null}

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xl font-sans font-bold">Recently Added</h2>
          {isLoading ? (
            <LoaderCircle className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : null}
        </div>
        <Tabs
          value={recentActiveType}
          onValueChange={(value) => setRecentActiveType(value as ResourceFilterType)}
        >
          <TabsList>
            <TabsTrigger value="all">All ({recentTypeCounts.all})</TabsTrigger>
            <TabsTrigger value="guide">Guides ({recentTypeCounts.guide})</TabsTrigger>
            <TabsTrigger value="pdf">PDFs ({recentTypeCounts.pdf})</TabsTrigger>
            <TabsTrigger value="link">Links ({recentTypeCounts.link})</TabsTrigger>
          </TabsList>
        </Tabs>
        {isLoading ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Card key={`recent-skeleton-${index}`} className="h-28 animate-pulse bg-muted/30" />
            ))}
          </div>
        ) : filteredRecentItems.length === 0 ? (
          <Card>
            <CardContent className="py-6 text-sm text-muted-foreground">
              No recent resources match this filter.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {filteredRecentItems.map((item) => (
              <Card key={`recent-${item.id}`} className="h-full">
                <CardHeader className="space-y-2 pb-2">
                  <div className="flex items-center justify-between gap-2">
                    <Badge variant="outline" className="inline-flex items-center gap-1">
                      {renderTypeIcon(item.type)}
                      {resourceTypeLabel(item.type)}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{formatUpdatedAt(item.updated_at)}</span>
                  </div>
                  <CardTitle className="line-clamp-2 text-sm">{item.title}</CardTitle>
                  <CardDescription className="line-clamp-2 text-xs">
                    {item.assignment_title}
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-1">
                  {renderPrimaryAction(item)}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-xl font-sans font-bold">Library</h2>
          <p className="text-sm text-muted-foreground">
            Search across all resource types and jump directly to chat, downloads, or assignment detail.
          </p>
        </div>

        <Card>
          <CardContent className="space-y-4 p-4">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto_auto]">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  type="search"
                  placeholder="Search by resource, assignment, or course..."
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  className="pl-8"
                />
              </div>

              <Select value={selectedCourse} onValueChange={setSelectedCourse}>
                <SelectTrigger className="w-full min-w-[170px]">
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
                <SelectTrigger className="w-full min-w-[150px]">
                  <SelectValue placeholder="Sort" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="newest">Newest</SelectItem>
                  <SelectItem value="oldest">Oldest</SelectItem>
                  <SelectItem value="az">Title A-Z</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Tabs value={activeType} onValueChange={(value) => setActiveType(value as ResourceFilterType)}>
              <TabsList>
                <TabsTrigger value="all">All ({data?.facets.type_counts.all ?? 0})</TabsTrigger>
                <TabsTrigger value="guide">Guides ({data?.facets.type_counts.guide ?? 0})</TabsTrigger>
                <TabsTrigger value="pdf">PDFs ({data?.facets.type_counts.pdf ?? 0})</TabsTrigger>
                <TabsTrigger value="link">Links ({data?.facets.type_counts.link ?? 0})</TabsTrigger>
              </TabsList>
            </Tabs>

            {isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, index) => (
                  <div key={`library-skeleton-${index}`} className="h-20 animate-pulse rounded-md bg-muted/30" />
                ))}
              </div>
            ) : filteredLibraryItems.length === 0 ? (
              <div className="rounded-md border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
                No resources match your current filters.
              </div>
            ) : (
              <div className="divide-y rounded-lg border">
                {filteredLibraryItems.map((item) => {
                  const assignmentHref = item.assignment_id
                    ? `/dashboard/assignments/${encodeURIComponent(item.assignment_id)}`
                    : null
                  const dueDateLabel = formatDueDateLabel(item.due_at_iso)

                  return (
                    <div
                      key={`library-${item.id}`}
                      className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline" className="inline-flex items-center gap-1">
                            {renderTypeIcon(item.type)}
                            {resourceTypeLabel(item.type)}
                          </Badge>
                          {item.guide_version_count != null ? (
                            <Badge variant="outline">v{item.guide_version_count}</Badge>
                          ) : null}
                          {item.byte_size != null ? (
                            <Badge variant="outline">{formatBytes(item.byte_size)}</Badge>
                          ) : null}
                        </div>

                        <p className="line-clamp-2 text-sm font-medium">{item.title}</p>
                        <p className="line-clamp-1 text-xs text-muted-foreground">
                          {item.assignment_title}
                          {item.course_name ? ` • ${item.course_name}` : ""}
                          {dueDateLabel ? ` • due ${dueDateLabel}` : ""}
                          {` • ${formatUpdatedAt(item.updated_at)}`}
                        </p>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        {renderPrimaryAction(item)}
                        {assignmentHref ? (
                          <Button asChild variant="ghost" size="sm">
                            <Link href={assignmentHref}>View Assignment</Link>
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  )
}
