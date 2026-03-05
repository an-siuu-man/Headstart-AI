# Extension Architecture

## Purpose

The Chrome MV3 extension detects Canvas assignment pages, extracts assignment data, stores normalized records in `chrome.storage.local`, and triggers Headstart AI runs through the web app API.

## Runtime Components

- `src/content/*`: Runs in Canvas pages. Detects page type, extracts assignment content, injects widget UI.
- `src/background/*`: Runs in the MV3 service worker. Routes runtime messages, persists assignment records, and coordinates backend calls.
- `src/storage/assignment-store.js`: Storage access layer for assignment records.
- `src/clients/webapp-client.js`: HTTP client for web app endpoints (`/api/ingest-assignment`, `/api/run-agent`).
- `src/shared/contracts/messages.js`: Message types shared across content and background contexts.

## Module Boundaries

- `content/detectors`: URL/page classification only.
- `content/extractors`: DOM/API extraction only.
- `content/injectors` and `content/ui`: UI injection only.
- `background/handlers`: Message-specific persistence/update handling.
- `background/workflows`: Multi-step orchestration, especially AI run flow.
- `storage`: All `chrome.storage.local` reads/writes.
- `clients`: All network calls from extension code.

## Data Model

- Assignment storage key format: `assignment::<courseId>::<assignmentId>`.
- Core stored fields: `courseId`, `assignmentId`, `title`, `dueDate`, `descriptionText`, `rubric`, `userTimezone`, `pdfAttachments`, metadata (`detectedAt`, `status`, `url`).
- Headstart payload is derived from stored assignment records via `buildHeadstartPayload`.

## Flow 1: Detection and Extraction

1. Content entrypoint `src/content/index.js` runs on matching Canvas URLs.
2. `detectCanvasPage()` classifies page as single assignment vs assignment list.
3. For single assignment pages:
4. `runSingleAssignmentFlow()` sends `ASSIGNMENT_DETECTED` to background.
5. `extractAssignmentData()` gathers normalized assignment fields.
6. Content sends `ASSIGNMENT_DATA` with extracted data.
7. `injectWidget()` renders the in-page widget.
8. Background router `src/background/index.js` dispatches to:
9. `handleAssignmentDetected()` -> `upsertDetectedAssignment()`.
10. `handleAssignmentData()` -> `mergeExtractedAssignment()`.

## Flow 2: Headstart Run Orchestration

1. Content/widget preflights `CHECK_ASSIGNMENT_GUIDE_STATUS` for single-assignment pages.
2. Background calls web app `/api/assignment-guide-status`.
3. If auth is missing, widget switches CTA to login (`HEADSTART_AUTH_REQUIRED` behavior).
4. Widget re-checks guide status when the Canvas tab regains focus/visibility to recover after login.
5. Content/widget sends `START_HEADSTART_RUN` once authenticated.
6. Background router calls `handleStartHeadstartRun()` (`background/workflows/headstart-run-workflow.js`).
7. Workflow parses Canvas IDs from tab URL, loads stored assignment record, and builds normalized payload.
8. Extension calls web app `/api/chat-session` to create a dashboard-backed session handoff.
9. Background sends `HEADSTART_RESULT`, `HEADSTART_AUTH_REQUIRED`, or `HEADSTART_ERROR` back to the active tab.

## Failure and Recovery Behavior

- Unknown runtime messages are acknowledged with `{ status: "unknown" }`.
- Missing Canvas assignment context or missing stored assignment record returns `HEADSTART_ERROR`.
- Non-2xx backend responses throw in `webapp-client` and are surfaced as `HEADSTART_ERROR`.
- Storage merges preserve earlier fields when partial extraction payloads are received.

## External Dependencies

- Chrome Extension APIs (`runtime`, `tabs`, `storage`, `action`).
- Canvas LMS DOM/URL patterns.
- Local web app API at `http://localhost:3000` by default.
