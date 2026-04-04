# Headstart Chrome Extension — Sequence Diagrams

This document details every interaction flow within the Headstart Chrome Extension using Mermaid sequence diagrams.

---

## Table of Contents

- [Headstart Chrome Extension — Sequence Diagrams](#headstart-chrome-extension--sequence-diagrams)
  - [Table of Contents](#table-of-contents)
  - [Architecture Overview](#architecture-overview)
  - [Flow 1: Page Detection \& Assignment Extraction (Single Assignment)](#flow-1-page-detection--assignment-extraction-single-assignment)
  - [Flow 2: Assignment List Detection \& Extraction](#flow-2-assignment-list-detection--extraction)
  - [Flow 3: Guide Status Check (Automatic on Widget Load)](#flow-3-guide-status-check-automatic-on-widget-load)
  - [Flow 4: Generate Guide](#flow-4-generate-guide)
  - [Flow 5: Authentication Recovery](#flow-5-authentication-recovery)
  - [Flow 6: View Guide in Dashboard](#flow-6-view-guide-in-dashboard)
  - [Flow 7: Popup — View Detected Assignments](#flow-7-popup--view-detected-assignments)
  - [Flow 8: Toggle Sidebar](#flow-8-toggle-sidebar)
  - [Message Protocol Summary](#message-protocol-summary)
    - [Content Script → Background (via `chrome.runtime.sendMessage`)](#content-script--background-via-chromeruntimesendmessage)
    - [Background → Content Script (via `chrome.tabs.sendMessage`)](#background--content-script-via-chrometabssendmessage)
  - [Storage Data Model](#storage-data-model)
  - [End-to-End Lifecycle (Consolidated)](#end-to-end-lifecycle-consolidated)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                Chrome Extension (MV3)                    │
│                                                          │
│  ┌──────────────────┐       ┌──────────────────────┐    │
│  │  Content Script   │       │  Service Worker       │    │
│  │  (Canvas pages)   │       │  (Background)         │    │
│  │                   │       │                       │    │
│  │  • page-detector  │       │  • message router     │    │
│  │  • extractors     │ chrome │  • assignment-handlers│    │
│  │  • widget-injector│◄─────►│  • headstart-workflow │    │
│  │  • workflows      │.runtime│  • headstart-payload  │    │
│  └──────────────────┘messaging└──────────┬───────────┘    │
│                                          │                │
│  ┌──────────────────┐       ┌────────────┴─────────┐    │
│  │  Popup            │       │  Storage Layer        │    │
│  │  (reads storage)  │──────►│  chrome.storage.local │    │
│  └──────────────────┘       └──────────────────────┘    │
└─────────────────────────────┬───────────────────────────┘
                              │ fetch (credentials: include)
                              ▼
                    ┌───────────────────┐
                    │  Webapp Backend   │
                    │  localhost:3000   │
                    │                   │
                    │  /api/chat-session│
                    │  /api/assignment- │
                    │    guide-status   │
                    └───────────────────┘
```

**Runtime Contexts:**

- **Content Script** — injected into Canvas LMS pages; detects assignments, extracts data, renders sidebar widget
- **Service Worker (Background)** — central message router; orchestrates storage and webapp API calls
- **Popup** — browser-action popup; reads detected assignments from `chrome.storage.local`

---

## Flow 1: Page Detection & Assignment Extraction (Single Assignment)

Triggered automatically when a user navigates to a Canvas single-assignment page (e.g., `/courses/123/assignments/456`).

```mermaid
sequenceDiagram
    participant User
    participant Browser as Chrome Browser
    participant CS as Content Script<br/>(index.js)
    participant PD as Page Detector<br/>(page-detector.js)
    participant AE as Assignment Extractor<br/>(assignment-extractor.js)
    participant CAE as Canvas API Extractor<br/>(canvas-api-extractor.js)
    participant RE as Rubric Extractor<br/>(rubric-extractor.js)
    participant WI as Widget Injector<br/>(widget-injector.js)
    participant BG as Service Worker<br/>(background/index.js)
    participant AH as Assignment Handlers<br/>(assignment-handlers.js)
    participant Store as chrome.storage.local
    participant CanvasAPI as Canvas REST API

    User->>Browser: Navigate to Canvas assignment page
    Browser->>CS: Inject content script (IIFE, on page load)

    Note over CS: Entry point runs immediately

    CS->>PD: detectCanvasPage(window.location.href)
    PD-->>CS: { type: "SINGLE_ASSIGNMENT", courseId, assignmentId, url }

    CS->>CS: Extract courseName from DOM<br/>(.mobile-header-title or<br/>#course_name_and_id span)

    Note over CS: Dispatch to runSingleAssignmentFlow()

    rect rgb(240, 248, 255)
        Note over CS,Store: Phase 1 — Notify Background of Detection
        CS->>BG: chrome.runtime.sendMessage(<br/>{ type: ASSIGNMENT_DETECTED,<br/>  courseId, assignmentId, courseName, url })
        BG->>AH: handleAssignmentDetected(payload, sender)
        AH->>Store: upsertDetectedAssignment(courseId, assignmentId, record)
        Store-->>AH: stored
        AH->>Browser: chrome.action.setBadge("!", tab) [if new]
        AH-->>BG: { status: "ack" }
        BG-->>CS: { status: "ack" }
    end

    rect rgb(240, 255, 240)
        Note over CS,CanvasAPI: Phase 2 — Extract Assignment Data
        CS->>AE: extractAssignmentData(courseId, assignmentId)

        AE->>CAE: fetchAssignmentFromAPI(courseId, assignmentId)

        par Parallel Canvas API Requests
            CAE->>CanvasAPI: GET /api/v1/courses/{courseId}/assignments/{assignmentId}<br/>?include[]=rubric_definition
            CanvasAPI-->>CAE: Assignment JSON (title, description, due_at,<br/>points, submission_types, rubric, attachments)
        and
            CAE->>CanvasAPI: GET /api/v1/courses/{courseId}
            CanvasAPI-->>CAE: Course JSON (name)
        and
            CAE->>CanvasAPI: GET /api/v1/users/self/profile
            CanvasAPI-->>CAE: Profile JSON (time_zone IANA)
        end

        Note over CAE: Check for PDF attachments in<br/>assignment.attachments[] and<br/>embedded file links in description HTML

        opt PDF attachments found
            loop For each PDF attachment
                CAE->>CanvasAPI: GET /api/v1/courses/{courseId}/files/{fileId}?download_frd=1
                CanvasAPI-->>CAE: File metadata with download URL
                CAE->>CanvasAPI: GET [presigned S3 URL]
                CanvasAPI-->>CAE: Binary PDF data
                Note over CAE: Convert PDF to base64
            end
        end

        CAE-->>AE: AssignmentData { title, courseName,<br/>descriptionHtml, descriptionText, dueDate,<br/>pointsPossible, submissionType, rubric,<br/>userTimezone, pdfAttachments }

        alt Canvas API fails (network error, 401, etc.)
            Note over AE: Fallback to DOM scraping
            AE->>AE: Scrape title, description, dueDate,<br/>pointsPossible, submissionType from<br/>DOM using CANVAS_SELECTORS
            AE->>RE: extractRubric()
            RE->>RE: Parse .rubric_container for criteria,<br/>ratings, points, descriptions
            RE-->>AE: Rubric object
        end

        AE-->>CS: AssignmentData (complete)
    end

    rect rgb(255, 248, 240)
        Note over CS,Store: Phase 3 — Send Extracted Data to Background
        CS->>BG: chrome.runtime.sendMessage(<br/>{ type: ASSIGNMENT_DATA,<br/>  courseId, assignmentId, data: AssignmentData })
        BG->>AH: handleAssignmentData(payload, sender)
        AH->>Store: mergeExtractedAssignment(courseId, assignmentId, data)
        Note over Store: Deep-merge: new non-empty values<br/>overwrite old; nulls preserve previous.<br/>Status updated to "extracted"
        Store-->>AH: merged record
        AH-->>BG: { status: "ack" }
        BG-->>CS: { status: "ack" }
    end

    rect rgb(248, 240, 255)
        Note over CS,WI: Phase 4 — Inject Sidebar Widget
        CS->>WI: injectWidget(assignmentData)
        WI->>WI: Create toggle button (rocket icon)<br/>+ sidebar panel in DOM
        WI->>WI: Apply CSS from headstart-widget.css
        WI->>WI: Set 500ms timeout to auto-open sidebar
        Note over WI: Widget now visible on page;<br/>auto-triggers guide status check (see Flow 3)
    end
```

---

## Flow 2: Assignment List Detection & Extraction

Triggered when a user navigates to a Canvas assignment list page (e.g., `/courses/123/assignments`).

```mermaid
sequenceDiagram
    participant User
    participant Browser as Chrome Browser
    participant CS as Content Script<br/>(index.js)
    participant PD as Page Detector
    participant ALE as Assignment List Extractor<br/>(assignment-list-extractor.js)
    participant WFS as waitForSelector utility
    participant WI as Widget Injector
    participant BG as Service Worker
    participant AH as Assignment Handlers
    participant Store as chrome.storage.local

    User->>Browser: Navigate to Canvas assignment list page
    Browser->>CS: Inject content script

    CS->>PD: detectCanvasPage(window.location.href)
    PD-->>CS: { type: "ASSIGNMENT_LIST", courseId, url }

    Note over CS: Dispatch to runAssignmentListFlow()

    CS->>ALE: extractAssignmentList()

    ALE->>WFS: waitForSelector(".assignment_group", 5000ms)
    Note over WFS: Uses MutationObserver to wait<br/>for list DOM elements to appear

    alt Elements found within timeout
        WFS-->>ALE: DOM elements available

        loop For each assignment row in DOM
            ALE->>ALE: Parse row: extract assignmentId,<br/>title, dueDate, URL from<br/>DOM selectors (.ig-title a, .due_date_display, etc.)
            ALE->>BG: chrome.runtime.sendMessage(<br/>{ type: ASSIGNMENT_DETECTED,<br/>  courseId, assignmentId, title, url })
            BG->>AH: handleAssignmentDetected(payload, sender)
            AH->>Store: upsertDetectedAssignment(courseId, assignmentId, record)
            AH-->>BG: { status: "ack" }
            BG-->>ALE: { status: "ack" }
        end

        ALE-->>CS: assignments[] (list of detected assignments)
    else Timeout — elements not found
        WFS-->>ALE: null (timeout)
        Note over ALE: Return empty list
        ALE-->>CS: []
    end

    CS->>WI: injectWidget(null, assignments)
    WI->>WI: Create toggle button + sidebar panel
    WI->>WI: CTA button shows "Open Dashboard"
    Note over WI: No guide-status check on list pages
```

---

## Flow 3: Guide Status Check (Automatic on Widget Load)

Triggered immediately after the widget is injected on a single-assignment page, and re-triggered on tab focus/visibility events.

```mermaid
sequenceDiagram
    participant WI as Widget Injector<br/>(Sidebar)
    participant BG as Service Worker
    participant WF as Headstart Workflow<br/>(headstart-run-workflow.js)
    participant HP as Headstart Payload<br/>(headstart-payload.js)
    participant WC as Webapp Client<br/>(webapp-client.js)
    participant Webapp as Webapp Backend<br/>(localhost:3000)

    Note over WI: Widget just mounted on<br/>single-assignment page

    WI->>WI: Set guideStatusCheckInFlight = true
    WI->>BG: chrome.runtime.sendMessage(<br/>{ type: CHECK_ASSIGNMENT_GUIDE_STATUS })
    BG->>WF: handleCheckAssignmentGuideStatus(tab)

    WF->>HP: getCanvasIdsFromUrl(tab.url)
    HP-->>WF: { courseId, assignmentId, instanceDomain }

    WF->>WC: getAssignmentGuideStatus(courseId, assignmentId, instanceDomain)
    WC->>Webapp: GET /api/assignment-guide-status<br/>?course_id={courseId}<br/>&assignment_id={assignmentId}<br/>&instance_domain={instanceDomain}

    alt 200 — Guide Exists
        Webapp-->>WC: { exists: true, latest_session_id,<br/>latest_session_updated_at, status }
        WC-->>WF: response
        WF-->>BG: { ok: true, exists: true,<br/>latestSessionId, latestSessionUpdatedAt }
        BG-->>WI: response

        WI->>WI: singleAssignmentActionLabel = "Generate New Guide"
        WI->>WI: Update CTA button text
        WI->>WI: guideStatusCheckInFlight = false

    else 200 — No Guide
        Webapp-->>WC: { exists: false }
        WC-->>WF: response
        WF-->>BG: { ok: true, exists: false }
        BG-->>WI: response

        WI->>WI: singleAssignmentActionLabel = "Generate Guide"
        WI->>WI: Update CTA button text
        WI->>WI: guideStatusCheckInFlight = false

    else 401/403 — Auth Required
        Webapp-->>WC: HTTP 401 or 403
        WC->>WC: throw WebappHttpError (isAuthError: true)
        WF->>WF: isWebappAuthError(error) → true
        WF-->>BG: { ok: false, authRequired: true,<br/>loginUrl: "http://localhost:3000/login" }
        BG-->>WI: response

        WI->>WI: authRequired = true
        WI->>WI: loginUrl = response.loginUrl
        WI->>WI: CTA button → "Log in to Headstart"
        WI->>WI: guideStatusCheckInFlight = false
    end

    Note over WI: Re-check on tab focus

    par Visibility/Focus Listeners
        WI->>WI: window.addEventListener("focus", recheckGuideStatus)
        WI->>WI: document.addEventListener("visibilitychange", recheckGuideStatus)
    end
```

---

## Flow 4: Generate Guide

Triggered when the user clicks the "Generate Guide" or "Generate New Guide" button.

```mermaid
sequenceDiagram
    participant User
    participant WI as Widget Injector<br/>(Sidebar)
    participant BG as Service Worker
    participant WF as Headstart Workflow<br/>(headstart-run-workflow.js)
    participant HP as Headstart Payload<br/>(headstart-payload.js)
    participant Store as chrome.storage.local
    participant WC as Webapp Client<br/>(webapp-client.js)
    participant Webapp as Webapp Backend<br/>(localhost:3000)

    User->>WI: Click "Generate Guide"
    WI->>WI: Disable CTA button
    WI->>WI: Show "Generating..." status

    WI->>BG: chrome.runtime.sendMessage(<br/>{ type: START_HEADSTART_RUN })

    BG->>WF: handleStartHeadstartRun(tab, pageTitle)

    rect rgb(240, 248, 255)
        Note over WF,Store: Step 1 — Load & Build Payload
        WF->>HP: getCanvasIdsFromUrl(tab.url)
        HP-->>WF: { courseId, assignmentId, instanceDomain }

        WF->>Store: getAssignmentRecord(courseId, assignmentId)
        Store-->>WF: assignment record (with all extracted data)

        WF->>HP: buildHeadstartPayload(assignment)
        Note over HP: Normalize payload:<br/>• Parse due date (ISO or Canvas format)<br/>• Format due date in user timezone<br/>• Calculate isPastDue & dueWithin48Hours<br/>• Structure course, assignment, rubric fields
        HP-->>WF: normalizedPayload
    end

    rect rgb(240, 255, 240)
        Note over WF,Webapp: Step 2 — Create Chat Session
        WF->>WC: createChatSession({ payload, userId })
        WC->>Webapp: POST /api/chat-session<br/>Body: { payload, userId }<br/>Credentials: include (cookies)
    end

    alt 200 — Session Created
        Webapp-->>WC: { session_id: "abc-123" }
        WC-->>WF: { session_id: "abc-123" }

        WF->>WF: Build redirectUrl = <br/>"http://localhost:3000/dashboard/chat?session=abc-123"

        WF->>BG: chrome.tabs.sendMessage(tab.id,<br/>{ type: HEADSTART_RESULT,<br/>  result: { status: "ok",<br/>  sessionId: "abc-123",<br/>  redirectUrl } })
        BG->>WI: Message received via<br/>chrome.runtime.onMessage listener

        WI->>WI: dashboardUrl = redirectUrl
        WI->>WI: CTA → "View Guide in Dashboard"
        WI->>WI: Show success status
        WI->>WI: Re-enable CTA button

    else 401/403 — Auth Error
        Webapp-->>WC: HTTP 401 or 403
        WC->>WC: throw WebappHttpError (isAuthError: true)
        WF->>WF: isWebappAuthError(error) → true

        WF->>BG: chrome.tabs.sendMessage(tab.id,<br/>{ type: HEADSTART_AUTH_REQUIRED,<br/>  message: "Login required",<br/>  loginUrl: "http://localhost:3000/login" })
        BG->>WI: Message received

        WI->>WI: authRequired = true
        WI->>WI: CTA → "Log in to Headstart"
        WI->>WI: Show error status

    else 5xx / Network Error
        Webapp-->>WC: HTTP 500 or network failure
        WC->>WC: throw WebappHttpError or TypeError

        WF->>BG: chrome.tabs.sendMessage(tab.id,<br/>{ type: HEADSTART_ERROR,<br/>  error: error.message })
        BG->>WI: Message received

        WI->>WI: Re-enable CTA button
        WI->>WI: Show error status with message
    end
```

---

## Flow 5: Authentication Recovery

Triggered when the user clicks "Log in to Headstart" and returns to the Canvas tab after logging in.

```mermaid
sequenceDiagram
    participant User
    participant WI as Widget Injector<br/>(Sidebar)
    participant Browser as Chrome Browser
    participant WebappTab as Webapp Login Page<br/>(new tab)
    participant BG as Service Worker
    participant WF as Headstart Workflow
    participant Webapp as Webapp Backend

    Note over WI: authRequired = true<br/>CTA: "Log in to Headstart"

    User->>WI: Click "Log in to Headstart"
    WI->>Browser: window.open(loginUrl, "_blank")
    Browser->>WebappTab: Open http://localhost:3000/login

    Note over User,WebappTab: User logs in on the<br/>webapp login page

    User->>WebappTab: Enter credentials & submit
    WebappTab->>WebappTab: Set session cookies

    User->>Browser: Switch back to Canvas tab

    Browser->>WI: window "focus" event fires

    WI->>WI: recheckGuideStatus()
    WI->>WI: Check guideStatusCheckInFlight == false

    WI->>BG: chrome.runtime.sendMessage(<br/>{ type: CHECK_ASSIGNMENT_GUIDE_STATUS })
    BG->>WF: handleCheckAssignmentGuideStatus(tab)
    WF->>Webapp: GET /api/assignment-guide-status?...

    alt Auth now succeeds (cookies valid)
        Webapp-->>WF: { exists: false } (or { exists: true })
        WF-->>BG: { ok: true, ... }
        BG-->>WI: response

        WI->>WI: authRequired = false
        WI->>WI: CTA → "Generate Guide"<br/>(or "Generate New Guide" if exists)
        Note over WI: Automatic recovery complete!
    else Still not authenticated
        Webapp-->>WF: 401/403
        WF-->>BG: { ok: false, authRequired: true }
        BG-->>WI: response
        WI->>WI: CTA remains "Log in to Headstart"
    end
```

---

## Flow 6: View Guide in Dashboard

Triggered after a successful guide generation when the user clicks "View Guide in Dashboard".

```mermaid
sequenceDiagram
    participant User
    participant WI as Widget Injector<br/>(Sidebar)
    participant Browser as Chrome Browser
    participant Dashboard as Webapp Dashboard<br/>(new tab)

    Note over WI: Guide was generated successfully<br/>CTA: "View Guide in Dashboard"<br/>dashboardUrl is set

    User->>WI: Click "View Guide in Dashboard"
    WI->>Browser: window.open(dashboardUrl, "_blank")
    Browser->>Dashboard: Open http://localhost:3000/dashboard/chat?session={sessionId}

    Note over Dashboard: Chat session loads with<br/>the generated assignment guide
```

---

## Flow 7: Popup — View Detected Assignments

Triggered when the user clicks the extension icon in the Chrome toolbar.

```mermaid
sequenceDiagram
    participant User
    participant Browser as Chrome Browser
    participant Popup as popup.js
    participant Store as chrome.storage.local

    User->>Browser: Click Headstart extension icon
    Browser->>Popup: Open popup.html

    Popup->>Store: chrome.storage.local.get(null)
    Note over Popup: Request ALL stored items

    Store-->>Popup: All key-value pairs

    Popup->>Popup: Filter keys starting with "assignment::"
    Popup->>Popup: Sort by detectedAt descending (newest first)

    alt Assignments found
        loop For each assignment record
            Popup->>Popup: Render list item:<br/>• Course name (bold)<br/>• Assignment title<br/>• Status badge:<br/>  - Green "extracted" (data complete)<br/>  - Gray "pending" (detected only)<br/>• Due date (if available)
        end
    else No assignments
        Popup->>Popup: Show "No assignments detected yet."
    end

    Note over Popup: Popup remains open until<br/>user clicks away
```

---

## Flow 8: Toggle Sidebar

The sidebar toggle button is always visible on Canvas assignment pages.

```mermaid
sequenceDiagram
    participant User
    participant Toggle as Toggle Button<br/>(rocket icon)
    participant Sidebar as Sidebar Panel
    participant Motion as Motion Library<br/>(spring animations)

    Note over Toggle,Sidebar: Widget injected via<br/>injectWidget() → injectSidebar()

    Note over Sidebar: Auto-open after 500ms timeout

    activate Sidebar
    Motion->>Sidebar: Spring animation: translateX(100%) → translateX(0)
    Note over Sidebar: sidebarOpen = true

    User->>Toggle: Click toggle button
    Toggle->>Sidebar: Toggle visibility
    Motion->>Sidebar: Spring animation: translateX(0) → translateX(100%)
    deactivate Sidebar
    Note over Sidebar: sidebarOpen = false

    User->>Toggle: Click toggle button again
    Toggle->>Sidebar: Toggle visibility
    activate Sidebar
    Motion->>Sidebar: Spring animation: translateX(100%) → translateX(0)
    Note over Sidebar: sidebarOpen = true
```

---

## Message Protocol Summary

### Content Script → Background (via `chrome.runtime.sendMessage`)

```mermaid
sequenceDiagram
    participant CS as Content Script
    participant BG as Background

    Note over CS,BG: ASSIGNMENT_DETECTED
    CS->>BG: { type, courseId, assignmentId, courseName, url }
    BG-->>CS: { status: "ack" }

    Note over CS,BG: ASSIGNMENT_DATA
    CS->>BG: { type, courseId, assignmentId, data: AssignmentData }
    BG-->>CS: { status: "ack" }

    Note over CS,BG: START_HEADSTART_RUN
    CS->>BG: { type }
    BG-->>CS: { ok: true } or { ok: false, error }

    Note over CS,BG: CHECK_ASSIGNMENT_GUIDE_STATUS
    CS->>BG: { type }
    BG-->>CS: { ok, exists, latestSessionId,<br/>authRequired, loginUrl }
```

### Background → Content Script (via `chrome.tabs.sendMessage`)

```mermaid
sequenceDiagram
    participant BG as Background
    participant CS as Content Script

    Note over BG,CS: HEADSTART_RESULT
    BG->>CS: { type, result: { status, sessionId, redirectUrl } }

    Note over BG,CS: HEADSTART_AUTH_REQUIRED
    BG->>CS: { type, message, loginUrl }

    Note over BG,CS: HEADSTART_ERROR
    BG->>CS: { type, error: string }
```

---

## Storage Data Model

```
chrome.storage.local
│
├── assignment::185114::1261395     ← key format: assignment::{courseId}::{assignmentId}
│   {
│     courseId: "185114",
│     assignmentId: "1261395",
│     url: "https://canvas.ku.edu/courses/185114/assignments/1261395",
│     title: "Project Proposal",
│     courseName: "EECS 582 - Capstone",
│     dueDate: "2026-03-20T23:59:00Z",
│     pointsPossible: 100,
│     submissionType: "online_upload",
│     descriptionText: "Write a project proposal...",
│     rubric: {
│       title: "Proposal Rubric",
│       criteria: [
│         { description: "Clarity", longDescription: "...", points: 25, ratings: [...] },
│         ...
│       ]
│     },
│     userTimezone: "America/Chicago",
│     pdfAttachments: [
│       { filename: "requirements.pdf", base64Data: "JVBERi0xLj..." }
│     ],
│     detectedAt: "2026-03-16T14:30:00.000Z",
│     status: "extracted"     ← "detected" → "extracted"
│   }
│
├── assignment::185114::1261400
│   { ... }
│
└── ...
```

---

## End-to-End Lifecycle (Consolidated)

```mermaid
sequenceDiagram
    actor User
    participant Canvas as Canvas LMS Page
    participant CS as Content Script
    participant BG as Background<br/>(Service Worker)
    participant Store as chrome.storage.local
    participant Webapp as Webapp Backend

    Note over User,Webapp: ① Page Load — Automatic Detection & Extraction

    User->>Canvas: Navigate to assignment page
    Canvas->>CS: Content script injected
    CS->>CS: Detect page type & extract course name
    CS->>BG: ASSIGNMENT_DETECTED
    BG->>Store: Upsert record (status: "detected")
    CS->>Canvas: Fetch data via Canvas REST API
    Canvas-->>CS: Assignment + Course + Profile data
    CS->>BG: ASSIGNMENT_DATA
    BG->>Store: Merge data (status: "extracted")
    CS->>Canvas: Inject sidebar widget

    Note over User,Webapp: ② Widget Load — Guide Status Check

    CS->>BG: CHECK_ASSIGNMENT_GUIDE_STATUS
    BG->>Webapp: GET /api/assignment-guide-status
    Webapp-->>BG: { exists: false }
    BG-->>CS: CTA = "Generate Guide"

    Note over User,Webapp: ③ User Action — Generate Guide

    User->>CS: Click "Generate Guide"
    CS->>BG: START_HEADSTART_RUN
    BG->>Store: Load stored assignment
    BG->>BG: Build normalized payload
    BG->>Webapp: POST /api/chat-session
    Webapp-->>BG: { session_id: "abc-123" }
    BG->>CS: HEADSTART_RESULT { redirectUrl }
    CS->>CS: CTA = "View Guide in Dashboard"

    Note over User,Webapp: ④ User Action — View Result

    User->>CS: Click "View Guide in Dashboard"
    CS->>User: Open webapp dashboard in new tab
```
