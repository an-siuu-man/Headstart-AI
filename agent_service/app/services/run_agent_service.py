"""
Artifact: agent_service/app/services/run_agent_service.py
Purpose: Coordinates request-level run-agent workflow execution for API handlers.
Author: Ansuman Sharma
Created: 2026-02-27
Revised:
- 2026-02-27: Added service layer to orchestrate PDF extraction and agent execution. (Ansuman Sharma)
- 2026-03-01: Added typed run streaming workflow events for SSE transport. (Codex)
Preconditions:
- Incoming request is validated as RunAgentRequest.
Inputs:
- Acceptable: Normalized payload object with optional PDF text/files.
- Unacceptable: Non-dict payloads or malformed PDF structures bypassing schema validation.
Postconditions:
- Agent is executed with merged PDF context and returns generated guide result.
Returns:
- Dictionary response from Headstart orchestrator.
Errors/Exceptions:
- Propagates orchestration/runtime exceptions to API layer for HTTP error mapping.
"""

import math
import json
from typing import Generator

from ..core.logging import get_logger
from ..schemas.requests import ChatStreamRequest, RunAgentRequest
from ..schemas.responses import ChatCompletionResponse, RunAgentResponse
from ..schemas.shared import PdfExtraction, PdfExtractionQuality, PdfPageExtraction
from .pdf_extraction_service import (
    build_pdf_file_extraction_payload,
    collect_visual_signals_from_extractions,
    extract_pdf_extractions_from_pdf_files,
    extract_pdf_extractions_with_file_map,
    format_pdf_extractions_for_prompt,
)

logger = get_logger("headstart.main")


def _run_headstart_agent(payload: dict, pdf_text: str, visual_signals: list[dict]) -> dict:
    """Lazy import to avoid loading LLM dependencies at module import time."""
    from ..orchestrators.headstart_orchestrator import run_headstart_agent

    return run_headstart_agent(payload, pdf_text, visual_signals=visual_signals)


def _stream_headstart_agent_markdown(
    payload: dict,
    pdf_text: str,
    visual_signals: list[dict],
):
    """Lazy import to avoid loading LLM dependencies at module import time."""
    from ..orchestrators.headstart_orchestrator import stream_headstart_agent_markdown

    return stream_headstart_agent_markdown(payload, pdf_text, visual_signals=visual_signals)


def _stream_headstart_chat_answer(
    assignment_payload: dict,
    guide_markdown: str,
    chat_history: list[dict],
    retrieval_context: list[dict],
    user_message: str,
    include_thinking: bool = False,
    calendar_context: dict | None = None,
    assignment_pdf_text: str = "",
    user_attachments_context: str = "",
):
    """Lazy import to avoid loading LLM dependencies at module import time."""
    from ..orchestrators.headstart_orchestrator import stream_headstart_chat_answer

    return stream_headstart_chat_answer(
        assignment_payload=assignment_payload,
        guide_markdown=guide_markdown,
        chat_history=chat_history,
        retrieval_context=retrieval_context,
        user_message=user_message,
        include_thinking=include_thinking,
        calendar_context=calendar_context,
        assignment_pdf_text=assignment_pdf_text,
        user_attachments_context=user_attachments_context,
    )


def run_agent_workflow(req: RunAgentRequest, route_path: str) -> dict:
    """Execute the full run-agent workflow for a validated request."""
    title = req.payload.get("title", "(no title)") if isinstance(req.payload, dict) else "(unknown)"
    course_id = req.payload.get("courseId", "?") if isinstance(req.payload, dict) else "?"
    num_pdf_files = len(req.pdf_files or [])

    logger.info(
        "POST %s | title=%r | courseId=%s | pdf_extractions=%d | pdf_files=%d",
        route_path,
        title,
        course_id,
        len(req.pdf_extractions),
        num_pdf_files,
    )

    pdf_extractions, _ = extract_pdf_extractions_with_file_map(req)
    pdf_text = format_pdf_extractions_for_prompt(pdf_extractions, source="assignment")
    visual_signals = collect_visual_signals_from_extractions(pdf_extractions)
    if pdf_text:
        logger.info("Combined PDF text: %d chars", len(pdf_text))
    if visual_signals:
        logger.info("Extracted visual signals: %d", len(visual_signals))

    result = _run_headstart_agent(req.payload, pdf_text, visual_signals=visual_signals)
    logger.info(
        "Agent completed | keys=%s",
        list(result.keys()) if isinstance(result, dict) else type(result).__name__,
    )
    return result


def _build_event(event: str, data: dict) -> dict:
    return {
        "event": event,
        "data": data,
    }


def _normalize_markdown_output(text: str) -> str:
    cleaned = (text or "").strip()
    if not cleaned:
        return ""

    if cleaned.startswith("{") and '"guideMarkdown"' in cleaned:
        try:
            parsed = json.loads(cleaned)
            guide_markdown = parsed.get("guideMarkdown")
            if isinstance(guide_markdown, str):
                cleaned = guide_markdown.strip()
        except Exception:
            pass

    if cleaned.startswith("```") and cleaned.endswith("```"):
        cleaned = cleaned.strip("`").strip()
        if cleaned.lower().startswith("markdown"):
            cleaned = cleaned[len("markdown") :].strip()

    return cleaned


def _split_stream_chunk(chunk: object) -> tuple[str, str]:
    """
    Normalize orchestrator stream chunks.
    Backward compatible with legacy string-only deltas.
    """
    if isinstance(chunk, str):
        return chunk, ""

    if isinstance(chunk, dict):
        content_delta = chunk.get("content_delta", "")
        reasoning_delta = chunk.get("reasoning_delta", "")
        return (
            content_delta if isinstance(content_delta, str) else "",
            reasoning_delta if isinstance(reasoning_delta, str) else "",
        )

    return "", ""


def stream_run_agent_workflow(req: RunAgentRequest, route_path: str) -> Generator[dict, None, None]:
    """
    Execute run workflow and emit typed stream events for SSE clients.

    Event sequence:
      run.started -> run.stage -> run.delta* -> run.stage -> run.completed
      or run.error on failure.
    """
    title = req.payload.get("title", "(no title)") if isinstance(req.payload, dict) else "(unknown)"
    course_id = req.payload.get("courseId", "?") if isinstance(req.payload, dict) else "?"
    num_pdf_files = len(req.pdf_files or [])

    logger.info(
        "POST %s [stream] | title=%r | courseId=%s | pdf_extractions=%d | pdf_files=%d",
        route_path,
        title,
        course_id,
        len(req.pdf_extractions),
        num_pdf_files,
    )

    try:
        yield _build_event(
            "run.started",
            {
                "stage": "queued",
                "progress_percent": 8,
                "status_message": "Run started",
            },
        )

        yield _build_event(
            "run.stage",
            {
                "stage": "preparing_payload",
                "progress_percent": 20,
                "status_message": "Preparing assignment payload",
            },
        )

        yield _build_event(
            "run.stage",
            {
                "stage": "extracting_pdf",
                "progress_percent": 38,
                "status_message": "Extracting PDF context",
            },
        )
        pdf_extractions, extractions_by_sha = extract_pdf_extractions_with_file_map(req)
        pdf_text = format_pdf_extractions_for_prompt(pdf_extractions, source="assignment")
        visual_signals = collect_visual_signals_from_extractions(pdf_extractions)
        if pdf_text:
            logger.info("Combined PDF text: %d chars", len(pdf_text))
        if visual_signals:
            logger.info("Extracted visual signals: %d", len(visual_signals))
        if extractions_by_sha:
            logger.info("Per-file structured extractions: %d file(s)", len(extractions_by_sha))

        yield _build_event(
            "run.stage",
            {
                "stage": "calling_agent",
                "progress_percent": 56,
                "status_message": "Calling AI generation service",
            },
        )

        chunks: list[str] = []
        chunk_count = 0
        char_count = 0
        reasoning_char_count = 0
        reasoning_chunks: list[str] = []

        for chunk in _stream_headstart_agent_markdown(req.payload, pdf_text, visual_signals):
            delta, reasoning_delta = _split_stream_chunk(chunk)
            if not delta and not reasoning_delta:
                continue

            if delta:
                chunks.append(delta)
                char_count += len(delta)
            if reasoning_delta:
                reasoning_chunks.append(reasoning_delta)
                reasoning_char_count += len(reasoning_delta)

            chunk_count += 1
            progress = min(94, 66 + round(28 * (1 - math.exp(-chunk_count / 18))))

            yield _build_event(
                "run.delta",
                {
                    "stage": "streaming_output",
                    "progress_percent": progress,
                    "status_message": "Generating guide",
                    "delta": delta,
                    "reasoning_delta": reasoning_delta,
                    "chunk_index": chunk_count,
                    "accumulated_chars": char_count,
                    "reasoning_accumulated_chars": reasoning_char_count,
                },
            )

        guide_markdown = _normalize_markdown_output("".join(chunks))
        if not guide_markdown:
            raise RuntimeError("Model returned empty guide markdown.")

        yield _build_event(
            "run.stage",
            {
                "stage": "validating_output",
                "progress_percent": 97,
                "status_message": "Validating guide output",
            },
        )

        result = RunAgentResponse.model_validate(
            {
                "guideMarkdown": guide_markdown,
            }
        ).model_dump()

        logger.info(
            "Streaming agent completed | markdown_len=%d reasoning_len=%d",
            len(guide_markdown),
            reasoning_char_count,
        )
        completed_payload = {
            **result,
            "stage": "completed",
            "progress_percent": 100,
            "status_message": "Guide ready",
        }
        thinking_content = "".join(reasoning_chunks).strip()
        if thinking_content:
            completed_payload["thinking_content"] = thinking_content
        pdf_file_extractions = build_pdf_file_extraction_payload(extractions_by_sha)
        if pdf_file_extractions:
            completed_payload["pdf_file_extractions"] = pdf_file_extractions
            # Backward-compatible legacy field for older clients.
            completed_payload["pdf_file_texts"] = [
                {
                    "file_sha256": item["file_sha256"],
                    "extracted_text": item["full_text"],
                }
                for item in pdf_file_extractions
                if item.get("full_text")
            ]
        yield _build_event("run.completed", completed_payload)
    except Exception as exc:
        logger.exception("Streaming run failed")
        yield _build_event(
            "run.error",
            {
                "stage": "failed",
                "progress_percent": 100,
                "status_message": "Guide generation failed",
                "message": str(exc),
            },
        )


def stream_chat_workflow(req: ChatStreamRequest, route_path: str) -> Generator[dict, None, None]:
    """
    Execute follow-up chat workflow and emit typed stream events for SSE clients.

    Event sequence:
      chat.started -> chat.delta* -> chat.completed
      or chat.error on failure.
    """
    num_user_pdfs = len(req.user_pdf_files or [])
    logger.info(
        "POST %s [chat.stream] | payload_keys=%d | guide_len=%d | history=%d | retrieval_chunks=%d | thinking_mode=%s | user_pdfs=%d",
        route_path,
        len(req.assignment_payload or {}),
        len(req.guide_markdown or ""),
        len(req.chat_history or []),
        len(req.retrieval_context or []),
        req.thinking_mode,
        num_user_pdfs,
    )

    try:
        yield _build_event(
            "chat.started",
            {
                "stage": "chat_streaming",
                "progress_percent": 97,
                "status_message": "Generating follow-up response",
            },
        )

        assignment_extractions: list[PdfExtraction] = list(req.assignment_pdf_extractions or [])
        if not assignment_extractions and (req.assignment_pdf_text or "").strip():
            legacy_text = (req.assignment_pdf_text or "").strip()
            assignment_extractions = [
                PdfExtraction(
                    filename="legacy-assignment-pdf.txt",
                    source="assignment",
                    full_text=legacy_text,
                    pages=[
                        PdfPageExtraction(
                            page_number=1,
                            text=legacy_text,
                            method="legacy-inline",
                            confidence=1.0,
                        )
                    ],
                    visual_signals=[],
                    quality=PdfExtractionQuality(
                        strategy="legacy_assignment_pdf_text",
                        docling_available=False,
                        native_chars=len(legacy_text),
                        docling_chars=0,
                        reconciled_chars=len(legacy_text),
                        notes=["legacy_assignment_pdf_text_field"],
                    ),
                )
            ]

        user_extractions = extract_pdf_extractions_from_pdf_files(
            req.user_pdf_files or [],
            source="user_upload",
        )
        user_attachments_context = format_pdf_extractions_for_prompt(
            user_extractions,
            source="user_upload",
        )
        assignment_pdf_context = format_pdf_extractions_for_prompt(
            assignment_extractions,
            source="assignment",
        )
        logger.info(
            "User attachment extraction: %d files -> %d chars | assignment_extractions=%d",
            num_user_pdfs,
            len(user_attachments_context),
            len(assignment_extractions),
        )

        chunks: list[str] = []
        chunk_count = 0
        char_count = 0
        reasoning_char_count = 0
        reasoning_chunks: list[str] = []

        for chunk in _stream_headstart_chat_answer(
            assignment_payload=req.assignment_payload,
            guide_markdown=req.guide_markdown,
            chat_history=[item.model_dump() for item in req.chat_history],
            retrieval_context=[item.model_dump() for item in req.retrieval_context],
            user_message=req.user_message,
            include_thinking=req.thinking_mode,
            calendar_context=req.calendar_context.model_dump() if req.calendar_context else None,
            assignment_pdf_text=assignment_pdf_context,
            user_attachments_context=user_attachments_context,
        ):
            delta, reasoning_delta = _split_stream_chunk(chunk)
            if not delta and not reasoning_delta:
                continue

            if delta:
                chunks.append(delta)
                char_count += len(delta)
            if reasoning_delta:
                reasoning_chunks.append(reasoning_delta)
                reasoning_char_count += len(reasoning_delta)

            chunk_count += 1
            progress = min(99, 97 + round(2 * (1 - math.exp(-chunk_count / 8))))

            yield _build_event(
                "chat.delta",
                {
                    "stage": "chat_streaming",
                    "progress_percent": progress,
                    "status_message": "Generating follow-up response",
                    "delta": delta,
                    "reasoning_delta": reasoning_delta,
                    "chunk_index": chunk_count,
                    "accumulated_chars": char_count,
                    "reasoning_accumulated_chars": reasoning_char_count,
                },
            )

        assistant_message = "".join(chunks).strip()
        if not assistant_message:
            raise RuntimeError("Model returned empty follow-up response.")

        result = ChatCompletionResponse.model_validate(
            {
                "assistantMessage": assistant_message,
            }
        ).model_dump()

        logger.info(
            "Streaming chat completed | chars=%d reasoning_len=%d",
            len(assistant_message),
            reasoning_char_count,
        )
        completed_payload = {
            "assistant_message": result["assistantMessage"],
            "stage": "completed",
            "progress_percent": 100,
            "status_message": "Response ready",
        }
        thinking_content = "".join(reasoning_chunks).strip()
        if thinking_content:
            completed_payload["thinking_content"] = thinking_content
        yield _build_event("chat.completed", completed_payload)
    except Exception as exc:
        logger.exception("Streaming chat failed")
        yield _build_event(
            "chat.error",
            {
                "stage": "failed",
                "progress_percent": 100,
                "status_message": "Follow-up response failed",
                "message": str(exc),
            },
        )
