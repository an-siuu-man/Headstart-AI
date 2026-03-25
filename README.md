# Headstart AI Capstone

Headstart AI is a multi-component system that helps students turn Canvas assignments into structured, actionable study guides.
It combines a Chrome extension (Canvas extraction + in-page entrypoint), a Next.js web app (dashboard + API gateway), and a FastAPI agent service (LLM orchestration + PDF context extraction).

## Table of Contents

- [What This Repository Contains](#what-this-repository-contains)
- [Core Features](#core-features)
- [Architecture Overview](#architecture-overview)
- [Tech Stack](#tech-stack)
- [Repository Structure](#repository-structure)
- [API Surface](#api-surface)
- [Local Development](#local-development)
- [Testing and Quality Checks](#testing-and-quality-checks)
- [Environment Variables](#environment-variables)
- [Database Migrations](#database-migrations)
- [Current State and Direction](#current-state-and-direction)

## What This Repository Contains

This monorepo has three runtime applications:

- `extension/`: Chrome Manifest V3 extension for Canvas page detection, assignment extraction, and in-page user interaction.
- `webapp/`: Next.js App Router application for dashboard UI and backend-for-frontend API routes used by the extension.
- `agent_service/`: FastAPI service that runs AI guide generation workflows using LangChain + NVIDIA models.

Architecture contracts and flow references live in:

- `internal/architecture/` (source-of-truth boundaries/contracts)
- `docs/` (supplementary diagrams and workflow notes)

## Core Features

### Extension (Canvas Runtime)

- Detects Canvas assignment pages and assignment list pages.
- Extracts assignment details using Canvas REST API first, with DOM scraping fallback.
- Pulls assignment context including title, course, due date, points, submission type, rubric data, attached PDFs, and user timezone when available.
- Persists assignment records in `chrome.storage.local` with merge/upsert logic.
- Injects a sidebar widget into Canvas pages.
- Starts guide generation from the widget and hands users off to dashboard chat.

### Web App (Dashboard + API Gateway)

- Provides student-facing pages for landing/login/signup, dashboard, assignments, resources, settings, streamed chat, and calendar planning.
- Creates in-memory chat sessions (`POST /api/chat-session`) and starts agent runs.
- Streams session updates via SSE (`GET /api/chat-session/[sessionId]/events`).
- Supports session snapshot/poll fallback (`GET /api/chat-session/[sessionId]`).
- Ingest endpoint for assignment handoff (`POST /api/ingest-assignment`).
- Google Calendar integration connect/disconnect + event creation endpoints.
- Monthly calendar planner page (`/dashboard/calendar`) with toggles for assignment due events, Google events, and proposed work blocks.
- Calendar aggregation endpoint (`GET /api/calendar/month`) for month-range event hydration.
- Heuristic proposal generator (`POST /api/calendar/proposals/generate`) for assignment work blocks.
- Legacy proxy endpoint for direct run forwarding (`POST /api/run-agent`).

### Agent Service (AI Orchestration)

- Exposes legacy and versioned endpoints: `/run-agent`, `/run-agent/stream`, `/health`, `/api/v1/runs`, `/api/v1/runs/stream`, `/api/v1/health`.
- Processes attached PDFs with native-first extraction (PyMuPDF) and selective OCR fallback.
- Extracts visual emphasis signals (highlights, underlines, style cues) and ranks significance.
- Streams typed run events over SSE (`run.started`, `run.stage`, `run.delta`, `run.completed`, `run.error`).
- Generates a structured markdown guide via LangChain + NVIDIA model integration.

## Architecture Overview

The default end-to-end guide generation flow is:

1. User opens a Canvas assignment page.
2. Extension content script detects page type and extracts normalized assignment data.
3. Extension background worker stores/merges assignment state in `chrome.storage.local`.
4. User clicks `Generate Guide` in the extension widget.
5. Extension calls web app `POST /api/chat-session`, passing payload + attachments context.
6. Web app starts an in-memory session and opens agent SSE stream.
7. Agent service emits run stage/delta/completion events while generating markdown.
8. Web app aggregates stream state and re-emits session updates to dashboard SSE clients.
9. User follows progress and final guide in web dashboard chat view.

Calendar planning flow (new):

1. User opens `/dashboard/calendar` month view.
2. Frontend calls `GET /api/calendar/month` with month range + timezone.
3. Backend returns a unified event list from assignment due dates, Google Calendar events, and persisted work blocks.
4. User clicks `Generate Proposals` or `Regenerate`.
5. Frontend calls `POST /api/calendar/proposals/generate`.
6. Backend computes heuristic blocks, avoids busy intervals, persists rows, and returns generated blocks.

### Component Responsibility Boundaries

- Extension owns Canvas detection, extraction, local extension state, and in-page UX.
- Web app owns dashboard UX, calendar planning UX, session orchestration, and API gateway behavior.
- Agent service owns LLM prompting, PDF context extraction, and response generation.
- Canvas LMS and Google Calendar are treated as external systems.

## Tech Stack

### Extension (`extension/`)

- Runtime: Chrome Extension Manifest V3
- Language: JavaScript (ES modules)
- Bundling: esbuild (content script IIFE, service worker ESM, popup IIFE)
- Testing: Jest + jsdom + babel-jest
- Notable libraries: `motion`, `marked`
- Platform APIs: `chrome.runtime`, `chrome.storage.local`, `chrome.action`, `chrome.tabs`

### Web App (`webapp/`)

- Framework: Next.js (App Router) + React + TypeScript
- Styling/UI: Tailwind CSS v4, shadcn/radix-style component primitives, `next-themes`
- Motion/UI behavior: `framer-motion`
- Markdown rendering: `react-markdown`, `remark-gfm`
- Date utilities: `date-fns`
- Calendar UI: `@fullcalendar/react`, `@fullcalendar/core`, `@fullcalendar/daygrid`
- Transport: Server runtime API routes + SSE endpoints

### Agent Service (`agent_service/`)

- Framework: FastAPI + Uvicorn
- Schema validation: Pydantic
- LLM orchestration: LangChain + `langchain-nvidia-ai-endpoints`
- PDF parsing: PyMuPDF (`pymupdf`)
- OCR fallback: `pytesseract` + `Pillow` (requires system `tesseract`)
- Configuration: `python-dotenv`

## Repository Structure

```text
.
|-- extension/                # Chrome MV3 extension
|   |-- src/
|   |   |-- background/       # Message routing and run workflow
|   |   |-- content/          # Page detection, extractors, widget injection
|   |   |-- clients/          # Web app HTTP client
|   |   |-- storage/          # chrome.storage access
|   |   |-- shared/           # Contracts, constants, logger
|   |   `-- popup/
|   `-- tests/                # Jest unit tests
|-- webapp/                   # Next.js dashboard + API routes
|   |-- src/
|   |   |-- app/
|   |   |   |-- api/          # ingest, chat-session, integrations, calendar routes
|   |   |   `-- dashboard/    # Dashboard pages, chat UI, and calendar planner view
|   |   `-- lib/              # Google/calendar integration and planner logic
|   `-- supabase/
|       `-- migrations/       # Supabase SQL migrations
|-- agent_service/            # FastAPI AI orchestration service
|   `-- app/
|       |-- api/v1/routes/    # health and runs endpoints
|       |-- services/         # run workflow + PDF extraction
|       |-- orchestrators/    # prompt and output orchestration
|       |-- clients/          # LLM provider client wrappers
|       `-- schemas/          # Request/response contracts
|-- internal/architecture/    # System contracts and boundaries
`-- docs/                     # Architecture and flow diagrams
```

## API Surface

### Web App API

- `POST /api/ingest-assignment`
- `POST /api/chat-session`
- `GET /api/chat-session/:sessionId`
- `GET /api/chat-session/:sessionId/events` (SSE)
- `POST /api/run-agent` (legacy proxy path)
- `GET /api/integrations/google-calendar`
- `GET /api/integrations/google-calendar/connect`
- `GET /api/integrations/google-calendar/callback`
- `POST /api/integrations/google-calendar/disconnect`
- `POST /api/integrations/google-calendar/events`
- `GET /api/calendar/month`
- `POST /api/calendar/proposals/generate`

### Agent Service API

- `GET /api/v1/health`
- `POST /api/v1/runs`
- `POST /api/v1/runs/stream` (SSE)
- `GET /health` (legacy)
- `POST /run-agent` (legacy)
- `POST /run-agent/stream` (legacy SSE)

## Local Development

### Prerequisites

- Node.js 18+
- Python 3.10+ recommended
- Chrome browser
- (Optional) system `tesseract` binary for OCR fallback in `agent_service`

### 1. Agent Service

```bash
cd agent_service
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### 2. Web App

```bash
cd webapp
npm install
npm run dev
```

Runs on `http://localhost:3000`.

### 3. Extension

```bash
cd extension
npm install
npm run build
```

Then load unpacked extension in Chrome from the `extension/` directory.

## Testing and Quality Checks

### Extension

```bash
cd extension
npm test
npm run build
```

### Web App

```bash
cd webapp
npm run lint
npm run build
```

### Agent Service

```bash
cd agent_service
python -m pytest
```

## Environment Variables

### `webapp/.env.local`

- `AGENT_SERVICE_URL`
  Example: `http://localhost:8000`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI`
  Example: `http://localhost:3000/api/integrations/google-calendar/callback`
- `GOOGLE_OAUTH_SCOPES`
  Example: `https://www.googleapis.com/auth/calendar.events openid email`
  Notes: default scopes include `calendar.events`, `openid`, and `email`; `openid` and `email` are optional if you only need calendar access.

### `agent_service/.env`

- `NVIDIA_API_KEY` (required for LLM calls)
- `ENABLE_VISUAL_SIGNALS` (optional feature flag, defaults enabled)

## Database Migrations

Calendar proposal persistence uses `public.assignment_work_blocks`.

- Migration script: `webapp/supabase/migrations/20260325_calendar_work_blocks.sql`
- Includes constraints for:
  - `source in ('heuristic', 'agent')`
  - `status in ('proposed', 'accepted', 'dismissed')`
  - `end_at > start_at`
- Includes indexes for user/range, user/assignment, and user/status/range queries.

## Current State and Direction

### Current

- Working local 3-app pipeline from Canvas extraction to streamed guide generation in dashboard chat.
- Extension-to-dashboard handoff is implemented and functional.
- Agent service supports both sync and stream workflows with typed stage events.
- Dashboard includes live chat, Google Calendar integration, and a monthly planner view with proposed assignment work blocks.

### Direction

- Add durable persistence for assignments, sessions, and generated guides.
- Add authentication/authorization and production-grade security constraints.
- Stabilize and version contracts across all components.
- Expand automated contract/integration/e2e coverage across extension, web app, and agent service.
