# Web App Architecture

## Purpose

The Next.js web app serves two roles:

- Student-facing UI (dashboard, chat, assignments, resources, profile/settings, and monthly calendar planner).
- Backend-for-frontend API facade used by both dashboard UI and extension workflows.

## Runtime Components

- `src/app/*`: App Router pages, layouts, and route handlers.
- `src/app/dashboard/calendar/page.tsx`: Monthly planner view using FullCalendar.
- `src/app/api/calendar/month/route.ts`: Aggregates assignment due events and Google events for a range.
- `src/app/api/calendar/proposals/generate/route.ts`: Generates ephemeral heuristic scheduling suggestions.
- `src/app/api/integrations/google-calendar/*`: OAuth/connectivity and event creation APIs.
- `src/lib/calendar-repository.ts`: Calendar assignment retrieval from persisted chat/session context.
- `src/lib/calendar-planner.ts`: Heuristic proposal generation.
- `src/lib/google-calendar-session.ts`: Token resolution/refresh state handling.
- `src/lib/google-calendar.ts`: Google Calendar API client (OAuth, list events, create events, revoke, refresh).
- `src/lib/calendar-google-markers.ts`: Study-block marker contract and classification helpers.
- `src/lib/chat-session-runner.ts`: Streams guide/chat agent calls, persists guide versions, PDF extraction text, and assignment category metadata.

## Module Boundaries

- `app/api/*`: Transport handlers (auth resolution, request validation, response mapping, integration calls).
- UI pages (`app/dashboard/*`): Rendering and user interactions.
- `lib/calendar-*`: Planner/domain logic and calendar event classification.
- `lib/google-calendar*`: OAuth + provider API integration.
- Session/auth helpers are centralized in `lib/auth/*` and consumed by route handlers.

## API Surface

### Existing

- `POST /api/ingest-assignment`
- `POST /api/chat-session`
- `GET /api/chat-session/:sessionId`
- `GET /api/chat-session/:sessionId/events` (SSE)
- `POST /api/run-agent` (legacy proxy)
- `GET /api/integrations/google-calendar`
- `GET /api/integrations/google-calendar/connect`
- `GET /api/integrations/google-calendar/callback`
- `POST /api/integrations/google-calendar/disconnect`
- `POST /api/integrations/google-calendar/events`

### Calendar Planner

- `GET /api/calendar/month`
  - Requires authenticated user.
  - Inputs: `start_iso`, `end_iso`, `timezone`.
  - Output: merged events from three sources:
    - `assignment_due`
    - `study_time_block`
    - `google_event`

- `POST /api/calendar/proposals/generate`
  - Requires authenticated user.
  - Inputs: `start_iso`, `end_iso`, `timezone`, `replace_existing` (compatibility field).
  - Behavior:
    - Builds assignment planning candidates for in-range, unsubmitted assignments.
    - Pulls busy intervals from Google events.
    - Generates ephemeral heuristic suggestions (no DB persistence).

## Flow 1: Month Calendar Aggregation

1. Client month view emits date range from FullCalendar (`datesSet`).
2. UI calls `GET /api/calendar/month`.
3. Route validates range/timezone and authenticates user.
4. Route loads assignment due items from repository.
5. Route resolves Google integration and lists events for the range (if connected).
6. Route classifies Google events as `study_time_block` (marker + legacy title fallback) or `google_event`.
7. Route returns normalized, sorted events.

## Flow 2: Proposal Generation and Scheduling

1. User clicks `Generate Proposals` or `Regenerate` in `/dashboard/calendar`.
2. UI calls `POST /api/calendar/proposals/generate`.
3. Route validates inputs and loads in-range assignments.
4. Route fetches Google busy events when integration is connected.
5. Route generates non-overlapping heuristic suggestions via `generateHeuristicWorkBlocks`.
6. UI lets user select suggestions and schedule them through `POST /api/calendar/schedule`.
7. Scheduled suggestions are created only in Google Calendar and then show in month view as `study_time_block`.

## Planner Heuristics

- Priority determines count/duration/offsets:
  - High: 3 x 90m at 168h, 72h, 24h pre-deadline.
  - Medium: 2 x 90m at 96h, 24h pre-deadline.
  - Low: 1 x 60m at 24h pre-deadline.
- Candidate windows shift backward by 30 minutes on overlap.
- Schedules avoid known Google busy intervals.
- Returned suggestions are limited to the requested range.

## Data and Persistence

- `public.chat_sessions.assignment_category` stores the nullable assignment category returned by the agent service (`coding`, `mathematics`, `science`, `speech`, `essay`, or `general`).
- The category is shown as a compact label in the chat header and chat list, and is passed back to the agent service for follow-up chat prompt selection.
- Local planner table `public.assignment_work_blocks` has been removed.
- Historical create migration: `supabase/migrations/20260325_calendar_work_blocks.sql`.
- Removal migration: `supabase/migrations/20260326_drop_assignment_work_blocks.sql`.
- Study-session identity is stored on Google events via private extended properties.

## Configuration and Dependencies

- Runtime: Next.js App Router (Node runtime for planner/google routes).
- Required env vars:
  - `AGENT_SERVICE_URL` (for legacy/agent flow).
  - Google OAuth envs for calendar integration.
- Calendar UI dependencies:
  - `@fullcalendar/core`
  - `@fullcalendar/react`
  - `@fullcalendar/daygrid`

## Failure Behavior

- Missing auth returns `401` for planner routes.
- Invalid range/timezone returns `400`.
- Google 400/401/403 responses transition integration to `needs_attention` and suppress Google events for planner responses.
- Upstream/network/provider failures map to `500` with error detail.
- Assignment category persistence is best-effort. If the category is missing or `NULL`, chat sessions continue with the base follow-up prompt and no category label.
