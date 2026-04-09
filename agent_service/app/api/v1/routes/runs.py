"""
Artifact: agent_service/app/api/v1/routes/runs.py
Purpose: Defines run creation route handlers and maps runtime failures to HTTP responses.
Author: Ansuman Sharma
Created: 2026-02-27
Revised:
- 2026-02-27: Added versioned runs route module with shared run handler function. (Ansuman Sharma)
- 2026-03-01: Added SSE run streaming endpoint and shared stream handler. (Codex)
Preconditions:
- Incoming request body conforms to RunAgentRequest schema.
Inputs:
- Acceptable: POST body containing payload plus optional structured pdf_extractions/pdf_files.
- Unacceptable: Invalid schema payloads or malformed JSON bodies.
Postconditions:
- Executes run-agent workflow and returns a markdown guide response.
Returns:
- Dictionary containing `guideMarkdown`.
Errors/Exceptions:
- Raises HTTPException(500) when workflow/orchestrator execution fails.
"""

import json
import traceback

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from ....core.logging import get_logger
from ....schemas.requests import RunAgentRequest
from ....services.run_agent_service import run_agent_workflow, stream_run_agent_workflow

logger = get_logger("headstart.main")
router = APIRouter(tags=["runs"])


def handle_run_agent_request(req: RunAgentRequest, route_path: str):
    """Shared run-agent handler body used by v1 and legacy routes."""
    try:
        return run_agent_workflow(req, route_path=route_path)
    except Exception as e:
        logger.error("Agent error: %s", repr(e))
        logger.debug("Traceback:\n%s", traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))


def _format_sse(event: str, data: dict, event_id: int) -> str:
    payload = json.dumps(data, ensure_ascii=False)
    lines = [f"id: {event_id}", f"event: {event}"]
    for line in payload.splitlines() or [""]:
        lines.append(f"data: {line}")
    lines.append("")
    return "\n".join(lines) + "\n"


def handle_run_agent_stream_request(req: RunAgentRequest, route_path: str):
    """Shared run-agent streaming handler body used by v1 and legacy routes."""

    def event_stream():
        try:
            for event_id, event in enumerate(
                stream_run_agent_workflow(req, route_path=route_path), start=1
            ):
                event_name = str(event.get("event", "message"))
                event_data = event.get("data", {})
                if not isinstance(event_data, dict):
                    event_data = {"value": event_data}
                yield _format_sse(event_name, event_data, event_id)
        except Exception as e:
            logger.error("Agent stream error: %s", repr(e))
            logger.debug("Traceback:\n%s", traceback.format_exc())
            yield _format_sse(
                "run.error",
                {
                    "stage": "failed",
                    "progress_percent": 100,
                    "status_message": "Guide generation failed",
                    "message": str(e),
                },
                event_id=999999,
            )

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/runs")
def create_run(req: RunAgentRequest):
    return handle_run_agent_request(req, route_path="/api/v1/runs")


@router.post("/runs/stream")
def create_run_stream(req: RunAgentRequest):
    return handle_run_agent_stream_request(req, route_path="/api/v1/runs/stream")
