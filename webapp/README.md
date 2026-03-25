# Web App (`webapp`)

Next.js App Router dashboard and backend-for-frontend API for Headstart AI.

## What This App Owns

- Student-facing UI (dashboard, assignments, resources, profile/settings, chat, calendar planner).
- Session APIs for agent orchestration (`/api/chat-session/*`).
- Assignment ingest API for extension handoff (`/api/ingest-assignment`).
- Google Calendar integration APIs (OAuth connect/callback/disconnect + event creation).
- Calendar planner APIs and UI:
  - `GET /api/calendar/month`
  - `POST /api/calendar/proposals/generate`
  - `/dashboard/calendar`

## Calendar Planner (Latest)

The new calendar planner page is a monthly calendar view that combines:

- Assignment due events from persisted chat session context and assignment submission status.
- Integrated Google Calendar events for the selected month range.
- Proposed assignment work blocks generated heuristically and persisted in Supabase.

UI location: `src/app/dashboard/calendar/page.tsx`

### Planner Controls

- Source toggles for `Assignment Due`, `Google Events`, and `Proposed Blocks`.
- `Generate Proposals`: generates additional blocks without replacing existing heuristic proposed blocks.
- `Regenerate`: replaces existing heuristic proposed blocks within the selected range, then generates fresh blocks.

### Heuristic Scheduling Rules

Implemented in `src/lib/calendar-planner.ts`.

- Priority derivation (from due date + submission state): `High`, `Medium`, `Low`.
- Slot templates:
  - `High`: 3 blocks, 90 minutes each, target offsets 168h, 72h, 24h before due date.
  - `Medium`: 2 blocks, 90 minutes each, target offsets 96h, 24h before due date.
  - `Low`: 1 block, 60 minutes, target offset 24h before due date.
- Collision handling:
  - Avoids overlap with Google busy events.
  - Avoids overlap with retained existing work blocks.
  - Shifts candidate windows backward in 30-minute increments.

## API Endpoints

### Session + Ingest

- `POST /api/ingest-assignment`
- `POST /api/chat-session`
- `GET /api/chat-session/:sessionId`
- `GET /api/chat-session/:sessionId/events` (SSE)
- `POST /api/run-agent` (legacy proxy)

### Google Calendar Integration

- `GET /api/integrations/google-calendar`
- `GET /api/integrations/google-calendar/connect`
- `GET /api/integrations/google-calendar/callback`
- `POST /api/integrations/google-calendar/disconnect`
- `POST /api/integrations/google-calendar/events`

### Calendar Planner

- `GET /api/calendar/month`
  - Query: `start_iso`, `end_iso`, `timezone`
  - Output: unified event list with `assignment_due`, `google_event`, `proposed_block`
- `POST /api/calendar/proposals/generate`
  - Body: `start_iso`, `end_iso`, `timezone`, `replace_existing`
  - Output: generated persisted proposed blocks for the range

## Data Model and Migration

Planner persistence table: `public.assignment_work_blocks`

- Migration script: `supabase/migrations/20260325_calendar_work_blocks.sql`
- Columns include: `user_id`, `assignment_id`, `source`, `status`, `title`, `start_at`, `end_at`, `google_event_id`, `metadata`
- Constraints:
  - `source in ('heuristic', 'agent')`
  - `status in ('proposed', 'accepted', 'dismissed')`
  - `end_at > start_at`

## Styling the Calendar

The calendar uses FullCalendar (`@fullcalendar/react` + `@fullcalendar/daygrid`) and supports custom styling.

Common options:

- Override FullCalendar selectors globally in `src/app/globals.css` (`.fc`, `.fc-daygrid-day`, `.fc-toolbar`, etc.).
- Set per-event colors/classes in the `events` mapping.
- Use hooks such as `eventContent`, `eventClassNames`, and `dayCellClassNames` for richer custom UI.

## Environment Variables (`.env.local`)

- `AGENT_SERVICE_URL` (required)
- `GOOGLE_OAUTH_CLIENT_ID` (required for Google integration)
- `GOOGLE_OAUTH_CLIENT_SECRET` (required for Google integration)
- `GOOGLE_OAUTH_REDIRECT_URI` (optional; defaults to `/api/integrations/google-calendar/callback`)
- `GOOGLE_OAUTH_SCOPES` (optional)
  - Example: `https://www.googleapis.com/auth/calendar.events openid email`
  - Defaults to `calendar.events openid email` when unset.
  - `openid` and `email` are optional if only calendar access is needed.

## Local Development

```bash
npm install
npm run dev
```

App runs on `http://localhost:3000` by default.

## Quality Checks

```bash
npm run lint
npm run build
```
