/**
 * Artifact: webapp/src/app/page.tsx
 * Purpose: Renders the public landing page experience with product messaging, feature highlights, and auth entry links.
 * Author: Ansuman Sharma
 * Created: 2026-02-09
 * Revised:
 * - 2026-03-01: Added standardized file-level prologue metadata and interface contracts. (Ansuman Sharma)
 * Preconditions:
 * - Executed in a Next.js client-component context with required UI component imports and motion support available.
 * Inputs:
 * - Acceptable: No direct function inputs; component relies on static content and client runtime environment.
 * - Unacceptable: Missing required component dependencies or invalid runtime rendering environment.
 * Postconditions:
 * - Landing page UI is rendered with navigation links to login/signup and supporting feature sections.
 * Returns:
 * - `LandingPage` returns JSX for the main public homepage.
 * Errors/Exceptions:
 * - Client rendering or dependency-load failures may produce runtime errors during page render.
 */

"use client"

import Link from "next/link"
import { motion } from "framer-motion"
import {
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  MousePointerClick,
  Sparkles,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { ModeToggle } from "@/components/mode-toggle"

const container = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
    },
  },
}

const item = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0 },
}

const features = [
  {
    title: "Assignment-Aware Help",
    description:
      "Turn Canvas assignment details into clear, actionable guides.",
    icon: BrainCircuit,
  },
  {
    title: "Easy Access",
    description:
      "One click from extension to dashboard. Generate and follow instantly.",
    icon: MousePointerClick,
  },
  {
    title: "Built for Student Workflow",
    description:
      "Highlights requirements and milestones, then supports quick follow-up.",
    icon: Sparkles,
  },
]

export default function LandingPage() {
  return (
    <div className="relative h-[100dvh] overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(88%_54%_at_15%_20%,rgba(0,81,186,0.11),transparent_70%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(72%_50%_at_90%_85%,rgba(148,163,184,0.15),transparent_76%)] dark:bg-[radial-gradient(72%_50%_at_90%_85%,rgba(248,250,252,0.1),transparent_78%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgba(148,163,184,0.08)_1px,transparent_1px),linear-gradient(to_bottom,rgba(148,163,184,0.08)_1px,transparent_1px)] bg-[size:24px_24px]" />

      <header className="relative z-20 h-16 border-b border-border/60 bg-background/75 backdrop-blur">
        <div className="mx-auto flex h-full w-full max-w-7xl items-center px-4 md:px-6">
          <Link href="/" className="inline-flex items-center gap-2">
            <BrainCircuit className="h-6 w-6 text-brand-blue" />
            <span className="text-xl font-heading font-bold tracking-tight">Headstart AI</span>
          </Link>

          <nav className="ml-auto flex items-center gap-2">
            <ModeToggle />
            <Link href="/login">
              <Button variant="ghost" size="sm">
                Log In
              </Button>
            </Link>
            <Link href="/signup">
              <Button
                size="sm"
                className="bg-brand-blue text-white shadow-sm shadow-brand-blue/30 hover:bg-brand-blue/90 hover:text-white"
              >
                Get Started
              </Button>
            </Link>
          </nav>
        </div>
      </header>

      <main className="relative z-10 mx-auto flex h-[calc(100dvh-4rem)] w-full max-w-7xl items-center px-4 py-4 md:px-6 md:py-6">
        <motion.div
          variants={container}
          initial="hidden"
          animate="show"
          className="grid w-full items-center gap-4 lg:grid-cols-[1.1fr_0.9fr] lg:gap-6"
        >
          <motion.section variants={item} className="space-y-4 lg:space-y-5">
            <p className="inline-flex items-center rounded-full border border-brand-blue/30 bg-brand-blue/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-brand-blue">
              Student Copilot
            </p>

            <h1 className="max-w-2xl text-3xl font-heading font-bold leading-tight tracking-tight sm:text-4xl lg:text-5xl">
              Assignment guidance that gets students moving fast.
            </h1>

            <p className="max-w-2xl text-sm text-muted-foreground sm:text-base">
              Turn Canvas tasks into clear guides with one click from extension to dashboard.
            </p>

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-2xl border border-border/70 bg-card/75 p-3 shadow-[0_10px_26px_-20px_rgba(15,23,42,0.45)]">
                <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                  Fast Access
                </p>
                <p className="mt-1 text-sm font-medium">Open assignment, generate, start.</p>
              </div>
              <div className="rounded-2xl border border-border/70 bg-card/75 p-3 shadow-[0_10px_26px_-20px_rgba(15,23,42,0.45)]">
                <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                  Student Focus
                </p>
                <p className="mt-1 text-sm font-medium">Clear steps, milestones, zero clutter.</p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              <Link href="/signup">
                <Button
                  size="lg"
                  className="bg-brand-blue px-6 text-white shadow-md shadow-brand-blue/25 hover:bg-brand-blue/90 hover:text-white"
                >
                  Get Started
                  <ArrowRight className="ml-1 h-4 w-4" />
                </Button>
              </Link>
              <Link href="/login">
                <Button size="lg" variant="outline" className="px-6">
                  Log In
                </Button>
              </Link>
            </div>
          </motion.section>

          <motion.aside
            variants={item}
            className="rounded-3xl border border-border/60 bg-card/75 p-3 shadow-[0_26px_60px_-40px_rgba(15,23,42,0.6)] backdrop-blur sm:p-4"
          >
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Why It Works
              </p>
              <p className="text-lg font-heading font-semibold tracking-tight">
                Clear guidance, minimal friction.
              </p>
            </div>

            <div className="mt-3 space-y-2.5">
              {features.map((feature) => {
                const Icon = feature.icon
                return (
                  <article
                    key={feature.title}
                    className="rounded-2xl border border-border/65 bg-background/65 p-3 shadow-[0_10px_22px_-18px_rgba(15,23,42,0.45)] transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-[0_18px_30px_-20px_rgba(15,23,42,0.5)]"
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-blue/10 text-brand-blue">
                        <Icon className="h-4 w-4" />
                      </div>
                      <div>
                        <h2 className="text-sm font-semibold">{feature.title}</h2>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground sm:text-sm">
                          {feature.description}
                        </p>
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>

            <div className="mt-3 rounded-2xl border border-brand-blue/25 bg-brand-blue/10 p-3">
              <p className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-[0.16em] text-brand-blue">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Accessible Workflow
              </p>
              <p className="mt-1 text-sm text-foreground/90">
                Open assignment, click generate, continue in dashboard chat.
              </p>
            </div>
          </motion.aside>
        </motion.div>
      </main>
    </div>
  )
}
