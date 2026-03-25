"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useState } from "react"
import {
  Home,
  FileText,
  BookOpen,
  LogOut,
  BrainCircuit,
  MessageSquare,
  CalendarDays,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

const links = [
  { href: "/dashboard", label: "Dashboard", icon: Home },
  { href: "/dashboard/assignments", label: "Assignments", icon: FileText },
  { href: "/dashboard/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/dashboard/chat", label: "Chat", icon: MessageSquare },
  { href: "/dashboard/resources", label: "Resources", icon: BookOpen },
]

interface SidebarContentProps {
  className?: string
  onClick?: () => void
  collapsed?: boolean
  onToggleCollapse?: () => void
  showCollapseToggle?: boolean
  onSignOut?: () => void
  isSigningOut?: boolean
}

export function SidebarContent({
  className,
  onClick,
  collapsed = false,
  onToggleCollapse,
  showCollapseToggle = false,
  onSignOut,
  isSigningOut = false,
}: SidebarContentProps) {
  const pathname = usePathname()

  return (
    <div className={cn("flex flex-col h-full", className)}>
      <div
        className={cn(
          "flex items-center border-b p-4 transition-all duration-300",
          collapsed ? "justify-start gap-0 px-4" : "justify-between gap-2 px-4"
        )}
      >
        <div
          aria-hidden={collapsed}
          className={cn(
            "flex items-center gap-2 overflow-hidden transition-[max-width,opacity,transform] duration-300 ease-out",
            collapsed ? "max-w-0 -translate-x-1 opacity-0" : "max-w-[210px] translate-x-0 opacity-100"
          )}
        >
          <BrainCircuit className="h-6 w-6 shrink-0 text-primary" />
          <span className="whitespace-nowrap text-xl font-heading font-bold tracking-tight">
            Headstart AI
          </span>
        </div>
        {showCollapseToggle ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onToggleCollapse}
            className={cn(
              "shrink-0 transition-all duration-300",
              "h-8 w-8",
              collapsed ? "ml-0" : ""
            )}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </Button>
        ) : null}
      </div>

      <div className="flex-1 py-6 px-3">
        <nav className="flex flex-col gap-1">
          {links.map((link) => {
             const isActive = pathname === link.href
             return (
              <Link
                key={link.href}
                href={link.href}
                onClick={onClick}
                className={cn(
                  "flex items-center rounded-md py-2 text-sm font-medium transition-all duration-300",
                  collapsed ? "justify-start px-3" : "gap-3 px-3",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <link.icon className="h-4 w-4" />
                <span
                  className={cn(
                    "overflow-hidden whitespace-nowrap transition-[max-width,opacity,transform] duration-300 ease-out",
                    collapsed ? "max-w-0 -translate-x-1 opacity-0" : "max-w-[140px] translate-x-0 opacity-100"
                  )}
                >
                  {link.label}
                </span>
              </Link>
            )
          })}
        </nav>
      </div>

      <div className={cn("border-t", collapsed ? "p-3" : "p-4")}>
         <Button
            variant="ghost"
            className={cn(
              "w-full text-muted-foreground hover:text-destructive transition-all duration-300",
              collapsed ? "justify-start px-3" : "justify-start gap-2"
            )}
            onClick={onSignOut}
            disabled={isSigningOut}
         >
            <LogOut className="h-4 w-4" />
            <span
              className={cn(
                "overflow-hidden whitespace-nowrap transition-[max-width,opacity,transform] duration-300 ease-out",
                collapsed ? "max-w-0 -translate-x-1 opacity-0" : "max-w-[100px] translate-x-0 opacity-100"
              )}
            >
              {isSigningOut ? "Logging out..." : "Log out"}
            </span>
         </Button>
      </div>
    </div>
  )
}

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false)
  const [isSigningOut, setIsSigningOut] = useState(false)
  const router = useRouter()

  async function handleSignOut() {
    if (isSigningOut) return

    setIsSigningOut(true)
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      })
    } finally {
      setIsSigningOut(false)
      router.replace("/login")
      router.refresh()
    }
  }

  return (
    <aside
      className={cn(
        "sticky top-0 hidden h-screen flex-col border-r bg-card transition-[width] duration-300 ease-out md:flex",
        collapsed ? "w-16" : "w-64"
      )}
    >
      <SidebarContent
         collapsed={collapsed}
         onToggleCollapse={() => setCollapsed((value) => !value)}
         showCollapseToggle
         onSignOut={handleSignOut}
         isSigningOut={isSigningOut}
       />
    </aside>
  )
}
