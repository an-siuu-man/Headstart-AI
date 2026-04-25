# Agent Service Streaming Details

This document describes the SSE (Server-Sent Events) streaming flow implemented for guide generation.

## Overview

The agent service now supports streaming guide generation progress and content over SSE so the dashboard can render incremental updates instead of waiting for one final REST response.

## Endpoints

- Versioned streaming endpoint:
  - `POST /api/v1/runs/stream`
- Legacy compatibility endpoint:
  - `POST /run-agent/stream`

Both endpoints accept the same request body shape as the non-stream run endpoint.

## Request Contract

The streaming request uses the existing run contract:

- `assignment_uuid` (optional string)
- `payload` (required object)
- `pdf_text` (optional string)
- `pdf_files` (optional list of `{ filename, storage_url? , base64_data? }`)

No contract changes were introduced for callers.

## Response Transport

- Content type: `text/event-stream`
- Framing:
  - `id: <number>`
  - `event: <event_name>`
  - `data: <json_payload>`

The server emits one JSON payload per event.

## Event Lifecycle

Events are emitted in this order (with repeats where noted):

1. `run.started`
2. `run.stage` (for deterministic stage transitions)
3. `run.stage` (`classifying_assignment`)
4. `run.delta` (repeated while model output streams)
5. `run.stage` (`validating_output`)
6. `run.completed`

Failure path:

- `run.error` is emitted if any step fails.

## Event Types and Payloads

### `run.started`
- Purpose: start signal for client state initialization.
- Includes:
  - `stage`
  - `progress_percent`
  - `status_message`

### `run.stage`
- Purpose: stage-level progress updates.
- Includes:
  - `stage` (`preparing_payload`, `extracting_pdf`, `calling_agent`, `validating_output`, `classifying_assignment`, etc.)
  - `progress_percent`
  - `status_message`

### `run.delta`
- Purpose: incremental guide text chunks.
- Includes:
  - `stage` (`streaming_output`)
  - `progress_percent`
  - `status_message`
  - `delta` (new markdown chunk only)
  - `reasoning_delta` (optional streamed thinking chunk from model)
  - `chunk_index`
  - `accumulated_chars`
  - `reasoning_accumulated_chars` (optional running count for thinking chunks)

### `run.completed`
- Purpose: terminal success event.
- Includes:
  - `guideMarkdown` (full final markdown body)
  - `assignment_category` (`coding`, `mathematics`, `science`, `speech`, `essay`, or `general`)
  - `thinking_content` (optional full streamed thinking trace)
  - `stage` (`completed`)
  - `progress_percent` (`100`)
  - `status_message` (`Guide ready`)

### `run.error`
- Purpose: terminal failure event.
- Includes:
  - `stage` (`failed`)
  - `progress_percent` (`100`)
  - `status_message`
  - `message`

## Agent Orchestration Behavior

The orchestrator includes a dedicated streaming markdown path:

- Uses a markdown-only prompt for stream mode.
- Uses NVIDIA-hosted `openai/gpt-oss-120b` through LangChain `ChatNVIDIA.stream`.
- Emits provider content chunks as they arrive instead of buffering a single response object.
- Streams optional provider reasoning chunks separately when thinking output is enabled.
- Final output is normalized and validated before `run.completed`.
- After PDF/context extraction and before guide generation, the service performs a best-effort lightweight assignment classification call.
  Classification failures emit `assignment_category: "general"` instead of failing the completed guide.

This keeps the dashboard rendering progressively for long-running guide generation.

## Progress Semantics

Progress is now stage-driven plus stream-driven:

- Stage checkpoints set baseline progress.
- `run.delta` events gradually advance progress while output is arriving.
- Final validation and completion steps move progress to `100`.

This removes the need for fake timer-only progress in the client.

## Error Handling

- Any streaming workflow exception is converted into `run.error`.
- The SSE route has defensive error wrapping so clients get a typed terminal event.
- Existing non-stream run endpoints remain available for backward compatibility.

## Compatibility and Migration

- Non-stream run endpoints are unchanged.
- Stream endpoints are additive.
- Webapp session runner now prefers `/api/v1/runs/stream` and can fall back to legacy `/run-agent/stream`.

## Related Files

- `agent_service/app/api/v1/routes/runs.py`
- `agent_service/app/main.py`
- `agent_service/app/services/run_agent_service.py`
- `agent_service/app/orchestrators/headstart_orchestrator.py`
- `webapp/src/lib/chat-session-runner.ts`
- `webapp/src/app/api/chat-session/[sessionId]/events/route.ts`
